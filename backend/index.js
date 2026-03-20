import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 4000; // dynamic port
app.use(cors());

// Health check for pipeline
app.get("/health", (req, res) => res.send("OK"));

// ABAP OData config
const BASE_URL = "https://hclcncs48.hcldigilabs.com:44300/sap/opu/odata/sap/Z_TRANSPORT_SRV_SRV/Transports?$format=json";
const USER = process.env.SAP_USER || "52213818";
const PASS = process.env.SAP_PASSWORD || "BTsolman@1234567";
const TOP = 100;

// Fetch helper functions (same as before)
async function fetchOData(service, filter = "", top = TOP, skip = 0, client = "200") { /* ... */ }
async function fetchTransports(targetSystem = "PROD", client = "200") { /* ... */ }

// API
app.get("/Transports", async (req, res) => {
  const target = req.query.target || "PROD";
  const client = req.query.client || "200";
  const data = await fetchTransports(target, client);
  res.json(data);
});

// Start server
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
