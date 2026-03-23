const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 4000;

// ✅ API FIRST
app.get("/api/transports", (req, res) => {
  res.json({
    d: {
      results: [
        {
          Transport: "TR001",
          Description: "Demo Transport",
          Status: "Failed",
          RiskScore: 0.8,
          FailedObjects: [],
          Logs: []
        }
      ]
    }
  });
});

// ✅ THEN static
app.use(express.static(path.join(__dirname, "frontend")));

// ✅ LAST catch-all
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend/index.html"));
});

app.listen(PORT, () => {
  console.log("Server running...");
});
