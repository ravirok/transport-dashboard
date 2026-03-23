app.get("/api/transports", async (req, res) => {
  try {
    const transports = [
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
    ];

    res.json({ d: { results: transports } });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
