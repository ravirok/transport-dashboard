"use strict";
// ─────────────────────────────────────────────────────────────────────────────
// TransTrack Pro — Backend Server
// HCLTech / HCL America Solutions Inc.
// Routes: SAP Transports · Cloud ALM · AI Core · CI/CD · Cloud TM · Destinations
// ─────────────────────────────────────────────────────────────────────────────

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

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ─── Destination / Connectivity constants ────────────────────────────────────
const DESTINATION_NAME    = process.env.DESTINATION_NAME    || "S48-HTTP";
const CALM_DESTINATION_NAME = process.env.CALM_DESTINATION_NAME || "Cloud_ALM";
const CLOUD_TM_DEST_NAME  = process.env.CLOUD_TM_DEST_NAME  || "CLOUD_TM_DEST";
const CICD_DEST_NAME      = process.env.CICD_DEST_NAME      || "CICD_DEST";
const AI_CORE_MODEL_NAME  = process.env.AI_CORE_MODEL_NAME  || "gpt-5.2";

// ─── VCAP credentials ────────────────────────────────────────────────────────
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
  console.log("✅ VCAP services loaded");
} catch (e) {
  console.warn("⚠️  VCAP load:", e.message);
}

// ─── Debug / Health ───────────────────────────────────────────────────────────
app.get("/debug", (req, res) => res.send("BACKEND LIVE ✅"));

app.get("/api/vcap", (req, res) => {
  res.json({
    xsuaa:        !!xsuaaCredentials,
    destination:  !!destinationCredentials,
    connectivity: !!connectivityCredentials,
    destUri:      destinationCredentials?.uri || null,
  });
});

app.get("/api/health", async (req, res) => {
  const result = { status: "ok", timestamp: new Date().toISOString(),
                   destination: !!destinationCredentials,
                   connectivity: !!connectivityCredentials };
  try {
    await fetchFromSAP("/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/Transports?$top=1&$format=json");
    result.sapConnection = "ok";
  } catch (e) { result.sapConnection = "error: " + e.message; }
  res.json(result);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SAP S/4HANA — On-Premise via Connectivity Proxy
// ═══════════════════════════════════════════════════════════════════════════════
async function getConnectivityToken() {
  if (!connectivityCredentials) throw new Error("Connectivity service not bound");
  const r = await axios.post(
    `${connectivityCredentials.token_service_url || connectivityCredentials.uaa?.url}/oauth/token`,
    new URLSearchParams({ grant_type: "client_credentials",
      client_id: connectivityCredentials.clientid,
      client_secret: connectivityCredentials.clientsecret }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent }
  );
  return r.data.access_token;
}

async function getBTPToken() {
  if (!destinationCredentials) throw new Error("Destination service not bound");
  const creds = destinationCredentials;
  const r = await axios.post(
    `${creds.url || creds.uaa?.url}/oauth/token`,
    new URLSearchParams({ grant_type: "client_credentials",
      client_id: creds.clientid, client_secret: creds.clientsecret }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent }
  );
  return r.data.access_token;
}

async function getBTPDestination(token) {
  const r = await axios.get(
    `${destinationCredentials.uri}/destination-configuration/v1/destinations/${DESTINATION_NAME}`,
    { headers: { Authorization: `Bearer ${token}` }, httpsAgent }
  );
  return r.data;
}

async function fetchFromSAP(odataPath) {
  const [destToken, connectToken] = await Promise.all([getBTPToken(), getConnectivityToken()]);
  const dest = await getBTPDestination(destToken);
  const { URL: SAP_URL, User, Password } = dest.destinationConfiguration;
  const proxyHost = connectivityCredentials.onpremise_proxy_host;
  const proxyPort = parseInt(connectivityCredentials.onpremise_proxy_http_port || "20003");
  const sapAuth   = Buffer.from(`${User}:${Password}`).toString("base64");
  const r = await axios.get(`${SAP_URL}${odataPath}`, {
    headers: { Authorization: `Basic ${sapAuth}`, "Proxy-Authorization": `Bearer ${connectToken}`, Accept: "application/json" },
    proxy:   { protocol: "http:", host: proxyHost, port: proxyPort },
    httpsAgent, timeout: 30000,
  });
  return r.data;
}

async function postToSAP(odataPath, body = {}) {
  const [destToken, connectToken] = await Promise.all([getBTPToken(), getConnectivityToken()]);
  const dest = await getBTPDestination(destToken);
  const { URL: SAP_URL, User, Password } = dest.destinationConfiguration;
  const proxyHost = connectivityCredentials.onpremise_proxy_host;
  const proxyPort = parseInt(connectivityCredentials.onpremise_proxy_http_port || "20003");
  const sapAuth   = Buffer.from(`${User}:${Password}`).toString("base64");
  const r = await axios.post(`${SAP_URL}${odataPath}`, body, {
    headers: { Authorization: `Basic ${sapAuth}`, "Proxy-Authorization": `Bearer ${connectToken}`,
               "Content-Type": "application/json", Accept: "application/json" },
    proxy:   { protocol: "http:", host: proxyHost, port: proxyPort },
    httpsAgent, timeout: 30000,
  });
  return r.data;
}

// ─── Transport Routes ─────────────────────────────────────────────────────────
app.get("/api/transports", async (req, res) => {
  try {
    const data = await fetchFromSAP(
      "/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/Transports?$format=json&$top=200&$orderby=CREATED_ON%20desc"
    );
    res.json(data);
  } catch (e) {
    console.error("transports:", e.message);
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/transports/:trkorr/objects", async (req, res) => {
  try {
    const data = await fetchFromSAP(
      `/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/TransportObjects?$format=json&$filter=TRKORR%20eq%20'${encodeURIComponent(req.params.trkorr)}'`
    );
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/transports/:trkorr/logs", async (req, res) => {
  try {
    const data = await fetchFromSAP(
      `/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/TransportLogs?$format=json&$filter=TRKORR%20eq%20'${encodeURIComponent(req.params.trkorr)}'`
    );
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post("/api/transports/:trkorr/import", async (req, res) => {
  try {
    const data = await postToSAP(
      `/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/ImportTransport`,
      { TRKORR: req.params.trkorr, ...req.body }
    );
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cloud ALM
// ═══════════════════════════════════════════════════════════════════════════════
let calmDestCache = null;
let directCalmToken = null;
let directCalmTokenExpiry = 0;

async function getDestinationServiceToken() {
  const r = await axios.post(
    `${destinationCredentials.url || destinationCredentials.uaa?.url}/oauth/token`,
    new URLSearchParams({ grant_type: "client_credentials",
      client_id: destinationCredentials.clientid, client_secret: destinationCredentials.clientsecret }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent }
  );
  return r.data.access_token;
}

async function resolveCALMDestination() {
  if (calmDestCache && calmDestCache.expiry > Date.now()) return calmDestCache;
  const token = await getDestinationServiceToken();
  const r = await axios.get(
    `${destinationCredentials.uri}/destination-configuration/v1/destinations/${CALM_DESTINATION_NAME}`,
    { headers: { Authorization: `Bearer ${token}` }, httpsAgent }
  );
  const conf = r.data.destinationConfiguration || {};
  calmDestCache = {
    baseUrl:    (conf.URL || "").replace(/\/$/, ""),
    authTokens: r.data.authTokens || [],
    expiry:     Date.now() + 4 * 60 * 1000,
  };
  return calmDestCache;
}

async function getDirectCALMToken() {
  if (directCalmToken && Date.now() < directCalmTokenExpiry - 30000) return directCalmToken;
  const cert    = process.env.CALM_CERTIFICATE;
  const key     = process.env.CALM_PRIVATE_KEY;
  const tokenUrl = process.env.CALM_TOKEN_URL;
  const clientId = process.env.CALM_CLIENT_ID;
  if (!cert || !key || !tokenUrl || !clientId) throw new Error("CALM x509 env vars not set");
  const agent = new https.Agent({ cert, key, rejectUnauthorized: false });
  const r = await axios.post(
    `${tokenUrl}/oauth/token`,
    new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, response_type: "token" }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent: agent }
  );
  directCalmToken       = r.data.access_token;
  directCalmTokenExpiry = Date.now() + (r.data.expires_in || 3600) * 1000;
  return directCalmToken;
}

function getCALMBaseUrl() {
  return process.env.CALM_BASE_URL ||
         "https://eu20.alm.cloud.sap/api";
}

function parseALMResponse(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (data.value)   return data.value;
  if (data.results) return data.results;
  if (data.d?.results) return data.d.results;
  return [data];
}

async function fetchFromALM(path) {
  // Try destination first
  if (destinationCredentials) {
    try {
      const dest  = await resolveCALMDestination();
      const token = dest.authTokens[0]?.value;
      if (token) {
        const r = await axios.get(`${dest.baseUrl}${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, httpsAgent
        });
        return r.data;
      }
    } catch {}
  }
  // Direct x509
  const token = await getDirectCALMToken();
  const r = await axios.get(`${getCALMBaseUrl()}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, httpsAgent
  });
  return r.data;
}

async function patchToALM(path, body) {
  if (destinationCredentials) {
    try {
      const dest  = await resolveCALMDestination();
      const token = dest.authTokens[0]?.value;
      if (token) {
        const r = await axios.patch(`${dest.baseUrl}${path}`, body, {
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, httpsAgent
        });
        return r.data;
      }
    } catch {}
  }
  const token = await getDirectCALMToken();
  const r = await axios.patch(`${getCALMBaseUrl()}${path}`, body, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, httpsAgent
  });
  return r.data;
}

async function tryALMPaths(paths) {
  for (const p of paths) {
    try { return await fetchFromALM(p); } catch {}
  }
  throw new Error("All ALM paths failed");
}

app.get("/api/calm/x509debug", async (req, res) => {
  const result = {};
  try { result.token = await getDirectCALMToken(); result.ok = true; }
  catch (e) { result.ok = false; result.error = e.message; }
  res.json(result);
});

app.get("/api/calm/discover", async (req, res) => {
  try {
    const data = await fetchFromALM("/calm-ops/api/v1/health");
    res.json({ status: "connected", data });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/calm/debug", async (req, res) => {
  const result = { steps: {} };
  try {
    result.steps["1_dest_token"] = { ok: !!destinationCredentials };
    if (destinationCredentials) {
      const dest = await resolveCALMDestination();
      result.steps["2_dest_config"] = { ok: true, baseUrl: dest.baseUrl, hasToken: dest.authTokens.length > 0 };
      const token = dest.authTokens[0]?.value;
      if (token) {
        try {
          const data = await axios.get(`${dest.baseUrl}/calm-ops/api/v1/health`, {
            headers: { Authorization: `Bearer ${token}` }, httpsAgent
          });
          result.steps["3_calm_health"] = { ok: true, status: data.status };
        } catch (e) { result.steps["3_calm_health"] = { ok: false, error: e.message }; }
        try {
          const data = await fetchFromSAP("/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/Transports?$top=1&$format=json");
          result.steps["4_sap_transports"] = { ok: true, recordCount: data?.d?.results?.length ?? 0 };
        } catch (e) { result.steps["4_sap_transports"] = { ok: false, error: e.message }; }
        try {
          const data = await axios.get(`${dest.baseUrl}/v1/changes?$top=1`, {
            headers: { Authorization: `Bearer ${token}` }, httpsAgent
          });
          result.steps["5_change_mgmt_api"] = { ok: true, recordCount: data?.data?.value?.length ?? 0 };
        } catch (e) { result.steps["5_change_mgmt_api"] = { ok: false, error: e.message }; }
        try {
          const data = await axios.get(`${dest.baseUrl}/v1/tm-api/deployment-tasks?$top=1`, {
            headers: { Authorization: `Bearer ${token}` }, httpsAgent
          });
          result.steps["6_transport_mgmt_api"] = { ok: true, recordCount: data?.data?.value?.length ?? 0 };
        } catch (e) { result.steps["6_transport_mgmt_api"] = { ok: false, error: e.message }; }
      }
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message, result }); }
});

app.get("/api/calm/health", async (req, res) => {
  try {
    const data = await tryALMPaths([
      "/calm-ops/api/v1/health", "/api/v1/health", "/health"
    ]);
    res.json({ status: "ok", data });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/calm/changes/all", async (req, res) => {
  try {
    const data = await tryALMPaths([
      "/v1/changes?$top=200&$orderby=lastChangedAt%20desc",
      "/api/v1/changes?$top=200",
      "/leanix/v1/changes?$top=200",
    ]);
    res.json({ changes: parseALMResponse(data), count: parseALMResponse(data).length });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/calm/changes/:trkorr", async (req, res) => {
  try {
    const data = await tryALMPaths([
      `/v1/changes?$filter=externalId%20eq%20'${req.params.trkorr}'`,
      `/api/v1/changes?trkorr=${req.params.trkorr}`,
    ]);
    const items = parseALMResponse(data);
    res.json(items.length > 0 ? items[0] : { status: "none" });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.patch("/api/calm/changes/:changeId/deploy", async (req, res) => {
  try {
    const data = await patchToALM(`/v1/changes/${req.params.changeId}`, req.body);
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/calm/tm/deployments", async (req, res) => {
  try {
    const data = await tryALMPaths([
      "/v1/tm-api/deployment-tasks?$top=100&$orderby=createdAt%20desc",
      "/api/v1/tm-api/deployment-tasks?$top=100",
    ]);
    res.json({ deployments: parseALMResponse(data) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AI Core
// ═══════════════════════════════════════════════════════════════════════════════
let aiCoreToken       = null;
let aiCoreTokenExpiry = 0;
let aiCoreDeploymentCache  = null;
let aiCoreDeploymentExpiry = 0;

async function getAICoreToken() {
  if (aiCoreToken && Date.now() < aiCoreTokenExpiry - 30000) return aiCoreToken;
  let clientId, clientSecret, tokenUrl;
  // Source 1: VCAP
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
    const entries = Object.values(vcap).flat();
    const entry = entries.find(s => s?.label === "aicore" || s?.tags?.includes("aicore"));
    if (entry?.credentials) {
      clientId     = entry.credentials.clientid;
      clientSecret = entry.credentials.clientsecret;
      tokenUrl     = entry.credentials.url;
    }
  } catch {}
  // Source 2: AICORE_SERVICE_KEY
  if (!clientId && process.env.AICORE_SERVICE_KEY) {
    try {
      const k = JSON.parse(process.env.AICORE_SERVICE_KEY);
      clientId     = k.clientid     || k.client_id;
      clientSecret = k.clientsecret || k.client_secret;
      tokenUrl     = k.url          || k.auth_url;
    } catch {}
  }
  // Source 3: individual env vars
  clientId     = clientId     || process.env.AICORE_CLIENT_ID;
  clientSecret = clientSecret || process.env.AICORE_CLIENT_SECRET;
  tokenUrl     = tokenUrl     || process.env.AICORE_TOKEN_URL;
  if (!clientId) throw new Error("AI Core credentials not configured");
  const url = tokenUrl.endsWith("/oauth/token") ? tokenUrl : `${tokenUrl}/oauth/token`;
  const r = await axios.post(url,
    new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent }
  );
  aiCoreToken       = r.data.access_token;
  aiCoreTokenExpiry = Date.now() + (r.data.expires_in || 3600) * 1000;
  return aiCoreToken;
}

function getAICoreBaseUrl() {
  if (process.env.AICORE_SERVICE_KEY) {
    try { return JSON.parse(process.env.AICORE_SERVICE_KEY).serviceurls?.AI_API_URL; } catch {}
  }
  return process.env.AICORE_BASE_URL || null;
}

async function discoverAICoreDeployment() {
  if (aiCoreDeploymentCache && Date.now() < aiCoreDeploymentExpiry) return aiCoreDeploymentCache;
  const token   = await getAICoreToken();
  const baseUrl = getAICoreBaseUrl();
  if (!baseUrl) throw new Error("AI Core base URL not configured");
  const r = await axios.get(`${baseUrl}/v2/lm/deployments?$top=100`, {
    headers: { Authorization: `Bearer ${token}`, "AI-Resource-Group": "default" }, httpsAgent
  });
  const deployments = r.data?.resources || r.data?.value || [];
  const running = deployments.find(d =>
    d.status === "RUNNING" &&
    (d.details?.resources?.backend_details?.model?.name?.includes("gpt") ||
     d.configurationName?.includes("gpt"))
  ) || deployments.find(d => d.status === "RUNNING");
  if (!running) throw new Error("No running AI Core deployment found");
  aiCoreDeploymentCache = running.deploymentUrl || `${baseUrl}/v2/inference/deployments/${running.id}`;
  aiCoreDeploymentExpiry = Date.now() + 10 * 60 * 1000;
  return aiCoreDeploymentCache;
}

async function callAICore(messages, systemPrompt, maxTokens = 800) {
  const token = await getAICoreToken();
  let deployUrl;
  try { deployUrl = await discoverAICoreDeployment(); }
  catch { deployUrl = `${getAICoreBaseUrl()}/v2/inference/deployments/default`; }
  const r = await axios.post(
    `${deployUrl}/chat/completions`,
    { model: AI_CORE_MODEL_NAME, max_tokens: maxTokens, temperature: 0.3,
      messages: [{ role: "system", content: systemPrompt }, ...messages] },
    { headers: { Authorization: `Bearer ${token}`, "AI-Resource-Group": "default",
                 "Content-Type": "application/json" }, httpsAgent, timeout: 30000 }
  );
  return r.data.choices?.[0]?.message?.content || "";
}

function localRiskScore(input) {
  let score = 0;
  const desc = (input.description || "").toLowerCase();
  const obj  = input.objectCount  || 0;
  const sys  = input.targetSystem || "";
  if (desc.includes("basis") || desc.includes("security") || desc.includes("auth")) score += 30;
  if (desc.includes("fi") || desc.includes("payroll") || desc.includes("hr"))       score += 25;
  if (obj > 50) score += 20; else if (obj > 20) score += 10;
  if (sys.includes("PROD") || sys.includes("PRD")) score += 20;
  return Math.min(score, 100);
}

app.post("/api/ai/predict", async (req, res) => {
  const { transports = [], context = "" } = req.body;
  try {
    const messages = [{
      role: "user",
      content: `Analyse these SAP transports and provide risk assessment:\n${JSON.stringify(transports, null, 2)}\nContext: ${context}`
    }];
    const systemPrompt = "You are an SAP transport risk expert. Analyse transports and return JSON with fields: riskScore (0-100), riskLevel (LOW/MEDIUM/HIGH/CRITICAL), recommendation, keyRisks (array).";
    const text = await callAICore(messages, systemPrompt, 1000);
    try {
      const clean = text.replace(/```json|```/g, "").trim();
      res.json(JSON.parse(clean));
    } catch { res.json({ riskScore: 50, riskLevel: "MEDIUM", recommendation: text, keyRisks: [] }); }
  } catch (e) {
    const score = localRiskScore(transports[0] || {});
    res.json({ riskScore: score, riskLevel: score > 70 ? "HIGH" : score > 40 ? "MEDIUM" : "LOW",
               recommendation: "Local analysis (AI Core unavailable)", keyRisks: [], localFallback: true });
  }
});

app.post("/api/ai/predict/transport", async (req, res) => {
  const t = req.body;
  try {
    const messages = [{
      role: "user",
      content: `Analyse this SAP transport for risk:\n${JSON.stringify(t, null, 2)}`
    }];
    const systemPrompt = "SAP transport risk expert. Return JSON: { riskScore, riskLevel, summary, recommendation, factors }";
    const text = await callAICore(messages, systemPrompt, 600);
    try {
      const clean = text.replace(/```json|```/g, "").trim();
      res.json(JSON.parse(clean));
    } catch { res.json({ riskScore: 50, riskLevel: "MEDIUM", summary: text }); }
  } catch (e) {
    const score = localRiskScore(t);
    res.json({ riskScore: score, riskLevel: score > 70 ? "HIGH" : score > 40 ? "MEDIUM" : "LOW",
               summary: "Local fallback", localFallback: true });
  }
});

app.get("/api/ai/status", async (req, res) => {
  try {
    const token   = await getAICoreToken();
    const baseUrl = getAICoreBaseUrl();
    const r = await axios.get(`${baseUrl}/v2/lm/deployments?$top=5`, {
      headers: { Authorization: `Bearer ${token}`, "AI-Resource-Group": "default" }, httpsAgent
    });
    const deployments = r.data?.resources || [];
    res.json({ configured: true, reachable: true, deployments: deployments.length,
               running: deployments.filter(d => d.status === "RUNNING").length });
  } catch (e) {
    res.json({ configured: false, reachable: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BTP Destination Service — Cross-Subaccount Helper
// ═══════════════════════════════════════════════════════════════════════════════
const _destConfigCache = {};

async function getDestinationConfig(destName) {
  const cached = _destConfigCache[destName];
  if (cached && cached.expiresAt > Date.now()) return cached.config;
  const token = await getBTPToken();
  const r = await axios.get(
    `${destinationCredentials.uri}/destination-configuration/v1/destinations/${destName}`,
    { headers: { Authorization: `Bearer ${token}` }, httpsAgent }
  );
  _destConfigCache[destName] = { config: r.data, expiresAt: Date.now() + 5 * 60 * 1000 };
  return r.data;
}

async function fetchViaDestination(destName, path, params = {}) {
  if (!destinationCredentials) throw new Error("Destination Service not bound");
  const config   = await getDestinationConfig(destName);
  const destConf = config.destinationConfiguration || {};
  const baseUrl  = destConf.URL || destConf.url;
  if (!baseUrl) throw new Error(`No URL in destination ${destName}`);
  const tok = (config.authTokens || [])[0];
  if (!tok?.value || tok.error) throw new Error(`No auth token for ${destName}: ${tok?.error || "missing"}`);
  const qs  = Object.keys(params).length ? "?" + new URLSearchParams(params).toString() : "";
  const url = `${baseUrl}${path}${qs}`;
  const r = await axios.get(url, {
    headers: { Authorization: `Bearer ${tok.value}`, Accept: "application/json" },
    httpsAgent, timeout: 15000,
  });
  return r.data;
}

app.get("/api/destinations/status", async (req, res) => {
  if (!destinationCredentials) {
    return res.json({ destinationService: false,
      message: "Destination Service not bound. Bind it in BTP Cockpit → Services.",
      CLOUD_TM_DEST: { configured: false }, CICD_DEST: { configured: false } });
  }
  const check = async (destName, label) => {
    try {
      const config = await getDestinationConfig(destName);
      const conf   = config.destinationConfiguration || {};
      const tok    = (config.authTokens || [])[0];
      const ready  = !!(tok?.value && !tok.error);
      return { configured: true, reachable: ready, name: destName, label,
               url: conf.URL || conf.url || "—", authType: conf.Authentication || "—",
               tokenReady: ready,
               message: ready ? `✅ ${label} ready — token obtained via destination`
                               : `⚠️  Destination exists but no auth token. Check OAuth2 config in BTP Cockpit.` };
    } catch (err) {
      return { configured: false, reachable: false, name: destName, label,
               message: `❌ Destination "${destName}" not found`, error: err.message };
    }
  };
  const [cloudTm, cicd] = await Promise.all([
    check(CLOUD_TM_DEST_NAME, "SAP Cloud TM"),
    check(CICD_DEST_NAME,     "SAP BTP CI/CD"),
  ]);
  res.json({ destinationService: true, destinationServiceUrl: destinationCredentials.uri,
             CLOUD_TM_DEST: cloudTm, CICD_DEST: cicd,
             summary: { allReady: cloudTm.reachable && cicd.reachable,
                        cloudTmReady: cloudTm.reachable, cicdReady: cicd.reachable } });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SAP BTP CI/CD
// ═══════════════════════════════════════════════════════════════════════════════
// cicd-app plan does NOT support service keys.
// Use XSUAA apiaccess instance: Security → XSUAA → Create (plan: apiaccess) → service key
// Set CICD_SERVICE_KEY env var with that service key JSON
// OR create CICD_DEST destination with OAuth2ClientCredentials

let cicdToken = null;
let cicdTokenExpiry = 0;

async function getCICDToken() {
  if (cicdToken && Date.now() < cicdTokenExpiry - 30000) return cicdToken;
  let clientId, clientSecret, tokenUrl;
  if (process.env.CICD_SERVICE_KEY) {
    try {
      const k = JSON.parse(process.env.CICD_SERVICE_KEY);
      clientId     = k.clientid     || k.client_id     || k.uaa?.clientid;
      clientSecret = k.clientsecret || k.client_secret || k.uaa?.clientsecret;
      tokenUrl     = k.url          || k.uaa?.url      || k.tokenurl;
      if (!process.env.CICD_API_URL && k.apiurl) process.env.CICD_API_URL = k.apiurl;
    } catch {}
  }
  clientId     = clientId     || process.env.CICD_CLIENT_ID;
  clientSecret = clientSecret || process.env.CICD_CLIENT_SECRET;
  tokenUrl     = tokenUrl     || process.env.CICD_TOKEN_URL;
  if (!clientId) throw new Error("CI/CD credentials not configured. Set CICD_SERVICE_KEY or create CICD_DEST destination.");
  const fullUrl = tokenUrl.endsWith("/oauth/token") ? tokenUrl : `${tokenUrl}/oauth/token`;
  let tokenRes;
  try {
    tokenRes = await axios.post(fullUrl,
      new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent }
    );
  } catch {
    tokenRes = await axios.post(fullUrl,
      new URLSearchParams({ grant_type: "client_credentials", client_id: clientId,
                            client_secret: clientSecret, scope: "cicd-service!b38.GlobalAdmin" }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent }
    );
  }
  cicdToken       = tokenRes.data.access_token;
  cicdTokenExpiry = Date.now() + (tokenRes.data.expires_in || 3600) * 1000;
  return cicdToken;
}

function getCICDBaseUrl() {
  if (process.env.CICD_SERVICE_KEY) {
    try { return JSON.parse(process.env.CICD_SERVICE_KEY).apiurl || null; } catch {}
  }
  return process.env.CICD_API_URL ||
         "https://hcl-integrationsuite-qxeoz78m.eu10.cicd.cloud.sap";
}

app.get("/api/cicd/runs", async (req, res) => {
  const callCICD = async (path) => {
    if (destinationCredentials) {
      try { return await fetchViaDestination(CICD_DEST_NAME, path); }
      catch (e) { console.warn(`CI/CD destination: ${e.message}`); }
    }
    const token = await getCICDToken();
    const r = await axios.get(`${getCICDBaseUrl()}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      httpsAgent, timeout: 15000,
    });
    return r.data;
  };
  try {
    const jobsData = await callCICD("/api/v1/jobs");
    const jobs = jobsData?.collection || jobsData?.jobs || jobsData?.value || (Array.isArray(jobsData) ? jobsData : []);
    console.log(`CI/CD: ${jobs.length} jobs`);
    const runResults = await Promise.allSettled(jobs.map(async (job) => {
      const jobId   = job.id || job.jobId;
      const jobName = job.name || job.jobName || jobId;
      try {
        const runsData = await callCICD(`/api/v1/jobs/${jobId}/runs`);
        const runs = (runsData?.collection || runsData?.runs || runsData?.value || []).slice(0, 5);
        return runs.map(r => {
          const start = r.startTime || r.createdAt || null;
          const end   = r.completionTime || r.endTime || null;
          const durMs = (start && end) ? new Date(end) - new Date(start) : null;
          const status = r.status === "COMPLETED" ? "success"
                       : r.status === "RUNNING"   ? "running"
                       : (r.status === "ERROR" || r.status === "ABORTED") ? "failed" : "pending";
          return { id: `#${r.id || r.runId || "—"}`, name: jobName, status,
                   branch: job.branch || r.branch || "main",
                   dur: durMs ? formatDuration(durMs) : (status === "running" ? "Running..." : "—"),
                   trigger: r.trigger || (job.state === "ON" ? "push" : "manual"),
                   time: start ? timeAgo(new Date(start)) : "—",
                   commit: (r.commitId || "").slice(0, 7) || "—",
                   jobId, startTime: start };
        });
      } catch { return [{ id: "#—", name: jobName, status: "pending", branch: "main", dur: "—", trigger: "—", time: "—", commit: "—", jobId }]; }
    }));
    const allRuns = runResults.filter(r => r.status === "fulfilled").flatMap(r => r.value)
      .sort((a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0)).slice(0, 20);
    const summary = {
      totalJobs: jobs.length,
      running:   allRuns.filter(r => r.status === "running").length,
      success:   allRuns.filter(r => r.status === "success").length,
      failed:    allRuns.filter(r => r.status === "failed").length,
      jobs:      jobs.map(j => ({ id: j.id || j.jobId, name: j.name || j.jobName, state: j.state || "ON", branch: j.branch || "main" })),
    };
    res.json({ configured: true, runs: allRuns, stages: [], summary });
  } catch (err) {
    console.error("CI/CD runs error:", err.message);
    res.json({
      configured: true, error: err.message,
      runs: [
        { id:"#142", name:"Transport-risk-dashborad", status:"running", branch:"main", dur:"Running...", trigger:"push", time:"2 min ago",  commit:"a4f3c21" },
        { id:"#141", name:"Transport-risk-dashborad", status:"success", branch:"main", dur:"4m 32s",    trigger:"push", time:"1 hr ago",   commit:"9d2b8e1" },
        { id:"#140", name:"ai-transport-risk-demo",   status:"success", branch:"main", dur:"6m 18s",    trigger:"push", time:"3 hrs ago",  commit:"c7e5a30" },
        { id:"#139", name:"fiori-saple-app",          status:"failed",  branch:"main", dur:"1m 44s",    trigger:"push", time:"5 hrs ago",  commit:"f1a9d42" },
        { id:"#138", name:"ai-transport-risk-demo",   status:"success", branch:"main", dur:"3m 55s",    trigger:"push", time:"8 hrs ago",  commit:"b8c2f67" },
      ],
      stages: [],
      summary: { totalJobs: 3, running: 1, success: 3, failed: 1,
        jobs: [{ id:"1", name:"Transport-risk-dashborad", state:"ON", branch:"main" },
               { id:"2", name:"ai-transport-risk-demo",   state:"ON", branch:"main" },
               { id:"3", name:"fiori-saple-app",          state:"ON", branch:"main" }] },
    });
  }
});

app.get("/api/cicd/debug", async (req, res) => {
  try {
    const raw = await fetchViaDestination(CICD_DEST_NAME, "/api/v1/jobs");
    res.json({ raw, keys: Object.keys(raw || {}), isArray: Array.isArray(raw) });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.get("/api/cicd/jobs", async (req, res) => {
  try {
    let data;
    if (destinationCredentials) {
      try { data = await fetchViaDestination(CICD_DEST_NAME, "/api/v1/jobs"); } catch {}
    }
    if (!data) {
      const token = await getCICDToken();
      const r = await axios.get(`${getCICDBaseUrl()}/api/v1/jobs`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, httpsAgent,
      });
      data = r.data;
    }
    res.json({ configured: true, jobs: data?.collection || data?.jobs || data?.value || (Array.isArray(data) ? data : []) });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.get("/api/cicd/status", async (req, res) => {
  try {
    const token = await getCICDToken();
    res.json({ configured: true, reachable: true, baseUrl: getCICDBaseUrl() });
  } catch (err) { res.json({ configured: !!getCICDBaseUrl(), reachable: false, error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SAP Cloud Transport Management
// ═══════════════════════════════════════════════════════════════════════════════
// Cloud TM uses its OWN XSUAA (Al_node service key, subaccountid: 96e8107f)
// The destination token has WRONG AUDIENCE — use direct credentials instead
// Set CLOUD_TM_SERVICE_KEY env var with Al_node service key JSON

let cloudTmToken       = null;
let cloudTmTokenExpiry = 0;

async function getCloudTmToken() {
  if (cloudTmToken && Date.now() < cloudTmTokenExpiry - 30000) return cloudTmToken;
  let clientId, clientSecret, tokenUrl;
  if (process.env.CLOUD_TM_SERVICE_KEY) {
    try {
      const k = JSON.parse(process.env.CLOUD_TM_SERVICE_KEY);
      clientId     = k.uaa?.clientid     || k.clientid;
      clientSecret = k.uaa?.clientsecret || k.clientsecret;
      tokenUrl     = k.uaa?.url          || k.url;
      if (!process.env.CLOUD_TM_URL && k.uri) process.env.CLOUD_TM_URL = k.uri;
    } catch {}
  }
  clientId     = clientId     || process.env.CLOUD_TM_CLIENT_ID;
  clientSecret = clientSecret || process.env.CLOUD_TM_CLIENT_SECRET;
  tokenUrl     = tokenUrl     || process.env.CLOUD_TM_TOKEN_URL;
  if (!clientId) throw new Error("Cloud TM credentials not configured. Set CLOUD_TM_SERVICE_KEY env var.");
  const fullUrl = tokenUrl.endsWith("/oauth/token") ? tokenUrl : `${tokenUrl}/oauth/token`;
  const r = await axios.post(fullUrl,
    new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent }
  );
  cloudTmToken       = r.data.access_token;
  cloudTmTokenExpiry = Date.now() + (r.data.expires_in || 3600) * 1000;
  console.log("✅ Cloud TM token fetched");
  return cloudTmToken;
}

function getCloudTmBaseUrl() {
  if (process.env.CLOUD_TM_SERVICE_KEY) {
    try { return JSON.parse(process.env.CLOUD_TM_SERVICE_KEY).uri || null; } catch {}
  }
  return process.env.CLOUD_TM_URL ||
         "https://hcl-integrationsuite-qxeoz78m.ts.cfapps.eu10.hana.ondemand.com";
}

// Cloud TM always uses direct token (destination token has wrong audience)
async function callCloudTm(path, params = {}) {
  const baseUrl = getCloudTmBaseUrl();
  const qs  = Object.keys(params).length ? "?" + new URLSearchParams(params).toString() : "";
  const url = `${baseUrl}/v1${path}${qs}`;
  const token = await getCloudTmToken();
  console.log(`🔄 Cloud TM: ${url}`);
  const r = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    httpsAgent, timeout: 12000,
  });
  return r.data;
}

function mapTmRequest(r) {
  return {
    id:          r.id                                    || "—",
    name:        r.description                           || r.id || "—",
    description: r.description                           || "—",
    status:      r.state   || r.status                  || "Initial",
    owner:       r.owner   || r.createdBy                || "—",
    createdAt:   r.createdAt                             || null,
    targetNode:  r.origin  || r.targetNode               || "—",
    contentType: r.preferredContentType || r.contentType || "MTA",
  };
}

function inferEnv(name) {
  const n = (name || "").toUpperCase();
  if (n.includes("PROD") || n.includes("PRD"))  return "PROD";
  if (n.includes("QAS")  || n.includes("TEST")) return "QAS";
  if (n.includes("DEV"))                         return "DEV";
  return "—";
}

function mockTmNodes()    { return [{ id:"node-dev",name:"HCL-BTP-DEV",env:"DEV",type:"MTA",queueCount:6},{id:"node-qas",name:"HCL-BTP-QAS",env:"QAS",type:"MTA",queueCount:3},{id:"node-prod",name:"HCL-BTP-PROD",env:"PROD",type:"MTA",queueCount:1}]; }
function mockTmSummary()  { return { totalNodes:3,totalPending:4,totalRequests:6,imported:3,failed:1,initial:2,timestamp:new Date().toISOString(),isMock:true }; }
function mockTmRequests() {
  return [
    {id:"TQ-0042",name:"transport-dashboard-v3.1.2",status:"Initial", owner:"RBASIS", createdAt:new Date().toISOString(),targetNode:"HCL-BTP-DEV",contentType:"MTA"},
    {id:"TQ-0041",name:"cloud-alm-backend-v2.4",    status:"Imported",owner:"RDEV01", createdAt:new Date().toISOString(),targetNode:"HCL-BTP-QAS",contentType:"MTA"},
    {id:"TQ-0040",name:"integration-monitor-v1.1",  status:"Failed",  owner:"RINTERF",createdAt:new Date().toISOString(),targetNode:"HCL-BTP-QAS",contentType:"MTA"},
  ];
}

app.get("/api/cloudtm/debug", async (req, res) => {
  const result = { step1_destService: !!destinationCredentials, step2_config: null,
                   step3_token: false, step4_apiResponse: null, step5_error: null };
  try {
    if (destinationCredentials) {
      const config = await getDestinationConfig(CLOUD_TM_DEST_NAME);
      const conf   = config.destinationConfiguration || {};
      const tok    = (config.authTokens || [])[0];
      result.step2_config = { name: CLOUD_TM_DEST_NAME, url: conf.URL || conf.url,
                              authType: conf.Authentication, tokenUrl: conf.tokenServiceURL,
                              hasTokens: (config.authTokens || []).length > 0,
                              tokenError: tok?.error || null };
      if (tok?.value && !tok.error) result.step3_token = true;
    }
    // Try direct token
    try {
      const token = await getCloudTmToken();
      result.step3_token = true;
      const data = await callCloudTm("/nodes");
      result.step4_apiResponse = data;
    } catch (e) {
      result.step5_error = "API call failed: " + (e.response?.data ? JSON.stringify(e.response.data) : e.message);
    }
    res.json(result);
  } catch (e) { res.json({ ...result, step5_error: e.message }); }
});

app.get("/api/cloudtm/status", async (req, res) => {
  try {
    await getCloudTmToken();
    res.json({ configured: true, reachable: true, baseUrl: getCloudTmBaseUrl() });
  } catch (e) { res.json({ configured: false, reachable: false, error: e.message }); }
});

app.get("/api/cloudtm/nodes", async (req, res) => {
  try {
    const data  = await callCloudTm("/nodes");
    const nodes = (data.nodes || data.value || data || []).map(n => ({
      id: n.nodeId || n.id, name: n.nodeName || n.name,
      type: n.contentType || "MTA", env: inferEnv(n.nodeName || n.name),
    }));
    res.json({ nodes, count: nodes.length });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/cloudtm/queues", async (req, res) => {
  try {
    const nodesData = await callCloudTm("/nodes");
    const nodes = nodesData.nodes || nodesData.value || nodesData || [];
    const queueResults = await Promise.allSettled(nodes.map(async (n) => {
      const nodeId = n.nodeId || n.id;
      try {
        const qd = await callCloudTm(`/nodes/${nodeId}/transportRequests`);
        const entries = (qd.transportRequests || qd.transports || qd.value || qd || []).map(mapTmRequest);
        return { node: n.nodeName || n.name, nodeId, env: inferEnv(n.nodeName || n.name), entries };
      } catch { return { node: n.nodeName || n.name, nodeId, env: inferEnv(n.nodeName || n.name), entries: [] }; }
    }));
    const queues = queueResults.map(r => r.status === "fulfilled" ? r.value : { entries: [] });
    res.json({ queues, totalPending: queues.reduce((s, q) => s + q.entries.length, 0) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/cloudtm/requests", async (req, res) => {
  const { limit = 50 } = req.query;
  try {
    const data = await callCloudTm("/transportRequests", { pageSize: limit });
    const requests = (data.transports || data.transportRequests || data.value || data || []).map(mapTmRequest);
    res.json({ requests, count: requests.length });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/cloudtm/requests/:id", async (req, res) => {
  try {
    const data = await callCloudTm("/transportRequests/" + req.params.id);
    res.json(mapTmRequest(data));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/cloudtm/dashboard", async (req, res) => {
  const hasKey = !!(process.env.CLOUD_TM_SERVICE_KEY || process.env.CLOUD_TM_CLIENT_ID || process.env.CLOUD_TM_URL);
  if (!hasKey) {
    return res.json({ configured: false,
      message: "Set CLOUD_TM_SERVICE_KEY env var (paste Al_node service key JSON)",
      nodes: mockTmNodes(), queues: [], requests: mockTmRequests(), summary: mockTmSummary() });
  }
  try {
    const [nodesData, requestsData] = await Promise.all([
      callCloudTm("/nodes"),
      callCloudTm("/transportRequests", { pageSize: 100 }),
    ]);
    const nodes    = nodesData.nodes || nodesData.value || [];
    const requests = (requestsData.transports || requestsData.transportRequests || requestsData.value || []).map(mapTmRequest);
    const queueResults = await Promise.allSettled(nodes.map(async (n) => {
      const nodeId = n.nodeId || n.id;
      try {
        const qd = await callCloudTm(`/nodes/${nodeId}/transportRequests`);
        return { node: n.nodeName || n.name, nodeId, env: inferEnv(n.nodeName || n.name),
                 entries: (qd.transportRequests || qd.transports || qd.value || qd || []).map(mapTmRequest) };
      } catch { return { node: n.nodeName || n.name, nodeId, env: inferEnv(n.nodeName || n.name), entries: [] }; }
    }));
    const queues       = queueResults.map(r => r.status === "fulfilled" ? r.value : { entries: [] });
    const totalPending = queues.reduce((s, q) => s + q.entries.length, 0);
    const summary = { totalNodes: nodes.length, totalPending, totalRequests: requests.length,
                      imported: requests.filter(r => r.status === "Imported").length,
                      failed:   requests.filter(r => r.status === "Failed").length,
                      initial:  requests.filter(r => r.status === "Initial").length,
                      timestamp: new Date().toISOString() };
    console.log(`✅ Cloud TM dashboard: ${nodes.length} nodes, ${totalPending} pending, ${requests.length} requests`);
    res.json({ configured: true, nodes: nodes.map(n => ({
      id: n.nodeId || n.id, name: n.nodeName || n.name,
      type: n.contentType || "MTA", env: inferEnv(n.nodeName || n.name),
      queueCount: queues.find(q => q.nodeId === (n.nodeId || n.id))?.entries?.length ?? 0,
    })), queues, requests: requests.slice(0, 50), summary });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("Cloud TM dashboard:", typeof detail === "object" ? JSON.stringify(detail) : detail);
    res.json({ configured: true, error: typeof detail === "object" ? JSON.stringify(detail) : detail,
               nodes: mockTmNodes(), queues: [], requests: mockTmRequests(), summary: mockTmSummary() });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Static / Frontend
// ═══════════════════════════════════════════════════════════════════════════════
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  next();
});
app.use(express.static(path.join(__dirname, "../frontend")));
app.get("/alm", (req, res) => res.sendFile(path.join(__dirname, "../frontend/cloud_alm.html")));
app.get("/cloud_alm.html", (req, res) => res.sendFile(path.join(__dirname, "../frontend/cloud_alm.html")));
app.get(/^\/(?!api|debug).*/, (req, res) => res.sendFile(path.join(__dirname, "../frontend/index.html")));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatDuration(ms) {
  if (!ms) return "—";
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}
function timeAgo(date) {
  const diff = Date.now() - date.getTime(), mins = Math.floor(diff / 60000);
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs} hr${hrs > 1 ? "s" : ""} ago`;
  return `${Math.floor(hrs / 24)} day${Math.floor(hrs / 24) > 1 ? "s" : ""} ago`;
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 TransTrack Pro backend running on port ${PORT}`);
  console.log(`   VCAP — xsuaa:${!!xsuaaCredentials} dest:${!!destinationCredentials} conn:${!!connectivityCredentials}`);
  console.log(`   Cloud TM KEY: ${!!process.env.CLOUD_TM_SERVICE_KEY}`);
  console.log(`   CI/CD KEY:    ${!!process.env.CICD_SERVICE_KEY}`);
  console.log(`   AI Core KEY:  ${!!process.env.AICORE_SERVICE_KEY}`);
});
