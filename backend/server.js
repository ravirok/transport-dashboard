const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 4000;

console.log("SERVER STARTED 🚀");

// ✅ API ROUTE (ALWAYS FIRST)
app.get("/api/transports", (req, res) => {
  res.json({
    d: {
      results: [
        {
          Transport: "TR001",
          Description: "Sales Fix",
          Status: "Failed",
          RiskScore: 0.8,
          FailedObjects: [
            { ObjectName: "Z_PROGRAM", Type: "ABAP", Error: "Syntax Error" }
          ],
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
          FailedObjects: [
            { ObjectName: "Z_TABLE", Type: "DDIC", Error: "Missing Field" }
          ],
          Logs: ["Missing field in Z_TABLE"]
        }
      ]
    }
  });
});

// ✅ SERVE FRONTEND FILES
app.use(express.static(path.join(__dirname, "../frontend")));

// ✅ VERY IMPORTANT: DO NOT OVERRIDE API
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// ✅ START SERVER
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
