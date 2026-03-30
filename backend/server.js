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

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const DESTINATION_NAME = process.env.DESTINATION_NAME || "S48-HTTP";

let xsuaaCredentials        = null;
let destinationCredentials  = null;
let connectivityCredentials = null;

// Load BTP Services
try {
  xsenv.loadEnv();
  const services = xsenv.getServices({
    xsuaa:        { tag: "xsuaa" },
    destination:  { tag: "destination" },
    connectivity: { tag: "connectivity" },
  });
  xsuaaCredentials        = services.xsuaa;
  destinationCredentials  = services.destination;
  connectivityCredentials = services.connectivity;
  console.log("✅ BTP services loaded from VCAP_SERVICES");
} catch (err) {
  console.error("❌ Failed to load BTP services:", err.message);
}

// Fallbacks
if (!xsuaaCredentials && process.env.XSUAA_URL) {
  xsuaaCredentials = { url: process.env.XSUAA_URL, clientid: process.env.XSUAA_CLIENT_ID, clientsecret: process.env.XSUAA_CLIENT_SECRET };
}
if (!destinationCredentials && process.env.DESTINATION_URI) {
  destinationCredentials = { uri: process.env.DESTINATION_URI, url: process.env.DESTINATION_TOKEN_URL, clientid: process.env.DESTINATION_CLIENT_ID, clientsecret: process.env.DESTINATION_CLIENT_SECRET };
}
if (!connectivityCredentials && process.env.CONNECTIVITY_PROXY_HOST) {
  connectivityCredentials = { clientid: process.env.CONNECTIVITY_CLIENT_ID, clientsecret: process.env.CONNECTIVITY_CLIENT_SECRET, token_service_url: process.env.CONNECTIVITY_TOKEN_URL, onpremise_proxy_host: process.env.CONNECTIVITY_PROXY_HOST, onpremise_proxy_http_port: process.env.CONNECTIVITY_PROXY_PORT || "20003" };
}

console.log("📡 XSUAA URL          :", xsuaaCredentials?.url);
console.log("📡 Destination URI    :", destinationCredentials?.uri);
console.log("📡 Connectivity Proxy :", connectivityCredentials?.onpremise_proxy_host);

// ─── Debug / Health ───────────────────────────────────────────────────────────

app.get("/debug", (req, res) => res.send("BACKEND LIVE ✅"));

app.get("/api/vcap", (req, res) => {
  try { res.json(JSON.parse(process.env.VCAP_SERVICES || "{}")); }
  catch (e) { res.json({ error: "VCAP_SERVICES not found" }); }
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

// ─── Token Helpers ────────────────────────────────────────────────────────────

async function getConnectivityToken() {
  if (!connectivityCredentials) throw new Error("Connectivity credentials not loaded.");
  const { clientid, clientsecret, token_service_url } = connectivityCredentials;
  const res = await axios.post(
    `${token_service_url}/oauth/token`,
    new URLSearchParams({ grant_type: "client_credentials", client_id: clientid, client_secret: clientsecret }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent }
  );
  console.log("✅ Connectivity token fetched");
  return res.data.access_token;
}

async function getBTPToken() {
  if (!destinationCredentials) throw new Error("Destination credentials not loaded.");
  const { clientid, clientsecret, url } = destinationCredentials;
  const res = await axios.post(
    `${url}/oauth/token`,
    new URLSearchParams({ grant_type: "client_credentials", client_id: clientid, client_secret: clientsecret }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent }
  );
  console.log("✅ Destination OAuth token fetched");
  return res.data.access_token;
}

async function getBTPDestination(token) {
  if (!destinationCredentials) throw new Error("Destination credentials not loaded.");
  const res = await axios.get(
    `${destinationCredentials.uri}/destination-configuration/v1/destinations/${DESTINATION_NAME}`,
    { headers: { Authorization: `Bearer ${token}` }, httpsAgent }
  );
  console.log("✅ Destination config fetched:", DESTINATION_NAME);
  return res.data;
}

// ─── Core SAP Fetch ───────────────────────────────────────────────────────────

async function fetchFromSAP(odataPath) {
  const [destToken, connectivityToken] = await Promise.all([
    getBTPToken(),
    getConnectivityToken(),
  ]);

  const destination = await getBTPDestination(destToken);
  const { URL: SAP_URL, User, Password } = destination.destinationConfiguration;
  if (!SAP_URL) throw new Error("SAP URL missing from destination config.");

  const proxyHost   = connectivityCredentials.onpremise_proxy_host;
  const proxyPort   = parseInt(connectivityCredentials.onpremise_proxy_http_port || "20003");
  const sapAuth     = Buffer.from(`${User}:${Password}`).toString("base64");
  const sapEndpoint = `${SAP_URL}${odataPath}`;

  console.log("🔄 Calling SAP:", sapEndpoint);

  const response = await axios.get(sapEndpoint, {
    headers: {
      Authorization:         `Basic ${sapAuth}`,
      "Proxy-Authorization": `Bearer ${connectivityToken}`,
      Accept:                "application/json",
    },
    proxy: { protocol: "http:", host: proxyHost, port: proxyPort },
    httpsAgent,
  });

  return response.data?.d?.results ?? response.data?.d ?? response.data ?? [];
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// 1. GET /api/transports — all transports
app.get("/api/transports", async (req, res) => {
  try {
    const data = await fetchFromSAP(
      "/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/Transports?$format=json"
    );
    const results = (Array.isArray(data) ? data : []).map((t) => ({
      TRKORR:     t.TRKORR     || "",
      OWNER:      t.OWNER      || "",
      CREATED_ON: t.CREATED_ON || "",
      STATUS:     t.STATUS     || "",
    }));
    console.log(`✅ Fetched ${results.length} transports`);
    res.json({ d: { results } });
  } catch (err) {
    console.error("❌ /api/transports error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 2. GET /api/transports/:trkorr/objects
// All fields are sap:filterable="false" so we fetch ALL objects and filter in Node
// Object entity key field linking to transport is "TRANSPORT" (not TRKORR)
app.get("/api/transports/:trkorr/objects", async (req, res) => {
  try {
    const { trkorr } = req.params;
    console.log(`🔄 Fetching all objects, will filter by TRANSPORT = ${trkorr}`);

    const data = await fetchFromSAP(
      "/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/Objects?$format=json"
    );

    const all = Array.isArray(data) ? data : [];

    // ✅ Filter in Node.js using TRANSPORT field (from metadata)
    const results = all
      .filter(o => o.TRANSPORT === trkorr)
      .map(o => ({
        OBJECT_NAME: o.OBJECT_NAME || "",
        OBJECT_TYPE: o.OBJECT_TYPE || "",
        TRANSPORT:   o.TRANSPORT   || "",
        STATUS:      o.STATUS      || "",
      }));

    console.log(`✅ Found ${results.length} objects for ${trkorr}`);
    res.json({ d: { results } });
  } catch (err) {
    console.error(`❌ objects error for ${req.params.trkorr}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// 3. GET /api/transports/:trkorr/logs
// All fields are sap:filterable="false" so we fetch ALL logs and filter in Node
// Log entity links to Object via OBJECT_NAME — no direct transport link
// So we first get objects for this transport, then match logs by OBJECT_NAME
app.get("/api/transports/:trkorr/logs", async (req, res) => {
  try {
    const { trkorr } = req.params;
    console.log(`🔄 Fetching all objects + logs, will filter by TRANSPORT = ${trkorr}`);

    // Fetch Objects and Logs in parallel
    const [objectsData, logsData] = await Promise.all([
      fetchFromSAP("/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/Objects?$format=json"),
      fetchFromSAP("/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/Logs?$format=json"),
    ]);

    const allObjects = Array.isArray(objectsData) ? objectsData : [];
    const allLogs    = Array.isArray(logsData)    ? logsData    : [];

    // Get object names belonging to this transport
    const objectNames = new Set(
      allObjects
        .filter(o => o.TRANSPORT === trkorr)
        .map(o => o.OBJECT_NAME)
    );

    // Filter logs by matching OBJECT_NAME
    const results = allLogs
      .filter(l => objectNames.has(l.OBJECT_NAME))
      .map(l => ({
        LOG_ID:      l.LOG_ID      || "",
        OBJECT_NAME: l.OBJECT_NAME || "",
        ACTION:      l.ACTION      || "",
        DATE:        l.DATE        || "",
        USER:        l.USER        || "",
      }));

    console.log(`✅ Found ${results.length} logs for ${trkorr}`);
    res.json({ d: { results } });
  } catch (err) {
    console.error(`❌ logs error for ${req.params.trkorr}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Serve Frontend ───────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, "../frontend")));
app.get(/^\/(?!api|debug).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});
// POST /api/transports/:trkorr/import
app.post("/api/transports/:trkorr/import", async (req, res) => {
  const { trkorr } = req.params;
  const { target = "P20" } = req.body;

  console.log(`🚀 Import requested: ${trkorr} → ${target}`);

  try {
    const [destToken, connectivityToken] = await Promise.all([
      getBTPToken(),
      getConnectivityToken(),
    ]);

    const destination = await getBTPDestination(destToken);
    const { URL: SAP_URL, User, Password } = destination.destinationConfiguration;

    const proxyHost = connectivityCredentials.onpremise_proxy_host;
    const proxyPort = parseInt(connectivityCredentials.onpremise_proxy_http_port || "20003");

    const sapAuth = Buffer.from(`${User}:${Password}`).toString("base64");

    const baseURL = `${SAP_URL}/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV`;

    // 🔹 1. Fetch CSRF Token
    const tokenRes = await axios.get(`${baseURL}/Transports`, {
      headers: {
        Authorization: `Basic ${sapAuth}`,
        "Proxy-Authorization": `Bearer ${connectivityToken}`,
        "x-csrf-token": "fetch",
        Accept: "application/json",
      },
      proxy: {
        protocol: "http:",
        host: proxyHost,
        port: proxyPort,
      },
      httpsAgent,
    });

    const csrfToken = tokenRes.headers["x-csrf-token"];
    const cookies = tokenRes.headers["set-cookie"];

    if (!csrfToken || !cookies) {
      throw new Error("Failed to fetch CSRF token or cookies");
    }

    console.log("✅ CSRF token fetched");

    // 🔹 2. Trigger Import (CREATE_ENTITY)
    const postRes = await axios.post(
      `${baseURL}/Transports`,
      {
        TRKORR: trkorr
      },
      {
        headers: {
          Authorization: `Basic ${sapAuth}`,
          "Proxy-Authorization": `Bearer ${connectivityToken}`,
          "x-csrf-token": csrfToken,
          "Content-Type": "application/json",
          "Cookie": cookies.join(";"),
          Accept: "application/json",
        },
        proxy: {
          protocol: "http:",
          host: proxyHost,
          port: proxyPort,
        },
        httpsAgent,
      }
    );

    console.log(`✅ Import triggered successfully: ${trkorr}`);

    res.json({
      success: true,
      message: `Transport ${trkorr} import triggered for ${target}`,
      data: postRes.data?.d || postRes.data,
    });

  } catch (err) {
    console.error(`❌ Import error for ${trkorr}:`, err.response?.data || err.message);

    res.status(500).json({
      error:
        err.response?.data?.error?.message?.value ||
        err.message ||
        "Import failed",
    });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Destination: ${DESTINATION_NAME}`);
});
