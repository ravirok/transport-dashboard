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

// Credentials
let xsuaaCredentials = null;
let destinationCredentials = null;
let connectivityCredentials = null;

// Load BTP Services from VCAP_SERVICES
try {
  xsenv.loadEnv();
  const services = xsenv.getServices({
    xsuaa:        { name: "Test-demo" },
    destination:  { name: "BTP-DEMO" },
    connectivity: { tag: "connectivity" },
  });
  xsuaaCredentials        = services.xsuaa;
  destinationCredentials  = services.destination;
  connectivityCredentials = services.connectivity;
  console.log("✅ BTP services loaded from VCAP_SERVICES");
} catch (err) {
  console.warn("⚠️ VCAP_SERVICES not found, falling back to env vars...");
}

// Fallback: XSUAA
if (!xsuaaCredentials) {
  if (process.env.XSUAA_URL && process.env.XSUAA_CLIENT_ID) {
    xsuaaCredentials = {
      url:          process.env.XSUAA_URL,
      clientid:     process.env.XSUAA_CLIENT_ID,
      clientsecret: process.env.XSUAA_CLIENT_SECRET,
    };
    console.log("✅ XSUAA loaded from env vars");
  } else {
    console.error("❌ XSUAA credentials missing");
  }
}

// Fallback: Destination Service
if (!destinationCredentials) {
  if (process.env.DESTINATION_URI && process.env.DESTINATION_CLIENT_ID) {
    destinationCredentials = {
      uri:          process.env.DESTINATION_URI,
      url:          process.env.DESTINATION_TOKEN_URL,
      clientid:     process.env.DESTINATION_CLIENT_ID,
      clientsecret: process.env.DESTINATION_CLIENT_SECRET,
    };
    console.log("✅ Destination service loaded from env vars");
  } else {
    console.error("❌ Destination service credentials missing");
  }
}

// Fallback: Connectivity Service
if (!connectivityCredentials) {
  if (process.env.CONNECTIVITY_PROXY_HOST) {
    connectivityCredentials = {
      clientid:                  process.env.CONNECTIVITY_CLIENT_ID,
      clientsecret:              process.env.CONNECTIVITY_CLIENT_SECRET,
      token_service_url:         process.env.CONNECTIVITY_TOKEN_URL,
      onpremise_proxy_host:      process.env.CONNECTIVITY_PROXY_HOST,
      onpremise_proxy_http_port: process.env.CONNECTIVITY_PROXY_PORT || "20003",
    };
    console.log("✅ Connectivity loaded from env vars");
  } else {
    console.warn("⚠️ Connectivity service credentials missing");
  }
}

console.log("📡 XSUAA URL           :", xsuaaCredentials?.url);
console.log("📡 Destination URI     :", destinationCredentials?.uri);
console.log("📡 Connectivity Proxy  :", connectivityCredentials?.onpremise_proxy_host);
console.log("📡 Connectivity Port   :", connectivityCredentials?.onpremise_proxy_http_port);

// ─── Debug Routes ─────────────────────────────────────────────────────────────

app.get("/debug", (req, res) => res.send("BACKEND LIVE ✅"));

app.get("/api/vcap", (req, res) => {
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
    res.json(vcap);
  } catch (err) {
    res.json({ error: "VCAP_SERVICES not found", raw: process.env.VCAP_SERVICES });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    config: {
      destinationName:          DESTINATION_NAME,
      xsuaaLoaded:              !!xsuaaCredentials,
      destinationServiceLoaded: !!destinationCredentials,
      connectivityLoaded:       !!connectivityCredentials,
      proxyHost:                connectivityCredentials?.onpremise_proxy_host      || "NOT LOADED",
      proxyPort:                connectivityCredentials?.onpremise_proxy_http_port || "NOT LOADED",
    },
  });
});

// ─── Step 1: Get Connectivity Token (for Proxy-Authorization header) ──────────
// IMPORTANT: Must use connectivity service's OWN clientid + clientsecret + token_service_url
// From your VCAP:
//   token_service_url = "https://hclbuild-g03o2ijo.authentication.eu10.hana.ondemand.com"
//   clientid          = "sb-cloned82c24e31e154ce99f229768fd670280!b227908|connectivity!b114511"
//   clientsecret      = "965f803f-c3cb-4f3f-baa5-..."

async function getConnectivityToken() {
  if (!connectivityCredentials) {
    throw new Error("Connectivity credentials not loaded.");
  }

  const { clientid, clientsecret, token_service_url } = connectivityCredentials;

  if (!token_service_url) {
    throw new Error("Connectivity token_service_url missing from VCAP_SERVICES.");
  }

  try {
    const response = await axios.post(
      `${token_service_url}/oauth/token`,
      new URLSearchParams({
        grant_type:    "client_credentials",
        client_id:     clientid,
        client_secret: clientsecret,
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        httpsAgent,
      }
    );
    console.log("✅ Connectivity token fetched");
    return response.data.access_token;
  } catch (err) {
    console.error("❌ Connectivity token fetch failed:", err.message);
    throw err;
  }
}

// ─── Step 2: Get Destination Service Token ────────────────────────────────────

async function getBTPToken() {
  if (!destinationCredentials) {
    throw new Error("Destination credentials not loaded.");
  }

  const { clientid, clientsecret, url } = destinationCredentials;

  try {
    const response = await axios.post(
      `${url}/oauth/token`,
      new URLSearchParams({
        grant_type:    "client_credentials",
        client_id:     clientid,
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
    console.error("❌ Destination token fetch failed:", err.message);
    console.error("❌ Token URL used:", `${url}/oauth/token`);
    throw err;
  }
}

// ─── Step 3: Get Destination Config ───────────────────────────────────────────

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
    console.error("❌ Destination URI used:", `${uri}/destination-configuration/v1/destinations/${DESTINATION_NAME}`);
    throw err;
  }
}

// ─── Step 4: Fetch SAP Transports via Connectivity Proxy ──────────────────────

async function fetchSAPTransports() {
  try {
    // Fetch both tokens in parallel
    const [destToken, connectivityToken] = await Promise.all([
      getBTPToken(),
      getConnectivityToken(),
    ]);

    const destination = await getBTPDestination(destToken);
    const { URL: SAP_URL, User, Password } = destination.destinationConfiguration;

    if (!SAP_URL) {
      throw new Error("SAP URL missing from destination config.");
    }

    if (!connectivityCredentials) {
      throw new Error("Connectivity service not bound. Cannot reach on-premise SAP system.");
    }

    // From your VCAP:
    //   onpremise_proxy_host      = "connectivityproxy.internal.cf.eu10-004.hana.ondemand.com"
    //   onpremise_proxy_http_port = "20003"
    const proxyHost = connectivityCredentials.onpremise_proxy_host;
    const proxyPort = parseInt(connectivityCredentials.onpremise_proxy_http_port || "20003");

    const sapAuth     = Buffer.from(`${User}:${Password}`).toString("base64");
    const sapEndpoint = `${SAP_URL}/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/Transports?$format=json`;

    console.log("🔄 Calling SAP endpoint :", sapEndpoint);
    console.log("🔄 Via connectivity proxy:", `${proxyHost}:${proxyPort}`);

    const response = await axios.get(sapEndpoint, {
      headers: {
        Authorization:         `Basic ${sapAuth}`,
        "Proxy-Authorization": `Bearer ${connectivityToken}`, // ✅ Connectivity service token
        Accept:                "application/json",
      },
      proxy: {
        protocol: "http:",
        host:     proxyHost,
        port:     proxyPort,
      },
      httpsAgent,
    });

    const data = response.data?.d?.results || [];
    console.log(`✅ Fetched ${data.length} transports`);

    return data.map((t) => ({
      Transport:     t.Transport,
      Description:   t.Description,
      Status:        t.Status,
      RiskScore:     t.RiskScore     || 0,
      FailedObjects: t.FailedObjects || [],
      Logs:          t.Logs          || [],
    }));

  } catch (err) {
    console.error("❌ SAP FETCH ERROR:", err.message);
    throw err;
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
  console.log(`📡 Destination: ${DESTINATION_NAME}`);
});
