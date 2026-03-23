# 🚢 Transport Risk Agent

An AI-powered transport risk assessment agent built with **LangGraph**, **GPT-4o**, and **FastAPI**.

Given a shipment description, the agent automatically invokes four specialist risk tools and synthesises the findings into a structured Markdown report.

---

## Architecture

```
User Query
    │
    ▼
[parse_shipment]          ← GPT-4o extracts structured ShipmentDetails from free text
    │
    ▼
[orchestrate_risk]  ◄──────────────────────────────────────┐
    │                                                        │
    ├─── tool_calls? ──► [ToolNode]  ─────────────────────►─┘
    │                        │
    │                   runs tools:
    │                   • check_route_disruption
    │                   • predict_delay
    │                   • assess_weather_geopolitical_risk
    │                   • score_carrier_performance
    │
    └─── DONE ──► [process_tool_results]   ← writes RiskScore fields to state
                         │
                         ▼
                  [generate_report]        ← GPT-4o writes Markdown risk report
                         │
                         ▼
                        END
```

### Key files

| File | Purpose |
|---|---|
| `agent/state.py` | Typed state — `ShipmentDetails`, `RiskScore`, `TransportRiskState` |
| `agent/tools.py` | Four `@tool`-decorated LangChain tools |
| `agent/nodes.py` | Async node functions + `should_continue` routing |
| `agent/graph.py` | Graph wiring and `StateGraph.compile()` |
| `main.py` | FastAPI server with REST + SSE streaming endpoints |
| `run_agent.py` | CLI for quick local testing |
| `tests/test_agent.py` | Pytest test suite for tools and state |

---

## Quickstart

### 1. Clone & install

```bash
git clone https://github.com/ravirok/ai-transport-risk-demo
cd ai-transport-risk-demo

python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

pip install -r requirements.txt
```

### 2. Set your OpenAI key

```bash
cp .env.example .env
# Edit .env and set OPENAI_API_KEY=sk-...
```

### 3. Run the CLI

```bash
python run_agent.py

# Custom query:
python run_agent.py --query "500 MT pharma from Mumbai to Hamburg via Suez, \
  carrier DB Schenker, departing 2024-08-20, value USD 5M"
```

### 4. Start the API server

```bash
uvicorn main:app --reload --port 8000
```

Then open **http://localhost:8000/docs** for the interactive Swagger UI.

---

## API Reference

### `POST /api/analyse`

Full risk analysis (waits for completion, ~15–30 s).

```bash
curl -X POST http://localhost:8000/api/analyse \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Analyse risk for shipment SHP-001: electronics from Shanghai to Rotterdam via Suez Canal, departing 2024-11-15, carrier Maersk, 500 MT, value USD 2.5M"
  }'
```

**Response**

```json
{
  "shipment_id": "SHP-001",
  "origin": "Shanghai",
  "destination": "Rotterdam",
  "carrier": "Maersk",
  "overall_score": 0.621,
  "overall_level": "high",
  "route_risk":       { "score": 0.812, "level": "critical", "summary": "...", "evidence": [...], "recommendations": [...] },
  "delay_risk":       { "score": 0.543, "level": "high",     ... },
  "weather_geo_risk": { "score": 0.689, "level": "high",     ... },
  "carrier_risk":     { "score": 0.148, "level": "low",      ... },
  "final_report": "# Transport Risk Report — SHP-001\n\n..."
}
```

You can also pass **structured fields** instead of (or alongside) `query`:

```json
{
  "origin": "Shanghai",
  "destination": "Rotterdam",
  "carrier": "Maersk",
  "cargo_type": "electronics",
  "departure_date": "2024-11-15",
  "route_waypoints": ["Suez Canal"],
  "weight_kg": 500000,
  "value_usd": 2500000
}
```

---

### `POST /api/analyse/stream`

Same as `/analyse` but returns **Server-Sent Events** so your frontend can update in real time.

```javascript
const response = await fetch('/api/analyse/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: '...' })
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  const lines = decoder.decode(value).split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const event = JSON.parse(line.slice(6));
      console.log(event); // { event, node, label, scores?, report? }
    }
  }
}
```

**SSE event types**

| `event` field | Payload fields |
|---|---|
| `start` | `message` |
| `node_complete` | `node`, `label`, + optional `shipment` / `scores` / `report` |
| `done` | `message` |
| `error` | `message` |

---

## Risk Dimensions

| Tool | Weight | What it checks |
|---|---|---|
| Route disruption | 30% | Chokepoints (Suez, Hormuz, Red Sea…), sanctioned corridors, piracy zones, cargo-type penalties |
| Delay prediction | 25% | Carrier on-time history, seasonal congestion (peak / CNY / monsoon), port congestion index, weight |
| Weather / Geopolitical | 25% | Hurricane/typhoon/monsoon seasons, conflict zones, trade sanctions, Red Sea Houthi threat |
| Carrier performance | 20% | On-time rate, claims ratio, track-and-trace capability, financial stability, lane specialisation |

**Overall score** = weighted average (0–1)

| Level | Score range |
|---|---|
| 🟢 Low | 0.00 – 0.24 |
| 🟡 Medium | 0.25 – 0.49 |
| 🔴 High | 0.50 – 0.74 |
| ⛔ Critical | 0.75 – 1.00 |

---

## Running Tests

```bash
pytest tests/ -v
```

---

## Extending with Real Data

The tool functions in `agent/tools.py` use simulated scoring logic. To connect real data sources:

1. **Weather**: [OpenWeatherMap API](https://openweathermap.org/api) or [StormGeo](https://www.stormgeo.com/)
2. **Geopolitical**: [Crisis24](https://crisis24.garda.com/) · [Dataminr](https://www.dataminr.com/)
3. **Freight visibility**: [project44](https://www.project44.com/) · [FourKites](https://www.fourkites.com/)
4. **Carrier benchmarks**: [Xeneta](https://www.xeneta.com/) · [Freightos](https://www.freightos.com/)
5. **Port congestion**: [MarineTraffic](https://www.marinetraffic.com/) · [Sea-Intelligence](https://www.sea-intelligence.com/)

Each tool accepts all necessary parameters — just replace the internal `_deterministic_score` logic with an async API call.

---

## Roadmap

- [ ] LangGraph persistence (PostgreSQL checkpointer) for conversation memory
- [ ] Multi-shipment batch analysis endpoint
- [ ] React/Next.js frontend consuming the SSE stream
- [ ] Alerting webhook when risk score exceeds threshold
- [ ] CTMS integration (re-using existing `ctms-key.json`)
- [ ] SAP AI Core deployment option

---

*Built with [LangGraph](https://github.com/langchain-ai/langgraph) · [LangChain](https://www.langchain.com/) · [FastAPI](https://fastapi.tiangolo.com/) · [GPT-4o](https://openai.com/gpt-4)*
