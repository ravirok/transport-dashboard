"""
Transport risk tools — each decorated with @tool so LangGraph can bind them to
the GPT-4o function-calling interface.

In production these would call real APIs (weather, freight visibility,
carrier databases, geopolitical-risk feeds). Here we implement realistic
*simulated* logic that produces varied scores based on the input fields so
the agent behaves meaningfully without external dependencies.
"""
from __future__ import annotations

import hashlib
import json
import random
from datetime import datetime
from typing import Optional

from langchain_core.tools import tool

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

_HIGH_RISK_ROUTES = {
    "suez canal", "strait of hormuz", "taiwan strait", "black sea",
    "red sea", "panama canal",
}
_HIGH_RISK_COUNTRIES = {
    "russia", "ukraine", "iran", "yemen", "myanmar", "sudan", "ethiopia",
    "haiti", "venezuela", "north korea", "somalia",
}
_POOR_CARRIERS = {"carrier_x", "express_fail", "slow_ship_co"}
_GOOD_CARRIERS = {"dhl", "fedex", "maersk", "ups", "db schenker", "kuehne nagel"}

_EXTREME_WEATHER_PORTS = {
    "shanghai", "guangzhou", "mumbai", "houston", "new orleans",
    "rotterdam", "hamburg",
}


def _deterministic_score(seed: str, lo: float, hi: float) -> float:
    """Produce a repeatable pseudo-random float in [lo, hi] for a seed string."""
    digest = int(hashlib.md5(seed.encode()).hexdigest(), 16)
    return lo + (digest % 1000) / 1000 * (hi - lo)


def _country_from_city(city: str) -> str:
    """Very simple city→country lookup for demo purposes."""
    mapping = {
        "moscow": "russia", "kyiv": "ukraine", "tehran": "iran",
        "sanaa": "yemen", "yangon": "myanmar", "khartoum": "sudan",
        "addis ababa": "ethiopia", "caracas": "venezuela",
    }
    return mapping.get(city.lower().strip(), city.lower().strip())


# ---------------------------------------------------------------------------
# Tool 1: Route disruption detection
# ---------------------------------------------------------------------------

@tool
def check_route_disruption(
    origin: str,
    destination: str,
    route_waypoints: Optional[list[str]] = None,
    cargo_type: Optional[str] = None,
) -> str:
    """
    Detect active or forecast route disruptions between origin and destination.

    Analyses chokepoints, sanctioned corridors, port strikes, infrastructure
    closures, and piracy hotspots along the route.

    Args:
        origin: Shipment origin city/port.
        destination: Shipment destination city/port.
        route_waypoints: Optional intermediate stops or chokepoints.
        cargo_type: Type of cargo being transported.

    Returns:
        JSON string with disruption risk score (0-1), level, summary, evidence,
        and recommendations.
    """
    waypoints = route_waypoints or []
    all_points = [origin.lower(), destination.lower()] + [w.lower() for w in waypoints]

    disruptions = []
    risk_score = 0.10  # baseline

    # Check for high-risk chokepoints
    for point in all_points:
        for hotspot in _HIGH_RISK_ROUTES:
            if hotspot in point or point in hotspot:
                risk_score = max(risk_score, 0.75)
                disruptions.append(f"Route passes through high-risk chokepoint: {hotspot.title()}")

    # Check country risk
    for point in all_points:
        country = _country_from_city(point)
        for risky in _HIGH_RISK_COUNTRIES:
            if risky in country or country in risky:
                risk_score = max(risk_score, 0.65)
                disruptions.append(f"Route touches high-risk country/region: {country.title()}")

    # Cargo-type modifiers
    if cargo_type:
        ct = cargo_type.lower()
        if any(k in ct for k in ["hazmat", "dangerous", "explosive", "chemical"]):
            risk_score = min(1.0, risk_score + 0.15)
            disruptions.append("Hazardous cargo faces additional regulatory checkpoints")
        elif any(k in ct for k in ["perishable", "food", "pharma", "vaccine"]):
            risk_score = min(1.0, risk_score + 0.10)
            disruptions.append("Perishable cargo at risk from route delays")

    # Add realistic detail noise
    seed = f"{origin}{destination}"
    noise = _deterministic_score(seed, 0.0, 0.12)
    risk_score = min(1.0, risk_score + noise)

    if not disruptions:
        disruptions = ["No major active disruptions detected on this corridor"]

    recommendations = []
    if risk_score >= 0.75:
        recommendations = [
            "Consider alternative routing via safer corridors",
            "Obtain War & Strike risk insurance",
            "Enable real-time freight visibility tracking",
            "Brief carrier on contingency diversion ports",
        ]
    elif risk_score >= 0.50:
        recommendations = [
            "Monitor corridor alerts via your freight forwarder",
            "Build 48–72h buffer into delivery schedule",
            "Confirm cargo insurance covers disruption delays",
        ]
    elif risk_score >= 0.25:
        recommendations = [
            "Standard monitoring sufficient",
            "Confirm customs pre-clearance documents are ready",
        ]
    else:
        recommendations = ["Route appears clear — proceed with standard protocol"]

    level = _level(risk_score)
    result = {
        "tool": "route_disruption",
        "score": round(risk_score, 3),
        "level": level,
        "summary": f"Route disruption risk is {level.upper()} ({risk_score:.0%}). "
                   f"Analysed {len(all_points)} corridor points.",
        "evidence": disruptions,
        "recommendations": recommendations,
    }
    return json.dumps(result)


# ---------------------------------------------------------------------------
# Tool 2: Delay prediction
# ---------------------------------------------------------------------------

@tool
def predict_delay(
    origin: str,
    destination: str,
    carrier: str,
    departure_date: str,
    cargo_type: Optional[str] = None,
    weight_kg: Optional[float] = None,
) -> str:
    """
    Predict shipment delay risk using historical carrier data, seasonal patterns,
    and port congestion indices.

    Args:
        origin: Shipment origin city/port.
        destination: Shipment destination city/port.
        carrier: Carrier or freight forwarder name.
        departure_date: ISO-format departure date (YYYY-MM-DD).
        cargo_type: Type of cargo.
        weight_kg: Shipment weight in kilograms.

    Returns:
        JSON string with delay risk score (0-1), estimated delay range in days,
        level, contributing factors, and recommendations.
    """
    risk_score = 0.15
    factors = []

    # Carrier reliability
    carrier_lower = carrier.lower().strip()
    if any(c in carrier_lower for c in _POOR_CARRIERS):
        risk_score = max(risk_score, 0.70)
        factors.append(f"Carrier '{carrier}' has a poor on-time delivery record")
    elif any(c in carrier_lower for c in _GOOD_CARRIERS):
        risk_score = max(risk_score, 0.10)
        factors.append(f"Carrier '{carrier}' has a strong on-time delivery record")
    else:
        risk_score = max(risk_score, 0.30)
        factors.append(f"Limited historical data for carrier '{carrier}'")

    # Seasonal congestion
    try:
        dep = datetime.fromisoformat(departure_date)
        month = dep.month
        # Peak shipping: Oct–Dec (pre-holiday), Chinese New Year: Jan–Feb
        if month in (10, 11, 12):
            risk_score = min(1.0, risk_score + 0.20)
            factors.append("Peak season (Oct–Dec): elevated port congestion expected")
        elif month in (1, 2):
            risk_score = min(1.0, risk_score + 0.15)
            factors.append("Chinese New Year period: reduced Asian port capacity")
        elif month in (6, 7, 8):
            risk_score = min(1.0, risk_score + 0.08)
            factors.append("Summer season: moderate congestion at EU/US ports")
    except ValueError:
        factors.append("Could not parse departure date — seasonal analysis skipped")

    # Weight/size factor
    if weight_kg and weight_kg > 20_000:
        risk_score = min(1.0, risk_score + 0.12)
        factors.append("Heavy shipment (>20 t) may face equipment/berth availability constraints")

    # Origin/destination congestion proxy
    congested_ports = ["shanghai", "ningbo", "rotterdam", "los angeles", "long beach",
                       "felixstowe", "hamburg", "antwerp"]
    for port in congested_ports:
        if port in origin.lower() or port in destination.lower():
            risk_score = min(1.0, risk_score + 0.10)
            factors.append(f"'{port.title()}' is a historically congested port")
            break

    # Noise
    seed = f"{carrier}{departure_date}{origin}"
    noise = _deterministic_score(seed, 0.0, 0.08)
    risk_score = min(1.0, risk_score + noise)

    # Estimate delay range
    if risk_score < 0.25:
        delay_range = "0–1 days"
    elif risk_score < 0.50:
        delay_range = "1–3 days"
    elif risk_score < 0.75:
        delay_range = "3–7 days"
    else:
        delay_range = "7–21 days"

    recommendations = []
    if risk_score >= 0.65:
        recommendations = [
            f"Build at least 7-day buffer into customer delivery commitment",
            "Negotiate priority loading with carrier",
            "Consider expedited air freight for high-value components",
            "Alert downstream supply chain partners now",
        ]
    elif risk_score >= 0.40:
        recommendations = [
            "Add 3-day buffer to planned arrival date",
            "Enable shipment tracking notifications",
            "Confirm carrier's delay compensation policy",
        ]
    else:
        recommendations = [
            "On-time delivery likely — standard tracking sufficient",
            "Ensure customs documentation is complete before departure",
        ]

    level = _level(risk_score)
    result = {
        "tool": "delay_prediction",
        "score": round(risk_score, 3),
        "level": level,
        "estimated_delay_range": delay_range,
        "summary": f"Delay risk is {level.upper()} ({risk_score:.0%}). "
                   f"Estimated additional delay: {delay_range}.",
        "evidence": factors,
        "recommendations": recommendations,
    }
    return json.dumps(result)


# ---------------------------------------------------------------------------
# Tool 3: Weather & geopolitical risk scoring
# ---------------------------------------------------------------------------

@tool
def assess_weather_geopolitical_risk(
    origin: str,
    destination: str,
    departure_date: str,
    route_waypoints: Optional[list[str]] = None,
) -> str:
    """
    Score combined weather and geopolitical risk for a shipment corridor.

    Checks active conflict zones, trade-sanction alerts, tropical storm seasons,
    and extreme-weather port closures.

    Args:
        origin: Shipment origin city/port.
        destination: Shipment destination city/port.
        departure_date: ISO-format departure date (YYYY-MM-DD).
        route_waypoints: Optional intermediate stops or waypoints.

    Returns:
        JSON string with combined weather/geopolitical risk score (0-1),
        breakdown into sub-scores, level, evidence, and recommendations.
    """
    waypoints = route_waypoints or []
    all_points = [origin.lower(), destination.lower()] + [w.lower() for w in waypoints]

    weather_score = 0.10
    geo_score = 0.10
    evidence = []

    # ---- Weather assessment ----
    try:
        dep = datetime.fromisoformat(departure_date)
        month = dep.month

        # Atlantic hurricane season: Jun–Nov
        atlantic_keywords = ["houston", "miami", "new orleans", "gulf", "caribbean",
                             "bahamas", "cuba", "atlantic", "norfolk"]
        if month in range(6, 12) and any(k in p for p in all_points for k in atlantic_keywords):
            weather_score = min(1.0, weather_score + 0.35)
            evidence.append(f"Atlantic hurricane season active (month {month}): elevated storm risk")

        # Pacific typhoon season: May–Nov
        pacific_keywords = ["shanghai", "guangzhou", "hong kong", "taipei", "manila",
                            "tokyo", "osaka", "busan", "pacific", "south china sea"]
        if month in range(5, 12) and any(k in p for p in all_points for k in pacific_keywords):
            weather_score = min(1.0, weather_score + 0.30)
            evidence.append(f"Western Pacific typhoon season active (month {month})")

        # Winter storms: Dec–Feb for Northern hemisphere ports
        winter_ports = ["hamburg", "rotterdam", "antwerp", "bremerhaven", "gdansk",
                        "st. petersburg", "vladivostok"]
        if month in (12, 1, 2) and any(k in p for p in all_points for k in winter_ports):
            weather_score = min(1.0, weather_score + 0.15)
            evidence.append("Northern European winter: ice/storm disruption possible")

        # Indian Ocean monsoon: Jun–Sep
        indian_keywords = ["mumbai", "chennai", "colombo", "karachi", "mombasa",
                           "indian ocean", "arabian sea", "bay of bengal"]
        if month in range(6, 10) and any(k in p for p in all_points for k in indian_keywords):
            weather_score = min(1.0, weather_score + 0.25)
            evidence.append("Indian Ocean monsoon season: port closure and swell risk")

    except ValueError:
        evidence.append("Departure date unparseable — seasonal weather skipped")

    # Extreme-weather ports add a base penalty
    for point in all_points:
        for port in _EXTREME_WEATHER_PORTS:
            if port in point:
                weather_score = min(1.0, weather_score + 0.08)
                evidence.append(f"'{port.title()}' is historically exposed to extreme-weather events")
                break

    # ---- Geopolitical assessment ----
    for point in all_points:
        country = _country_from_city(point)
        for risky in _HIGH_RISK_COUNTRIES:
            if risky in country:
                geo_score = min(1.0, geo_score + 0.40)
                evidence.append(f"Active conflict / sanctions risk: {country.title()}")
                break

    # Red Sea / Houthi threat (2024-2025 ongoing context)
    if any(k in p for p in all_points for k in ["red sea", "suez", "aden", "djibouti", "eritrea"]):
        geo_score = min(1.0, geo_score + 0.50)
        evidence.append("Red Sea / Bab-el-Mandeb: active Houthi maritime threat (2024–25)")

    # Taiwan Strait tensions
    if any(k in p for p in all_points for k in ["taiwan", "taipei", "kaohsiung", "taiwan strait"]):
        geo_score = min(1.0, geo_score + 0.30)
        evidence.append("Taiwan Strait: elevated military-exercise and tension risk")

    # Noise
    seed = f"{origin}{destination}{departure_date}"
    weather_score = min(1.0, weather_score + _deterministic_score(seed + "w", 0, 0.08))
    geo_score    = min(1.0, geo_score    + _deterministic_score(seed + "g", 0, 0.06))

    combined_score = round(0.5 * weather_score + 0.5 * geo_score, 3)

    recommendations = []
    if combined_score >= 0.70:
        recommendations = [
            "Re-route to avoid active conflict/storm zones",
            "Obtain full War & Weather extension on cargo insurance",
            "Monitor NOAA / IMO maritime advisories daily",
            "Identify alternative carrier / vessel options",
        ]
    elif combined_score >= 0.45:
        recommendations = [
            "Subscribe to real-time weather and geopolitical alerts",
            "Confirm insurance coverage for named-storm and war perils",
            "Add 5–10 day buffer to ETA",
        ]
    elif combined_score >= 0.25:
        recommendations = [
            "Monitor standard weather forecasts weekly",
            "Verify cargo insurance is active",
        ]
    else:
        recommendations = ["Low weather/geopolitical exposure — proceed normally"]

    level = _level(combined_score)
    result = {
        "tool": "weather_geopolitical",
        "score": combined_score,
        "level": level,
        "weather_sub_score": round(weather_score, 3),
        "geopolitical_sub_score": round(geo_score, 3),
        "summary": (
            f"Weather/geo risk is {level.upper()} ({combined_score:.0%}). "
            f"Weather sub-score: {weather_score:.0%}, "
            f"Geopolitical sub-score: {geo_score:.0%}."
        ),
        "evidence": evidence or ["No significant weather or geopolitical alerts found"],
        "recommendations": recommendations,
    }
    return json.dumps(result)


# ---------------------------------------------------------------------------
# Tool 4: Carrier performance scoring
# ---------------------------------------------------------------------------

@tool
def score_carrier_performance(
    carrier: str,
    origin: str,
    destination: str,
    cargo_type: Optional[str] = None,
) -> str:
    """
    Score a carrier's historical performance for a given lane.

    Evaluates on-time delivery rate, claims ratio, track-and-trace capability,
    financial stability, and sustainability rating.

    Args:
        carrier: Carrier or freight forwarder name.
        origin: Shipment origin city/port.
        destination: Shipment destination city/port.
        cargo_type: Type of cargo (used to check carrier specialisation).

    Returns:
        JSON string with carrier risk score (0-1), KPI breakdown, level,
        and recommendations.
    """
    carrier_lower = carrier.lower().strip()
    risk_score = 0.30  # default moderate unknown risk

    kpis = {}
    evidence = []

    # Known-carrier profiles
    if any(c in carrier_lower for c in _GOOD_CARRIERS):
        risk_score = _deterministic_score(carrier_lower, 0.08, 0.22)
        kpis = {
            "on_time_rate": f"{round(90 + _deterministic_score(carrier_lower+'ot', 0, 9), 1)}%",
            "claims_ratio": f"{round(_deterministic_score(carrier_lower+'cr', 0.2, 1.0), 2)}%",
            "track_and_trace": "real-time AIS / EDI",
            "financial_stability": "investment-grade",
            "sustainability_rating": "A–B",
        }
        evidence.append(f"'{carrier}' is a Tier-1 global carrier with strong lane coverage")
    elif any(c in carrier_lower for c in _POOR_CARRIERS):
        risk_score = _deterministic_score(carrier_lower, 0.70, 0.90)
        kpis = {
            "on_time_rate": f"{round(55 + _deterministic_score(carrier_lower+'ot', 0, 15), 1)}%",
            "claims_ratio": f"{round(_deterministic_score(carrier_lower+'cr', 3.0, 7.0), 2)}%",
            "track_and_trace": "milestone-only (no real-time)",
            "financial_stability": "speculative / watch-list",
            "sustainability_rating": "C–D",
        }
        evidence.append(f"'{carrier}' has a documented history of delays and cargo claims")
    else:
        # Unknown/regional carrier — score from seed
        risk_score = _deterministic_score(carrier_lower, 0.28, 0.55)
        kpis = {
            "on_time_rate": f"{round(75 + _deterministic_score(carrier_lower+'ot', 0, 12), 1)}%",
            "claims_ratio": f"{round(_deterministic_score(carrier_lower+'cr', 0.8, 2.5), 2)}%",
            "track_and_trace": "periodic milestone updates",
            "financial_stability": "not publicly rated",
            "sustainability_rating": "unknown",
        }
        evidence.append(f"'{carrier}' is not in the top-tier carrier database — limited data available")

    # Lane specialisation check
    if cargo_type:
        ct = cargo_type.lower()
        if "reefer" in ct or "cold" in ct or "refrigerat" in ct:
            if not any(c in carrier_lower for c in ["maersk", "hamburg sud", "evergreen"]):
                risk_score = min(1.0, risk_score + 0.12)
                evidence.append("Cold chain requires specialised reefer capacity — verify carrier capability")
        if "hazmat" in ct or "dangerous" in ct:
            risk_score = min(1.0, risk_score + 0.10)
            evidence.append("Hazmat requires IATA/IMDG-certified carrier — confirm certification")
        if "oversize" in ct or "heavy lift" in ct:
            risk_score = min(1.0, risk_score + 0.15)
            evidence.append("Oversize/heavy-lift requires specialist equipment — verify carrier capacity")

    # Long-distance lane penalty for unknown carriers
    long_haul_pairs = [("asia", "europe"), ("asia", "america"), ("china", "usa"),
                       ("india", "brazil"), ("africa", "europe")]
    origin_l, dest_l = origin.lower(), destination.lower()
    for (a, b) in long_haul_pairs:
        if (a in origin_l and b in dest_l) or (b in origin_l and a in dest_l):
            if carrier_lower not in _GOOD_CARRIERS:
                risk_score = min(1.0, risk_score + 0.08)
                evidence.append("Long-haul trans-oceanic lane increases exposure to unknown carriers")

    recommendations = []
    if risk_score >= 0.65:
        recommendations = [
            "Replace carrier with Tier-1 alternative for this shipment",
            "Request carrier financial stability certificate",
            "Require real-time track-and-trace as contract condition",
            "Increase cargo insurance coverage limit",
        ]
    elif risk_score >= 0.40:
        recommendations = [
            "Validate carrier certifications before booking",
            "Negotiate SLA with delay penalties",
            "Confirm carrier insurance and liability limits",
        ]
    elif risk_score >= 0.20:
        recommendations = [
            "Carrier performance is acceptable — standard due diligence",
            "Confirm booking terms and documentation requirements",
        ]
    else:
        recommendations = ["Top-tier carrier — proceed with confidence"]

    level = _level(risk_score)
    result = {
        "tool": "carrier_performance",
        "score": round(risk_score, 3),
        "level": level,
        "carrier": carrier,
        "kpis": kpis,
        "summary": f"Carrier risk is {level.upper()} ({risk_score:.0%}) for '{carrier}' on this lane.",
        "evidence": evidence,
        "recommendations": recommendations,
    }
    return json.dumps(result)


# ---------------------------------------------------------------------------
# Public export
# ---------------------------------------------------------------------------

ALL_TOOLS = [
    check_route_disruption,
    predict_delay,
    assess_weather_geopolitical_risk,
    score_carrier_performance,
]


def _level(score: float) -> str:
    if score < 0.25:
        return "low"
    if score < 0.50:
        return "medium"
    if score < 0.75:
        return "high"
    return "critical"
