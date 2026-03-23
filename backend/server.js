const axios = require("axios");

app.get("/api/transports", async (req, res) => {
  try {
    const transports = [
      { Transport: "TR001", Description: "Sales Fix" },
      { Transport: "TR002", Description: "Finance Update" },
      { Transport: "TR003", Description: "HR Enhancement" }
    ];

    // Call Python AI agent
    const response = await axios.post("http://localhost:5000/analyze", {
      transports: transports
    });

    res.json({ d: { results: response.data.results } });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
