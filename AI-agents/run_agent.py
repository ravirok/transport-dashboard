#!/usr/bin/env python3
"""
Quick CLI to run the transport risk agent without starting a FastAPI server.

Usage:
    python run_agent.py
    python run_agent.py --query "500 MT electronics Shanghai to Rotterdam via Suez, Maersk, departs 2024-11-15"
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

from langchain_core.messages import HumanMessage

DEFAULT_QUERY = (
    "Analyse risk for shipment SHP-2024-001: 500 MT of consumer electronics "
    "from Shanghai, China to Rotterdam, Netherlands via Suez Canal, "
    "departing 2024-11-15, carried by Maersk. Value USD 2,500,000."
)


async def main(query: str) -> None:
    # Lazy import so we don't slow down --help
    from agent import transport_risk_graph, default_state

    try:
        from rich.console import Console
        from rich.markdown import Markdown
        from rich.panel import Panel
        console = Console()
        use_rich = True
    except ImportError:
        use_rich = False

    if use_rich:
        console.print(Panel("[bold cyan]Transport Risk Agent[/bold cyan]", expand=False))
        console.print(f"[dim]Query:[/dim] {query}\n")
    else:
        print("=" * 60)
        print("Transport Risk Agent")
        print("=" * 60)
        print(f"Query: {query}\n")

    state = default_state()
    state["messages"] = [HumanMessage(content=query)]

    print("Running analysis (this may take 15–30 seconds)...\n")

    result = await transport_risk_graph.ainvoke(state)

    # Print risk scorecard
    dims = [
        ("Route disruption", result.get("route_risk")),
        ("Delay prediction",  result.get("delay_risk")),
        ("Weather / Geo",     result.get("weather_geo_risk")),
        ("Carrier",           result.get("carrier_risk")),
    ]

    if use_rich:
        from rich.table import Table
        table = Table(title="Risk Scorecard", show_header=True, header_style="bold")
        table.add_column("Dimension", style="cyan")
        table.add_column("Score", justify="right")
        table.add_column("Level")
        for name, risk in dims:
            if risk:
                colour = {"low": "green", "medium": "yellow",
                          "high": "red", "critical": "bold red"}.get(risk.level, "white")
                table.add_row(name, f"{risk.score:.2f}", f"[{colour}]{risk.level.upper()}[/{colour}]")
        console.print(table)

        overall_score = result.get("overall_risk_score", 0)
        overall_level = result.get("overall_risk_level", "unknown")
        colour = {"low": "green", "medium": "yellow",
                  "high": "red", "critical": "bold red"}.get(overall_level, "white")
        console.print(f"\n[bold]Overall Risk:[/bold] [{colour}]{overall_level.upper()} ({overall_score:.0%})[/{colour}]\n")

        report = result.get("final_report", "")
        if report:
            console.print(Markdown(report))
    else:
        for name, risk in dims:
            if risk:
                print(f"  {name:25s} {risk.score:.2f}  [{risk.level.upper()}]")

        print(f"\nOverall: {result.get('overall_risk_level','?').upper()} "
              f"({result.get('overall_risk_score', 0):.0%})")
        print("\n--- REPORT ---")
        print(result.get("final_report", "(no report generated)"))


if __name__ == "__main__":
    if not os.getenv("OPENAI_API_KEY"):
        print("ERROR: OPENAI_API_KEY environment variable is not set.", file=sys.stderr)
        sys.exit(1)

    parser = argparse.ArgumentParser(description="Transport Risk Agent CLI")
    parser.add_argument("--query", default=DEFAULT_QUERY, help="Shipment description")
    args = parser.parse_args()

    asyncio.run(main(args.query))
