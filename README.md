**High Level Architecture**
                
                ┌────────────────────┐
                │   User Query       │
                └────────┬───────────┘
                         ↓
                ┌────────────────────┐
                │   Agent (Planner)  │
                └────────┬───────────┘
                         ↓
           ┌───────────────────────────────┐
           │ Tool 1: BTSolman Data Fetch   │
           │ Tool 2: Risk Analyzer         │
           │ Tool 3: Retrieval (Vector DB) │
           └──────────────┬────────────────┘
                          ↓
              ┌────────────────────────┐
              │ LLM Reasoning Layer    │
              └────────────────────────┘
                          ↓
              ┌────────────────────────┐
              │ Risk Summary Output    │
              └────────────────────────┘
