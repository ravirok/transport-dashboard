"""
Transport Risk Agent — LangGraph graph definition.

Graph topology
--------------

    [parse_shipment]
           │
    [orchestrate_risk] ◄────────────────────┐
           │                                 │
      ┌────┴────┐                            │
      │         │                            │
   "tools"  "process_results"               │
      │         │                            │
  [ToolNode]   [process_tool_results]        │
      │         │                            │
      └────►────┘ ── back to orchestrate? ──┘
                │
         [generate_report]
                │
              [END]

The orchestrate_risk ↔ ToolNode loop runs until the LLM emits no more
tool_calls (it outputs "DONE"), then control passes to process_tool_results
and on to generate_report.
"""
from __future__ import annotations

from langgraph.graph import StateGraph, END
from langgraph.prebuilt import ToolNode

from .state import TransportRiskState, default_state
from .nodes import (
    parse_shipment,
    orchestrate_risk,
    process_tool_results,
    generate_report,
    should_continue,
)
from .tools import ALL_TOOLS


def build_graph() -> StateGraph:
    """
    Construct and compile the transport risk LangGraph.

    Returns a compiled graph that can be invoked with:
        result = await graph.ainvoke({"messages": [HumanMessage(content="...")]})
    """
    # ------------------------------------------------------------------
    # 1. Define the graph with our typed state
    # ------------------------------------------------------------------
    graph = StateGraph(dict)  # dict state — TransportRiskState keys applied at runtime

    # ------------------------------------------------------------------
    # 2. Register nodes
    # ------------------------------------------------------------------
    graph.add_node("parse_shipment",       parse_shipment)
    graph.add_node("orchestrate_risk",     orchestrate_risk)
    graph.add_node("tools",                ToolNode(ALL_TOOLS))          # prebuilt
    graph.add_node("process_tool_results", process_tool_results)
    graph.add_node("generate_report",      generate_report)

    # ------------------------------------------------------------------
    # 3. Entry point
    # ------------------------------------------------------------------
    graph.set_entry_point("parse_shipment")

    # ------------------------------------------------------------------
    # 4. Edges
    # ------------------------------------------------------------------

    # parse → orchestrate
    graph.add_edge("parse_shipment", "orchestrate_risk")

    # orchestrate → (tools | process_results)   — conditional
    graph.add_conditional_edges(
        "orchestrate_risk",
        should_continue,
        {
            "tools":           "tools",
            "process_results": "process_tool_results",
        },
    )

    # tools → back to orchestrate (loop)
    graph.add_edge("tools", "orchestrate_risk")

    # process_results → generate_report
    graph.add_edge("process_tool_results", "generate_report")

    # generate_report → END
    graph.add_edge("generate_report", END)

    # ------------------------------------------------------------------
    # 5. Compile
    # ------------------------------------------------------------------
    return graph.compile()


# Singleton compiled graph — import and use directly
transport_risk_graph = build_graph()
