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
let aiCoreCredentials       = null;

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

// ─── Load AI Core credentials ─────────────────────────────────────────────────

function loadAiCoreCredentials() {
  try {
    const svc = xsenv.getServices({ aicore: { tag: "aicore" } });
    if (svc?.aicore?.serviceurls?.AI_API_URL) {
      console.log("✅ AI Core loaded from VCAP_SERVICES (tag: aicore)");
      return svc.aicore;
    }
  } catch { /* not found by tag */ }

  try {
    const svc = xsenv.getServices({ aicore: { label: "aicore" } });
    if (svc?.aicore?.serviceurls?.AI_API_URL) {
      console.log("✅ AI Core loaded from VCAP_SERVICES (label: aicore)");
      return svc.aicore;
    }
  } catch { /* not found by label */ }

  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
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

// ─── FIX 1: Sanitize AI_API_URL — strip trailing slash immediately after load ─
// This prevents double-slash URLs like ".../v2/lm/deployments" from breaking
// the discovery and inference calls.
if (aiCoreCredentials?.serviceurls?.AI_API_URL) {
  aiCoreCredentials.serviceurls.AI_API_URL =
    aiCoreCredentials.serviceurls.AI_API_URL.replace(/\/+$/, "");
  console.log("📡 AI Core URL (sanitized):", aiCoreCredentials.serviceurls.AI_API_URL);
}

// ─── Fallbacks from .env ──────────────────────────────────────────────────────

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

async function getAiCoreToken() {
  if (!aiCoreCredentials) throw new Error("AI Core credentials not loaded.");
  return getCachedToken("aicore", async () => {
    const tokenUrl     = aiCoreCredentials.url + "/oauth/token";
    const clientid     = aiCoreCredentials.clientid;
    const clientsecret = aiCoreCredentials.clientsecret;
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

const _deploymentCache = {};

async function resolveDeployment(baseUrl, token, resourceGroup) {
  const cacheKey = `${baseUrl}::${resourceGroup}`;
  const now      = Date.now();
  const cached   = _deploymentCache[cacheKey];

  if (cached && cached.expiresAt > now) {
    console.log(`✅ AI Core deployment from cache: ${cached.deploymentId} (${cached.modelName})`);
    return cached;
  }

  if (process.env.AICORE_DEPLOYMENT_ID) {
    const deploymentId = process.env.AICORE_DEPLOYMENT_ID;
    const modelName    = process.env.AICORE_MODEL_NAME || await fetchModelName(baseUrl, token, resourceGroup, deploymentId);
    const entry        = { deploymentId, modelName, expiresAt: now + 10 * 60 * 1000 };
    _deploymentCache[cacheKey] = entry;
    console.log(`✅ AI Core deployment pinned via env: ${deploymentId} (${modelName})`);
    return entry;
  }

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

  const deployments = listRes.data?.resources || listRes.data?.data || [];
  if (!deployments.length) {
    throw new Error(`No RUNNING deployments found in AI Core resource group "${resourceGroup}". Deploy a model first in AI Launchpad.`);
  }

  const dep          = deployments[0];
  const deploymentId = dep.id;
  const modelName    =
    dep.details?.resources?.backendDetails?.modelName ||
    dep.details?.scaling?.backendDetails?.modelName   ||
    dep.modelName ||
    process.env.AICORE_MODEL_NAME ||
    "unknown";

  const entry = { deploymentId, modelName, expiresAt: now + 10 * 60 * 1000 };
  _deploymentCache[cacheKey] = entry;

  console.log(`✅ AI Core auto-discovered deployment: ${deploymentId} (${modelName})`);
  if (deployments.length > 1) {
    console.log(`   ℹ️  ${deployments.length} running deployments found — using first. Set AICORE_DEPLOYMENT_ID to pin a specific one.`);
  }
  return entry;
}

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
    return (
      res.data?.details?.resources?.backendDetails?.modelName ||
      res.data?.modelName ||
      "unknown"
    );
  } catch {
    return "unknown";
  }
}

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
    const token = await getAiCoreToken();
    const { deploymentId, modelName } = await resolveDeployment(baseUrl, token, resourceGroup);

    const inferenceUrl = `${baseUrl}/v2/inference/deployments/${deploymentId}/chat/completions`;
    console.log(`🤖 AI Core → ${inferenceUrl}  model: ${modelName}  transport: ${payload.trkorr}`);

    // ─── FIX 2: Do NOT send "model" in the request body ──────────────────────
    // AI Core deployments already know their own model. Sending model: "unknown"
    // (or any wrong name) causes a 404 "Resource not found" from the inference API.
    const aiRes = await axios.post(
      inferenceUrl,
      {
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
        max_tokens:  300,
        temperature: 0.2,
      },
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

    const cleaned = content.replace(/```json|```/gi, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.error("❌ AI Core: non-JSON response:", content);
      return res.status(502).json({ error: "Model returned non-JSON", raw: content });
    }

    const riskScore = Math.min(Math.max(parseInt(parsed.riskScore ?? parsed.risk_score ?? parsed.score) || 20, 5), 98);
    const reasoning = String(parsed.reasoning || parsed.reason || "").slice(0, 150);

    console.log(`✅ Risk score for ${payload.trkorr}: ${riskScore}% — ${reasoning}`);
    return res.json({ riskScore, reasoning, model: modelName, deploymentId });

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error(`❌ AI Core error for ${payload.trkorr}:`, detail);
    return res.status(502).json({
      error:  "AI Core inference failed",
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
