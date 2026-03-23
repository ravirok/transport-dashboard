const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 4000;

console.log("🔥 SERVER.JS RUNNING");

// ✅ DEBUG ROUTE (pehle test ke liye)
app.get("/debug", (req, res) => {
  res.send("BACKEND LIVE ✅");
});

// ✅ MAIN API
app.get("/api/transports", (req, res) => {
  res.json({
    d: {
      results: [
        {
          Transport: "TR001",
          Description: "Sales Fix",
          Status: "Failed",
          RiskScore: 0.8
        },
        {
          Transport: "TR002",
          Description: "Finance Update",
          Status: "Success",
          RiskScore: 0.2
        }
      ]
    }
  });
});

// ✅ STATIC FILES (frontend serve)
app.use(express.static(path.join(__dirname, "../frontend")));

// ✅ CATCH-ALL (API ko touch nahi karega)
app.get(/^\/(?!api|debug).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// ✅ START SERVER
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
