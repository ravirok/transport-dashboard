import express from "express";
import axios from "axios";
import cors from "cors";
 
const app = express();
const PORT = 4000;
app.use(cors());
 
// ABAP OData config
const BASE_URL = "http://hclcncs48.hcldigilabs.com:8000/sap/opu/odata/sap/Z_TRANSPORT_SRV_SRV";
const USER = "52213818";
const PASS = "BTsolman@1234567";
const TOP = 100;
 
// Helper
async function fetchOData(service, filter = "", top = TOP, skip = 0, client = "200") {
  try {
    const res = await axios.get(`${BASE_URL}/${service}`, {
      params: {
        $filter: filter,
        $top: top,
        $skip: skip,
        $format: "json",
        "sap-client": client
      },
      auth: { username: USER, password: PASS },
      headers: { Accept: "application/json" }
    });
    return res.data.d.results;
  } catch (err) {
    console.error(`Error fetching ${service}:`, err.message);
    return [];
  }
}
 
async function fetchTransports(targetSystem = "PROD", client = "200") {
  const dashboardData = [];
  let skipTransports = 0;
  let transportsBatch = [];
 
  do {
    transportsBatch = await fetchOData("Transports", `TARGET eq '${targetSystem}'`, TOP, skipTransports, client);
    skipTransports += TOP;
 
    const failedTransports = transportsBatch.filter(t => t.TRSTATUS === "E");
 
    for (const t of failedTransports) {
      const trkorr = t.TRKORR;
 
      // Objects
      let objects = [];
      let skipObjects = 0;
      let objectsBatch = [];
      do {
        objectsBatch = await fetchOData("Objects", `TRKORR eq '${trkorr}'`, TOP, skipObjects, client);
        objects = objects.concat(objectsBatch);
        skipObjects += TOP;
      } while (objectsBatch.length === TOP);
 
      // Logs
      let logs = [];
      let skipLogs = 0;
      let logsBatch = [];
      do {
        logsBatch = await fetchOData("Logs", `TRKORR eq '${trkorr}'`, TOP, skipLogs, client);
        logs = logs.concat(logsBatch);
        skipLogs += TOP;
      } while (logsBatch.length === TOP);
 
      t.objects = objects;
      t.logs = logs;
    }
 
    dashboardData.push(...transportsBatch);
 
  } while (transportsBatch.length === TOP);
 
  return dashboardData;
}
 
// API
app.get("/api/transports", async (req, res) => {
  const target = req.query.target || "PROD";
  const client = req.query.client || "200";
  const data = await fetchTransports(target, client);
  res.json(data);
});
 
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
