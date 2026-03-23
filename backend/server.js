require("dotenv").config();

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

// HTTPS Agent
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Destination Name
const DESTINATION_NAME = process.env.DESTINATION_NAME || "S48-HTTP";

// Load BTP Services
let xsuaaCredentials = null;
let destinationCredentials = null;

// Try VCAP_SERVICES first
try {
  xsenv.loadEnv();
  const services = xsenv.getServices({
    xsuaa: { name: "Test-demo" },
    destination: { name: "BTP-DEMO" },
  });
  xsuaaCredentials = services.xsuaa;
  destinationCredentials = services.destination;
  console.log("✅ BTP services loaded from VCAP_SERVICES");
} catch (err) {
  console.warn("⚠️ VCAP_SERVICES not found, falling back to env vars...");
}

// Fallback to env vars
if (!xsuaaCredentials) {
  if (process.env.XSUAA_URL && process.env.XSUAA_CLIENT_ID) {
    xsuaaCredentials = {
      url: process.env.XSUAA_URL,
      clientid: process.env.XSUAA_CLIENT_ID,
      clientsecret: process.env.XSUAA_CLIENT_SECRET,
    };
    console.log("✅ XSUAA loaded from env vars");
  } else {
    console.error("❌ XSUAA credentials missing");
  }
}

if (!destinationCredentials) {
  if (process.env.DESTINATION_URI && process.env.DESTINATION_CLIENT_ID) {
    destinationCredentials = {
      uri: process.env.DESTINATION_URI,
      url: process.env.DESTINATION_TOKEN_URL,
      clientid: process.env.DESTINATION_CLIENT_ID,
      clientsecret: process.env.DESTINATION_CLIENT_SECRET,
    };
    console.log("✅ Destination service loaded from env vars");
  } else {
    console.error("❌ Destination service credentials missing");
  }
}

console.log("📡 XSUAA URL      :", xsuaaCredentials?.url);
console.log("📡 Destination URI:", destinationCredentials?.uri);
console.log("📡 Destination URL:", destinationCredentials?.url);

// Debug Route
app.get("/debug", (req, res) => res.send("BACKEND LIVE ✅"));

// VCAP Debug Route
app.get("/api/vcap", (req, res) => {
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
    res.json(vcap);
  } catch (err) {
    res.json({
      error: "VCAP_SERVICES not found",
      raw: process.env.VCAP_SERVICES,
    });
  }
});

// Health Check
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    config: {
      destinationName: DESTINATION_NAME,
      xsuaaLoaded: !!xsuaaCredentials,
      destinationServiceLoaded: !!destinationCredentials,
      destinationClientId: destinationCredentials?.clientid || "NOT LOADED",
      destinationTokenUrl: destinationCredentials?.url || "NOT LOADED",
      destinationUri: destinationCredentials?.uri || "NOT LOADED",
    },
  });
});

// Step 1: Get Token using Destination Service Credentials
async function getBTPToken() {
  if (!destinationCredentials) {
    throw new Error("Destination credentials not loaded. Check service bindings.");
  }

  const { clientid, clientsecret, url } = destinationCredentials;

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

    console.log("✅ Destination OAuth token fetched");
    return response.data.access_token;
  } catch (err) {
    console.error("❌ Token fetch failed:", err.message);
    console.error("❌ Token URL used :", `${url}/oauth/token`);
    throw err;
  }
}

// Step 2: Get Destination Config
async function getBTPDestination(token) {
  if (!destinationCredentials) {
    throw new Error("Destination credentials not loaded.");
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

    console.log("✅ Destination config fetched:", DESTINATION_NAME);
    return response.data;
  } catch (err) {
    console.error("❌ Destination fetch failed:", err.response?.status, err.message);
    console.error("❌ Destination URI used    :", `${uri}/destination-configuration/v1/destinations/${DESTINATION_NAME}`);
    throw err;
  }
}

// Step 3: Fetch SAP Transports
async function fetchSAPTransports() {
  try {
    const token = await getBTPToken();
    const destination = await getBTPDestination(token);
    const { URL: SAP_URL, User, Password } = destination.destinationConfiguration;

    if (!SAP_URL) {
      throw new Error("SAP URL missing from destination config.");
    }

    const sapAuth = Buffer.from(`${User}:${Password}`).toString("base64");
    const sapEndpoint = `${SAP_URL}/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/Transports?$format=json`;

    console.log("🔄 Calling SAP endpoint:", sapEndpoint);

    const response = await axios.get(sapEndpoint, {
      headers: {
        Authorization: `Basic ${sapAuth}`,
        Accept: "application/json",
      },
      httpsAgent,
    });

    const data = response.data?.d?.results || [];
    console.log(`✅ Fetched ${data.length} transports`);

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

// API Routes
app.get("/api/transports", async (req, res) => {
  try {
    const transports = await fetchSAPTransports();
    res.json({ d: { results: transports } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve Frontend
app.use(express.static(path.join(__dirname, "../frontend")));

app.get(/^\/(?!api|debug).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Destination: ${DESTINATION_NAME}`);
});
