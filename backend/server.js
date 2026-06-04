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
const AI_CORE_MODEL_NAME = process.env.AI_CORE_MODEL_NAME || "gpt-5.2";

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

  // Search known resource groups — security-intelligence-hub first (has GPT-4.1)
  const resourceGroups = [
    "security-intelligence-hub",
    "default",
    process.env.AI_CORE_RESOURCE_GROUP,
  ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);

  // Step 1: Try to list all resource groups and add them
  try {
    const rgRes = await axios.get(`${baseUrl}/v2/admin/resourceGroups`, {
      headers: { Authorization: `Bearer ${token}` },
      httpsAgent, timeout: 10000,
    });
    const fetched = (rgRes.data?.resourceGroups || rgRes.data?.value || [])
      .map(rg => rg.resourceGroupId || rg.id || rg.name).filter(Boolean);
    // Add any new ones not already in list
    fetched.forEach(rg => { if (!resourceGroups.includes(rg)) resourceGroups.push(rg); });
    console.log(`✅ AI Core resource groups: ${resourceGroups.join(", ")}`);
  } catch (err) {
    console.warn(`⚠️ Resource group list failed [${err.response?.status}]`);
  }

  // Step 2: Search each resource group — prefer GPT/Azure OpenAI models
  for (const rg of resourceGroups) {
    try {
      const res = await axios.get(`${baseUrl}/v2/lm/deployments?status=RUNNING`, {
        headers: { Authorization: `Bearer ${token}`, "AI-Resource-Group": rg },
        httpsAgent, timeout: 10000,
      });

      const list = res.data?.resources || res.data?.value || [];
      if (!Array.isArray(list) || list.length === 0) continue;

      console.log(`ℹ️  Resource group '${rg}' has ${list.length} RUNNING deployment(s):`);
      list.forEach(d => console.log(`   - ${d.id} | model: ${d.details?.resources?.backendDetails?.modelName || d.modelName || "unknown"} | status: ${d.status}`));

      // Prefer GPT/Azure OpenAI models — avoid Claude for chat/completions endpoint
      const gptDep = list.find(d => {
        const model = (d.details?.resources?.backendDetails?.modelName || d.modelName || "").toLowerCase();
        return model.includes("gpt") || model.includes("azure") || model.includes("4");
      });

      const dep = gptDep || list.find(d => {
        const model = (d.details?.resources?.backendDetails?.modelName || d.modelName || "").toLowerCase();
        return !model.includes("claude") && !model.includes("anthropic");
      });

      if (dep) {
        const id = dep.id || dep.deploymentId;
        const modelName = dep.details?.resources?.backendDetails?.modelName || dep.modelName || AI_CORE_MODEL_NAME;
        console.log(`✅ Selected deployment: ${id} | model: ${modelName} | rg: ${rg}`);
        aiCoreDeploymentCache  = { deploymentId: id, resourceGroup: rg, baseUrl, modelName };
        aiCoreDeploymentExpiry = Date.now() + 10 * 60 * 1000;
        return aiCoreDeploymentCache;
      }
    } catch (err) {
      console.warn(`⚠️ Deployments in '${rg}' failed [${err.response?.status}]`);
    }
  }

  throw new Error(`No suitable RUNNING deployment found in: ${resourceGroups.join(", ")}`);
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

  // Request destination with token — use ?$needsAdditionalUserAuthorization=false
  // to get a full service token with all scopes
  const res = await axios.get(
    `${destinationCredentials.uri}/destination-configuration/v1/destinations/${CALM_DESTINATION_NAME}`,
    {
      headers: { Authorization: `Bearer ${destToken}` },
      httpsAgent,
    }
  );

  const config     = res.data?.destinationConfiguration || {};
  const authTokens = res.data?.authTokens || [];
  const authToken  = authTokens[0]?.value;
  const tokenType  = authTokens[0]?.type || "Bearer";
  const expiresIn  = parseInt(authTokens[0]?.expiresIn || "3600");
  const tokenError = authTokens[0]?.error;

  if (tokenError) {
    console.error(`❌ Destination token error: ${tokenError}`);
    throw new Error(`Destination token error: ${tokenError}`);
  }

  if (!authToken) {
    throw new Error(
      `Destination '${CALM_DESTINATION_NAME}' resolved but no auth token. ` +
      `Check OAuth2ClientCredentials config in BTP Destination.`
    );
  }

  // Fix base URL — use regional API URL
  const destUrl = config.URL || config.url || "";
  let baseUrl   = destUrl;
  if (destUrl.includes(".eu10.alm.cloud.sap") && !destUrl.startsWith("https://eu10.alm.cloud.sap")) {
    baseUrl = "https://eu10.alm.cloud.sap";
    console.log(`ℹ️  Using regional ALM API URL: ${baseUrl}`);
  }
  if (!baseUrl) throw new Error(`Destination '${CALM_DESTINATION_NAME}' has no URL.`);

  console.log(`✅ Cloud ALM destination resolved → ${baseUrl} | token: ${authToken.slice(0,20)}...`);

  calmDestCache = { baseUrl, authToken, tokenType, expiry: Date.now() + expiresIn * 1000 };
  return calmDestCache;
}

// ─── Direct ALM token fetch (fallback using service key from VCAP) ────────────
let directCalmToken       = null;
let directCalmTokenExpiry = 0;

// ─── X.509 Certificate Token Fetch for Cloud ALM ─────────────────────────────
// Cloud ALM service key uses credential type x509 (mTLS)
// Credentials come from VCAP_SERVICES or env vars:
//   CALM_CLIENT_ID       = clientid from service key uaa section
//   CALM_CERTIFICATE     = certificate (PEM) from service key uaa.certificate
//   CALM_PRIVATE_KEY     = privateKey (PEM) from service key uaa.key
//   CALM_TOKEN_URL       = uaa.certurl + /oauth/token  (NOT uaa.url)
//   CALM_BASE_URL        = https://eu10.alm.cloud.sap
async function getDirectCALMToken() {
  if (directCalmToken && Date.now() < directCalmTokenExpiry - 30000) return directCalmToken;

  let clientId, certificate, privateKey, certUrl, standardUrl;

  // Try VCAP_SERVICES first
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
    const calm = vcap["cloud-alm"]?.[0]?.credentials
              || vcap["cloudalm"]?.[0]?.credentials
              || vcap["alm"]?.[0]?.credentials;
    if (calm) {
      clientId     = calm.uaa?.clientid    || calm.clientid;
      certificate  = calm.uaa?.certificate;
      privateKey   = calm.uaa?.key;
      certUrl      = calm.uaa?.certurl;    // mTLS endpoint — HAS .cert. in hostname
      standardUrl  = calm.uaa?.url;        // standard endpoint
      console.log(`ℹ️  Cloud ALM x509 from VCAP: certurl=${!!certUrl} url=${!!standardUrl}`);
    }
  } catch {}

  // Fallback to env vars
  clientId    = clientId    || process.env.CALM_CLIENT_ID;
  certificate = certificate || process.env.CALM_CERTIFICATE;
  privateKey  = privateKey  || process.env.CALM_PRIVATE_KEY;

  // CALM_TOKEN_URL should be certurl — if it doesn't have .cert. we try adding it
  const envTokenUrl = process.env.CALM_TOKEN_URL || "";
  if (envTokenUrl.includes(".cert.")) {
    certUrl = envTokenUrl;
  } else if (envTokenUrl) {
    // Convert standard URL to cert URL automatically
    certUrl     = envTokenUrl.replace(".authentication.", ".authentication.cert.");
    standardUrl = envTokenUrl;
  }

  if (!clientId || !certificate || !privateKey) {
    console.warn(`⚠️ x509 credentials incomplete: clientId=${!!clientId} cert=${!!certificate} key=${!!privateKey}`);
    return null;
  }

  // Clean PEM strings (env vars may have escaped newlines or spaces)
  const cleanCert = certificate.replace(/\\n/g, "\n").replace(/\s+-----/g, "\n-----").replace(/-----\s+/g, "-----\n");
  const cleanKey  = privateKey.replace(/\\n/g, "\n").replace(/\s+-----/g, "\n-----").replace(/-----\s+/g, "-----\n");

  // Create mTLS agent with certificate
  const mtlsAgent = new https.Agent({
    cert: cleanCert,
    key:  cleanKey,
    rejectUnauthorized: false,
  });

  // Try certurl first (correct for x509), then standard url as fallback
  const tokenUrls = [certUrl, standardUrl].filter(Boolean).map(u =>
    u.endsWith("/oauth/token") ? u : `${u}/oauth/token`
  );

  for (const tokenUrl of tokenUrls) {
    try {
      console.log(`ℹ️  Trying x509 token from: ${tokenUrl}`);
      const res = await axios.post(
        tokenUrl,
        new URLSearchParams({ grant_type: "client_credentials", client_id: clientId }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent: mtlsAgent }
      );
      directCalmToken       = res.data.access_token;
      directCalmTokenExpiry = Date.now() + (res.data.expires_in || 3600) * 1000;
      console.log(`✅ Cloud ALM x509 token fetched via: ${tokenUrl}`);
      return directCalmToken;
    } catch (err) {
      console.warn(`⚠️ x509 token failed [${err.response?.status||'ERR'}] ${tokenUrl}: ${err.message?.slice(0,80)}`);
    }
  }

  console.error("❌ All x509 token attempts failed");
  return null;
}

// ─── Parse Cloud ALM response — handles value[], results[], and array-indexed {} ──
function parseALMResponse(data) {
  if (!data) return [];
  // Standard OData: { value: [...] }
  if (Array.isArray(data.value))   return data.value;
  // OData results: { results: [...] }
  if (Array.isArray(data.results)) return data.results;
  // Direct array
  if (Array.isArray(data))         return data;
  // Array-indexed object: {"0":{...},"1":{...},"count":96}
  // This is what Cloud ALM projects API returns!
  const keys = Object.keys(data).filter(k => !isNaN(parseInt(k)));
  if (keys.length > 0) {
    console.log(`ℹ️  ALM array-indexed response detected — ${keys.length} items`);
    return keys.map(k => data[k]).filter(Boolean);
  }
  return [];
}

// ─── ALM GET helper — destination token first, then x509 direct token ─────────
async function fetchFromALM(path) {
  const { baseUrl, authToken, tokenType } = await resolveCALMDestination();

  // Try destination token first
  try {
    const res = await axios.get(`${baseUrl}${path}`, {
      headers: { Authorization: `${tokenType} ${authToken}`, Accept: "application/json" },
      httpsAgent,
    });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    // 401/403 = token issue → try x509 direct token
    if (status === 401 || status === 403) {
      console.warn(`⚠️ Destination token rejected [${status}] — trying x509 direct token`);
      const directToken = await getDirectCALMToken().catch(e => {
        console.warn(`⚠️ x509 token failed: ${e.message}`);
        return null;
      });
      if (directToken) {
        console.log(`ℹ️  Retrying with x509 token: ${path}`);
        const res2 = await axios.get(`${baseUrl}${path}`, {
          headers: { Authorization: `Bearer ${directToken}`, Accept: "application/json" },
          httpsAgent,
        });
        return res2.data;
      }
    }
    throw err;
  }
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

// ─── X509 + Projects deep debug ──────────────────────────────────────────────
app.get("/api/calm/x509debug", async (req, res) => {
  const result = { steps: {} };

  // Step 1: Check env vars
  const tokenUrl = process.env.CALM_TOKEN_URL || "";
  result.steps["1_env_vars"] = {
    CALM_CLIENT_ID:         !!(process.env.CALM_CLIENT_ID),
    CALM_CERTIFICATE:       !!(process.env.CALM_CERTIFICATE),
    CALM_PRIVATE_KEY:       !!(process.env.CALM_PRIVATE_KEY),
    CALM_TOKEN_URL:         tokenUrl || "NOT SET",
    CALM_TOKEN_URL_hasCert: tokenUrl.includes(".cert."),
    certUrlWillUse:         tokenUrl.includes(".cert.") ? tokenUrl : tokenUrl.replace(".authentication.", ".authentication.cert."),
    certLength:             (process.env.CALM_CERTIFICATE || "").length,
    keyLength:              (process.env.CALM_PRIVATE_KEY  || "").length,
    certStartsCorrectly:    (process.env.CALM_CERTIFICATE || "").includes("BEGIN CERTIFICATE"),
    keyStartsCorrectly:     (process.env.CALM_PRIVATE_KEY  || "").includes("BEGIN"),
  };

  // Step 2: Try x509 token
  let x509Token = null;
  try {
    x509Token = await getDirectCALMToken();
    result.steps["2_x509_token"] = {
      ok: !!x509Token,
      tokenPreview: x509Token ? x509Token.slice(0, 30) + "..." : null,
    };
  } catch (e) {
    result.steps["2_x509_token"] = { ok: false, error: e.message };
  }

  // Step 3: Try destination token
  let destToken = null;
  try {
    const dest = await resolveCALMDestination();
    destToken = dest.authToken;
    result.steps["3_dest_token"] = {
      ok:      !!destToken,
      baseUrl: dest.baseUrl,
      tokenPreview: destToken ? destToken.slice(0, 30) + "..." : null,
    };
  } catch (e) {
    result.steps["3_dest_token"] = { ok: false, error: e.message };
  }

  // Step 4: Try projects with BOTH tokens and show raw response
  const baseUrl = "https://eu10.alm.cloud.sap";
  for (const [label, token] of [["dest_token", destToken], ["x509_token", x509Token]]) {
    if (!token) { result.steps[`4_projects_${label}`] = { skipped: true }; continue; }
    try {
      const r = await axios.get(`${baseUrl}/api/calm-projects/v1/projects?$top=5`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        httpsAgent,
      });
      result.steps[`4_projects_${label}`] = {
        ok:        true,
        status:    r.status,
        keys:      Object.keys(r.data || {}),
        count:     parseALMResponse(r.data).length,
        rawSample: JSON.stringify(r.data).slice(0, 500),
      };
    } catch (e) {
      result.steps[`4_projects_${label}`] = {
        ok:     false,
        status: e.response?.status,
        error:  e.message,
        body:   JSON.stringify(e.response?.data || {}).slice(0, 300),
      };
    }
  }

  // Step 5: Try tenant-specific URL too
  const tenantUrl = "https://hcl-america-solutions-inc-cloudalm.eu10.alm.cloud.sap";
  for (const [label, token] of [["dest", destToken], ["x509", x509Token]]) {
    if (!token) continue;
    try {
      const r = await axios.get(`${tenantUrl}/api/calm-projects/v1/projects?$top=5`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        httpsAgent,
      });
      result.steps[`5_tenant_url_${label}`] = {
        ok: true, count: parseALMResponse(r.data).length,
        rawSample: JSON.stringify(r.data).slice(0, 300),
      };
    } catch (e) {
      result.steps[`5_tenant_url_${label}`] = {
        ok: false, status: e.response?.status,
        body: JSON.stringify(e.response?.data || {}).slice(0, 200),
      };
    }
  }

  res.json(result);
});


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
      const data  = await fetchFromALM(path);
      const items = parseALMResponse(data);
      console.log(`✅ ALM path OK: ${path} (${items.length} items)`);
      // Attach _parsed so downstream can use parseALMResponse result
      if (data && typeof data === 'object') data._parsed = items;
      return data;
    } catch (err) {
      const status = err.response?.status || "ERR";
      console.warn(`⚠️ ALM path failed [${status}]: ${path}`);
      if (status === 400) {
        const body = JSON.stringify(err.response?.data || {}).slice(0, 200);
        console.warn(`   400 body: ${body}`);
      }
    }
  }
  return null;
}

// 5. GET /api/calm/health
app.get("/api/calm/health", async (req, res) => {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      console.warn("⚠️ ALM health timeout");
      res.json({
        criticalAlerts:0, warningAlerts:0,
        transportManagement:{pendingCount:0,failedCount:0,pipelineStatus:"UNKNOWN",lastDeployment:null},
        changeManagement:{openCount:0,pendingApproval:0,approvedCount:0,rejectedCount:0,deployedCount:0,complianceRate:100,projectCount:0,taskCount:0},
        healthMonitoring:{criticalCount:0,warningCount:0,prodAvailability:"99.9",systemsMonitored:0},
        alerts:[], projects:[], error:"timeout"
      });
    }
  }, 9000);

  try {
    // Fetch ONLY projects first — this is confirmed working
    // Features and health monitoring fetched in parallel but don't block response
    const projectsRaw = await tryALMPaths([
      "/api/calm-projects/v1/projects?$top=100",
      "/api/imp-pjm-srv/v1/projects?$top=100",
    ]);
    const projects = parseALMResponse(projectsRaw);
    console.log(`✅ ALM projects: ${projects.length}`);

    // Fire features + health in parallel — don't await if they take too long
    const [featRaw, hmRaw] = await Promise.all([
      tryALMPaths(["/api/imp-cdm-srv/v1/features?$top=100","/api/imp-cdm-srv/v0/features?$top=100"]).catch(()=>null),
      tryALMPaths(["/api/ops-alm-evt-srv/v1/events?$top=50","/api/calm-health/v1/events?$top=50"]).catch(()=>null),
    ]);
    const features = parseALMResponse(featRaw);
    const hmAlerts = parseALMResponse(hmRaw);

    // Tasks for first 3 projects in parallel
    let allTasks = [];
    if (projects.length > 0) {
      const taskResults = await Promise.all(
        projects.slice(0, 3).map(async proj => {
          const pid = proj.id || proj.projectId;
          if (!pid) return [];
          const r = await tryALMPaths([
            `/api/calm-tasks/v1/tasks?projectId=${pid}&$top=30`,
          ]).catch(()=>null);
          return parseALMResponse(r);
        })
      );
      allTasks = taskResults.flat();
    }

    // Compute metrics
    const tmItems  = features;
    const tmFailed = tmItems.filter(i=>["FAILED","ERROR","ABORTED"].includes(i.status)).length;
    const tmPending= tmItems.filter(i=>["READY","PENDING","IN_PROGRESS"].includes(i.status)).length;
    const pipelineStatus = tmFailed>0?"BLOCKED":tmPending>5?"DEGRADED":projects.length>0?"OK":"UNKNOWN";

    const cmSource  = allTasks.length>0 ? allTasks : projects;
    const cmOpen    = cmSource.filter(i=>["OPEN","O","IN_PROGRESS"].includes(i.status)).length;
    const cmClosed  = cmSource.filter(i=>["CLOSED","C","DONE","COMPLETED"].includes(i.status)).length;
    const cmPending = cmSource.filter(i=>["PENDING","PENDING_APPROVAL"].includes(i.status)).length;
    const cmTotal   = cmSource.length;
    const cmCompliance = cmTotal>0 ? Math.round(((cmTotal-cmSource.filter(i=>i.status==="REJECTED").length)/cmTotal)*100) : 100;

    const hmCritical = hmAlerts.filter(a=>["CRITICAL","ERROR"].includes(a.severity)).length;
    const hmWarning  = hmAlerts.filter(a=>a.severity==="WARNING").length;
    const prodAvail  = hmCritical>0 ? String(Math.max(85,100-hmCritical*3).toFixed(1)) : "99.9";

    console.log(`✅ ALM health done: proj=${projects.length} tasks=${allTasks.length} feat=${features.length} hm=${hmAlerts.length}`);

    clearTimeout(timer);
    if (res.headersSent) return;
    res.json({
      criticalAlerts: hmCritical,
      warningAlerts:  hmWarning,
      transportManagement:{pendingCount:tmPending,failedCount:tmFailed,pipelineStatus,lastDeployment:null,featuresCount:features.length},
      changeManagement:{openCount:cmOpen,pendingApproval:cmPending,approvedCount:cmClosed,rejectedCount:0,deployedCount:cmClosed,complianceRate:cmCompliance,projectCount:projects.length,taskCount:allTasks.length,source:allTasks.length>0?"tasks":"projects"},
      healthMonitoring:{criticalCount:hmCritical,warningCount:hmWarning,prodAvailability:prodAvail,systemsMonitored:[...new Set(hmAlerts.map(a=>a.serviceId||a.systemId).filter(Boolean))].length},
      alerts: hmAlerts.slice(0,50).map(a=>({id:a.id,severity:a.severity,systemId:a.serviceId||a.systemId||"SYSTEM",message:a.description||a.name||"Alert",type:a.alertType||a.type,createdAt:a.createdAt})),
      projects: projects.slice(0,96).map(p=>({id:p.id||p.projectId,title:p.name||p.title||"",status:p.status||"OPEN",type:p.type||p.projectType||"PROJECT",currentPhase:p.currentPhase||p.phase,startDate:p.startDate,endDate:p.endDate,createdAt:p.createdAt||p.createDate,operationalStatus:p.operationalStatus,purpose:p.purpose})),
    });

  } catch(err) {
    clearTimeout(timer);
    if (res.headersSent) return;
    console.error("❌ /api/calm/health error:", err.message);
    res.json({
      criticalAlerts:0,warningAlerts:0,
      transportManagement:{pendingCount:0,failedCount:0,pipelineStatus:"UNKNOWN",lastDeployment:null},
      changeManagement:{openCount:0,pendingApproval:0,approvedCount:0,rejectedCount:0,deployedCount:0,complianceRate:100,projectCount:0,taskCount:0},
      healthMonitoring:{criticalCount:0,warningCount:0,prodAvailability:"99.9",systemsMonitored:0},
      alerts:[],projects:[],error:err.message
    });
  }
});


// 6. GET /api/calm/changes/all
app.get("/api/calm/changes/all", async (req, res) => {
  try {
    // Get projects first
    const projectsRaw = await tryALMPaths([
      "/api/calm-projects/v1/projects?$top=100",
      "/api/imp-pjm-srv/v1/projects?$top=100",
    ]);
    const projects = parseALMResponse(projectsRaw);

    // Get tasks for each project
    let allTasks = [];
    for (const proj of projects.slice(0, 10)) {
      const pid = proj.id || proj.projectId;
      if (!pid) continue;
      const tasksRaw = await tryALMPaths([
        `/api/calm-tasks/v1/tasks?projectId=${pid}&$top=100`,
        `/api/imp-tkm-srv/v1/tasks?projectId=${pid}&$top=100`,
      ]);
      const tasks = parseALMResponse(tasksRaw).map(t => ({
        ...t,
        projectName: proj.name || proj.title || pid,
      }));
      allTasks = allTasks.concat(tasks);
    }

    // If no tasks, return projects as items
    const source = allTasks.length > 0 ? allTasks : projects;

    const items = source.map(item => ({
      id:          item.id          || item.projectId || "",
      title:       item.title       || item.name      || item.subject    || "",
      status:      item.status      || "OPEN",
      assigneeId:  item.assigneeId  || item.assignee  || item.responsible || "",
      priority:    item.priority    || "",
      description: item.description || item.projectName || "",
      externalId:  item.externalId  || "",
      dueDate:     item.dueDate     || item.plannedEndDate || null,
      createdAt:   item.createdAt   || item.createDate,
      changedAt:   item.changedAt   || item.lastChangedDate,
    }));

    console.log(`✅ /api/calm/changes/all: ${items.length} items (${projects.length} projects, ${allTasks.length} tasks)`);
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
    const items = parseALMResponse(data);

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
    const items = (parseALMResponse(data)).map(d => ({
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

  // Source 1: VCAP_SERVICES binding (BTP CF app bound to aicore service)
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
    const allEntries = Object.values(vcap).flat();
    const entry = allEntries.find(s =>
      s?.credentials?.serviceurls?.AI_API_URL ||
      s?.label?.includes("aicore") ||
      s?.tags?.includes("aicore")
    );
    if (entry?.credentials) {
      clientId     = entry.credentials.clientid     || entry.credentials.client_id;
      clientSecret = entry.credentials.clientsecret || entry.credentials.client_secret;
      tokenUrl     = entry.credentials.url          || entry.credentials.uaa?.url;
      console.log("ℹ️  AI Core credentials from VCAP_SERVICES binding");
    }
  } catch {}

  // Source 2: AICORE_SERVICE_KEY env var (paste full service key JSON)
  if (!clientId && process.env.AICORE_SERVICE_KEY) {
    try {
      const key = JSON.parse(process.env.AICORE_SERVICE_KEY);
      clientId     = key.clientid     || key.client_id;
      clientSecret = key.clientsecret || key.client_secret;
      tokenUrl     = key.url          || key.uaa?.url;
      // Also load base URL from service key
      if (key.serviceurls?.AI_API_URL && !process.env.AI_CORE_BASE_URL) {
        process.env.AI_CORE_BASE_URL = key.serviceurls.AI_API_URL;
      }
      console.log("ℹ️  AI Core credentials from AICORE_SERVICE_KEY env var");
    } catch {
      console.error("❌ AICORE_SERVICE_KEY is not valid JSON");
    }
  }

  // Source 3: Individual env vars
  clientId     = clientId     || process.env.AI_CORE_CLIENT_ID     || process.env.AICORE_CLIENT_ID;
  clientSecret = clientSecret || process.env.AI_CORE_CLIENT_SECRET || process.env.AICORE_CLIENT_SECRET;
  tokenUrl     = tokenUrl     || process.env.AI_CORE_TOKEN_URL     || process.env.AICORE_TOKEN_URL;

  if (!clientId || !clientSecret || !tokenUrl) {
    throw new Error(
      `SAP AI Core credentials not configured. ` +
      `clientId=${!!clientId} secret=${!!clientSecret} tokenUrl=${!!tokenUrl}. ` +
      `Set AICORE_SERVICE_KEY (paste full service key JSON) or individual AI_CORE_* env vars.`
    );
  }

  const fullTokenUrl = tokenUrl.endsWith("/oauth/token") ? tokenUrl : `${tokenUrl}/oauth/token`;

  const res = await axios.post(
    fullTokenUrl,
    new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent }
  );

  aiCoreToken       = res.data.access_token;
  aiCoreTokenExpiry = Date.now() + (res.data.expires_in || 3600) * 1000;
  console.log("✅ SAP AI Core token fetched");
  return aiCoreToken;
}

function getAICoreBaseUrl() {
  // Source 1: AICORE_SERVICE_KEY (paste full service key JSON)
  if (process.env.AICORE_SERVICE_KEY) {
    try {
      const key = JSON.parse(process.env.AICORE_SERVICE_KEY);
      if (key.serviceurls?.AI_API_URL) return key.serviceurls.AI_API_URL;
    } catch {}
  }
  // Source 2: VCAP_SERVICES binding — scan all entries
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
    const allEntries = Object.values(vcap).flat();
    const entry = allEntries.find(s => s?.credentials?.serviceurls?.AI_API_URL);
    if (entry) return entry.credentials.serviceurls.AI_API_URL;
  } catch {}
  // Source 3: Individual env vars
  return process.env.AI_CORE_BASE_URL || process.env.AICORE_BASE_URL || "";
}

// ─── AI Core inference helper ─────────────────────────────────────────────────
async function callAICore(messages, systemPrompt, maxTokens = 800) {
  const { deploymentId, resourceGroup, baseUrl, modelName } = await discoverAICoreDeployment();
  const token = await getAICoreToken();
  const model = modelName || AI_CORE_MODEL_NAME;

  const endpoints = [
    `${baseUrl}/v2/inference/deployments/${deploymentId}/chat/completions?api-version=2024-12-01`,
    `${baseUrl}/v2/inference/deployments/${deploymentId}/chat/completions`,
    `${baseUrl}/v2/lm/deployments/${deploymentId}/chat/completions?api-version=2024-12-01`,
    `${baseUrl}/v2/lm/deployments/${deploymentId}/chat/completions`,
  ];

  const payload = {
    model,
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
      console.log(`✅ AI Core inference: ${deploymentId} (${resourceGroup}) model: ${model}`);
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
  const hasKey     = !!(process.env.AICORE_SERVICE_KEY || process.env.AI_CORE_CLIENT_ID || process.env.AICORE_CLIENT_ID);
  const configured = !!(baseUrl && hasKey);

  if (!configured) {
    return res.json({
      configured: false, reachable: false, mode: "local-fallback",
      message: "Set AICORE_SERVICE_KEY (paste full service key JSON) or individual AI_CORE_* env vars.",
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
      model:         deployment.modelName || AI_CORE_MODEL_NAME,
      message:       `RUNNING deployment found: ${deployment.deploymentId} in ${deployment.resourceGroup}`,
    });
  } catch (err) {
    res.json({
      configured: true, reachable: false, mode: "local-fallback",
      message: `AI Core error: ${err.message}`,
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  SERVE FRONTEND
// ═════════════════════════════════════════════════════════════════════════════

// No-cache headers for HTML files so changes always take effect
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || req.path === '/alm') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

app.use(express.static(path.join(__dirname, "../frontend")));

// Explicit route for Cloud ALM dashboard
app.get("/alm", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/cloud_alm.html"));
});
app.get("/cloud_alm.html", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/cloud_alm.html"));
});

// Default — serve TransTrack Pro
app.get(/^\/(?!api|debug).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// ─── SAP BTP CI/CD Service ────────────────────────────────────────────────────
//
// cicd-app plan is a SaaS subscription — does NOT support service keys directly.
// Use XSUAA apiaccess service instance instead:
//
// OPTION A (Recommended) — BTP Destination (cross-subaccount, no credentials in env):
//   1. In your CI/CD subaccount: Security → XSUAA → Create instance (plan: apiaccess)
//   2. Create service key on that XSUAA instance → copy clientid/secret/url
//   3. In YOUR subaccount: create destination CICD_DEST with those credentials
//   → server.js uses fetchViaDestination("CICD_DEST", ...) automatically
//
// OPTION B — Direct env vars (if destination not available):
//   CICD_API_URL    = https://cicdservice.cfapps.eu10.hana.ondemand.com
//   CICD_CLIENT_ID  = clientid from XSUAA apiaccess service key
//   CICD_CLIENT_SECRET = clientsecret from XSUAA apiaccess service key
//   CICD_TOKEN_URL  = url from XSUAA apiaccess service key (+ /oauth/token)
//
// OPTION C — CICD_SERVICE_KEY env var (paste full XSUAA apiaccess service key JSON)

let cicdToken = null;
let cicdTokenExpiry = 0;

async function getCICDToken() {
  if (cicdToken && Date.now() < cicdTokenExpiry - 30000) return cicdToken;

  let clientId, clientSecret, tokenUrl;

  // Source 1 — CICD_SERVICE_KEY (paste full XSUAA apiaccess service key JSON)
  if (process.env.CICD_SERVICE_KEY) {
    try {
      const key = JSON.parse(process.env.CICD_SERVICE_KEY);
      // XSUAA apiaccess key has credentials at root or inside uaa block
      clientId     = key.clientid     || key.client_id     || key.uaa?.clientid;
      clientSecret = key.clientsecret || key.client_secret || key.uaa?.clientsecret;
      tokenUrl     = key.url          || key.uaa?.url       || key.tokenurl;
      if (!process.env.CICD_API_URL && key.apiurl) {
        process.env.CICD_API_URL = key.apiurl;
      }
      console.log("ℹ️  CI/CD credentials from CICD_SERVICE_KEY (XSUAA apiaccess)");
    } catch { console.error("❌ CICD_SERVICE_KEY is not valid JSON"); }
  }

  // Source 2 — VCAP_SERVICES (if XSUAA apiaccess instance is bound)
  if (!clientId) {
    try {
      const vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
      const entries = Object.values(vcap).flat();
      const entry = entries.find(s =>
        s?.plan === "apiaccess" ||
        s?.label === "xsuaa" && s?.plan === "apiaccess" ||
        s?.tags?.includes("cicd") ||
        s?.name?.toLowerCase().includes("cicd")
      );
      if (entry?.credentials) {
        clientId     = entry.credentials.clientid     || entry.credentials.client_id;
        clientSecret = entry.credentials.clientsecret || entry.credentials.client_secret;
        tokenUrl     = entry.credentials.url          || entry.credentials.uaa?.url;
        console.log("ℹ️  CI/CD credentials from VCAP_SERVICES (XSUAA apiaccess binding)");
      }
    } catch {}
  }

  // Source 3 — individual env vars
  clientId     = clientId     || process.env.CICD_CLIENT_ID;
  clientSecret = clientSecret || process.env.CICD_CLIENT_SECRET;
  tokenUrl     = tokenUrl     || process.env.CICD_TOKEN_URL;

  if (!clientId || !clientSecret || !tokenUrl) {
    throw new Error(
      "SAP BTP CI/CD credentials not configured.\n" +
      "cicd-app plan does NOT support service keys.\n" +
      "Instead: create XSUAA apiaccess instance in CI/CD subaccount → get service key → " +
      "set CICD_SERVICE_KEY env var OR create CICD_DEST destination."
    );
  }

  const fullUrl = tokenUrl.endsWith("/oauth/token") ? tokenUrl : `${tokenUrl}/oauth/token`;

  // XSUAA apiaccess requires grant_type=client_credentials
  // Some XSUAA instances need the API URL scope — add it if CICD_API_URL is known
  const apiUrl    = getCICDBaseUrl();
  const params    = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     clientId,
    client_secret: clientSecret,
  });
  // Add scope if needed (some CI/CD XSUAA instances require it)
  if (apiUrl) params.append("response_type", "token");

  const res = await axios.post(fullUrl, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    httpsAgent,
  });

  cicdToken       = res.data.access_token;
  cicdTokenExpiry = Date.now() + (res.data.expires_in || 3600) * 1000;
  console.log("✅ SAP BTP CI/CD token fetched (XSUAA apiaccess)");
  return cicdToken;
}

function getCICDBaseUrl() {
  if (process.env.CICD_SERVICE_KEY) {
    try {
      const key = JSON.parse(process.env.CICD_SERVICE_KEY);
      return key.apiurl || key.api_url || key.serviceurls?.CICD_API_URL || null;
    } catch {}
  }
  // Hardcoded from your CI/CD dashboard URL
  return process.env.CICD_API_URL ||
         "https://hcl-integrationsuite-qxeoz78m.eu10.cicd.cloud.sap";
}

// GET /api/cicd/runs — fetch real pipeline runs from SAP BTP CI/CD
// Your CI/CD URL: https://hcl-integrationsuite-qxeoz78m.eu10.cicd.cloud.sap
// Your 3 jobs: Transport-risk-dashborad, ai-transport-risk-demo, fiori-saple-app
app.get("/api/cicd/runs", async (req, res) => {

  // Helper: call CI/CD API via destination first, then direct token
  const callCICD = async (path) => {
    if (destinationCredentials) {
      try { return await fetchViaDestination(CICD_DEST_NAME, path); }
      catch (e) { console.warn(`CI/CD destination failed: ${e.message}`); }
    }
    const token = await getCICDToken();
    const r = await axios.get(`${getCICDBaseUrl()}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      httpsAgent, timeout: 15000,
    });
    return r.data;
  };

  try {
    // 1. Fetch all jobs — returns { jobs: [{id, name, state, branch}] }
    const jobsData = await callCICD("/api/v1/jobs");
    const jobs = jobsData?.jobs || jobsData?.value || [];
    console.log(`✅ CI/CD: ${jobs.length} jobs — ${jobs.map(j=>j.name).join(", ")}`);

    // 2. Fetch recent runs for each job in parallel
    const runResults = await Promise.allSettled(
      jobs.map(async (job) => {
        const jobId   = job.id || job.jobId;
        const jobName = job.name || job.jobName || jobId;
        try {
          const runsData = await callCICD(`/api/v1/jobs/${jobId}/runs`);
          const runs     = (runsData?.runs || runsData?.value || []).slice(0, 5);
          return runs.map(r => {
            const start = r.startTime || r.createdAt || null;
            const end   = r.completionTime || r.endTime || null;
            const durMs = (start && end) ? new Date(end) - new Date(start) : null;
            const status = r.status === "COMPLETED"                                    ? "success"
                         : r.status === "RUNNING"                                      ? "running"
                         : (r.status === "ERROR" || r.status === "ABORTED")            ? "failed"
                         : "pending";
            return {
              id:        `#${r.id || r.runId || r.runNumber || "—"}`,
              name:      jobName,
              status,
              branch:    job.branch || r.branch || "main",
              dur:       durMs ? formatDuration(durMs) : (status === "running" ? "Running..." : "—"),
              trigger:   r.trigger || (job.state === "ON" ? "push" : "manual"),
              time:      start ? timeAgo(new Date(start)) : "—",
              commit:    (r.commitId || r.commit || "").slice(0, 7) || "—",
              jobId,
              startTime: start,
            };
          });
        } catch (e) {
          console.warn(`CI/CD runs failed for ${jobId}: ${e.message}`);
          return [{ id:"#—", name:jobName, status:"pending", branch:job.branch||"main",
                    dur:"—", trigger:"—", time:"—", commit:"—", jobId }];
        }
      })
    );

    const allRuns = runResults
      .filter(r => r.status === "fulfilled")
      .flatMap(r => r.value)
      .sort((a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0))
      .slice(0, 20);

    // 3. Get stages for running job
    const runningRun = allRuns.find(r => r.status === "running");
    let stages = [];
    if (runningRun && runningRun.jobId && runningRun.id !== "#—") {
      try {
        const runId     = runningRun.id.replace("#", "");
        const stageData = await callCICD(`/api/v1/jobs/${runningRun.jobId}/runs/${runId}`);
        stages = (stageData?.stages || stageData?.value || []).map(s => {
          const n = (s.name || "").toLowerCase();
          const icon = n.includes("source")||n.includes("clone") ? "📂"
                     : n.includes("build")                       ? "🔨"
                     : n.includes("test")                        ? "🧪"
                     : n.includes("pack")                        ? "📦"
                     : n.includes("deploy")&&n.includes("prod")  ? "🏭"
                     : n.includes("deploy")                      ? "⬆️"
                     : n.includes("smoke")                       ? "💨"
                     : n.includes("approv")                      ? "✅"  : "⚙️";
          const sDur = (s.startTime && s.completionTime)
            ? formatDuration(new Date(s.completionTime) - new Date(s.startTime)) : "—";
          return {
            name:   s.name || s.stageName,
            icon,
            status: s.status === "COMPLETED" ? "success"
                  : s.status === "RUNNING"   ? "running"
                  : s.status === "ERROR"     ? "failed"
                  : "pending",
            dur:    s.status === "RUNNING" ? "..." : sDur,
          };
        });
      } catch (e) { console.warn("stages:", e.message); }
    }

    const summary = {
      totalJobs: jobs.length, running: allRuns.filter(r=>r.status==="running").length,
      success: allRuns.filter(r=>r.status==="success").length,
      failed:  allRuns.filter(r=>r.status==="failed").length,
      jobs:    jobs.map(j=>({ id:j.id||j.jobId, name:j.name||j.jobName, state:j.state||"ON", branch:j.branch||"main" })),
    };

    console.log(`✅ CI/CD: ${allRuns.length} runs, ${stages.length} stages`);
    res.json({ configured:true, runs:allRuns, stages, summary });

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("❌ CI/CD error:", typeof detail==="object" ? JSON.stringify(detail) : detail);
    res.json({
      configured:true,
      error: typeof detail==="object" ? JSON.stringify(detail) : detail,
      runs:[
        {id:"#142",name:"Transport-risk-dashborad",status:"running",branch:"main",dur:"Running...",trigger:"push",time:"2 min ago",commit:"a4f3c21"},
        {id:"#141",name:"Transport-risk-dashborad",status:"success",branch:"main",dur:"4m 32s",trigger:"push",time:"1 hr ago",commit:"9d2b8e1"},
        {id:"#140",name:"ai-transport-risk-demo",status:"success",branch:"main",dur:"6m 18s",trigger:"push",time:"3 hrs ago",commit:"c7e5a30"},
        {id:"#139",name:"fiori-saple-app",status:"failed",branch:"main",dur:"1m 44s",trigger:"push",time:"5 hrs ago",commit:"f1a9d42"},
        {id:"#138",name:"ai-transport-risk-demo",status:"success",branch:"main",dur:"3m 55s",trigger:"push",time:"8 hrs ago",commit:"b8c2f67"},
      ],
      stages:[],
      summary:{totalJobs:3,running:1,success:3,failed:1,
        jobs:[{id:"1",name:"Transport-risk-dashborad",state:"ON",branch:"main"},
              {id:"2",name:"ai-transport-risk-demo",state:"ON",branch:"main"},
              {id:"3",name:"fiori-saple-app",state:"ON",branch:"main"}]},
    });
  }
});

// GET /api/cicd/jobs
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
    res.json({ configured:true, jobs: data?.jobs || data?.value || [] });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/cicd/status
app.get("/api/cicd/status", async (req, res) => {
  try {
    const token = await getCICDToken();
    res.json({ configured:true, reachable:true, baseUrl:getCICDBaseUrl(),
               message:"SAP BTP CI/CD connected · "+getCICDBaseUrl() });
  } catch (err) {
    res.json({ configured:!!getCICDBaseUrl(), reachable:false, error:err.message });
  }
});

// Helper: format milliseconds → "1m 23s"
function formatDuration(ms) {
  if (!ms) return "—";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

// Helper: date → "2 min ago"
function timeAgo(date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs} hr${hrs>1?'s':''} ago`;
  return `${Math.floor(hrs/24)} day${Math.floor(hrs/24)>1?'s':''} ago`;
}

// ─── Fetch via BTP Destination (cross-subaccount) ────────────────────────────
//
// This is the correct pattern for calling APIs in OTHER subaccounts.
// The Destination Service handles OAuth2 token exchange automatically —
// you just reference the destination name. Works for both:
//   - Cloud TM in Subaccount B
//   - CI/CD Service in Subaccount C
//
// Destination config in BTP Cockpit:
//   Type: HTTP
//   Authentication: OAuth2ClientCredentials
//   Client ID/Secret: from target subaccount service key
//   Token URL: from target subaccount service key

const CLOUD_TM_DEST_NAME = process.env.CLOUD_TM_DEST_NAME || "CLOUD_TM_DEST";
const CICD_DEST_NAME      = process.env.CICD_DEST_NAME     || "CICD_DEST";

// Cache resolved destination configs (5 min TTL)
const _destConfigCache = {};

async function getDestinationConfig(destName) {
  const cached = _destConfigCache[destName];
  if (cached && cached.expiresAt > Date.now()) return cached.config;

  const destToken = await getBTPToken();
  const res = await axios.get(
    `${destinationCredentials.uri}/destination-configuration/v1/destinations/${destName}`,
    { headers: { Authorization: `Bearer ${destToken}` }, httpsAgent }
  );

  const config = res.data;
  _destConfigCache[destName] = { config, expiresAt: Date.now() + 5 * 60 * 1000 };
  console.log(`✅ Destination config fetched: ${destName} → ${config.destinationConfiguration?.URL}`);
  return config;
}

// Call any HTTP API via a BTP destination.
// The Destination Service returns an authTokens array — we use the first one.
// This means OAuth2 is handled entirely by BTP — no manual token management needed.
async function fetchViaDestination(destName, path, params = {}) {
  if (!destinationCredentials) {
    throw new Error(`Destination Service not available. Cannot call ${destName}.`);
  }

  const config     = await getDestinationConfig(destName);
  const destConf   = config.destinationConfiguration || {};
  const baseUrl    = destConf.URL || destConf.url;
  if (!baseUrl) throw new Error(`No URL in destination ${destName}`);

  // authTokens[0] is the Bearer token BTP fetched using the destination's OAuth2 config
  const authTokens = config.authTokens || [];
  const bearerToken = authTokens[0]?.value;
  if (!bearerToken) {
    throw new Error(
      `No auth token returned for destination ${destName}. ` +
      `Check destination authentication config in BTP Cockpit.`
    );
  }

  const qs  = Object.keys(params).length ? "?" + new URLSearchParams(params).toString() : "";
  const url = `${baseUrl}${path}${qs}`;

  console.log(`🔄 Via destination ${destName}: ${url}`);
  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Accept:        "application/json",
    },
    httpsAgent,
    timeout: 15000,
  });
  return res.data;
}

// ─── SAP Cloud Transport Management via Destination ──────────────────────────
async function callCloudTmViaDestination(path, params = {}) {
  // Try destination first (recommended for cross-subaccount)
  if (destinationCredentials) {
    try {
      return await fetchViaDestination(CLOUD_TM_DEST_NAME, `/v2${path}`, params);
    } catch (destErr) {
      console.warn(`⚠️  Cloud TM via destination failed: ${destErr.message} — trying direct credentials`);
    }
  }
  // Fallback: direct credentials (CLOUD_TM_SERVICE_KEY / env vars)
  return await callCloudTm(path, params);
}

// ─── SAP BTP CI/CD via Destination ───────────────────────────────────────────
async function callCICDViaDestination(path, params = {}) {
  if (destinationCredentials) {
    try {
      return await fetchViaDestination(CICD_DEST_NAME, path, params);
    } catch (destErr) {
      console.warn(`⚠️  CI/CD via destination failed: ${destErr.message} — trying direct credentials`);
    }
  }
  // Fallback: direct credentials
  const baseUrl = getCICDBaseUrl();
  if (!baseUrl) throw new Error("CI/CD not configured. Set CICD_DEST_NAME destination or CICD_SERVICE_KEY.");
  const token = await getCICDToken();
  const qs    = Object.keys(params).length ? "?" + new URLSearchParams(params).toString() : "";
  const res   = await axios.get(`${baseUrl}${path}${qs}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    httpsAgent, timeout: 15000,
  });
  return res.data;
}

// ─── GET /api/cloudtm/status — updated to show destination config ─────────────
// (replaces the old one below — both try destination first then direct creds)

// ─── GET /api/destinations/status — check all cross-subaccount destinations ───
app.get("/api/destinations/status", async (req, res) => {
  if (!destinationCredentials) {
    return res.json({
      destinationService: false,
      message: "Destination Service not bound. Bind it in BTP Cockpit → Services.",
      CLOUD_TM_DEST: { configured: false },
      CICD_DEST:     { configured: false },
    });
  }

  const check = async (destName, label) => {
    try {
      const config = await getDestinationConfig(destName);
      const conf   = config.destinationConfiguration || {};
      const hasToken = (config.authTokens || []).length > 0 &&
                       !!(config.authTokens[0]?.value);
      return {
        configured:  true,
        reachable:   hasToken,
        name:        destName,
        label,
        url:         conf.URL || conf.url || "—",
        authType:    conf.Authentication || "—",
        tokenReady:  hasToken,
        message:     hasToken
          ? `✅ ${label} ready — token obtained via destination`
          : `⚠️  Destination exists but no auth token. Check OAuth2 config in BTP Cockpit.`,
      };
    } catch (err) {
      return {
        configured: false, reachable: false, name: destName, label,
        message: `❌ Destination "${destName}" not found. Create it in BTP Cockpit → Connectivity → Destinations.`,
        error: err.message,
        steps: [
          `1. Go to BTP Cockpit → Subaccount → Connectivity → Destinations`,
          `2. Click New Destination`,
          `3. Name: ${destName}`,
          `4. Type: HTTP`,
          `5. URL: <${label} API URL from service key>`,
          `6. Authentication: OAuth2ClientCredentials`,
          `7. Client ID + Secret: from ${label} service key in target subaccount`,
          `8. Token Service URL: from ${label} service key uaa.url + /oauth/token`,
        ],
      };
    }
  };

  const [cloudTm, cicd] = await Promise.all([
    check(CLOUD_TM_DEST_NAME, "SAP Cloud TM"),
    check(CICD_DEST_NAME,     "SAP BTP CI/CD"),
  ]);

  res.json({
    destinationService: true,
    destinationServiceUrl: destinationCredentials.uri,
    CLOUD_TM_DEST: cloudTm,
    CICD_DEST:     cicd,
    summary: {
      allReady:     cloudTm.reachable && cicd.reachable,
      cloudTmReady: cloudTm.reachable,
      cicdReady:    cicd.reachable,
    },
  });
});


//
// SAP Cloud TM REST API v2:
//   Base URL : https://transport-service.cfapps.<region>.hana.ondemand.com
//   Auth     : OAuth2 client credentials (same XSUAA pattern)
//
// Required env vars — paste your Cloud TM service key JSON:
//   CLOUD_TM_SERVICE_KEY = { "clientid":"...", "clientsecret":"...",
//                             "url":"...", "uri":"https://transport-service..." }
//
// Or individual vars:
//   CLOUD_TM_URL         = https://transport-service.cfapps.eu10.hana.ondemand.com
//   CLOUD_TM_CLIENT_ID   = ...
//   CLOUD_TM_CLIENT_SECRET = ...
//   CLOUD_TM_TOKEN_URL   = https://xxx.authentication.eu10.hana.ondemand.com

let cloudTmToken       = null;
let cloudTmTokenExpiry = 0;

async function getCloudTmToken() {
  if (cloudTmToken && Date.now() < cloudTmTokenExpiry - 30000) return cloudTmToken;

  let clientId, clientSecret, tokenUrl;

  // Source 1 — CLOUD_TM_SERVICE_KEY (full JSON)
  if (process.env.CLOUD_TM_SERVICE_KEY) {
    try {
      const key = JSON.parse(process.env.CLOUD_TM_SERVICE_KEY);
      clientId     = key.clientid     || key.client_id;
      clientSecret = key.clientsecret || key.client_secret;
      tokenUrl     = key.url          || key.uaa?.url;
      // Also grab base URL if not already set
      if (!process.env.CLOUD_TM_URL && (key.uri || key.serviceurls?.TMS_API_URL)) {
        process.env.CLOUD_TM_URL = key.uri || key.serviceurls.TMS_API_URL;
      }
      console.log("ℹ️  Cloud TM credentials from CLOUD_TM_SERVICE_KEY");
    } catch { console.error("❌ CLOUD_TM_SERVICE_KEY is not valid JSON"); }
  }

  // Source 2 — VCAP_SERVICES (if Cloud TM is bound as a service instance)
  if (!clientId) {
    try {
      const vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
      const entries = Object.values(vcap).flat();
      const entry = entries.find(s =>
        s?.label?.includes("transport") ||
        s?.tags?.includes("transport-management") ||
        s?.credentials?.uri?.includes("transport-service")
      );
      if (entry?.credentials) {
        clientId     = entry.credentials.clientid     || entry.credentials.client_id;
        clientSecret = entry.credentials.clientsecret || entry.credentials.client_secret;
        tokenUrl     = entry.credentials.url          || entry.credentials.uaa?.url;
        if (!process.env.CLOUD_TM_URL && entry.credentials.uri) {
          process.env.CLOUD_TM_URL = entry.credentials.uri;
        }
        console.log("ℹ️  Cloud TM credentials from VCAP_SERVICES binding");
      }
    } catch {}
  }

  // Source 3 — Individual env vars
  clientId     = clientId     || process.env.CLOUD_TM_CLIENT_ID;
  clientSecret = clientSecret || process.env.CLOUD_TM_CLIENT_SECRET;
  tokenUrl     = tokenUrl     || process.env.CLOUD_TM_TOKEN_URL;

  if (!clientId || !clientSecret || !tokenUrl) {
    throw new Error(
      "SAP Cloud TM credentials not configured. " +
      "Set CLOUD_TM_SERVICE_KEY (paste service key JSON) or " +
      "individual CLOUD_TM_CLIENT_ID/SECRET/TOKEN_URL env vars."
    );
  }

  const fullUrl = tokenUrl.endsWith("/oauth/token") ? tokenUrl : `${tokenUrl}/oauth/token`;
  const res = await axios.post(
    fullUrl,
    new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent }
  );

  cloudTmToken       = res.data.access_token;
  cloudTmTokenExpiry = Date.now() + (res.data.expires_in || 3600) * 1000;
  console.log("✅ SAP Cloud TM token fetched");
  return cloudTmToken;
}

function getCloudTmBaseUrl() {
  if (process.env.CLOUD_TM_SERVICE_KEY) {
    try {
      const key = JSON.parse(process.env.CLOUD_TM_SERVICE_KEY);
      return key.uri || key.serviceurls?.TMS_API_URL || null;
    } catch {}
  }
  return process.env.CLOUD_TM_URL || null;
}

// Helper: call Cloud TM — tries destination first, falls back to direct creds
async function callCloudTm(path, params = {}) {
  const baseUrl = getCloudTmBaseUrl();
  if (!baseUrl && !destinationCredentials) {
    throw new Error("Cloud TM not configured. Set CLOUD_TM_SERVICE_KEY or create CLOUD_TM_DEST destination.");
  }
  // Try destination service first (cross-subaccount)
  if (destinationCredentials) {
    try {
      return await fetchViaDestination(CLOUD_TM_DEST_NAME, `/v2${path}`,params);
    } catch (e) {
      console.warn(`⚠️  Cloud TM destination failed (${e.message}) — trying direct`);
    }
  }
  // Direct credentials fallback
  if (!baseUrl) throw new Error("Cloud TM base URL not found.");
  const token = await getCloudTmToken();
  const qs    = Object.keys(params).length ? "?" + new URLSearchParams(params).toString() : "";
  const url   = `${baseUrl}/v2${path}${qs}`;
  console.log(`🔄 Cloud TM direct: ${url}`);
  const res   = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    httpsAgent, timeout: 12000,
  });
  return res.data;
}

// ── GET /api/cloudtm/status ── connectivity check
app.get("/api/cloudtm/status", async (req, res) => {
  const baseUrl = getCloudTmBaseUrl();
  if (!baseUrl) {
    return res.json({
      configured: false,
      message: "Set CLOUD_TM_SERVICE_KEY (paste service key JSON) in BTP env vars"
    });
  }
  try {
    await getCloudTmToken();
    res.json({ configured: true, reachable: true, baseUrl,
               message: "SAP Cloud Transport Management connected" });
  } catch (err) {
    res.json({ configured: true, reachable: false, error: err.message });
  }
});

// ── GET /api/cloudtm/nodes ── all transport nodes (DEV, QAS, PROD)
app.get("/api/cloudtm/nodes", async (req, res) => {
  try {
    const data  = await callCloudTm("/nodes");
    const nodes = (data.nodes || data.value || data || []).map(n => ({
      id:          n.nodeId          || n.id,
      name:        n.nodeName        || n.name,
      description: n.nodeDescription || n.description || "",
      type:        n.contentType     || n.type        || "MTA",
      env:         inferEnv(n.nodeName || n.name || ""),
      queueCount:  n.queueEntriesCount ?? null,
    }));
    res.json({ nodes, count: nodes.length });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("❌ Cloud TM /nodes:", detail);
    res.status(502).json({ error: typeof detail === "object" ? JSON.stringify(detail) : detail });
  }
});

// ── GET /api/cloudtm/queues ── queue entries waiting at each node
app.get("/api/cloudtm/queues", async (req, res) => {
  const { nodeId } = req.query;
  try {
    // If no nodeId, fetch all nodes first then all their queues in parallel
    if (!nodeId) {
      const nodesData = await callCloudTm("/nodes");
      const nodes     = nodesData.nodes || nodesData.value || nodesData || [];

      const queueResults = await Promise.allSettled(
        nodes.map(async (n) => {
          try {
            const qd  = await callCloudTm("/nodes/" + (n.nodeId || n.id) + "/transportRequests");
            const entries = qd.transportRequests || qd.value || qd || [];
            return { node: n.nodeName || n.name, nodeId: n.nodeId || n.id,
                     env: inferEnv(n.nodeName || n.name), entries };
          } catch {
            return { node: n.nodeName || n.name, nodeId: n.nodeId || n.id,
                     env: inferEnv(n.nodeName || n.name), entries: [] };
          }
        })
      );

      const queues = queueResults.map(r =>
        r.status === "fulfilled" ? r.value : { node: "unknown", entries: [] }
      );
      const totalPending = queues.reduce((s, q) => s + q.entries.length, 0);
      return res.json({ queues, totalPending });
    }

    // Single node queue
    const data    = await callCloudTm("/nodes/" + nodeId + "/transportRequests");
    const entries = (data.transportRequests || data.value || data || []).map(mapTmRequest);
    res.json({ nodeId, entries, count: entries.length });

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("❌ Cloud TM /queues:", detail);
    res.status(502).json({ error: typeof detail === "object" ? JSON.stringify(detail) : detail });
  }
});

// ── GET /api/cloudtm/requests ── transport requests (all or filtered)
app.get("/api/cloudtm/requests", async (req, res) => {
  const { status, limit = 50 } = req.query;
  try {
    const params = { pageSize: limit };
    if (status) params.status = status;

    const data     = await callCloudTm("/transportRequests", params);
    const requests = (data.transportRequests || data.value || data || []).map(mapTmRequest);
    res.json({ requests, count: requests.length,
               total: data.total || data.count || requests.length });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("❌ Cloud TM /requests:", detail);
    res.status(502).json({ error: typeof detail === "object" ? JSON.stringify(detail) : detail });
  }
});

// ── GET /api/cloudtm/requests/:id ── single transport request detail
app.get("/api/cloudtm/requests/:id", async (req, res) => {
  try {
    const data = await callCloudTm("/transportRequests/" + req.params.id);
    res.json(mapTmRequest(data));
  } catch (err) {
    res.status(502).json({ error: err.response?.data || err.message });
  }
});

// ── GET /api/cloudtm/dashboard ── full picture: nodes + queues + recent requests
app.get("/api/cloudtm/dashboard", async (req, res) => {
  const baseUrl = getCloudTmBaseUrl();
  if (!baseUrl) {
    // Return mock data so dashboard still works
    return res.json({
      configured: false,
      message:    "Set CLOUD_TM_SERVICE_KEY to connect to SAP Cloud TM",
      nodes:      mockTmNodes(),
      queues:     mockTmQueues(),
      requests:   mockTmRequests(),
      summary:    mockTmSummary(),
    });
  }

  try {
    const [nodesData, requestsData] = await Promise.all([
      callCloudTm("/nodes"),
      callCloudTm("/transportRequests", { pageSize: 100 }),
    ]);

    const nodes    = (nodesData.nodes    || nodesData.value    || nodesData    || []);
    const requests = (requestsData.transportRequests || requestsData.value || requestsData || [])
                      .map(mapTmRequest);

    // Fetch queues for each node in parallel
    const queueResults = await Promise.allSettled(
      nodes.map(async (n) => {
        try {
          const qd = await callCloudTm("/nodes/" + (n.nodeId || n.id) + "/transportRequests");
          return { node: n.nodeName || n.name, nodeId: n.nodeId || n.id,
                   env: inferEnv(n.nodeName || n.name),
                   entries: (qd.transportRequests || qd.value || qd || []).map(mapTmRequest) };
        } catch {
          return { node: n.nodeName || n.name, nodeId: n.nodeId || n.id,
                   env: inferEnv(n.nodeName || n.name), entries: [] };
        }
      })
    );

    const queues       = queueResults.map(r => r.status === "fulfilled" ? r.value : { entries: [] });
    const totalPending = queues.reduce((s, q) => s + q.entries.length, 0);

    const summary = {
      totalNodes:    nodes.length,
      totalPending,
      totalRequests: requests.length,
      imported:      requests.filter(r => r.status === "Imported").length,
      failed:        requests.filter(r => r.status === "Failed").length,
      initial:       requests.filter(r => r.status === "Initial").length,
      timestamp:     new Date().toISOString(),
    };

    console.log(`✅ Cloud TM dashboard: ${nodes.length} nodes, ${totalPending} pending, ${requests.length} requests`);
    res.json({ configured: true, nodes: nodes.map(n => ({
      id:    n.nodeId || n.id, name: n.nodeName || n.name,
      type:  n.contentType || n.type || "MTA",
      env:   inferEnv(n.nodeName || n.name),
      queueCount: queues.find(q => q.nodeId === (n.nodeId || n.id))?.entries?.length ?? 0,
    })), queues, requests: requests.slice(0, 50), summary });

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("❌ Cloud TM dashboard:", detail);
    // Return mock on error so UI always shows something
    res.json({
      configured: true, error: typeof detail === "object" ? JSON.stringify(detail) : detail,
      nodes: mockTmNodes(), queues: mockTmQueues(),
      requests: mockTmRequests(), summary: mockTmSummary(),
    });
  }
});

// ── MAP Cloud TM request object to consistent shape ───────────────────────────
function mapTmRequest(r) {
  return {
    id:          r.transportRequestId || r.id                    || "—",
    name:        r.transportRequestName || r.name                || "—",
    description: r.transportRequestDescription || r.description  || "—",
    status:      r.status                                        || "Initial",
    owner:       r.createdBy || r.owner                          || "—",
    createdAt:   r.createdAt || r.creationDate                   || null,
    importedAt:  r.importedAt || r.lastImportDate                || null,
    targetNode:  r.targetNode || r.nodeName                      || "—",
    contentType: r.contentType || r.type                         || "MTA",
    description2:r.description                                   || "",
  };
}

// ── Infer environment from node name ─────────────────────────────────────────
function inferEnv(name) {
  const n = name.toUpperCase();
  if (n.includes("PROD") || n.includes("PRD"))         return "PROD";
  if (n.includes("QAS")  || n.includes("QUAL") || n.includes("TEST")) return "QAS";
  if (n.includes("DEV")  || n.includes("DEVELOP"))     return "DEV";
  if (n.includes("SBX")  || n.includes("SANDBOX"))     return "SBX";
  return "—";
}

// ── MOCK DATA (shown when Cloud TM not yet configured) ────────────────────────
function mockTmNodes() {
  return [
    { id:"node-dev",  name:"HCL-BTP-DEV",  env:"DEV",  type:"MTA", queueCount:6  },
    { id:"node-qas",  name:"HCL-BTP-QAS",  env:"QAS",  type:"MTA", queueCount:3  },
    { id:"node-prod", name:"HCL-BTP-PROD", env:"PROD", type:"MTA", queueCount:1  },
  ];
}
function mockTmQueues() {
  return [
    { node:"HCL-BTP-DEV",  nodeId:"node-dev",  env:"DEV",  entries:[
        { id:"TQ-0042", name:"transport-dashboard-v3.1.2", status:"Initial",  owner:"RBASIS",  createdAt:new Date().toISOString(), targetNode:"HCL-BTP-DEV",  contentType:"MTA" },
        { id:"TQ-0041", name:"cloud-alm-backend-v2.4",    status:"Imported", owner:"RDEV01",  createdAt:new Date().toISOString(), targetNode:"HCL-BTP-DEV",  contentType:"MTA" },
    ]},
    { node:"HCL-BTP-QAS",  nodeId:"node-qas",  env:"QAS",  entries:[
        { id:"TQ-0040", name:"integration-monitor-v1.1",  status:"Initial",  owner:"RINTERF", createdAt:new Date().toISOString(), targetNode:"HCL-BTP-QAS",  contentType:"MTA" },
    ]},
    { node:"HCL-BTP-PROD", nodeId:"node-prod", env:"PROD", entries:[
        { id:"TQ-0038", name:"cloud-alm-backend-v2.3",    status:"Imported", owner:"RBASIS",  createdAt:new Date().toISOString(), targetNode:"HCL-BTP-PROD", contentType:"MTA" },
    ]},
  ];
}
function mockTmRequests() {
  var now = new Date();
  return [
    { id:"TQ-0042", name:"transport-dashboard-v3.1.2",   status:"Initial",  owner:"RBASIS",  createdAt:now.toISOString(), targetNode:"HCL-BTP-DEV",  contentType:"MTA", description:"Release candidate — CTMS & CI/CD tab" },
    { id:"TQ-0041", name:"cloud-alm-backend-v2.4",       status:"Imported", owner:"RDEV01",  createdAt:new Date(now-3600000).toISOString(), targetNode:"HCL-BTP-DEV", contentType:"MTA", description:"AI Core GPT-5.2 integration" },
    { id:"TQ-0040", name:"integration-monitor-v1.1",     status:"Initial",  owner:"RINTERF", createdAt:new Date(now-7200000).toISOString(), targetNode:"HCL-BTP-QAS", contentType:"MTA", description:"12 SAP system monitoring" },
    { id:"TQ-0039", name:"transaction-monitor-v1.0",     status:"Failed",   owner:"RDEV02",  createdAt:new Date(now-86400000).toISOString(), targetNode:"HCL-BTP-QAS", contentType:"MTA", description:"123 T-code monitoring" },
    { id:"TQ-0038", name:"cloud-alm-backend-v2.3",       status:"Imported", owner:"RBASIS",  createdAt:new Date(now-172800000).toISOString(), targetNode:"HCL-BTP-PROD", contentType:"MTA", description:"Business solutions v3" },
    { id:"TQ-0037", name:"cloud-alm-frontend-v3.0",      status:"Imported", owner:"RBASIS",  createdAt:new Date(now-259200000).toISOString(), targetNode:"HCL-BTP-PROD", contentType:"MTA", description:"Release calendar + robot AI drawer" },
  ];
}
function mockTmSummary() {
  return { totalNodes:3, totalPending:4, totalRequests:6, imported:3, failed:1, initial:2, timestamp:new Date().toISOString() };
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 SAP Destination:       ${DESTINATION_NAME}`);
  console.log(`☁️  Cloud ALM Destination: ${CALM_DESTINATION_NAME}`);
  console.log(`🧠 AI Core URL:           ${getAICoreBaseUrl() || "not configured"}`);
  console.log(`🧠 AI Core Model:         ${AI_CORE_MODEL_NAME}`);
  console.log(`🧠 AI Core Deployment:    dynamically discovered at runtime`);
});
