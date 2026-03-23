"""
Transport Risk Agent — FastAPI server

Endpoints
---------
POST /api/analyse          Full risk analysis (async, returns complete result)
POST /api/analyse/stream   Same but streams events via Server-Sent Events
GET  /api/health           Liveness probe
GET  /docs                 Auto-generated Swagger UI

Run locally:
    uvicorn main:app --reload --port 8000

Environment variables:
    OPENAI_API_KEY   (required)
    LOG_LEVEL        DEBUG | INFO (default INFO)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from langchain_core.messages import HumanMessage
from pydantic import BaseModel, Field

from agent import transport_risk_graph, default_state
from agent.state import ShipmentDetails, RiskScore

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=getattr(logging, os.getenv("LOG_LEVEL", "INFO")),
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Transport Risk Agent",
    description="AI-powered transport risk analysis using LangGraph + GPT-4o",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------

class AnalyseRequest(BaseModel):
    """Natural-language shipment description OR structured fields."""

    # Option A: free text
    query: str | None = Field(
        default=None,
        example=(
            "Analyse risk for shipment SHP-2024-001: 500 MT of electronics "
            "from Shanghai to Rotterdam via Suez Canal, departing 2024-11-15, "
            "carrier Maersk."
        ),
    )

    # Option B: structured fields (all optional — agent can infer from query)
    shipment_id:      str | None = None
    origin:           str | None = None
    destination:      str | None = None
    carrier:          str | None = None
    cargo_type:       str | None = None
    departure_date:   str | None = None
    route_waypoints:  list[str]  = Field(default_factory=list)
    weight_kg:        float      = 0.0
    value_usd:        float      = 0.0


class RiskScoreOut(BaseModel):
    score: float
    level: str
    summary: str
    evidence: list[str]
    recommendations: list[str]


class AnalyseResponse(BaseModel):
    shipment_id:        str
    origin:             str
    destination:        str
    carrier:            str
    overall_score:      float
    overall_level:      str
    route_risk:         RiskScoreOut
    delay_risk:         RiskScoreOut
    weather_geo_risk:   RiskScoreOut
    carrier_risk:       RiskScoreOut
    final_report:       str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_user_message(req: AnalyseRequest) -> str:
    """Combine free-text query + structured fields into a single prompt string."""
    parts = []

    if req.query:
        parts.append(req.query)

    structured = {
        "shipment_id":     req.shipment_id,
        "origin":          req.origin,
        "destination":     req.destination,
        "carrier":         req.carrier,
        "cargo_type":      req.cargo_type,
        "departure_date":  req.departure_date,
        "route_waypoints": req.route_waypoints or None,
        "weight_kg":       req.weight_kg or None,
        "value_usd":       req.value_usd or None,
    }
    # Only include non-None structured fields
    filled = {k: v for k, v in structured.items() if v}
    if filled:
        parts.append("Structured shipment data: " + json.dumps(filled))

    if not parts:
        raise HTTPException(status_code=422, detail="Provide at least a 'query' or one structured field")

    return "\n\n".join(parts)


def _extract_response(result: dict) -> AnalyseResponse:
    """Map raw graph state to the API response schema."""
    def _rs(risk: RiskScore | None) -> RiskScoreOut:
        r = risk or RiskScore()
        return RiskScoreOut(
            score=r.score,
            level=r.level,
            summary=r.summary,
            evidence=r.evidence,
            recommendations=r.recommendations,
        )

    shipment: ShipmentDetails = result.get("shipment") or ShipmentDetails()

    return AnalyseResponse(
        shipment_id=shipment.shipment_id or "unknown",
        origin=shipment.origin,
        destination=shipment.destination,
        carrier=shipment.carrier,
        overall_score=result.get("overall_risk_score", 0.0),
        overall_level=result.get("overall_risk_level", "unknown"),
        route_risk=_rs(result.get("route_risk")),
        delay_risk=_rs(result.get("delay_risk")),
        weather_geo_risk=_rs(result.get("weather_geo_risk")),
        carrier_risk=_rs(result.get("carrier_risk")),
        final_report=result.get("final_report", ""),
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/api/health", tags=["System"])
async def health():
    """Liveness probe."""
    return {"status": "ok", "agent": "transport-risk-v1"}


@app.post("/api/analyse", response_model=AnalyseResponse, tags=["Risk Analysis"])
async def analyse(req: AnalyseRequest) -> AnalyseResponse:
    """
    Run a full transport risk analysis and return the complete result.

    The agent will:
    1. Parse shipment details from your input
    2. Call all four risk tools (route, delay, weather/geo, carrier)
    3. Generate a comprehensive Markdown risk report

    Typical response time: 15–30 seconds.
    """
    user_message = _build_user_message(req)

    state = default_state()
    state["messages"] = [HumanMessage(content=user_message)]

    logger.info("Starting risk analysis | query=%s", user_message[:80])

    try:
        result = await transport_risk_graph.ainvoke(state)
    except Exception as exc:
        logger.exception("Graph invocation failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return _extract_response(result)


@app.post("/api/analyse/stream", tags=["Risk Analysis"])
async def analyse_stream(req: AnalyseRequest):
    """
    Stream risk analysis progress as Server-Sent Events (SSE).

    Each event carries a JSON payload describing the current graph node
    and any partial state updates.  The final event contains the complete
    risk report.

    Connect with EventSource or any SSE client:

        const src = new EventSource('/api/analyse/stream', {method:'POST', ...})
        src.onmessage = e => console.log(JSON.parse(e.data))
    """
    user_message = _build_user_message(req)

    state = default_state()
    state["messages"] = [HumanMessage(content=user_message)]

    async def _event_generator() -> AsyncGenerator[str, None]:
        def _sse(payload: dict) -> str:
            return f"data: {json.dumps(payload)}\n\n"

        yield _sse({"event": "start", "message": "Transport Risk Agent starting analysis..."})

        node_labels = {
            "parse_shipment":       "Parsing shipment details",
            "orchestrate_risk":     "Orchestrating risk assessment",
            "tools":                "Running risk tools",
            "process_tool_results": "Processing tool results",
            "generate_report":      "Generating risk report",
        }

        try:
            async for chunk in transport_risk_graph.astream(state):
                for node_name, node_state in chunk.items():
                    label = node_labels.get(node_name, node_name)
                    logger.debug("SSE node=%s", node_name)

                    payload: dict = {"event": "node_complete", "node": node_name, "label": label}

                    # Surface key partial state for live UI updates
                    if node_name == "parse_shipment":
                        s = node_state.get("shipment")
                        if s:
                            payload["shipment"] = {
                                "id":          s.shipment_id,
                                "origin":      s.origin,
                                "destination": s.destination,
                                "carrier":     s.carrier,
                                "cargo_type":  s.cargo_type,
                            }

                    elif node_name == "process_tool_results":
                        def _mini(r: RiskScore | None) -> dict | None:
                            if not r or r.score == 0:
                                return None
                            return {"score": r.score, "level": r.level, "summary": r.summary}

                        payload["scores"] = {
                            "route":      _mini(node_state.get("route_risk")),
                            "delay":      _mini(node_state.get("delay_risk")),
                            "weather_geo":_mini(node_state.get("weather_geo_risk")),
                            "carrier":    _mini(node_state.get("carrier_risk")),
                            "overall": {
                                "score": node_state.get("overall_risk_score"),
                                "level": node_state.get("overall_risk_level"),
                            },
                        }

                    elif node_name == "generate_report":
                        payload["report"] = node_state.get("final_report", "")

                    yield _sse(payload)
                    await asyncio.sleep(0)   # yield control to event loop

        except Exception as exc:
            logger.exception("Stream error")
            yield _sse({"event": "error", "message": str(exc)})
            return

        yield _sse({"event": "done", "message": "Analysis complete"})

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
