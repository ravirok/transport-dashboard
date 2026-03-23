require("dotenv").config(); // fallback for local dev

const express = require("express");
const path = require("path");
const cors = require("cors");
const axios = require("axios");
const https = require("https");
const xsenv = require("@sap/xsenv");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// ─── HTTPS Agent (disable SSL verify for dev) ─────────────────────────────────
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ─── Destination Name (set in manifest.yml env block) ────────────────────────
const DESTINATION_NAME = process.env.DESTINATION_NAME || "S48";

// ─── Load BTP Services from VCAP_SERVICES ────────────────────────────────────
let xsuaaCredentials = null;
let destinationCredentials = null;

try {
  xsenv.loadEnv(); // loads .env locally, ignored on BTP
  const services = xsenv.getServices({
    xsuaa: { tag: "xsuaa" },
    destination: { tag: "destination" },
  });

  xsuaaCredentials = services.xsuaa;
  destinationCredentials = services.destination;

  console.log("✅ BTP services loaded successfully");
  console.log("📡 XSUAA URL:", xsuaaCredentials?.url);
  console.log("📡 Destination URI:", destinationCredentials?.uri);
} catch (err) {
  console.error("❌ Failed to load BTP services:", err.message);
  console.error("👉 Make sure xsuaa and destination services are bound to your app in manifest.yml");
}

// ─── Debug Route ──────────────────────────────────────────────────────────────
app.get("/debug", (req, res) => res.send("BACKEND LIVE ✅"));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    config: {
      destinationName: DESTINATION_NAME,
      xsuaaLoaded: !!xsuaaCredentials,
      destinationServiceLoaded: !!destinationCredentials,
    },
  });
});

// ─── Step 1: Get BTP OAuth Token from XSUAA ──────────────────────────────────
async function getBTPToken() {
  if (!xsuaaCredentials) {
    throw new Error("XSUAA credentials not loaded. Check service bindings.");
  }

  const { url, clientid, clientsecret } = xsuaaCredentials;

  try {
    const response = await axios.post(
      `${url}/oauth/token`,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientid,
        client_secret: clientsecret,
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        httpsAgent,
      }
    );

    console.log("✅ BTP OAuth token fetched");
    return response.data.access_token;
  } catch (err) {
    console.error("❌ Failed to get BTP token:", err.message);
    throw err;
  }
}

// ─── Step 2: Get Destination Details from BTP ────────────────────────────────
async function getBTPDestination(token) {
  if (!destinationCredentials) {
    throw new Error("Destination service credentials not loaded. Check service bindings.");
  }

  const { uri } = destinationCredentials;

  try {
    const response = await axios.get(
      `${uri}/destination-configuration/v1/destinations/${DESTINATION_NAME}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        httpsAgent,
      }
    );

    console.log("✅ Destination details fetched:", DESTINATION_NAME);
    return response.data;
  } catch (err) {
    console.error("❌ Failed to get destination:", err.message);
    throw err;
  }
}

// ─── Step 3: Fetch Transports from SAP ───────────────────────────────────────
async function fetchSAPTransports() {
  try {
    // Step 1 — Get BTP token
    const token = await getBTPToken();

    // Step 2 — Get destination config
    const destination = await getBTPDestination(token);
    const { URL: SAP_URL, User, Password } = destination.destinationConfiguration;

    if (!SAP_URL) {
      throw new Error("SAP URL not found in destination config.");
    }

    // Step 3 — Call SAP OData endpoint
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

    // Map to frontend format
    return data.map((t) => ({
      Transport: t.Transport,
      Description: t.Description,
      Status: t.Status,
      RiskScore: t.RiskScore || 0,
      FailedObjects: t.FailedObjects || [],
      Logs: t.Logs || [],
    }));

  } catch (err) {
    console.error("❌ SAP FETCH ERROR:", err.message);
    return [];
  }
}

// ─── API Routes ───────────────────────────────────────────────────────────────
app.get("/api/transports", async (req, res) => {
  try {
    const transports = await fetchSAPTransports();
    res.json({ d: { results: transports } });
  } catch (err) {
    console.error("❌ /api/transports error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Serve Frontend ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "../frontend")));

app.get(/^\/(?!api|debug).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Destination Name: ${DESTINATION_NAME}`);
  console.log(`🔗 Health: /api/health`);
  console.log(`🔗 Transports: /api/transports`);
});
