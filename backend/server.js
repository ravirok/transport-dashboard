const express = require("express");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());

// Debug route
app.get("/debug", (req, res) => res.send("BACKEND LIVE ✅"));

// Sample transport API
app.get("/api/transports", (req, res) => {
  res.json({
    d: {
      results: [
        {
          Transport: "TR001",
          Description: "Sales Fix",
          Status: "Failed",
          RiskScore: 0.8,
          FailedObjects: [{ ObjectName: "Z_PROGRAM", Type: "ABAP", Error: "Syntax Error" }],
          Logs: ["Syntax error in Z_PROGRAM"]
        },
        {
          Transport: "TR002",
          Description: "Finance Update",
          Status: "Success",
          RiskScore: 0.2,
          FailedObjects: [],
          Logs: []
        },
        {
          Transport: "TR003",
          Description: "HR Enhancement",
          Status: "Failed",
          RiskScore: 0.6,
          FailedObjects: [{ ObjectName: "Z_TABLE", Type: "DDIC", Error: "Missing Field" }],
          Logs: ["Missing field in Z_TABLE"]
        }
      ]
    }
  });
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, "../frontend")));

// Catch-all for SPA (ignore /api and /debug)
app.get(/^\/(?!api|debug).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT} 🚀`));
