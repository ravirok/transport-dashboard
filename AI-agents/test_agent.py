"""
Tests for the Transport Risk Agent.

Run with:   pytest tests/ -v
"""
from __future__ import annotations

import json
import pytest

from agent.tools import (
    check_route_disruption,
    predict_delay,
    assess_weather_geopolitical_risk,
    score_carrier_performance,
    _level,
)
from agent.state import RiskScore, ShipmentDetails, risk_level, default_state


# ---------------------------------------------------------------------------
# State helpers
# ---------------------------------------------------------------------------

class TestState:
    def test_default_state_keys(self):
        state = default_state()
        assert "messages" in state
        assert "shipment" in state
        assert "route_risk" in state
        assert "overall_risk_score" in state

    def test_risk_level_thresholds(self):
        assert risk_level(0.10) == "low"
        assert risk_level(0.30) == "medium"
        assert risk_level(0.60) == "high"
        assert risk_level(0.80) == "critical"

    def test_shipment_defaults(self):
        s = ShipmentDetails()
        assert s.shipment_id == ""
        assert s.route_waypoints == []


# ---------------------------------------------------------------------------
# Tool: check_route_disruption
# ---------------------------------------------------------------------------

class TestRouteDisruption:
    def test_safe_route(self):
        raw = check_route_disruption.invoke({
            "origin": "Frankfurt",
            "destination": "Paris",
        })
        data = json.loads(raw)
        assert 0.0 <= data["score"] <= 1.0
        assert data["level"] in ("low", "medium", "high", "critical")
        assert data["tool"] == "route_disruption"

    def test_suez_is_high_risk(self):
        raw = check_route_disruption.invoke({
            "origin": "Shanghai",
            "destination": "Rotterdam",
            "route_waypoints": ["Suez Canal"],
        })
        data = json.loads(raw)
        assert data["score"] >= 0.60, "Suez Canal route should be high risk"
        assert data["level"] in ("high", "critical")

    def test_hazmat_increases_score(self):
        baseline = json.loads(check_route_disruption.invoke({
            "origin": "Berlin", "destination": "Warsaw",
        }))["score"]
        hazmat = json.loads(check_route_disruption.invoke({
            "origin": "Berlin", "destination": "Warsaw",
            "cargo_type": "hazmat chemicals",
        }))["score"]
        assert hazmat >= baseline

    def test_returns_recommendations(self):
        data = json.loads(check_route_disruption.invoke({
            "origin": "Aden", "destination": "Djibouti",
            "route_waypoints": ["Red Sea"],
        }))
        assert len(data["recommendations"]) > 0


# ---------------------------------------------------------------------------
# Tool: predict_delay
# ---------------------------------------------------------------------------

class TestDelayPrediction:
    def test_good_carrier_low_risk(self):
        raw = predict_delay.invoke({
            "origin": "Hamburg",
            "destination": "New York",
            "carrier": "Maersk",
            "departure_date": "2024-03-15",
        })
        data = json.loads(raw)
        assert data["score"] < 0.50, "Maersk should have low-medium delay risk"

    def test_peak_season_raises_score(self):
        off_peak = json.loads(predict_delay.invoke({
            "origin": "Shanghai", "destination": "Los Angeles",
            "carrier": "Cosco", "departure_date": "2024-04-10",
        }))["score"]
        peak = json.loads(predict_delay.invoke({
            "origin": "Shanghai", "destination": "Los Angeles",
            "carrier": "Cosco", "departure_date": "2024-11-10",
        }))["score"]
        assert peak > off_peak, "Peak season should raise delay score"

    def test_has_delay_range(self):
        data = json.loads(predict_delay.invoke({
            "origin": "Tokyo", "destination": "Sydney",
            "carrier": "DHL", "departure_date": "2024-07-01",
        }))
        assert "estimated_delay_range" in data
        assert "days" in data["estimated_delay_range"]

    def test_heavy_cargo_raises_score(self):
        normal = json.loads(predict_delay.invoke({
            "origin": "Mumbai", "destination": "Dubai",
            "carrier": "Kuehne Nagel", "departure_date": "2024-05-01",
            "weight_kg": 1000,
        }))["score"]
        heavy = json.loads(predict_delay.invoke({
            "origin": "Mumbai", "destination": "Dubai",
            "carrier": "Kuehne Nagel", "departure_date": "2024-05-01",
            "weight_kg": 25000,
        }))["score"]
        assert heavy >= normal


# ---------------------------------------------------------------------------
# Tool: assess_weather_geopolitical_risk
# ---------------------------------------------------------------------------

class TestWeatherGeoRisk:
    def test_red_sea_critical(self):
        raw = assess_weather_geopolitical_risk.invoke({
            "origin": "Jeddah",
            "destination": "Djibouti",
            "departure_date": "2024-09-01",
            "route_waypoints": ["Red Sea", "Bab-el-Mandeb"],
        })
        data = json.loads(raw)
        assert data["geopolitical_sub_score"] >= 0.50
        assert data["level"] in ("high", "critical")

    def test_has_sub_scores(self):
        data = json.loads(assess_weather_geopolitical_risk.invoke({
            "origin": "Rotterdam",
            "destination": "Antwerp",
            "departure_date": "2024-06-01",
        }))
        assert "weather_sub_score" in data
        assert "geopolitical_sub_score" in data

    def test_pacific_typhoon_season(self):
        data = json.loads(assess_weather_geopolitical_risk.invoke({
            "origin": "Shanghai",
            "destination": "Manila",
            "departure_date": "2024-08-15",
        }))
        # Aug is peak typhoon season for South China Sea
        assert data["weather_sub_score"] > 0.25

    def test_safe_corridor(self):
        data = json.loads(assess_weather_geopolitical_risk.invoke({
            "origin": "Vienna",
            "destination": "Munich",
            "departure_date": "2024-05-20",
        }))
        assert data["score"] < 0.50


# ---------------------------------------------------------------------------
# Tool: score_carrier_performance
# ---------------------------------------------------------------------------

class TestCarrierPerformance:
    def test_known_good_carrier(self):
        data = json.loads(score_carrier_performance.invoke({
            "carrier": "DHL",
            "origin": "London",
            "destination": "Singapore",
        }))
        assert data["score"] < 0.35
        assert "kpis" in data
        assert "on_time_rate" in data["kpis"]

    def test_unknown_carrier_moderate_risk(self):
        data = json.loads(score_carrier_performance.invoke({
            "carrier": "Mystery Freight Co",
            "origin": "Lagos",
            "destination": "Cape Town",
        }))
        assert 0.20 <= data["score"] <= 0.80
        assert "Limited historical data" in " ".join(data["evidence"])

    def test_hazmat_certification_warning(self):
        data = json.loads(score_carrier_performance.invoke({
            "carrier": "Generic Carrier",
            "origin": "Houston",
            "destination": "Rotterdam",
            "cargo_type": "hazmat chemicals",
        }))
        evidence_text = " ".join(data["evidence"])
        assert "IATA" in evidence_text or "hazmat" in evidence_text.lower() or "Hazmat" in evidence_text

    def test_result_schema(self):
        data = json.loads(score_carrier_performance.invoke({
            "carrier": "FedEx",
            "origin": "Memphis",
            "destination": "Tokyo",
        }))
        for field in ("tool", "score", "level", "summary", "evidence", "recommendations"):
            assert field in data, f"Missing field: {field}"


# ---------------------------------------------------------------------------
# Score level helper
# ---------------------------------------------------------------------------

class TestLevelHelper:
    @pytest.mark.parametrize("score,expected", [
        (0.00, "low"),
        (0.24, "low"),
        (0.25, "medium"),
        (0.49, "medium"),
        (0.50, "high"),
        (0.74, "high"),
        (0.75, "critical"),
        (1.00, "critical"),
    ])
    def test_thresholds(self, score, expected):
        assert _level(score) == expected
