require("dotenv").config();

const express = require("express");
const path    = require("path");
const cors    = require("cors");
const axios   = require("axios");
const https   = require("https");
const xsenv   = require("@sap/xsenv");

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

const httpsAgent      = new https.Agent({ rejectUnauthorized: false });
const DESTINATION_NAME = process.env.DESTINATION_NAME || "S48-HTTP";

// ─── Service credentials ─────────────────────────────────────────────────────
let xsuaaCredentials        = null;
let destinationCredentials  = null;
let connectivityCredentials = null;

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

// Env var fallbacks
if (!xsuaaCredentials && process.env.XSUAA_URL) {
  xsuaaCredentials = {
    url:          process.env.XSUAA_URL,
    clientid:     process.env.XSUAA_CLIENT_ID,
    clientsecret: process.env.XSUAA_CLIENT_SECRET,
  };
}
if (!destinationCredentials && process.env.DESTINATION_URI) {
  destinationCredentials = {
    uri:          process.env.DESTINATION_URI,
    url:          process.env.DESTINATION_TOKEN_URL,
    clientid:     process.env.DESTINATION_CLIENT_ID,
    clientsecret: process.env.DESTINATION_CLIENT_SECRET,
  };
}
if (!connectivityCredentials && process.env.CONNECTIVITY_PROXY_HOST) {
  connectivityCredentials = {
    clientid:                  process.env.CONNECTIVITY_CLIENT_ID,
    clientsecret:              process.env.CONNECTIVITY_CLIENT_SECRET,
    token_service_url:         process.env.CONNECTIVITY_TOKEN_URL,
    onpremise_proxy_host:      process.env.CONNECTIVITY_PROXY_HOST,
    onpremise_proxy_http_port: process.env.CONNECTIVITY_PROXY_PORT || "20003",
  };
}

console.log("📡 XSUAA URL          :", xsuaaCredentials?.url);
console.log("📡 Destination URI    :", destinationCredentials?.uri);
console.log("📡 Connectivity Proxy :", connectivityCredentials?.onpremise_proxy_host);

// ─── Debug / Health ───────────────────────────────────────────────────────────
app.get("/debug", (req, res) => res.send("BACKEND LIVE ✅"));

app.get("/api/vcap", (req, res) => {
  try   { res.json(JSON.parse(process.env.VCAP_SERVICES || "{}")); }
  catch { res.json({ error: "VCAP_SERVICES not found" }); }
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

// ─── SAP Token Helpers ────────────────────────────────────────────────────────
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

// ─── Core SAP OData Fetch ─────────────────────────────────────────────────────
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
    proxy:      { protocol: "http:", host: proxyHost, port: proxyPort },
    httpsAgent,
  });

  return response.data?.d?.results ?? response.data?.d ?? response.data ?? [];
}

// ─── SAP OData POST helper (for import) ───────────────────────────────────────
async function postToSAP(odataPath, body = {}) {
  const [destToken, connectivityToken] = await Promise.all([
    getBTPToken(),
    getConnectivityToken(),
  ]);

  const destination = await getBTPDestination(destToken);
  const { URL: SAP_URL, User, Password } = destination.destinationConfiguration;

  const proxyHost = connectivityCredentials.onpremise_proxy_host;
  const proxyPort = parseInt(connectivityCredentials.onpremise_proxy_http_port || "20003");
  const sapAuth   = Buffer.from(`${User}:${Password}`).toString("base64");

  const response = await axios.post(`${SAP_URL}${odataPath}`, body, {
    headers: {
      Authorization:         `Basic ${sapAuth}`,
      "Proxy-Authorization": `Bearer ${connectivityToken}`,
      Accept:                "application/json",
      "Content-Type":        "application/json",
      "X-Requested-With":    "XMLHttpRequest",
    },
    proxy:      { protocol: "http:", host: proxyHost, port: proxyPort },
    httpsAgent,
  });

  return response.data?.d ?? response.data ?? {};
}

// ═════════════════════════════════════════════════════════════════════════════
//  TRANSPORT ROUTES
// ═════════════════════════════════════════════════════════════════════════════

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
      TARSYSTEM:  t.TARSYSTEM  || t.TARGET || "",
    }));
    console.log(`✅ Fetched ${results.length} transports`);
    res.json({ d: { results } });
  } catch (err) {
    console.error("❌ /api/transports error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 2. GET /api/transports/:trkorr/objects
//    All fields are sap:filterable="false" — fetch ALL and filter in Node
app.get("/api/transports/:trkorr/objects", async (req, res) => {
  try {
    const { trkorr } = req.params;
    console.log(`🔄 Fetching objects for TRKORR = ${trkorr}`);

    const data = await fetchFromSAP(
      "/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/Objects?$format=json"
    );

    const all = Array.isArray(data) ? data : [];
    console.log(`📦 Total objects from SAP: ${all.length}`);

    if (all.length > 0) {
      console.log("🔍 Sample object fields:", Object.keys(all[0]).filter(k => k !== "__metadata"));
    }

    // Filter by TRANSPORT field — fallback to TRKORR if TRANSPORT not present
    const results = all
      .filter(o => (o.TRANSPORT || o.TRKORR || "").trim() === trkorr)
      .map(o => ({
        OBJECT_NAME: o.OBJECT_NAME || o.OBJ_NAME  || "",
        OBJECT_TYPE: o.OBJECT_TYPE || o.OBJECT    || "",
        TRANSPORT:   o.TRANSPORT   || o.TRKORR    || "",
        STATUS:      o.STATUS                      || "",
      }));

    console.log(`✅ Found ${results.length} objects for ${trkorr}`);
    res.json({ d: { results } });
  } catch (err) {
    console.error(`❌ /api/transports/${req.params.trkorr}/objects error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// 3. GET /api/transports/:trkorr/logs
//    All fields are sap:filterable="false" — fetch ALL and filter via object names
app.get("/api/transports/:trkorr/logs", async (req, res) => {
  try {
    const { trkorr } = req.params;
    console.log(`🔄 Fetching E070L logs for TRKORR = ${trkorr}`);

    const data = await fetchFromSAP(
      "/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/Logs?$format=json"
    );

    const all = Array.isArray(data) ? data : [];
    console.log(`📋 Total log entries from SAP: ${all.length}`);

    if (all.length > 0) {
      console.log("🔍 Sample log fields:", Object.keys(all[0]).filter(k => k !== "__metadata"));
    }

    // Filter by TRANSPORT field directly
    const results = all
      .filter(l => (l.TRANSPORT || l.TRKORR || "").trim() === trkorr)
      .map(l => ({
        LOG_ID:      l.LOG_ID    || l.TRKORR   || "",
        OBJECT_NAME: l.TRANSPORT || l.TRKORR   || "",
        ACTION:      l.ACTION                  || "",
        DATE:        l.LOG_DATE  || l.AS4DATE  || l.DATE  || "",
        TIME:        l.LOG_TIME  || l.AS4TIME  || "",
        USER:        l.USER      || l.AS4USER  || "",
        STATUS:      l.STATUS                  || "",
        SYSTEM:      l.SYSTEM    || l.SYSNAM   || "",
        TARGET:      l.TARGET    || l.TARSYSTEM|| "",
      }));

    console.log(`✅ Found ${results.length} log entries for ${trkorr}`);
    res.json({ d: { results } });
  } catch (err) {
    console.error(`❌ /api/transports/${req.params.trkorr}/logs error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// 4. POST /api/transports/:trkorr/import — trigger STMS import via OData
app.post("/api/transports/:trkorr/import", async (req, res) => {
  const { trkorr } = req.params;
  const { target = "PROD", changeRequestId } = req.body;
  console.log(`🚀 Import requested: ${trkorr} → ${target}, ALM CR: ${changeRequestId || "none"}`);

  try {
    // ── Call SAP STMS OData function import ──────────────────────
    // Adjust the function import name to match your SEGW service definition
    // Common names: ImportTransport, TriggerImport, STMSImport, ExecuteImport
    const result = await postToSAP(
      `/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/ImportTransport` +
      `?Trkorr='${trkorr}'&Tarsystem='${target}'`
    );

    const retType = (result.Type    || result.TYPE    || "").trim();
    const retMsg  =  result.Message || result.MESSAGE ||
                    `Transport ${trkorr} import initiated into ${target}.`;

    if (retType === "E") {
      return res.status(400).json({ error: retMsg });
    }

    // ── Auto-sync to Cloud ALM if CR provided ─────────────────────
    let almSynced = false;
    if (changeRequestId) {
      try {
        await patchToALM(
          `/api/calm/v0/changeManagement/changeRequests/${changeRequestId}`,
          {
            status:     "DEPLOYED",
            deployedAt: new Date().toISOString(),
            comment:    `Transport ${trkorr} deployed to ${target} via TransTrack Pro.`,
          }
        );
        almSynced = true;
        console.log(`✅ ALM CR ${changeRequestId} synced to DEPLOYED`);
      } catch (almErr) {
        console.warn(`⚠️  ALM sync failed (non-blocking): ${almErr.message}`);
      }
    }

    console.log(`✅ Import successful: ${trkorr} → ${target} | ALM synced: ${almSynced}`);
    res.json({ success: true, message: retMsg, almSynced, trkorr, target });

  } catch (err) {
    const msg = err.response?.data?.error?.message?.value || err.message;
    console.error(`❌ Import error for ${trkorr}:`, msg);
    res.status(500).json({ error: msg });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  CLOUD ALM — CROSS-SUBACCOUNT VIA BTP DESTINATION SERVICE
//
//  Architecture:
//    YOUR APP SUBACCOUNT
//      └─ Destination Service  ──►  CLOUD ALM SUBACCOUNT
//                                        └─ Cloud ALM APIs
//
//  Setup steps in BTP Cockpit:
//  1. In YOUR subaccount → Destinations → New Destination:
//       Name:            CLOUD_ALM_DEST        (or set CALM_DESTINATION_NAME)
//       Type:            HTTP
//       URL:             https://your-calm-tenant.eu10.alm.cloud.sap
//       Authentication:  OAuth2ClientCredentials
//       Token Service URL: https://your-calm-subdomain.authentication.eu10.hana.ondemand.com/oauth/token
//       Client ID:       <from Cloud ALM service key in ALM subaccount>
//       Client Secret:   <from Cloud ALM service key in ALM subaccount>
//       Additional Properties:
//         HTML5.DynamicDestination = true
//         WebIDEEnabled            = true
//
//  2. The Destination Service fetches the token automatically — your app
//     just calls the Destination Service API and gets back the resolved URL
//     + a ready-to-use Bearer token via "authTokens" in the response.
//
//  Required env vars (in addition to existing ones):
//    CALM_DESTINATION_NAME   — name of the destination above (default: CLOUD_ALM_DEST)
//
//  No CALM_CLIENT_ID / CALM_CLIENT_SECRET needed in your app env —
//  those live inside the BTP Destination configuration in the ALM subaccount.
// ═════════════════════════════════════════════════════════════════════════════

const CALM_DESTINATION_NAME = process.env.CALM_DESTINATION_NAME || "Cloud_ALM";

// ─── SAP AI Core — model name only hardcoded, deployment discovered dynamically
const AI_CORE_MODEL_NAME = process.env.AI_CORE_MODEL_NAME || "gpt-4.1";

// Deployment cache — populated by discoverAICoreDeployment()
let aiCoreDeploymentCache  = null;
let aiCoreDeploymentExpiry = 0;

// ─── Dynamically discover RUNNING deployment across all resource groups ───────
async function discoverAICoreDeployment() {
  if (aiCoreDeploymentCache && Date.now() < aiCoreDeploymentExpiry) {
    return aiCoreDeploymentCache;
  }

  const token   = await getAICoreToken();
  const baseUrl = getAICoreBaseUrl();
  if (!baseUrl) throw new Error("AI_CORE_BASE_URL not configured.");

  // Step 1: Try to list all resource groups
  let resourceGroups = ["default", "security-intelligence-hub"];
  try {
    const rgRes = await axios.get(`${baseUrl}/v2/admin/resourceGroups`, {
      headers: { Authorization: `Bearer ${token}` },
      httpsAgent, timeout: 10000,
    });
    const fetched = (rgRes.data?.resourceGroups || rgRes.data?.value || [])
      .map(rg => rg.resourceGroupId || rg.id || rg.name).filter(Boolean);
    if (fetched.length > 0) {
      resourceGroups = fetched;
      console.log(`✅ AI Core resource groups: ${resourceGroups.join(", ")}`);
    }
  } catch (err) {
    console.warn(`⚠️ Resource group list failed [${err.response?.status}] — trying known groups`);
  }

  // Step 2: Search each resource group for a RUNNING deployment
  for (const rg of resourceGroups) {
    try {
      const res = await axios.get(`${baseUrl}/v2/lm/deployments?status=RUNNING`, {
        headers: {
          Authorization:       `Bearer ${token}`,
          "AI-Resource-Group": rg,
        },
        httpsAgent, timeout: 10000,
      });

      const list    = res.data?.resources || res.data?.value || [];
      const running = Array.isArray(list)
        ? list.find(d => d.status === "RUNNING" || d.deploymentStatus === "RUNNING")
        : null;

      if (running) {
        const id = running.id || running.deploymentId;
        console.log(`✅ Found RUNNING deployment: ${id} | resource group: ${rg}`);
        aiCoreDeploymentCache  = { deploymentId: id, resourceGroup: rg, baseUrl };
        aiCoreDeploymentExpiry = Date.now() + 10 * 60 * 1000;
        return aiCoreDeploymentCache;
      }
    } catch (err) {
      console.warn(`⚠️ Deployments in '${rg}' failed [${err.response?.status}]: ${err.message?.slice(0,60)}`);
    }
  }

  throw new Error(`No RUNNING deployment found in: ${resourceGroups.join(", ")}`);
}

// Cache: { url, token, expiry }
let calmDestCache = null;

// ─── Step 1: Get Destination Service OAuth token (YOUR subaccount) ────────────
async function getDestinationServiceToken() {
  // Reuse the existing getBTPToken() — it already fetches a token
  // scoped to your subaccount's Destination Service
  return getBTPToken();
}

// ─── Step 2: Resolve the Cloud_ALM destination ───────────────────────────────
async function resolveCALMDestination() {
  if (calmDestCache && Date.now() < calmDestCache.expiry - 300000) {
    return calmDestCache;
  }

  const destToken = await getDestinationServiceToken();

  const res = await axios.get(
    `${destinationCredentials.uri}/destination-configuration/v1/destinations/${CALM_DESTINATION_NAME}`,
    { headers: { Authorization: `Bearer ${destToken}` }, httpsAgent }
  );

  const config     = res.data?.destinationConfiguration || {};
  const authTokens = res.data?.authTokens || [];
  const authToken  = authTokens[0]?.value;
  const tokenType  = authTokens[0]?.type || "Bearer";
  const expiresIn  = parseInt(authTokens[0]?.expiresIn || "3600");

  if (!authToken) {
    throw new Error(
      `Destination '${CALM_DESTINATION_NAME}' resolved but no auth token returned. ` +
      `Check OAuth2ClientCredentials configuration in BTP Destination.`
    );
  }

  // ── CRITICAL: Use the correct Cloud ALM API base URL ─────────────────────
  // From SAP service key: endpoints.Api = "https://eu10.alm.cloud.sap/api"
  // The correct base URL is https://eu10.alm.cloud.sap (without /api)
  // NOT the tenant-specific URL https://hcl-america-solutions-inc-cloudalm.eu10.alm.cloud.sap
  // API paths are then: /api/calm-tasks/v1/tasks etc.
  const destUrl  = config.URL || config.url || "";
  // If destination URL is tenant-specific, swap to the regional API URL
  let baseUrl = destUrl;
  if (destUrl.includes(".eu10.alm.cloud.sap") && !destUrl.startsWith("https://eu10.alm.cloud.sap")) {
    baseUrl = "https://eu10.alm.cloud.sap";
    console.log(`ℹ️  Using regional ALM API URL: ${baseUrl} (was: ${destUrl})`);
  }

  if (!baseUrl) throw new Error(`Destination '${CALM_DESTINATION_NAME}' has no URL configured.`);

  console.log(`✅ Cloud ALM destination resolved: ${CALM_DESTINATION_NAME} → ${baseUrl}`);

  calmDestCache = { baseUrl, authToken, tokenType, expiry: Date.now() + expiresIn * 1000 };
  return calmDestCache;
}

// ─── ALM GET helper ───────────────────────────────────────────────────────────
async function fetchFromALM(path) {
  const { baseUrl, authToken, tokenType } = await resolveCALMDestination();

  // Destination URL: https://hcl-america-solutions-inc-cloudalm.eu10.alm.cloud.sap
  // API paths:       /api/calm/v0/...
  // path already includes /api/calm/v0/... so use as-is
  const res = await axios.get(`${baseUrl}${path}`, {
    headers: {
      Authorization: `${tokenType} ${authToken}`,
      Accept:        "application/json",
    },
    httpsAgent,
  });
  return res.data;
}

// ─── ALM PATCH helper ─────────────────────────────────────────────────────────
async function patchToALM(path, body) {
  const { baseUrl, authToken, tokenType } = await resolveCALMDestination();

  const res = await axios.patch(`${baseUrl}${path}`, body, {
    headers: {
      Authorization:  `${tokenType} ${authToken}`,
      Accept:         "application/json",
      "Content-Type": "application/json",
    },
    httpsAgent,
  });
  return res.data;
}

// ─── Expose base URL for startup log ─────────────────────────────────────────
function getCALMBaseUrl() {
  return calmDestCache?.baseUrl || `via destination: ${CALM_DESTINATION_NAME}`;
}

// ─── Week helper ──────────────────────────────────────────────────────────────
function isThisWeek(dateStr) {
  if (!dateStr) return false;
  const d       = new Date(dateStr);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return d >= weekAgo;
}

// ─── CALM Discovery — finds correct API paths for your tenant ────────────────
app.get("/api/calm/discover", async (req, res) => {
  let resolvedBase = "unknown";
  try { resolvedBase = (await resolveCALMDestination()).baseUrl; } catch (e) { resolvedBase = e.message; }

  const testPaths = [
    // Change & Deployment
    "/api/imp-cdm-srv/v1/features?$top=1",
    "/api/imp-cdm-srv/v0/features?$top=1",
    // Projects
    "/api/imp-pjm-srv/v1/projects?$top=1",
    "/api/imp-pjm-srv/v0/projects?$top=1",
    "/api/calm-projects/v1/projects?$top=1",
    // Tasks (needs projectId — test without)
    "/api/calm-tasks/v1/tasks",
    "/api/imp-tkm-srv/v1/tasks",
    // Health Monitoring
    "/api/ops-alm-evt-srv/v1/events?$top=1",
    "/api/ops-ihm-srv/v1/healthStatus?$top=1",
    "/api/ops-ihm-srv/v1/monitoringData?$top=1",
    "/api/calm-health/v1/events?$top=1",
    // Analytics
    "/api/calm-analytics/v1/providers",
    "/api/imp-cdm-srv/v1/transportRequests?$top=1",
  ];

  const results = {};
  for (const path of testPaths) {
    try {
      const data = await fetchFromALM(path);
      results[path] = { ok: true, keys: Object.keys(data||{}), count: data?.value?.length ?? data?.results?.length ?? 0 };
    } catch (err) {
      results[path] = {
        ok: false,
        status: err.response?.status || "ERR",
        body: JSON.stringify(err.response?.data || {}).slice(0, 200),
      };
    }
  }

  const working = Object.entries(results).filter(([,v]) => v.ok).map(([k]) => k);
  res.json({ resolvedBaseUrl: resolvedBase, summary: working.length > 0 ? `✅ ${working.length} paths working` : "❌ No paths working", working, all: results });
});


// Visit: https://your-app.cfapps.eu10.hana.ondemand.com/api/calm/debug
// Remove this after fixing the issue
app.get("/api/calm/debug", async (req, res) => {
  const result = {
    timestamp: new Date().toISOString(),
    steps: {},
  };

  // Step 1: Check destination credentials loaded
  result.steps["1_destination_credentials"] = {
    loaded: !!destinationCredentials,
    uri:    destinationCredentials?.uri   || "MISSING",
    url:    destinationCredentials?.url   || "MISSING",
  };

  // Step 2: Try get BTP token
  try {
    const token = await getBTPToken();
    result.steps["2_btp_token"] = { ok: true, tokenLength: token?.length };
  } catch (e) {
    result.steps["2_btp_token"] = { ok: false, error: e.message };
    return res.json(result);
  }

  // Step 3: Try resolve CLOUD_ALM_DEST destination
  try {
    const dest = await resolveCALMDestination();
    result.steps["3_calm_destination"] = {
      ok:       true,
      baseUrl:  dest.baseUrl,
      hasToken: !!dest.authToken,
      tokenType:dest.tokenType,
    };
  } catch (e) {
    result.steps["3_calm_destination"] = {
      ok:                false,
      error:             e.message,
      destinationName:   CALM_DESTINATION_NAME,
      fix: "Create destination '" + CALM_DESTINATION_NAME + "' in BTP Cockpit → " +
           "your app subaccount → Connectivity → Destinations. " +
           "Type: HTTP, Auth: OAuth2ClientCredentials, " +
           "URL: your Cloud ALM base URL, " +
           "Token Service URL + Client ID + Secret from ALM subaccount service key.",
    };
    return res.json(result);
  }

  // Step 4: Try actual ALM health API call
  try {
    const data = await fetchFromALM("/api/calm-health/v0/events?$top=1");
    result.steps["4_calm_api_call"] = {
      ok: true, responseKeys: Object.keys(data || {}), recordCount: data?.value?.length ?? 0,
    };
  } catch (e) {
    // Try alternate path
    try {
      const data2 = await fetchFromALM("/api/calm-health/v1/events?$top=1");
      result.steps["4_calm_api_call"] = { ok: true, path: "v1", recordCount: data2?.value?.length ?? 0 };
    } catch (e2) {
      result.steps["4_calm_api_call"] = { ok: false, error: e.message, error_v1: e2.message };
    }
  }

  // Step 5: Try change management
  try {
    const data = await fetchFromALM("/api/calm-requirements/v0/changeRequests?$top=1");
    result.steps["5_change_mgmt_api"] = { ok: true, recordCount: data?.value?.length ?? 0 };
  } catch (e) {
    try {
      const data2 = await fetchFromALM("/api/calm-requirements/v1/changeRequests?$top=1");
      result.steps["5_change_mgmt_api"] = { ok: true, path: "v1", recordCount: data2?.value?.length ?? 0 };
    } catch (e2) {
      result.steps["5_change_mgmt_api"] = { ok: false, error: e.message, error_v1: e2.message };
    }
  }

  // Step 6: Try transport management
  try {
    const data = await fetchFromALM("/api/calm-operations/v0/deploymentOperations?$top=1");
    result.steps["6_transport_mgmt_api"] = { ok: true, recordCount: data?.value?.length ?? 0 };
  } catch (e) {
    try {
      const data2 = await fetchFromALM("/api/calm-operations/v1/deploymentOperations?$top=1");
      result.steps["6_transport_mgmt_api"] = { ok: true, path: "v1", recordCount: data2?.value?.length ?? 0 };
    } catch (e2) {
      result.steps["6_transport_mgmt_api"] = { ok: false, error: e.message, error_v1: e2.message };
    }
  }

  const allOk = Object.values(result.steps).every(s => s.ok !== false);
  result.summary = allOk
    ? "✅ All checks passed — ALM integration should work"
    : "❌ Some checks failed — see steps above for details";

  res.json(result);
});



// ─── Helper: try multiple ALM paths until one works ──────────────────────────
async function tryALMPaths(paths) {
  for (const path of paths) {
    try {
      const data = await fetchFromALM(path);
      console.log(`✅ ALM path OK: ${path}`);
      return data;
    } catch (err) {
      const status = err.response?.status || "ERR";
      console.warn(`⚠️ ALM path failed [${status}]: ${path}`);
      // 400 = bad request (auth/param issue) — log response body for debugging
      if (status === 400) {
        const body = JSON.stringify(err.response?.data || {}).slice(0, 200);
        console.warn(`   400 response body: ${body}`);
      }
    }
  }
  return null;
}

// 5. GET /api/calm/health
app.get("/api/calm/health", async (req, res) => {
  try {
    // calm-tasks/v1/tasks requires ?projectId — fetch projects first, then tasks
    // imp-cdm-srv/v1/features = Change & Deployment Management (Features app)
    // ops-ihm-srv = Health Monitoring (internal service name from UI app ID)
    const [tmRaw, cmRaw, hmRaw] = await Promise.all([
      // Transport/Deployment: Features from Change & Deployment Management
      tryALMPaths([
        "/api/imp-cdm-srv/v1/features?$top=100&$expand=transports",
        "/api/imp-cdm-srv/v1/features?$top=100",
        "/api/imp-cdm-srv/v0/features?$top=100",
      ]),
      // Change Management: Projects (doesn't need projectId)
      tryALMPaths([
        "/api/imp-pjm-srv/v1/projects?$top=100",
        "/api/calm-projects/v1/projects?$top=100",
        "/api/imp-pjm-srv/v0/projects?$top=100",
      ]),
      // Health Monitoring
      tryALMPaths([
        "/api/ops-alm-evt-srv/v1/eventSubscriptions?$top=200",
        "/api/ops-alm-evt-srv/v1/events?$top=200",
        "/api/calm-health/v1/events?$top=200",
        "/api/ops-ihm-srv/v1/healthStatus?$top=200",
        "/api/ops-ihm-srv/v1/monitoringData?$top=200",
      ]),
    ]);

    // ── Transport Management ──────────────────────────────────────
    const tmItems   = tmRaw?.value || tmRaw?.results || [];
    const tmPending = tmItems.filter(i => ["READY_FOR_DEPLOYMENT","IN_QUEUE","PENDING"].includes(i.status)).length;
    const tmFailed  = tmItems.filter(i => ["FAILED","ERROR"].includes(i.status)).length;
    const tmLast    = tmItems.find(i => i.status === "DEPLOYED")?.deployedAt || null;
    const pipelineStatus = tmFailed > 0 ? "BLOCKED" : tmPending > 10 ? "DEGRADED" : "OK";

    // ── Change Management ─────────────────────────────────────────
    const cmItems      = cmRaw?.value || cmRaw?.results || [];
    const cmOpen       = cmItems.filter(i => ["OPEN","IN_PROGRESS"].includes(i.status)).length;
    const cmPending    = cmItems.filter(i => i.status === "PENDING_APPROVAL").length;
    const cmApproved   = cmItems.filter(i => i.status === "APPROVED").length;
    const cmRejected   = cmItems.filter(i => i.status === "REJECTED" && isThisWeek(i.changedAt)).length;
    const cmDeployed   = cmItems.filter(i => i.status === "DEPLOYED").length;
    const cmTotal      = cmItems.length;
    const cmCompliance = cmTotal > 0
      ? Math.round(((cmTotal - cmItems.filter(i => i.status === "REJECTED").length) / cmTotal) * 100)
      : 100;

    // ── Health Monitoring ─────────────────────────────────────────
    const hmAlerts   = hmRaw?.value || hmRaw?.results || [];
    const hmCritical = hmAlerts.filter(a => ["CRITICAL","ERROR"].includes(a.severity)).length;
    const hmWarning  = hmAlerts.filter(a => a.severity === "WARNING").length;
    const hmSystems  = [...new Set(hmAlerts.map(a => a.serviceId || a.systemId))].length;
    const prodAlerts = hmAlerts.filter(a =>
      (a.systemId || "").toUpperCase().includes("PROD") &&
      ["CRITICAL","ERROR"].includes(a.severity)
    );
    const prodAvail  = prodAlerts.length > 0
      ? Math.max(85, 100 - prodAlerts.length * 3).toFixed(1)
      : "99.9";

    console.log(`✅ ALM health: TM=${tmItems.length} CM=${cmItems.length} HM=${hmAlerts.length} | pipeline=${pipelineStatus}`);

    res.json({
      criticalAlerts: hmCritical,
      warningAlerts:  hmWarning,
      transportManagement: {
        pendingCount:   tmPending,
        failedCount:    tmFailed,
        pipelineStatus,
        lastDeployment: tmLast,
      },
      changeManagement: {
        openCount:       cmOpen,
        pendingApproval: cmPending,
        approvedCount:   cmApproved,
        rejectedCount:   cmRejected,
        deployedCount:   cmDeployed,
        complianceRate:  cmCompliance,
      },
      healthMonitoring: {
        criticalCount:    hmCritical,
        warningCount:     hmWarning,
        prodAvailability: prodAvail,
        systemsMonitored: hmSystems,
      },
      // Full alert list for banner + table
      alerts: hmAlerts.slice(0, 50).map(a => ({
        id:        a.id,
        severity:  a.severity,
        systemId:  a.serviceId || a.systemId || "SYSTEM",
        message:   a.description || a.name    || "Alert",
        type:      a.alertType  || a.type,
        createdAt: a.createdAt,
      })),
    });

  } catch (err) {
    console.error("❌ /api/calm/health error:", err.message);
    // Return empty structure — frontend handles gracefully
    res.json({
      criticalAlerts: 0,
      warningAlerts:  0,
      transportManagement:  { pendingCount:0, failedCount:0, pipelineStatus:"UNKNOWN", lastDeployment:null },
      changeManagement:     { openCount:0, pendingApproval:0, approvedCount:0, rejectedCount:0, deployedCount:0, complianceRate:100 },
      healthMonitoring:     { criticalCount:0, warningCount:0, prodAvailability:"99.9", systemsMonitored:0 },
      alerts: [],
      error: err.message,
    });
  }
});

// 6. GET /api/calm/changes/all
app.get("/api/calm/changes/all", async (req, res) => {
  try {
    const data = await tryALMPaths([
      "/api/imp-cdm-srv/v1/features?$top=200",
      "/api/imp-cdm-srv/v0/features?$top=200",
      "/api/imp-pjm-srv/v1/projects?$top=200",
      "/api/calm-projects/v1/projects?$top=200",
    ]);
    if (!data) throw new Error("All paths 404. Open /api/calm/discover for diagnosis.");
    const items = (data?.value || data?.results || []).map(cr => ({
      id:          cr.id              || "",
      title:       cr.title           || cr.name       || cr.featureName || "",
      status:      cr.status          || cr.featureStatus || "OPEN",
      assigneeId:  cr.assigneeId      || cr.responsible  || cr.owner || "",
      priority:    cr.priority        || "",
      description: cr.description     || "",
      externalId:  cr.externalId      || "",
      dueDate:     cr.dueDate         || cr.plannedEndDate || null,
      createdAt:   cr.createdAt       || cr.createDate,
      changedAt:   cr.changedAt       || cr.lastChangedDate,
    }));
    console.log(`✅ Fetched ${items.length} features/projects`);
    res.json({ d: { results: items } });
  } catch (err) {
    console.error("❌ /api/calm/changes/all:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 7. GET /api/calm/changes/:trkorr — single CR linked to a transport number
app.get("/api/calm/changes/:trkorr", async (req, res) => {
  const { trkorr } = req.params;
  if (trkorr === "all") return res.json({ status: "none", id: null });

  try {
    const data  = await fetchFromALM(
      `/api/calm-requirements/v0/changeRequests` +
      `?$filter=externalId eq '${trkorr}' or contains(title,'${trkorr}')` +
      `&$top=1&$orderby=createdAt desc`
    );
    const items = data?.value || [];

    if (!items.length) {
      console.log(`ℹ️  No ALM CR found for ${trkorr}`);
      return res.json({ status: "none", id: null });
    }

    const cr = items[0];
    console.log(`✅ ALM CR found for ${trkorr}: ${cr.id} (${cr.status})`);
    res.json({
      id:          cr.id,
      status:      cr.status,
      title:       cr.title       || cr.name,
      description: cr.description || "",
      approver:    cr.assigneeId  || cr.approver || "",
      priority:    cr.priority    || "",
      dueDate:     cr.dueDate     || cr.plannedEndDate || null,
      createdAt:   cr.createdAt,
      updatedAt:   cr.changedAt   || cr.updatedAt,
      externalId:  cr.externalId  || trkorr,
    });

  } catch (err) {
    console.error(`❌ /api/calm/changes/${trkorr} error:`, err.message);
    res.json({ status: "none", id: null, error: err.message });
  }
});

// 8. PATCH /api/calm/changes/:changeId/deploy — sync CR → DEPLOYED after import
app.patch("/api/calm/changes/:changeId/deploy", async (req, res) => {
  const { changeId } = req.params;
  try {
    await patchToALM(
      `/api/calm-requirements/v0/changeRequests/${changeId}`,
      {
        status:     "DEPLOYED",
        deployedAt: new Date().toISOString(),
        comment:    `Deployed via TransTrack Pro at ${new Date().toISOString()}`,
      }
    );
    console.log(`✅ ALM CR ${changeId} updated to DEPLOYED`);
    res.json({ success: true, message: `CR ${changeId} updated to DEPLOYED in Cloud ALM.` });
  } catch (err) {
    console.error(`❌ ALM sync error for ${changeId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// 9. GET /api/calm/tm/deployments
app.get("/api/calm/tm/deployments", async (req, res) => {
  try {
    const data = await tryALMPaths([
      "/api/imp-cdm-srv/v1/features?$top=100",
      "/api/imp-cdm-srv/v0/features?$top=100",
      "/api/calm-cdm/v1/features?$top=100",
      "/api/imp-tkm-srv/v1/tasks?$top=100",
    ]);
    if (!data) throw new Error("All deployment paths returned 404. Check /api/calm/discover.");
    const items = (data?.value || data?.results || []).map(d => ({
      id:         d.id,
      title:      d.title      || d.name        || d.featureName || "",
      status:     d.status     || d.featureStatus || "",
      target:     d.targetSystemId || d.target  || "",
      createdAt:  d.createdAt  || d.createDate,
      deployedAt: d.deployedAt || d.finishedAt,
      transports: (d.transportRequests || d.transports || [])
                  .map(c => c.transportRequest || c.externalId || c.id),
    }));
    console.log(`✅ Fetched ${items.length} features/deployments`);
    res.json({ d: { results: items } });
  } catch (err) {
    console.error("❌ /api/calm/tm/deployments error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  SAP AI CORE INTEGRATION
//
//  Required env vars / BTP service binding (aicore service):
//    AI_CORE_TOKEN_URL     — https://your-subdomain.authentication.eu10.hana.ondemand.com
//    AI_CORE_CLIENT_ID     — client id from AI Core service key
//    AI_CORE_CLIENT_SECRET — client secret from AI Core service key
//    AI_CORE_BASE_URL      — https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com
//    AI_CORE_RESOURCE_GROUP— default  (or your resource group name)
//    AI_CORE_DEPLOYMENT_ID — your deployed model's deployment ID (from AI Launchpad)
//
//  On BTP these come from VCAP_SERVICES under service "aicore".
// ═════════════════════════════════════════════════════════════════════════════

let aiCoreToken       = null;
let aiCoreTokenExpiry = 0;

// ─── AI Core token (cached, auto-renews) ─────────────────────────────────────
async function getAICoreToken() {
  if (aiCoreToken && Date.now() < aiCoreTokenExpiry - 30000) return aiCoreToken;

  let clientId, clientSecret, tokenUrl;

  // Try VCAP_SERVICES first (BTP aicore service binding)
  try {
    const vcap   = JSON.parse(process.env.VCAP_SERVICES || "{}");
    const aicore = vcap["aicore"]?.[0]?.credentials
                || vcap["ai-core"]?.[0]?.credentials
                || vcap["sap-aicore"]?.[0]?.credentials;
    if (aicore) {
      clientId     = aicore.clientid     || aicore.client_id;
      clientSecret = aicore.clientsecret || aicore.client_secret;
      tokenUrl     = aicore.url          || aicore.uaa?.url;
      console.log(`ℹ️  AI Core credentials from VCAP_SERVICES`);
    }
  } catch {}

  // Fallback to env vars
  clientId     = clientId     || process.env.AI_CORE_CLIENT_ID;
  clientSecret = clientSecret || process.env.AI_CORE_CLIENT_SECRET;
  tokenUrl     = tokenUrl     || process.env.AI_CORE_TOKEN_URL;

  if (!clientId || !clientSecret || !tokenUrl) {
    throw new Error(
      "SAP AI Core credentials not configured. " +
      `clientId=${!!clientId} clientSecret=${!!clientSecret} tokenUrl=${!!tokenUrl}. ` +
      "Set AI_CORE_CLIENT_ID, AI_CORE_CLIENT_SECRET, AI_CORE_TOKEN_URL."
    );
  }

  // Token URL may or may not include /oauth/token
  const fullTokenUrl = tokenUrl.endsWith("/oauth/token")
    ? tokenUrl
    : `${tokenUrl}/oauth/token`;

  const res = await axios.post(
    fullTokenUrl,
    new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     clientId,
      client_secret: clientSecret,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent }
  );

  aiCoreToken       = res.data.access_token;
  aiCoreTokenExpiry = Date.now() + (res.data.expires_in || 3600) * 1000;
  console.log("✅ SAP AI Core token fetched");
  return aiCoreToken;
}

function getAICoreBaseUrl() {
  try {
    const vcap   = JSON.parse(process.env.VCAP_SERVICES || "{}");
    const aicore = vcap["aicore"]?.[0]?.credentials
                || vcap["ai-core"]?.[0]?.credentials
                || vcap["sap-aicore"]?.[0]?.credentials;
    if (aicore?.serviceurls?.AI_API_URL) return aicore.serviceurls.AI_API_URL;
    if (aicore?.serviceurls?.ai_api_url) return aicore.serviceurls.ai_api_url;
  } catch {}
  return process.env.AI_CORE_BASE_URL || "";
}

// ─── AI Core inference helper ─────────────────────────────────────────────────
async function callAICore(messages, systemPrompt, maxTokens = 800) {
  // Dynamically discover the RUNNING deployment
  const { deploymentId, resourceGroup, baseUrl } = await discoverAICoreDeployment();

  const token = await getAICoreToken();

  const endpoints = [
    `${baseUrl}/v2/lm/deployments/${deploymentId}/chat/completions?api-version=2024-12-01`,
    `${baseUrl}/v2/lm/deployments/${deploymentId}/chat/completions`,
    `${baseUrl}/v2/inference/deployments/${deploymentId}/chat/completions?api-version=2024-12-01`,
    `${baseUrl}/v2/inference/deployments/${deploymentId}/chat/completions`,
  ];

  const payload = {
    model:       AI_CORE_MODEL_NAME,
    max_tokens:  maxTokens,
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages,
    ],
  };

  for (const endpoint of endpoints) {
    try {
      const res = await axios.post(endpoint, payload, {
        headers: {
          Authorization:       `Bearer ${token}`,
          "AI-Resource-Group": resourceGroup,
          "Content-Type":      "application/json",
        },
        httpsAgent, timeout: 30000,
      });
      console.log(`✅ AI Core inference: ${deploymentId} (${resourceGroup})`);
      return res.data?.choices?.[0]?.message?.content || "";
    } catch (err) {
      const status = err.response?.status || "ERR";
      const body   = JSON.stringify(err.response?.data || {}).slice(0, 200);
      console.warn(`⚠️ AI Core [${status}] ${endpoint} — ${body}`);
      if (endpoint === endpoints[endpoints.length - 1]) throw err;
    }
  }
}

// ─── Fallback: local scoring when AI Core unavailable ────────────────────────
function localRiskScore(input) {
  const { criticalAlerts=0, warningAlerts=0, failedDeployments=0,
          pendingDeployments=0, pipelineStatus="OK", prodAvailability=99.9,
          pendingApprovals=0, rejectedCRs=0, complianceRate=100 } = input;

  const importRisk = Math.min(98, Math.max(2,
    criticalAlerts * 20 +
    warningAlerts  *  7 +
    failedDeployments * 12 +
    (pipelineStatus === "BLOCKED" ? 25 : pipelineStatus === "DEGRADED" ? 12 : 0) +
    ((100 - prodAvailability) * 2.5) +
    pendingApprovals * 3 +
    rejectedCRs * 8
  ));

  const healthScore = Math.round(Math.max(0, Math.min(100,
    100 -
    criticalAlerts    * 15 -
    warningAlerts     *  5 -
    failedDeployments *  8 -
    (pendingDeployments > 10 ? 8 : 0) -
    ((100 - complianceRate) * 0.5)
  )));

  const approvalRate = Math.min(99, Math.max(50, complianceRate));

  const factors = [];
  if (criticalAlerts > 0)      factors.push({ factor: "Critical health alerts",     impact: "HIGH",   value: criticalAlerts });
  if (warningAlerts  > 0)      factors.push({ factor: "Warning alerts active",       impact: warningAlerts > 3 ? "HIGH" : "MEDIUM", value: warningAlerts });
  if (failedDeployments > 0)   factors.push({ factor: "Failed deployments",          impact: "HIGH",   value: failedDeployments });
  if (pendingDeployments > 5)  factors.push({ factor: "Large deployment backlog",    impact: "MEDIUM", value: pendingDeployments });
  if (rejectedCRs > 0)         factors.push({ factor: "Rejected change requests",    impact: "MEDIUM", value: rejectedCRs });
  if (pendingApprovals > 3)    factors.push({ factor: "CRs awaiting approval",       impact: "LOW",    value: pendingApprovals });

  const level = importRisk >= 65 ? "HIGH" : importRisk >= 35 ? "MEDIUM" : "LOW";

  const recommendation =
    level === "HIGH"
      ? `Do not proceed with imports. ${criticalAlerts} critical alert(s) active on PROD. ` +
        `Resolve health issues in SM21/SLG1 before importing any transports.`
      : level === "MEDIUM"
      ? `Proceed with caution. Run import simulation in STMS and verify all change requests ` +
        `are approved. Monitor SM21 closely post-import for at least 2 hours.`
      : `System is stable. All indicators are within normal range. ` +
        `Safe to proceed with planned imports. Continue standard 24h post-import monitoring.`;

  return {
    healthScore,
    importRisk,
    importRiskLevel: level,
    approvalRate,
    factors,
    recommendation,
    trend:          healthScore >= 80 ? "STABLE" : healthScore >= 60 ? "DEGRADING" : "CRITICAL",
    modelVersion:   "local-fallback-v1",
    aiPowered:      false,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  10. POST /api/ai/predict — main AI Core risk prediction endpoint
//      Called by cloud_alm.html on page load and every 45s refresh
// ═════════════════════════════════════════════════════════════════════════════
app.post("/api/ai/predict", async (req, res) => {
  const {
    criticalAlerts    = 0,
    warningAlerts     = 0,
    failedDeployments = 0,
    pendingDeployments= 0,
    pipelineStatus    = "OK",
    prodAvailability  = 99.9,
    pendingApprovals  = 0,
    rejectedCRs       = 0,
    complianceRate    = 100,
    recentAlerts      = [],
    recentCRs         = [],
  } = req.body;

  // Always compute local score first (fast, used as fallback)
  const local = localRiskScore({
    criticalAlerts, warningAlerts, failedDeployments, pendingDeployments,
    pipelineStatus, prodAvailability, pendingApprovals, rejectedCRs, complianceRate,
  });

  // Try SAP AI Core for enriched natural-language analysis
  try {
    const systemPrompt = `You are SAP Core AI, an expert system for SAP transport risk assessment and system health analysis.
Analyse the provided SAP system metrics and return a JSON response ONLY — no markdown, no explanation outside the JSON.

Response schema:
{
  "healthScore": <integer 0-100>,
  "importRisk": <integer 0-100>,
  "importRiskLevel": "LOW" | "MEDIUM" | "HIGH",
  "approvalRate": <integer 0-100>,
  "trend": "IMPROVING" | "STABLE" | "DEGRADING" | "CRITICAL",
  "recommendation": "<2-3 sentence actionable recommendation>",
  "factors": [
    { "factor": "<factor name>", "impact": "HIGH" | "MEDIUM" | "LOW", "value": <number> }
  ],
  "insight": "<1 sentence executive summary>",
  "modelVersion": "sap-core-ai-v2.4",
  "aiPowered": true
}`;

    const userMessage = `Current SAP system metrics:
- Critical health alerts: ${criticalAlerts}
- Warning alerts: ${warningAlerts}
- Failed deployments: ${failedDeployments}
- Pending deployments in queue: ${pendingDeployments}
- Pipeline status: ${pipelineStatus}
- PROD system availability: ${prodAvailability}%
- Change requests pending approval: ${pendingApprovals}
- Change requests rejected this week: ${rejectedCRs}
- CR compliance rate: ${complianceRate}%
- Recent alert types: ${recentAlerts.slice(0,5).map(a => `${a.severity}:${a.systemId}`).join(", ") || "none"}
- Recent CR statuses: ${recentCRs.slice(0,5).map(c => c.status).join(", ") || "none"}

Provide risk assessment and import recommendation for the SAP operations team.`;

    const raw    = await callAICore([{ role: "user", content: userMessage }], systemPrompt, 600);
    const clean  = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    console.log(`✅ SAP AI Core prediction: healthScore=${parsed.healthScore}, importRisk=${parsed.importRisk}%`);
    return res.json({ ...parsed, aiPowered: true, modelVersion: "sap-core-ai-v2.4" });

  } catch (aiErr) {
    // AI Core unavailable — return local score with flag
    console.warn(`⚠️  SAP AI Core unavailable (${aiErr.message}) — using local fallback`);
    return res.json({ ...local, aiPowered: false, modelVersion: "local-fallback-v1" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  11. POST /api/ai/predict/transport — per-transport AI risk score
//      Called when a transport is clicked in TransTrack Pro
// ═════════════════════════════════════════════════════════════════════════════
app.post("/api/ai/predict/transport", async (req, res) => {
  const {
    trkorr        = "",
    owner         = "",
    status        = "",
    objectCount   = 0,
    objectTypes   = [],
    failedObjects = 0,
    logErrors     = 0,
    crStatus      = "NONE",
    prodHealthOk  = true,
  } = req.body;

  // Local fallback score
  let score = 20;
  if (status === "Modifiable")        score += 20;
  if (status === "Failed")            score += 35;
  score += Math.min(failedObjects * 12, 36);
  score += Math.min(logErrors * 8, 24);
  if (objectCount > 10)               score += 10;
  if (objectTypes.includes("PROG") || objectTypes.includes("FUGR")) score += 8;
  if (objectTypes.includes("AUTH"))   score += 10;
  if (crStatus === "REJECTED")        score += 15;
  if (!crStatus || crStatus === "NONE") score += 10;
  if (!prodHealthOk)                  score += 12;
  const localScore = Math.min(98, Math.max(5, score));
  const localLevel = localScore >= 65 ? "HIGH" : localScore >= 40 ? "MEDIUM" : "LOW";

  try {
    const systemPrompt = `You are SAP Core AI specialised in transport risk assessment.
Return ONLY a JSON object — no markdown, no text outside JSON.
Schema: { "riskScore": <0-100>, "riskLevel": "LOW"|"MEDIUM"|"HIGH", "recommendation": "<2 sentences>", "aiPowered": true }`;

    const userMessage = `Assess transport risk for:
Transport: ${trkorr}
Owner: ${owner}
Status: ${status}
Objects: ${objectCount} (types: ${objectTypes.join(", ")||"unknown"})
Failed objects: ${failedObjects}
Log errors: ${logErrors}
ALM CR status: ${crStatus}
PROD health OK: ${prodHealthOk}`;

    const raw    = await callAICore([{ role: "user", content: userMessage }], systemPrompt, 200);
    const clean  = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    console.log(`✅ AI Core transport prediction: ${trkorr} → ${parsed.riskScore}%`);
    return res.json({ ...parsed, aiPowered: true });

  } catch (aiErr) {
    console.warn(`⚠️  AI Core unavailable for transport prediction — using local`);
    return res.json({
      riskScore:      localScore,
      riskLevel:      localLevel,
      recommendation: localLevel === "HIGH"
        ? "High risk detected. Resolve object errors and ensure ALM CR is approved before importing."
        : localLevel === "MEDIUM"
        ? "Medium risk. Review warnings and run STMS import simulation before proceeding."
        : "Low risk. Transport appears safe to import. Standard monitoring applies.",
      aiPowered:      false,
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  12. GET /api/ai/status — check if AI Core is configured and reachable
// ═════════════════════════════════════════════════════════════════════════════
app.get("/api/ai/status", async (req, res) => {
  const baseUrl    = getAICoreBaseUrl();
  const configured = !!(baseUrl && process.env.AI_CORE_CLIENT_ID);

  if (!configured) {
    return res.json({
      configured: false, reachable: false, mode: "local-fallback",
      message: "Set AI_CORE_BASE_URL, AI_CORE_CLIENT_ID, AI_CORE_CLIENT_SECRET, AI_CORE_TOKEN_URL.",
    });
  }

  try {
    const deployment = await discoverAICoreDeployment();
    res.json({
      configured:    true,
      reachable:     true,
      mode:          "sap-core-ai",
      baseUrl,
      deploymentId:  deployment.deploymentId,
      resourceGroup: deployment.resourceGroup,
      model:         AI_CORE_MODEL_NAME,
      message:       `RUNNING deployment found: ${deployment.deploymentId} in ${deployment.resourceGroup}`,
    });
  } catch (err) {
    res.json({
      configured: true, reachable: false, mode: "local-fallback",
      message: `AI Core reachable but no RUNNING deployment: ${err.message}`,
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  SERVE FRONTEND
// ═════════════════════════════════════════════════════════════════════════════
app.use(express.static(path.join(__dirname, "../frontend")));
app.get(/^\/(?!api|debug).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 SAP Destination:       ${DESTINATION_NAME}`);
  console.log(`☁️  Cloud ALM Destination: ${CALM_DESTINATION_NAME}`);
  console.log(`🧠 AI Core URL:           ${getAICoreBaseUrl() || "not configured"}`);
  console.log(`🧠 AI Core Model:         ${AI_CORE_MODEL_NAME}`);
  console.log(`🧠 AI Core Deployment:    dynamically discovered at runtime`);
});
