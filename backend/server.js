require("dotenv").config();

const express = require("express");
const path = require("path");
const cors = require("cors");
const axios = require("axios");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// ─── Debug Route ──────────────────────────────────────────────────────────────
app.get("/debug", (req, res) => res.send("BACKEND LIVE ✅"));

// ─── BTP Config ───────────────────────────────────────────────────────────────
const DESTINATION_NAME = process.env.DESTINATION_NAME || "S48";

// ─── HTTPS Agent (disable SSL verify for dev — remove rejectUnauthorized in prod) ───
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ─── Step 1: Get BTP OAuth Token from XSUAA ──────────────────────────────────
async function getBTPToken() {
  const { XSUAA_URL, XSUAA_CLIENT_ID, XSUAA_CLIENT_SECRET } = process.env;

  if (!XSUAA_URL || !XSUAA_CLIENT_ID || !XSUAA_CLIENT_SECRET) {
    throw new Error("Missing XSUAA environment variables. Check your .env file.");
  }

  try {
    const response = await axios.post(
      `${XSUAA_URL}/oauth/token`,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: XSUAA_CLIENT_ID,
        client_secret: XSUAA_CLIENT_SECRET,
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        httpsAgent,
      }
    );

    console.log("✅ BTP Token fetched successfully");
    return response.data.access_token;
  } catch (err) {
    console.error("❌ Failed to get BTP token:", err.message);
    throw err;
  }
}

// ─── Step 2: Get Destination Details from BTP ────────────────────────────────
async function getBTPDestination(token) {
  const { DESTINATION_SERVICE_URL } = process.env;

  if (!DESTINATION_SERVICE_URL) {
    throw new Error("Missing DESTINATION_SERVICE_URL in .env file.");
  }

  try {
    const response = await axios.get(
      `${DESTINATION_SERVICE_URL}/destination-configuration/v1/destinations/${DESTINATION_NAME}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        httpsAgent,
      }
    );

    console.log("✅ Destination fetched:", DESTINATION_NAME);
    return response.data;
  } catch (err) {
    console.error("❌ Failed to get BTP destination:", err.message);
    throw err;
  }
}

// ─── Step 3: Fetch Transports from SAP via BTP Destination ───────────────────
async function fetchSAPTransports() {
  try {
    // Get BTP OAuth token
    const token = await getBTPToken();

    // Get destination config (URL + credentials)
    const destination = await getBTPDestination(token);
    const { URL: SAP_URL, User, Password } = destination.destinationConfiguration;

    if (!SAP_URL) {
      throw new Error("Destination URL not found. Check your BTP destination config.");
    }

    // Build SAP Basic Auth header
    const sapAuth = Buffer.from(`${User}:${Password}`).toString("base64");

    const sapEndpoint = `${SAP_URL}/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/Transports?$format=json`;

    console.log("🔄 Fetching SAP transports from:", sapEndpoint);

    const response = await axios.get(sapEndpoint, {
      headers: {
        Authorization: `Basic ${sapAuth}`,
        Accept: "application/json",
      },
      httpsAgent,
    });

    const data = response.data?.d?.results || [];

    console.log(`✅ Fetched ${data.length} transports from SAP`);

    // Map SAP fields to frontend format
    const transports = data.map((t) => ({
      Transport: t.Transport,
      Description: t.Description,
      Status: t.Status,
      RiskScore: t.RiskScore || 0,
      FailedObjects: t.FailedObjects || [],
      Logs: t.Logs || [],
    }));

    return transports;
  } catch (err) {
    console.error("❌ SAP FETCH ERROR:", err.message);
    return [];
  }
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Get all transports
app.get("/api/transports", async (req, res) => {
  try {
    const transports = await fetchSAPTransports();
    res.json({ d: { results: transports } });
  } catch (err) {
    console.error("❌ /api/transports error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check — also shows env config status
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    config: {
      destination: DESTINATION_NAME,
      xsuaa: !!process.env.XSUAA_URL,
      destinationService: !!process.env.DESTINATION_SERVICE_URL,
    },
  });
});

// ─── Serve Frontend ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "../frontend")));

// Catch-all for SPA routing (exclude API and debug routes)
app.get(/^\/(?!api|debug).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Destination: ${DESTINATION_NAME}`);
  console.log(`🔗 http://localhost:${PORT}/debug`);
  console.log(`🔗 http://localhost:${PORT}/api/health`);
  console.log(`🔗 http://localhost:${PORT}/api/transports`);
});
