const express = require("express");
const path = require("path");
const cors = require("cors");
const axios = require("axios");
 
const app = express();
const PORT = process.env.PORT || 4000;
 
app.use(cors());
 
// Debug route
app.get("/debug", (req, res) => res.send("BACKEND LIVE ✅"));
 
// SAP OData Config
const SAP_BASE_URL = "https://hclcncs48.hcldigilabs.com:44300/sap/opu/odata/sap/Z_TRANSPORT_SRV/Transports?$format=json";
const SAP_USER = process.env.SAP_USER || "52213818";
const SAP_PASS = process.env.SAP_PASSWORD || "BTsolman@1234567";
 
// Fetch transports from SAP
async function fetchSAPTransports() {
  const auth = Buffer.from(`${SAP_USER}:${SAP_PASS}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}` };
 
  try {
    const response = await axios.get(SAP_BASE_URL, { headers });
    const data = response.data?.d?.results || [];
 
    // Map SAP response to frontend format
    const transports = data.map(t => ({
      Transport: t.Transport,
      Description: t.Description,
      Status: t.Status,
      RiskScore: t.RiskScore || 0, // optional
      FailedObjects: t.FailedObjects || [],
      Logs: t.Logs || []
    }));
 
    return transports;
  } catch (err) {
    console.error("SAP FETCH ERROR:", err.message);
    return [];
  }
}
 
// API to get transports
app.get("/api/transports", async (req, res) => {
  try {
    const transports = await fetchSAPTransports();
    res.json({ d: { results: transports } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// Serve frontend
app.use(express.static(path.join(__dirname, "../frontend")));
 
// Catch-all for SPA
app.get(/^\/(?!api|debug).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});
 
app.listen(PORT, () => console.log(`Server running on port ${PORT} 🚀`));
