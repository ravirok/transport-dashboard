from __future__ import annotations
from typing import Annotated, Any
from dataclasses import dataclass, field
from langgraph.graph.message import add_messages
from langchain_core.messages import BaseMessage


@dataclass
class ShipmentDetails:
    """Structured shipment information extracted from user input."""
    shipment_id: str = ""
    origin: str = ""
    destination: str = ""
    carrier: str = ""
    cargo_type: str = ""
    departure_date: str = ""
    route_waypoints: list[str] = field(default_factory=list)
    weight_kg: float = 0.0
    value_usd: float = 0.0


@dataclass
class RiskScore:
    """A single risk dimension score with evidence."""
    score: float = 0.0           # 0.0 (no risk) – 1.0 (critical)
    level: str = "unknown"       # low | medium | high | critical
    summary: str = ""
    evidence: list[str] = field(default_factory=list)
    recommendations: list[str] = field(default_factory=list)


class TransportRiskState(dict):
    """
    Typed LangGraph state.

    Fields
    ------
    messages            Conversation turns (append-only via add_messages reducer)
    shipment            Parsed shipment details
    route_risk          Route disruption risk score
    delay_risk          Delay prediction risk score
    weather_geo_risk    Weather / geopolitical risk score
    carrier_risk        Carrier performance risk score
    overall_risk_score  Weighted aggregate (0–1)
    overall_risk_level  Human label for aggregate
    final_report        Markdown-formatted risk report
    tool_calls_made     Which tools have already run (dedup guard)
    error               Non-empty when a node fails
    """
    messages: Annotated[list[BaseMessage], add_messages]
    shipment: ShipmentDetails
    route_risk: RiskScore
    delay_risk: RiskScore
    weather_geo_risk: RiskScore
    carrier_risk: RiskScore
    overall_risk_score: float
    overall_risk_level: str
    final_report: str
    tool_calls_made: list[str]
    error: str


def default_state() -> dict:
    """Return a fresh state dict with safe defaults."""
    return {
        "messages": [],
        "shipment": ShipmentDetails(),
        "route_risk": RiskScore(),
        "delay_risk": RiskScore(),
        "weather_geo_risk": RiskScore(),
        "carrier_risk": RiskScore(),
        "overall_risk_score": 0.0,
        "overall_risk_level": "unknown",
        "final_report": "",
        "tool_calls_made": [],
        "error": "",
    }


def risk_level(score: float) -> str:
    """Map a 0–1 score to a human label."""
    if score < 0.25:
        return "low"
    if score < 0.50:
        return "medium"
    if score < 0.75:
        return "high"
    return "critical"
