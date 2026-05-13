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
//  CLOUD ALM TOKEN + HELPERS
// ═════════════════════════════════════════════════════════════════════════════
let calmToken       = null;
let calmTokenExpiry = 0;

async function getCloudALMToken() {
  // Return cached token if still valid (with 30s buffer)
  if (calmToken && Date.now() < calmTokenExpiry - 30000) return calmToken;

  // Try VCAP_SERVICES first (BTP service binding), then env vars
  let clientId, clientSecret, tokenUrl;
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
    const calm =
      vcap["cloud-alm"]?.[0]?.credentials ||
      vcap["cloudalm"]?.[0]?.credentials  ||
      vcap["alm"]?.[0]?.credentials;
    if (calm) {
      clientId     = calm.clientid     || calm.client_id;
      clientSecret = calm.clientsecret || calm.client_secret;
      tokenUrl     = calm.url          || calm.token_service_url;
    }
  } catch {}

  // Fallback to env vars
  clientId     = clientId     || process.env.CALM_CLIENT_ID;
  clientSecret = clientSecret || process.env.CALM_CLIENT_SECRET;
  tokenUrl     = tokenUrl     || process.env.CALM_TOKEN_URL;

  if (!clientId || !clientSecret || !tokenUrl) {
    throw new Error(
      "Cloud ALM credentials not configured. " +
      "Set CALM_TOKEN_URL, CALM_CLIENT_ID, CALM_CLIENT_SECRET in environment."
    );
  }

  const res = await axios.post(
    `${tokenUrl}/oauth/token`,
    new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     clientId,
      client_secret: clientSecret,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent }
  );

  calmToken       = res.data.access_token;
  calmTokenExpiry = Date.now() + (res.data.expires_in || 3600) * 1000;
  console.log("✅ Cloud ALM token fetched");
  return calmToken;
}

function getCALMBaseUrl() {
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
    const calm =
      vcap["cloud-alm"]?.[0]?.credentials ||
      vcap["cloudalm"]?.[0]?.credentials;
    if (calm?.endpoints?.["calm-service"]) return calm.endpoints["calm-service"];
    if (calm?.url) return calm.url.replace(/\/oauth\/token.*/, "");
  } catch {}
  return process.env.CALM_BASE_URL || "";
}

async function fetchFromALM(path) {
  const token   = await getCloudALMToken();
  const baseUrl = getCALMBaseUrl();
  if (!baseUrl) throw new Error("CALM_BASE_URL not configured.");

  const res = await axios.get(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    httpsAgent,
  });
  return res.data;
}

async function patchToALM(path, body) {
  const token   = await getCloudALMToken();
  const baseUrl = getCALMBaseUrl();
  if (!baseUrl) throw new Error("CALM_BASE_URL not configured.");

  const res = await axios.patch(`${baseUrl}${path}`, body, {
    headers: {
      Authorization:  `Bearer ${token}`,
      Accept:         "application/json",
      "Content-Type": "application/json",
    },
    httpsAgent,
  });
  return res.data;
}

// ─── Week helper ──────────────────────────────────────────────────────────────
function isThisWeek(dateStr) {
  if (!dateStr) return false;
  const d       = new Date(dateStr);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return d >= weekAgo;
}

// ═════════════════════════════════════════════════════════════════════════════
//  CLOUD ALM ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// 5. GET /api/calm/health
//    Combined TM + CM + HM health data in one call
app.get("/api/calm/health", async (req, res) => {
  try {
    const [tmData, cmData, hmData] = await Promise.allSettled([
      fetchFromALM("/api/calm/v0/transportManagement/deploymentItems?$top=100&$orderby=createdAt desc"),
      fetchFromALM("/api/calm/v0/changeManagement/changeRequests?$top=100&$orderby=createdAt desc"),
      fetchFromALM("/api/calm/v0/healthMonitoring/alerts?$filter=status eq 'OPEN'&$top=200"),
    ]);

    // ── Transport Management ──────────────────────────────────────
    const tmItems   = tmData.status === "fulfilled" ? (tmData.value?.value || []) : [];
    const tmPending = tmItems.filter(i => ["READY_FOR_DEPLOYMENT","IN_QUEUE"].includes(i.status)).length;
    const tmFailed  = tmItems.filter(i => ["FAILED","ERROR"].includes(i.status)).length;
    const tmLast    = tmItems.find(i => i.status === "DEPLOYED")?.deployedAt || null;
    const pipelineStatus = tmFailed > 0 ? "BLOCKED" : tmPending > 10 ? "DEGRADED" : "OK";

    // ── Change Management ─────────────────────────────────────────
    const cmItems      = cmData.status === "fulfilled" ? (cmData.value?.value || []) : [];
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
    const hmAlerts   = hmData.status === "fulfilled" ? (hmData.value?.value || []) : [];
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

    console.log(`✅ ALM health: ${hmCritical} critical, ${hmWarning} warnings, pipeline: ${pipelineStatus}`);

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

// 6. GET /api/calm/changes/all — all change requests (for CR table in Cloud ALM dashboard)
app.get("/api/calm/changes/all", async (req, res) => {
  try {
    const data  = await fetchFromALM(
      "/api/calm/v0/changeManagement/changeRequests?$top=200&$orderby=createdAt desc"
    );
    const items = (data?.value || []).map(cr => ({
      id:          cr.id,
      title:       cr.title       || cr.name        || "",
      status:      cr.status                         || "OPEN",
      assigneeId:  cr.assigneeId  || cr.approver     || "",
      priority:    cr.priority                       || "",
      description: cr.description                    || "",
      externalId:  cr.externalId                     || "",
      dueDate:     cr.dueDate     || cr.plannedEndDate|| null,
      createdAt:   cr.createdAt,
      changedAt:   cr.changedAt   || cr.updatedAt,
    }));
    console.log(`✅ Fetched ${items.length} change requests`);
    res.json({ d: { results: items } });
  } catch (err) {
    console.error("❌ /api/calm/changes/all error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 7. GET /api/calm/changes/:trkorr — single CR linked to a transport number
app.get("/api/calm/changes/:trkorr", async (req, res) => {
  const { trkorr } = req.params;

  // Skip if called with "all" — handled by route above
  if (trkorr === "all") return res.json({ status: "none", id: null });

  try {
    const data  = await fetchFromALM(
      `/api/calm/v0/changeManagement/changeRequests` +
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
    // Return none — don't break the agent when CR is missing
    res.json({ status: "none", id: null, error: err.message });
  }
});

// 8. PATCH /api/calm/changes/:changeId/deploy — sync CR → DEPLOYED after import
app.patch("/api/calm/changes/:changeId/deploy", async (req, res) => {
  const { changeId } = req.params;
  try {
    await patchToALM(
      `/api/calm/v0/changeManagement/changeRequests/${changeId}`,
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

// 9. GET /api/calm/tm/deployments — deployment items from ALM TM
app.get("/api/calm/tm/deployments", async (req, res) => {
  try {
    const data  = await fetchFromALM(
      "/api/calm/v0/transportManagement/deploymentItems" +
      "?$top=100&$orderby=createdAt desc&$expand=changeItems"
    );
    const items = (data?.value || []).map(d => ({
      id:         d.id,
      title:      d.title      || d.name,
      status:     d.status,
      target:     d.targetSystemId || d.target,
      createdAt:  d.createdAt,
      deployedAt: d.deployedAt,
      transports: (d.changeItems || []).map(c => c.externalId || c.id),
    }));
    console.log(`✅ Fetched ${items.length} deployment items`);
    res.json({ d: { results: items } });
  } catch (err) {
    console.error("❌ /api/calm/tm/deployments error:", err.message);
    res.status(500).json({ error: err.message });
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
  console.log(`📡 SAP Destination:  ${DESTINATION_NAME}`);
  console.log(`☁️  Cloud ALM URL:   ${getCALMBaseUrl() || "not configured"}`);
});

