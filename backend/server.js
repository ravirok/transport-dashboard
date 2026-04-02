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
let aiCoreCredentials       = null;   // ← AI Core service binding

// ─── Load BTP Services ────────────────────────────────────────────────────────

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

// ─── Load AI Core credentials (3 sources, tried in order) ────────────────────
//
//  Source 1 — VCAP_SERVICES service binding (Cloud Foundry, when app is bound)
//             xsenv returns the credentials block directly, so serviceurls,
//             clientid, clientsecret, url are all top-level fields.
//
//  Source 2 — AICORE_SERVICE_KEY env var (SAP's official local-dev approach)
//             Paste your entire service key JSON as a single env var.
//             e.g. AICORE_SERVICE_KEY='{"clientid":"...","clientsecret":"...",
//                                       "url":"...","serviceurls":{"AI_API_URL":"..."}}'
//
//  Source 3 — Individual env vars (AICORE_BASE_URL etc.) as a last resort.

function loadAiCoreCredentials() {
  // ── Source 1: VCAP_SERVICES binding ──────────────────────────────────────
  try {
    // Try by tag first ("aicore" is the standard CF tag)
    const svc = xsenv.getServices({ aicore: { tag: "aicore" } });
    if (svc?.aicore?.serviceurls?.AI_API_URL) {
      console.log("✅ AI Core loaded from VCAP_SERVICES (tag: aicore)");
      return svc.aicore;
    }
  } catch { /* not found by tag */ }

  try {
    // Fallback: try by service label "aicore"
    const svc = xsenv.getServices({ aicore: { label: "aicore" } });
    if (svc?.aicore?.serviceurls?.AI_API_URL) {
      console.log("✅ AI Core loaded from VCAP_SERVICES (label: aicore)");
      return svc.aicore;
    }
  } catch { /* not found by label */ }

  // Manual VCAP parse — sometimes xsenv misses it; scan all services ourselves
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
    // AI Core can appear under "aicore" or "sap-aicore" or similar
    const allEntries = Object.values(vcap).flat();
    const entry = allEntries.find(
      (s) =>
        s?.credentials?.serviceurls?.AI_API_URL ||
        s?.label?.includes("aicore") ||
        s?.tags?.includes("aicore")
    );
    if (entry?.credentials?.serviceurls?.AI_API_URL) {
      console.log(`✅ AI Core loaded from VCAP_SERVICES (manual scan, label: ${entry.label})`);
      return entry.credentials;
    }
  } catch { /* VCAP parse failed */ }

  // ── Source 2: AICORE_SERVICE_KEY env var ──────────────────────────────────
  if (process.env.AICORE_SERVICE_KEY) {
    try {
      const key = JSON.parse(process.env.AICORE_SERVICE_KEY);
      if (key?.serviceurls?.AI_API_URL) {
        console.log("✅ AI Core loaded from AICORE_SERVICE_KEY env var");
        return key;
      }
      console.warn("⚠️  AICORE_SERVICE_KEY parsed but missing serviceurls.AI_API_URL");
    } catch {
      console.error("❌ AICORE_SERVICE_KEY is set but is not valid JSON");
    }
  }

  // ── Source 3: Individual env vars ─────────────────────────────────────────
  if (process.env.AICORE_BASE_URL) {
    console.log("✅ AI Core loaded from individual AICORE_* env vars");
    return {
      serviceurls:  { AI_API_URL: process.env.AICORE_BASE_URL },
      clientid:     process.env.AICORE_CLIENT_ID     || "",
      clientsecret: process.env.AICORE_CLIENT_SECRET || "",
      url:          process.env.AICORE_TOKEN_URL      || "",
    };
  }

  console.warn("⚠️  AI Core credentials NOT loaded — set AICORE_SERVICE_KEY or bind the aicore service");
  return null;
}

aiCoreCredentials = loadAiCoreCredentials();

// ─── Fallbacks from .env (existing services) ──────────────────────────────────

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
console.log("📡 AI Core URL        :", aiCoreCredentials?.serviceurls?.AI_API_URL || "NOT LOADED");

// ─── Token cache helpers ──────────────────────────────────────────────────────

// Generic in-memory token cache (one slot per label)
const _tokenCache = {};

async function getCachedToken(label, fetchFn) {
  const now = Date.now();
  const cached = _tokenCache[label];
  if (cached && cached.expiresAt > now + 30_000) return cached.token;
  const { token, expiresIn } = await fetchFn();
  _tokenCache[label] = { token, expiresAt: now + expiresIn * 1000 };
  return token;
}

async function getConnectivityToken() {
  if (!connectivityCredentials) throw new Error("Connectivity credentials not loaded.");
  return getCachedToken("connectivity", async () => {
    const { clientid, clientsecret, token_service_url } = connectivityCredentials;
    const res = await axios.post(
      `${token_service_url}/oauth/token`,
      new URLSearchParams({ grant_type: "client_credentials", client_id: clientid, client_secret: clientsecret }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent }
    );
    console.log("✅ Connectivity token fetched");
    return { token: res.data.access_token, expiresIn: res.data.expires_in ?? 3600 };
  });
}

async function getBTPToken() {
  if (!destinationCredentials) throw new Error("Destination credentials not loaded.");
  return getCachedToken("destination", async () => {
    const { clientid, clientsecret, url } = destinationCredentials;
    const res = await axios.post(
      `${url}/oauth/token`,
      new URLSearchParams({ grant_type: "client_credentials", client_id: clientid, client_secret: clientsecret }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent }
    );
    console.log("✅ Destination OAuth token fetched");
    return { token: res.data.access_token, expiresIn: res.data.expires_in ?? 3600 };
  });
}

// AI Core uses its own XSUAA client (different clientid/secret from destination service)
async function getAiCoreToken() {
  if (!aiCoreCredentials) throw new Error("AI Core credentials not loaded.");
  return getCachedToken("aicore", async () => {
    const tokenUrl    = aiCoreCredentials.url + "/oauth/token";
    const clientid    = aiCoreCredentials.clientid;
    const clientsecret= aiCoreCredentials.clientsecret;
    const res = await axios.post(
      tokenUrl,
      new URLSearchParams({ grant_type: "client_credentials", client_id: clientid, client_secret: clientsecret }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent }
    );
    console.log("✅ AI Core token fetched");
    return { token: res.data.access_token, expiresIn: res.data.expires_in ?? 3600 };
  });
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
      aiCoreLoaded:             !!aiCoreCredentials,
      aiCoreUrl:                aiCoreCredentials?.serviceurls?.AI_API_URL || "NOT LOADED",
      proxyHost:                connectivityCredentials?.onpremise_proxy_host      || "NOT LOADED",
      proxyPort:                connectivityCredentials?.onpremise_proxy_http_port || "NOT LOADED",
    },
  });
});

// ─── API Routes — SAP Transports ──────────────────────────────────────────────

// 1. GET /api/transports
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
app.get("/api/transports/:trkorr/objects", async (req, res) => {
  try {
    const { trkorr } = req.params;
    console.log(`🔄 Fetching all objects, will filter by TRANSPORT = ${trkorr}`);

    const data = await fetchFromSAP(
      "/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/Objects?$format=json"
    );

    const all = Array.isArray(data) ? data : [];
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
app.get("/api/transports/:trkorr/logs", async (req, res) => {
  try {
    const { trkorr } = req.params;
    console.log(`🔄 Fetching all objects + logs, will filter by TRANSPORT = ${trkorr}`);

    const [objectsData, logsData] = await Promise.all([
      fetchFromSAP("/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/Objects?$format=json"),
      fetchFromSAP("/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/Logs?$format=json"),
    ]);

    const allObjects = Array.isArray(objectsData) ? objectsData : [];
    const allLogs    = Array.isArray(logsData)    ? logsData    : [];

    const objectNames = new Set(
      allObjects
        .filter(o => o.TRANSPORT === trkorr)
        .map(o => o.OBJECT_NAME)
    );

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

// 4. POST /api/transports/:trkorr/import
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
    const sapAuth   = Buffer.from(`${User}:${Password}`).toString("base64");
    const baseURL   = `${SAP_URL}/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV`;

    // Fetch CSRF token
    const tokenRes = await axios.get(`${baseURL}/Transports`, {
      headers: {
        Authorization:         `Basic ${sapAuth}`,
        "Proxy-Authorization": `Bearer ${connectivityToken}`,
        "x-csrf-token":        "fetch",
        Accept:                "application/json",
      },
      proxy:      { protocol: "http:", host: proxyHost, port: proxyPort },
      httpsAgent,
    });

    const csrfToken = tokenRes.headers["x-csrf-token"];
    const cookies   = tokenRes.headers["set-cookie"];
    if (!csrfToken || !cookies) throw new Error("Failed to fetch CSRF token or cookies");
    console.log("✅ CSRF token fetched");

    // Trigger import
    const postRes = await axios.post(
      `${baseURL}/Transports`,
      { TRKORR: trkorr },
      {
        headers: {
          Authorization:         `Basic ${sapAuth}`,
          "Proxy-Authorization": `Bearer ${connectivityToken}`,
          "x-csrf-token":        csrfToken,
          "Content-Type":        "application/json",
          "Cookie":              cookies.join(";"),
          Accept:                "application/json",
        },
        proxy:      { protocol: "http:", host: proxyHost, port: proxyPort },
        httpsAgent,
      }
    );

    console.log(`✅ Import triggered successfully: ${trkorr}`);
    res.json({
      success: true,
      message: `Transport ${trkorr} import triggered for ${target}`,
      data:    postRes.data?.d || postRes.data,
    });

  } catch (err) {
    console.error(`❌ Import error for ${trkorr}:`, err.response?.data || err.message);
    res.status(500).json({
      error: err.response?.data?.error?.message?.value || err.message || "Import failed",
    });
  }
});

// ─── SAP AI Core ──────────────────────────────────────────────────────────────

/**
 * Deployment discovery cache.
 * AI Core deployments are looked up once per resource-group, then cached
 * so we don't re-query the management API on every transport click.
 *
 * Cache entry: { deploymentId, modelName, expiresAt }
 * TTL: 10 minutes (deployments rarely change)
 */
const _deploymentCache = {};

/**
 * Queries GET /v2/lm/deployments?status=RUNNING from the AI Core
 * management API and picks the first running deployment.
 *
 * If AICORE_DEPLOYMENT_ID is set in .env we skip discovery and use it
 * directly — useful when you have multiple deployments and want to pin one.
 */
async function resolveDeployment(baseUrl, token, resourceGroup) {
  const cacheKey = `${baseUrl}::${resourceGroup}`;
  const now      = Date.now();
  const cached   = _deploymentCache[cacheKey];

  if (cached && cached.expiresAt > now) {
    console.log(`✅ AI Core deployment from cache: ${cached.deploymentId} (${cached.modelName})`);
    return cached;
  }

  // If pinned via env var, skip discovery but still resolve model name
  if (process.env.AICORE_DEPLOYMENT_ID) {
    const deploymentId = process.env.AICORE_DEPLOYMENT_ID;
    const modelName    = process.env.AICORE_MODEL_NAME || null;
    // For pinned deployments, build URL from base — deploymentUrl not available without a list call
    const apiVersion   = process.env.AICORE_API_VERSION || "2024-02-01";
    const inferenceUrl = `${baseUrl}/v2/inference/deployments/${deploymentId}/chat/completions?api-version=${apiVersion}`;
    const entry        = { deploymentId, modelName, inferenceUrl, expiresAt: now + 10 * 60 * 1000 };
    _deploymentCache[cacheKey] = entry;
    console.log(`✅ AI Core deployment pinned via env: ${deploymentId}`);
    console.log(`🔗 Inference URL: ${inferenceUrl}`);
    return entry;
  }

  // Auto-discover: list all RUNNING deployments
  console.log(`🔍 AI Core: discovering deployments in resource group "${resourceGroup}"...`);
  const listRes = await axios.get(
    `${baseUrl}/v2/lm/deployments?status=RUNNING`,
    {
      headers: {
        "Authorization":     `Bearer ${token}`,
        "AI-Resource-Group": resourceGroup,
      },
      httpsAgent,
    }
  );

  // Log raw response so we can see exact field structure
  console.log("📋 AI Core deployments raw:", JSON.stringify(listRes.data).slice(0, 800));

  const deployments = listRes.data?.resources || listRes.data?.data || [];
  if (!deployments.length) {
    throw new Error(`No RUNNING deployments found in AI Core resource group "${resourceGroup}". Deploy a model first in AI Launchpad.`);
  }

  // Pick first running deployment and extract model name from all known field paths
  const dep          = deployments[0];
  const deploymentId = dep.id;
  const modelName    = extractModelName(dep);
  const inferenceUrl = resolveInferenceUrl(dep, baseUrl, deploymentId);

  const entry = { deploymentId, modelName, inferenceUrl, expiresAt: now + 10 * 60 * 1000 };
  _deploymentCache[cacheKey] = entry;

  console.log(`✅ AI Core auto-discovered: ${deploymentId} (model: ${modelName || "not sent"})`);
  console.log(`🔗 Inference URL: ${inferenceUrl} ${dep?.deploymentUrl ? "[from deploymentUrl]" : "[constructed]"}`);
  if (deployments.length > 1) {
    console.log(`   ℹ️  ${deployments.length} running deployments — using first. Set AICORE_DEPLOYMENT_ID to pin one.`);
  }
  return entry;
}

/**
 * Extracts model name from a deployment object.
 *
 * From confirmed live SAP AI Core response (your logs, 2026):
 *   details.resources.backendDetails  = {}           ← EMPTY (camelCase)
 *   details.resources.backend_details = { model: { name: "gpt-5" } }  ← HAS DATA
 *
 * The || chain fails because backendDetails exists (truthy empty object {}),
 * so .model?.name returns undefined and falls through. Using an explicit
 * candidates array with string validation avoids this trap entirely.
 */
function extractModelName(dep) {
  const candidates = [
    dep?.details?.resources?.backend_details?.model?.name,   // ✅ confirmed live path
    dep?.details?.resources?.backendDetails?.model?.name,
    dep?.details?.scaling?.backend_details?.model?.name,
    dep?.details?.scaling?.backendDetails?.model?.name,
    dep?.details?.resources?.backend_details?.modelName,
    dep?.details?.resources?.backendDetails?.modelName,
    dep?.details?.resources?.backend_details?.model_name,
    dep?.details?.resources?.backendDetails?.model_name,
    dep?.modelName,
    dep?.model_name,
    // configurationName: strip "_autogenerated" suffix → "gpt-5_autogenerated" becomes "gpt-5"
    dep?.configurationName?.replace(/_autogenerated$/i, "").trim(),
    process.env.AICORE_MODEL_NAME,
  ];
  for (const c of candidates) {
    if (c && typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return null; // null = omit model field; let the deployment decide
}

/**
 * Returns the full inference URL for a deployment.
 * IMPORTANT: SAP AI Core (Azure OpenAI backend) requires ?api-version=2024-02-01
 * Without this query parameter the endpoint returns 404 "Resource not found".
 */
function resolveInferenceUrl(dep, baseUrl, deploymentId) {
  const apiVersion = process.env.AICORE_API_VERSION || "2024-02-01";
  const depUrl = dep?.deploymentUrl || dep?.deployment_url;
  if (depUrl) {
    return `${depUrl.replace(/\/+$/, "")}/chat/completions?api-version=${apiVersion}`;
  }
  return `${baseUrl}/v2/inference/deployments/${deploymentId}/chat/completions?api-version=${apiVersion}`;
}

/**
 * Fetch deployment details by ID and extract the model name.
 * Called when AICORE_DEPLOYMENT_ID is pinned but AICORE_MODEL_NAME is not set.
 */
async function fetchModelName(baseUrl, token, resourceGroup, deploymentId) {
  try {
    const res = await axios.get(
      `${baseUrl}/v2/lm/deployments/${deploymentId}`,
      {
        headers: {
          "Authorization":     `Bearer ${token}`,
          "AI-Resource-Group": resourceGroup,
        },
        httpsAgent,
      }
    );
    console.log("📋 AI Core deployment detail raw:", JSON.stringify(res.data).slice(0, 600));
    return extractModelName(res.data) || null;
  } catch (e) {
    console.warn("⚠️  Could not fetch deployment detail:", e.message);
    return null;
  }
}

/**
 * Builds the LLM prompt. Asks the model to respond ONLY with JSON.
 */
function buildAiCorePrompt(p) {
  return `You are a SAP Basis expert and transport risk analyst.
Analyse the SAP transport below and return ONLY a valid JSON object — no markdown, no text outside the JSON.

Transport details:
  ID            : ${p.trkorr}
  Status        : ${p.status}
  Owner         : ${p.owner        || "unknown"}
  Target system : ${p.target       || "unknown"}
  Created on    : ${p.createdOn    || "unknown"}
  Objects total : ${p.objectCount  || 0}  (${p.failedObjectCount || 0} in error, ${p.warnObjectCount || 0} with warnings)
  Object types  : ${(p.objectTypes || []).join(", ") || "none"}
  Log entries   : ${p.logCount     || 0}  (${p.failedLogCount || 0} with errors)
  Has PROG/FUGR : ${p.hasPROG || p.hasFUGR}
  Has AUTH      : ${p.hasAUTH}
  Has TABL      : ${p.hasTABL}

Scoring rules:
  - Return an integer riskScore between 5 and 98.
  - "Failed" status is a strong risk signal (+35).
  - "Modifiable" means not yet released (+20).
  - Each failed object adds risk (up to +36). Each failed log adds risk (up to +24).
  - AUTH objects raise authorisation risk (+10). TABL changes risk data loss (+8). PROG/FUGR risk runtime errors (+8).
  - reasoning must be ONE sentence, max 20 words, explaining the top risk driver.

Respond with exactly:
{
  "riskScore": <integer 5–98>,
  "reasoning": "<one sentence>"
}`;
}

/**
 * POST /api/ai-core/analyze
 *
 * Receives transport metadata from index.html, resolves the active AI Core
 * deployment automatically (no hardcoded deployment ID or model name needed),
 * calls the chat-completions endpoint, and returns { riskScore, reasoning }.
 *
 * Optional .env overrides:
 *   AICORE_DEPLOYMENT_ID  — pin a specific deployment (skips auto-discovery)
 *   AICORE_MODEL_NAME     — override model name label shown in the UI
 *   AICORE_RESOURCE_GROUP — resource group (default: "default")
 */
app.post("/api/ai-core/analyze", async (req, res) => {
  const payload = req.body;

  if (!payload || !payload.trkorr) {
    return res.status(400).json({ error: "Missing transport payload (trkorr required)" });
  }

  if (!aiCoreCredentials) {
    return res.status(503).json({
      error: "AI Core credentials not loaded. Bind the 'aicore' service on BTP or set AICORE_BASE_URL / AICORE_CLIENT_ID / AICORE_CLIENT_SECRET / AICORE_TOKEN_URL env vars.",
    });
  }

  const baseUrl       = aiCoreCredentials.serviceurls?.AI_API_URL;
  const resourceGroup = process.env.AICORE_RESOURCE_GROUP || "default";

  if (!baseUrl) {
    return res.status(503).json({ error: "AI Core base URL missing from service binding (serviceurls.AI_API_URL)." });
  }

  try {
    // 1. Get bearer token
    const token = await getAiCoreToken();

    // 2. Resolve deployment ID + model name automatically from the management API
    //    (or use AICORE_DEPLOYMENT_ID env var if pinned)
    const { deploymentId, modelName, inferenceUrl } = await resolveDeployment(baseUrl, token, resourceGroup);

    console.log(`🤖 AI Core → ${inferenceUrl}  model: ${modelName || "(not sent)"}  transport: ${payload.trkorr}`);

    // SAP AI Core "foundation-models" deployments do NOT accept a "model" field
    // in the request body — the deployment URL already identifies the model.
    // Sending model:"gpt-5" causes 404 "Resource not found" even when correct.
    const requestBody = {
      messages: [
        {
          role:    "system",
          content: "You are a SAP Basis expert. Always respond with pure JSON only — no markdown, no explanation.",
        },
        {
          role:    "user",
          content: buildAiCorePrompt(payload),
        },
      ],
      max_completion_tokens: 300,
      temperature: 0.2,
      // NOTE: "model" field intentionally omitted — foundation-models deployments
      // reject it. The deployment URL already encodes the model.
    };

    // 3. Call inference
    const aiRes = await axios.post(
      inferenceUrl,
      requestBody,
      {
        headers: {
          "Content-Type":      "application/json",
          "Authorization":     `Bearer ${token}`,
          "AI-Resource-Group": resourceGroup,
        },
        httpsAgent,
      }
    );

    const content = aiRes.data?.choices?.[0]?.message?.content || "{}";
    console.log(`✅ AI Core raw response for ${payload.trkorr}:`, content);

    // 4. Parse — strip markdown fences if model added them
    const cleaned = content.replace(/```json|```/gi, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.error("❌ AI Core: non-JSON response:", content);
      return res.status(502).json({ error: "Model returned non-JSON", raw: content });
    }

    // 5. Clamp + sanitise
    const riskScore = Math.min(Math.max(parseInt(parsed.riskScore ?? parsed.risk_score ?? parsed.score) || 20, 5), 98);
    const reasoning = String(parsed.reasoning || parsed.reason || "").slice(0, 150);

    console.log(`✅ Risk score for ${payload.trkorr}: ${riskScore}% — ${reasoning}`);
    return res.json({ riskScore, reasoning, model: modelName, deploymentId });

  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data || err.message;
    console.error(`❌ AI Core error for ${payload.trkorr} [HTTP ${status}]:`, JSON.stringify(detail).slice(0, 500));
    // Clear deployment cache on 404 so next request re-discovers
    if (status === 404) {
      const cacheKey = `${aiCoreCredentials?.serviceurls?.AI_API_URL}::${process.env.AICORE_RESOURCE_GROUP || "default"}`;
      delete _deploymentCache[cacheKey];
      console.warn("⚠️  404 from AI Core — deployment cache cleared. Will re-discover on next request.");
    }
    return res.status(502).json({
      error:  "AI Core inference failed",
      status,
      detail: typeof detail === "object" ? JSON.stringify(detail) : detail,
    });
  }
});

// ─── Serve Frontend ───────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, "../frontend")));
app.get(/^\/(?!api|debug).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Destination    : ${DESTINATION_NAME}`);
  console.log(`🤖 AI Core loaded : ${!!aiCoreCredentials}`);
});
