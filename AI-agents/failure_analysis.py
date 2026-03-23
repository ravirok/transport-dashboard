"""
Transport Failure Analysis — Simple Script
Fetches failed shipment from CTMS and analyses it using GPT-4o.

Usage:
    pip install openai httpx
    export OPENAI_API_KEY=sk-...
    python failure_analysis.py SHP-FAIL-1001
"""

import os
import sys
import json
import httpx
from openai import OpenAI

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# ── Load CTMS credentials ─────────────────────────────────────────────────────

def load_ctms_creds():
    try:
        with open("ctms-key.json") as f:
            return json.load(f)
    except FileNotFoundError:
        return {"url": "", "token": ""}


# ── Fetch failed shipment from CTMS ──────────────────────────────────────────

def fetch_shipment(shipment_id: str) -> dict:
    creds = load_ctms_creds()
    base_url = creds.get("url", "")
    token    = creds.get("token", "")

    if base_url and token:
        try:
            resp = httpx.get(
                f"{base_url}/shipments/{shipment_id}",
                headers={"Authorization": f"Bearer {token}"},
                timeout=15,
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            print(f"[CTMS] Could not reach server: {e} — using sample data\n")

    # ── Sample data (replace with real CTMS response shape) ──────────────────
    return {
        "shipment_id":       shipment_id,
        "status":            "FAILED",
        "failure_type":      "CUSTOMS_HOLD",
        "failure_stage":     "CUSTOMS_CLEARANCE",
        "failure_timestamp": "2024-11-10T14:30:00",
        "origin":            "Shanghai",
        "destination":       "Rotterdam",
        "carrier":           "Maersk",
        "cargo_type":        "Electronics",
        "weight_kg":         5000,
        "value_usd":         250000,
        "departure_date":    "2024-10-25",
        "planned_eta":       "2024-11-12",
        "timeline": [
            {"stage": "PICKUP",           "timestamp": "2024-10-25T08:00:00", "status": "OK",      "note": ""},
            {"stage": "ORIGIN_PORT",      "timestamp": "2024-10-27T10:00:00", "status": "OK",      "note": ""},
            {"stage": "IN_TRANSIT_SEA",   "timestamp": "2024-10-28T06:00:00", "status": "WARNING", "note": "Minor vessel delay"},
            {"stage": "DESTINATION_PORT", "timestamp": "2024-11-09T18:00:00", "status": "OK",      "note": ""},
            {"stage": "CUSTOMS_CLEARANCE","timestamp": "2024-11-10T14:30:00", "status": "FAILED",  "note": "Incorrect HS code on invoice"},
        ],
        "failure_details": {
            "hold_reason":        "Incorrect HS code on commercial invoice",
            "hold_duration_days": 7,
            "customs_docs":       ["Commercial Invoice", "Packing List", "Bill of Lading"],
        },
        "carrier_comments": "Maersk is coordinating with the customs broker.",
    }


# ── Analyse with GPT-4o ───────────────────────────────────────────────────────

def analyse(shipment: dict) -> dict:
    prompt = f"""
You are a transport risk analyst. Analyse this failed shipment from our CTMS system.

SHIPMENT DATA:
{json.dumps(shipment, indent=2)}

Return your analysis as a JSON object with exactly these keys:

{{
  "root_cause": "one-sentence explanation of why it failed",
  "root_cause_category": "CARRIER | DOCUMENTATION | EXTERNAL | INFRASTRUCTURE | PROCESS",
  "confidence": 0.0-1.0,
  "contributing_factors": ["factor 1", "factor 2", ...],
  "responsible_party": "CARRIER | SHIPPER | PORT | CUSTOMS | EXTERNAL",
  "blame_split": {{"PARTY": percentage_number, ...}},
  "sla_breached": true/false,
  "financial_impact": {{
    "estimated_loss_usd": number,
    "delay_cost_usd": number,
    "recovery_cost_usd": number,
    "total_usd": number,
    "insurance_recovery_usd": number,
    "net_exposure_usd": number
  }},
  "timeline_summary": "short description of where things first went wrong",
  "recurring_risk": "LOW | MEDIUM | HIGH",
  "future_risk_score": 0.0-1.0,
  "prevention_actions": [
    {{"priority": "IMMEDIATE|SHORT_TERM|LONG_TERM", "action": "...", "owner": "LOGISTICS|COMPLIANCE|FINANCE|CARRIER"}},
    ...
  ],
  "alert_required": true/false,
  "alert_reason": "why alert is needed or empty string"
}}

Return ONLY valid JSON. No markdown, no explanation.
"""

    response = client.chat.completions.create(
        model="gpt-4o",
        temperature=0.1,
        response_format={"type": "json_object"},
        messages=[{"role": "user", "content": prompt}],
    )

    return json.loads(response.choices[0].message.content)


# ── Print report ──────────────────────────────────────────────────────────────

def print_report(shipment: dict, analysis: dict):
    sid   = shipment.get("shipment_id", "")
    sep   = "─" * 60

    print(f"\n{'═'*60}")
    print(f"  FAILURE ANALYSIS REPORT — {sid}")
    print(f"{'═'*60}\n")

    # Shipment basics
    print(f"Origin      : {shipment.get('origin')} → {shipment.get('destination')}")
    print(f"Carrier     : {shipment.get('carrier')}")
    print(f"Cargo       : {shipment.get('cargo_type')} | {shipment.get('weight_kg')} kg | ${shipment.get('value_usd'):,}")
    print(f"Failure     : {shipment.get('failure_type')} at {shipment.get('failure_stage')}")
    print(f"Timestamp   : {shipment.get('failure_timestamp')}\n")

    # Timeline
    print(sep)
    print("TIMELINE")
    print(sep)
    for ev in shipment.get("timeline", []):
        icon = {"OK": "✓", "WARNING": "⚠", "FAILED": "✗"}.get(ev["status"], "•")
        note = f"  ← {ev['note']}" if ev.get("note") else ""
        print(f"  {icon} [{ev['status']:7}] {ev['stage']:25} {ev['timestamp'][:16]}{note}")

    print(f"\n  First anomaly: {analysis.get('timeline_summary', '')}\n")

    # Root cause
    print(sep)
    print("ROOT CAUSE")
    print(sep)
    print(f"  {analysis.get('root_cause', '')}")
    print(f"  Category   : {analysis.get('root_cause_category')}  (confidence: {analysis.get('confidence', 0):.0%})")
    print("\n  Contributing factors:")
    for f in analysis.get("contributing_factors", []):
        print(f"    • {f}")

    # Blame
    print(f"\n{sep}")
    print("RESPONSIBILITY")
    print(sep)
    blame = analysis.get("blame_split", {})
    for party, pct in sorted(blame.items(), key=lambda x: -x[1]):
        bar = "█" * int(pct / 5)
        print(f"  {party:20} {bar:20} {pct:.0f}%")
    print(f"\n  SLA breached: {'YES ⚠' if analysis.get('sla_breached') else 'no'}")

    # Financial
    fi = analysis.get("financial_impact", {})
    print(f"\n{sep}")
    print("FINANCIAL IMPACT")
    print(sep)
    items = [
        ("Estimated cargo loss",  fi.get("estimated_loss_usd", 0)),
        ("Delay / demurrage cost",fi.get("delay_cost_usd", 0)),
        ("Recovery cost",         fi.get("recovery_cost_usd", 0)),
        ("Total gross impact",    fi.get("total_usd", 0)),
        ("Insurance recovery",   -fi.get("insurance_recovery_usd", 0)),
        ("NET EXPOSURE",          fi.get("net_exposure_usd", 0)),
    ]
    for label, amount in items:
        prefix = "-" if amount < 0 else " "
        print(f"  {label:28} {prefix}${abs(amount):>10,.0f}")

    # Prevention
    print(f"\n{sep}")
    print("PREVENTION ACTIONS")
    print(sep)
    priority_order = {"IMMEDIATE": 0, "SHORT_TERM": 1, "LONG_TERM": 2}
    actions = sorted(
        analysis.get("prevention_actions", []),
        key=lambda a: priority_order.get(a.get("priority", "LONG_TERM"), 3),
    )
    for a in actions:
        print(f"  [{a.get('priority'):12}] [{a.get('owner'):12}] {a.get('action')}")

    # Future risk
    score = analysis.get("future_risk_score", 0)
    level = analysis.get("recurring_risk", "?")
    print(f"\n{sep}")
    print("FUTURE RISK (if same route repeated without fixes)")
    print(sep)
    bar = "█" * int(score * 20)
    print(f"  {bar:20} {score:.0%}  [{level}]")

    # Alert
    if analysis.get("alert_required"):
        print(f"\n{'🚨'*3}  ALERT REQUIRED  {'🚨'*3}")
        print(f"  {analysis.get('alert_reason', '')}")

    print(f"\n{'═'*60}\n")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    shipment_id = sys.argv[1] if len(sys.argv) > 1 else "SHP-FAIL-1001"

    print(f"Fetching shipment {shipment_id} from CTMS...")
    shipment = fetch_shipment(shipment_id)

    print("Running GPT-4o analysis...")
    analysis = analyse(shipment)

    print_report(shipment, analysis)

    # Optionally save JSON
    if "--save" in sys.argv:
        out = {"shipment": shipment, "analysis": analysis}
        with open(f"{shipment_id}_analysis.json", "w") as f:
            json.dump(out, f, indent=2)
        print(f"Saved to {shipment_id}_analysis.json")


if __name__ == "__main__":
    main()
