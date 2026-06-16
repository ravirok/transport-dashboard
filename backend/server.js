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
  try   { res.json(JSON.parse(process.env.VCAP_SERVICES || "{}")); }
  catch { res.json({ error: "VCAP_SERVICES not found" }); }
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "OK", timestamp: new Date().toISOString(),
    config: { destinationName: DESTINATION_NAME, xsuaaLoaded: !!xsuaaCredentials, destinationServiceLoaded: !!destinationCredentials, connectivityLoaded: !!connectivityCredentials, proxyHost: connectivityCredentials?.onpremise_proxy_host || "NOT LOADED", proxyPort: connectivityCredentials?.onpremise_proxy_http_port || "NOT LOADED" },
  });
});

// ─── SAP Token Helpers ────────────────────────────────────────────────────────
async function getConnectivityToken() {
  if (!connectivityCredentials) throw new Error("Connectivity credentials not loaded.");
  const { clientid, clientsecret, token_service_url } = connectivityCredentials;
  const res = await axios.post(`${token_service_url}/oauth/token`, new URLSearchParams({ grant_type: "client_credentials", client_id: clientid, client_secret: clientsecret }), { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent });
  console.log("✅ Connectivity token fetched");
  return res.data.access_token;
}

async function getBTPToken() {
  if (!destinationCredentials) throw new Error("Destination credentials not loaded.");
  const { clientid, clientsecret, url } = destinationCredentials;
  const res = await axios.post(`${url}/oauth/token`, new URLSearchParams({ grant_type: "client_credentials", client_id: clientid, client_secret: clientsecret }), { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent });
  console.log("✅ Destination OAuth token fetched");
  return res.data.access_token;
}

async function getBTPDestination(token) {
  if (!destinationCredentials) throw new Error("Destination credentials not loaded.");
  const res = await axios.get(`${destinationCredentials.uri}/destination-configuration/v1/destinations/${DESTINATION_NAME}`, { headers: { Authorization: `Bearer ${token}` }, httpsAgent });
  console.log("✅ Destination config fetched:", DESTINATION_NAME);
  return res.data;
}

async function fetchFromSAP(odataPath) {
  const [destToken, connectivityToken] = await Promise.all([getBTPToken(), getConnectivityToken()]);
  const destination = await getBTPDestination(destToken);
  const { URL: SAP_URL, User, Password } = destination.destinationConfiguration;
  if (!SAP_URL) throw new Error("SAP URL missing from destination config.");
  const proxyHost   = connectivityCredentials.onpremise_proxy_host;
  const proxyPort   = parseInt(connectivityCredentials.onpremise_proxy_http_port || "20003");
  const sapAuth     = Buffer.from(`${User}:${Password}`).toString("base64");
  const sapEndpoint = `${SAP_URL}${odataPath}`;
  console.log("🔄 Calling SAP:", sapEndpoint);
  const response = await axios.get(sapEndpoint, {
    headers: { Authorization: `Basic ${sapAuth}`, "Proxy-Authorization": `Bearer ${connectivityToken}`, Accept: "application/json" },
    proxy: { protocol: "http:", host: proxyHost, port: proxyPort },
    httpsAgent,
  });
  return response.data?.d?.results ?? response.data?.d ?? response.data ?? [];
}

async function postToSAP(odataPath, body = {}) {
  const [destToken, connectivityToken] = await Promise.all([getBTPToken(), getConnectivityToken()]);
  const destination = await getBTPDestination(destToken);
  const { URL: SAP_URL, User, Password } = destination.destinationConfiguration;
  const proxyHost = connectivityCredentials.onpremise_proxy_host;
  const proxyPort = parseInt(connectivityCredentials.onpremise_proxy_http_port || "20003");
  const sapAuth   = Buffer.from(`${User}:${Password}`).toString("base64");
  const response  = await axios.post(`${SAP_URL}${odataPath}`, body, {
    headers: { Authorization: `Basic ${sapAuth}`, "Proxy-Authorization": `Bearer ${connectivityToken}`, Accept: "application/json", "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    proxy: { protocol: "http:", host: proxyHost, port: proxyPort },
    httpsAgent,
  });
  return response.data?.d ?? response.data ?? {};
}

// ═════════════════════════════════════════════════════════════════════════════
//  TRANSPORT ROUTES
// ═════════════════════════════════════════════════════════════════════════════
app.get("/api/transports", async (req, res) => {
  try {
    const data    = await fetchFromSAP("/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/Transports?$format=json");
    const results = (Array.isArray(data) ? data : []).map(t => ({ TRKORR: t.TRKORR||"", OWNER: t.OWNER||"", CREATED_ON: t.CREATED_ON||"", STATUS: t.STATUS||"", TARSYSTEM: t.TARSYSTEM||t.TARGET||"" }));
    console.log(`✅ Fetched ${results.length} transports`);
    res.json({ d: { results } });
  } catch (err) { console.error("❌ /api/transports error:", err.message); res.status(500).json({ error: err.message }); }
});

app.get("/api/transports/:trkorr/objects", async (req, res) => {
  try {
    const { trkorr } = req.params;
    const data    = await fetchFromSAP("/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/Objects?$format=json");
    const all     = Array.isArray(data) ? data : [];
    const results = all.filter(o => (o.TRANSPORT||o.TRKORR||"").trim() === trkorr).map(o => ({ OBJECT_NAME: o.OBJECT_NAME||o.OBJ_NAME||"", OBJECT_TYPE: o.OBJECT_TYPE||o.OBJECT||"", TRANSPORT: o.TRANSPORT||o.TRKORR||"", STATUS: o.STATUS||"" }));
    res.json({ d: { results } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/transports/:trkorr/logs", async (req, res) => {
  try {
    const { trkorr } = req.params;
    const data    = await fetchFromSAP("/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/Logs?$format=json");
    const all     = Array.isArray(data) ? data : [];
    const results = all.filter(l => (l.TRANSPORT||l.TRKORR||"").trim() === trkorr).map(l => ({ LOG_ID: l.LOG_ID||l.TRKORR||"", OBJECT_NAME: l.TRANSPORT||l.TRKORR||"", ACTION: l.ACTION||"", DATE: l.LOG_DATE||l.AS4DATE||l.DATE||"", TIME: l.LOG_TIME||l.AS4TIME||"", USER: l.USER||l.AS4USER||"", STATUS: l.STATUS||"", SYSTEM: l.SYSTEM||l.SYSNAM||"", TARGET: l.TARGET||l.TARSYSTEM||"" }));
    res.json({ d: { results } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/transports/:trkorr/import", async (req, res) => {
  const { trkorr } = req.params;
  const { target = "PROD", changeRequestId } = req.body;
  try {
    const result = await postToSAP(`/sap/opu/odata/sap/Z_TRANSPORTS_lOG_SRV_SRV/ImportTransport?Trkorr='${trkorr}'&Tarsystem='${target}'`);
    const retType = (result.Type||result.TYPE||"").trim();
    const retMsg  =  result.Message||result.MESSAGE||`Transport ${trkorr} import initiated into ${target}.`;
    if (retType === "E") return res.status(400).json({ error: retMsg });
    let almSynced = false;
    if (changeRequestId) {
      try { await patchToALM(`/api/calm/v0/changeManagement/changeRequests/${changeRequestId}`, { status: "DEPLOYED", deployedAt: new Date().toISOString(), comment: `Transport ${trkorr} deployed to ${target} via TransTrack Pro.` }); almSynced = true; } catch (almErr) { console.warn(`⚠️  ALM sync failed: ${almErr.message}`); }
    }
    res.json({ success: true, message: retMsg, almSynced, trkorr, target });
  } catch (err) { res.status(500).json({ error: err.response?.data?.error?.message?.value || err.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  CLOUD ALM
// ═════════════════════════════════════════════════════════════════════════════
const CALM_DESTINATION_NAME = process.env.CALM_DESTINATION_NAME || "Cloud_ALM";
const AI_CORE_MODEL_NAME    = process.env.AI_CORE_MODEL_NAME    || "gpt-4.1";

let aiCoreDeploymentCache  = null;
let aiCoreDeploymentExpiry = 0;

async function discoverAICoreDeployment() {
  if (aiCoreDeploymentCache && Date.now() < aiCoreDeploymentExpiry) return aiCoreDeploymentCache;
  const token   = await getAICoreToken();
  const baseUrl = getAICoreBaseUrl();
  if (!baseUrl) throw new Error("AI_CORE_BASE_URL not configured.");
  const resourceGroups = ["security-intelligence-hub","default",process.env.AI_CORE_RESOURCE_GROUP].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i);
  try {
    const rgRes = await axios.get(`${baseUrl}/v2/admin/resourceGroups`, { headers: { Authorization: `Bearer ${token}` }, httpsAgent, timeout: 10000 });
    const fetched = (rgRes.data?.resourceGroups||rgRes.data?.value||[]).map(rg=>rg.resourceGroupId||rg.id||rg.name).filter(Boolean);
    fetched.forEach(rg => { if (!resourceGroups.includes(rg)) resourceGroups.push(rg); });
  } catch (err) { console.warn(`⚠️ Resource group list failed [${err.response?.status}]`); }
  for (const rg of resourceGroups) {
    try {
      const res  = await axios.get(`${baseUrl}/v2/lm/deployments?status=RUNNING`, { headers: { Authorization: `Bearer ${token}`, "AI-Resource-Group": rg }, httpsAgent, timeout: 10000 });
      const list = res.data?.resources||res.data?.value||[];
      if (!Array.isArray(list)||list.length===0) continue;
      const gptDep = list.find(d => { const m=(d.details?.resources?.backendDetails?.modelName||d.modelName||"").toLowerCase(); return m.includes("gpt")||m.includes("azure")||m.includes("4"); });
      const dep    = gptDep||list.find(d => { const m=(d.details?.resources?.backendDetails?.modelName||d.modelName||"").toLowerCase(); return !m.includes("claude")&&!m.includes("anthropic"); });
      if (dep) {
        const id = dep.id||dep.deploymentId;
        const modelName = dep.details?.resources?.backendDetails?.modelName||dep.modelName||AI_CORE_MODEL_NAME;
        aiCoreDeploymentCache  = { deploymentId: id, resourceGroup: rg, baseUrl, modelName };
        aiCoreDeploymentExpiry = Date.now() + 10*60*1000;
        return aiCoreDeploymentCache;
      }
    } catch (err) { console.warn(`⚠️ Deployments in '${rg}' failed [${err.response?.status}]`); }
  }
  throw new Error(`No suitable RUNNING deployment found in: ${resourceGroups.join(", ")}`);
}

let calmDestCache = null;

async function getDestinationServiceToken() { return getBTPToken(); }

async function resolveCALMDestination() {
  if (calmDestCache && Date.now() < calmDestCache.expiry - 300000) return calmDestCache;
  const destToken  = await getDestinationServiceToken();
  const res        = await axios.get(`${destinationCredentials.uri}/destination-configuration/v1/destinations/${CALM_DESTINATION_NAME}`, { headers: { Authorization: `Bearer ${destToken}` }, httpsAgent });
  const config     = res.data?.destinationConfiguration || {};
  const authTokens = res.data?.authTokens || [];
  const authToken  = authTokens[0]?.value;
  const tokenType  = authTokens[0]?.type || "Bearer";
  const expiresIn  = parseInt(authTokens[0]?.expiresIn || "3600");
  const tokenError = authTokens[0]?.error;
  if (tokenError) throw new Error(`Destination token error: ${tokenError}`);
  if (!authToken) throw new Error(`Destination '${CALM_DESTINATION_NAME}' resolved but no auth token.`);
  const destUrl = config.URL||config.url||"";
  let baseUrl   = destUrl;
  if (destUrl.includes(".eu10.alm.cloud.sap") && !destUrl.startsWith("https://eu10.alm.cloud.sap")) { baseUrl = "https://eu10.alm.cloud.sap"; }
  if (!baseUrl) throw new Error(`Destination '${CALM_DESTINATION_NAME}' has no URL.`);
  calmDestCache = { baseUrl, authToken, tokenType, expiry: Date.now() + expiresIn * 1000 };
  return calmDestCache;
}

let directCalmToken       = null;
let directCalmTokenExpiry = 0;

async function getDirectCALMToken() {
  if (directCalmToken && Date.now() < directCalmTokenExpiry - 30000) return directCalmToken;
  let clientId, certificate, privateKey, certUrl, standardUrl;
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES||"{}");
    const calm = vcap["cloud-alm"]?.[0]?.credentials||vcap["cloudalm"]?.[0]?.credentials||vcap["alm"]?.[0]?.credentials;
    if (calm) { clientId=calm.uaa?.clientid||calm.clientid; certificate=calm.uaa?.certificate; privateKey=calm.uaa?.key; certUrl=calm.uaa?.certurl; standardUrl=calm.uaa?.url; }
  } catch {}
  clientId    = clientId    || process.env.CALM_CLIENT_ID;
  certificate = certificate || process.env.CALM_CERTIFICATE;
  privateKey  = privateKey  || process.env.CALM_PRIVATE_KEY;
  const envTokenUrl = process.env.CALM_TOKEN_URL||"";
  if (envTokenUrl.includes(".cert.")) { certUrl=envTokenUrl; } else if (envTokenUrl) { certUrl=envTokenUrl.replace(".authentication.",".authentication.cert."); standardUrl=envTokenUrl; }
  if (!clientId||!certificate||!privateKey) { console.warn(`⚠️ x509 credentials incomplete`); return null; }
  const cleanCert = certificate.replace(/\\n/g,"\n").replace(/\s+-----/g,"\n-----").replace(/-----\s+/g,"-----\n");
  const cleanKey  = privateKey.replace(/\\n/g,"\n").replace(/\s+-----/g,"\n-----").replace(/-----\s+/g,"-----\n");
  const mtlsAgent = new https.Agent({ cert: cleanCert, key: cleanKey, rejectUnauthorized: false });
  const tokenUrls = [certUrl,standardUrl].filter(Boolean).map(u=>u.endsWith("/oauth/token")?u:`${u}/oauth/token`);
  for (const tokenUrl of tokenUrls) {
    try {
      const res = await axios.post(tokenUrl, new URLSearchParams({ grant_type: "client_credentials", client_id: clientId }), { headers: { "Content-Type": "application/x-www-form-urlencoded" }, httpsAgent: mtlsAgent });
      directCalmToken=res.data.access_token; directCalmTokenExpiry=Date.now()+(res.data.expires_in||3600)*1000;
      console.log(`✅ Cloud ALM x509 token fetched`); return directCalmToken;
    } catch (err) { console.warn(`⚠️ x509 token failed [${err.response?.status||"ERR"}] ${tokenUrl}`); }
  }
  return null;
}

function parseALMResponse(data) {
  if (!data) return [];
  if (Array.isArray(data.value))   return data.value;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data))         return data;
  const keys = Object.keys(data).filter(k => !isNaN(parseInt(k)));
  if (keys.length > 0) return keys.map(k=>data[k]).filter(Boolean);
  return [];
}

async function fetchFromALM(path) {
  const { baseUrl, authToken, tokenType } = await resolveCALMDestination();
  try {
    const res = await axios.get(`${baseUrl}${path}`, { headers: { Authorization: `${tokenType} ${authToken}`, Accept: "application/json" }, httpsAgent });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    if (status===401||status===403) {
      const directToken = await getDirectCALMToken().catch(()=>null);
      if (directToken) {
        const res2 = await axios.get(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${directToken}`, Accept: "application/json" }, httpsAgent });
        return res2.data;
      }
    }
    throw err;
  }
}

async function patchToALM(path, body) {
  const { baseUrl, authToken, tokenType } = await resolveCALMDestination();
  const res = await axios.patch(`${baseUrl}${path}`, body, { headers: { Authorization: `${tokenType} ${authToken}`, Accept: "application/json", "Content-Type": "application/json" }, httpsAgent });
  return res.data;
}

function getCALMBaseUrl() { return calmDestCache?.baseUrl || `via destination: ${CALM_DESTINATION_NAME}`; }
function isThisWeek(dateStr) { if (!dateStr) return false; const d=new Date(dateStr); return d>=new Date(Date.now()-7*24*60*60*1000); }

async function tryALMPaths(paths) {
  for (const path of paths) {
    try { const data=await fetchFromALM(path); const items=parseALMResponse(data); if (data&&typeof data==='object') data._parsed=items; return data; }
    catch (err) { console.warn(`⚠️ ALM path failed [${err.response?.status||"ERR"}]: ${path}`); }
  }
  return null;
}

app.get("/api/calm/x509debug", async (req, res) => {
  const result = { steps: {} };
  const tokenUrl = process.env.CALM_TOKEN_URL||"";
  result.steps["1_env_vars"] = { CALM_CLIENT_ID: !!(process.env.CALM_CLIENT_ID), CALM_CERTIFICATE: !!(process.env.CALM_CERTIFICATE), CALM_PRIVATE_KEY: !!(process.env.CALM_PRIVATE_KEY), CALM_TOKEN_URL: tokenUrl||"NOT SET" };
  let x509Token=null, destToken=null;
  try { x509Token=await getDirectCALMToken(); result.steps["2_x509_token"]={ ok:!!x509Token }; } catch(e){ result.steps["2_x509_token"]={ ok:false, error:e.message }; }
  try { const dest=await resolveCALMDestination(); destToken=dest.authToken; result.steps["3_dest_token"]={ ok:!!destToken, baseUrl:dest.baseUrl }; } catch(e){ result.steps["3_dest_token"]={ ok:false, error:e.message }; }
  const baseUrl="https://eu10.alm.cloud.sap";
  for (const [label,token] of [["dest_token",destToken],["x509_token",x509Token]]) {
    if (!token) { result.steps[`4_projects_${label}`]={ skipped:true }; continue; }
    try { const r=await axios.get(`${baseUrl}/api/calm-projects/v1/projects?$top=5`,{ headers:{ Authorization:`Bearer ${token}`, Accept:"application/json" }, httpsAgent }); result.steps[`4_projects_${label}`]={ ok:true, count:parseALMResponse(r.data).length }; }
    catch(e){ result.steps[`4_projects_${label}`]={ ok:false, status:e.response?.status, error:e.message }; }
  }
  res.json(result);
});

app.get("/api/calm/discover", async (req, res) => {
  let resolvedBase="unknown";
  try { resolvedBase=(await resolveCALMDestination()).baseUrl; } catch(e){ resolvedBase=e.message; }
  const testPaths=["/api/imp-cdm-srv/v1/features?$top=1","/api/imp-pjm-srv/v1/projects?$top=1","/api/calm-projects/v1/projects?$top=1","/api/calm-tasks/v1/tasks","/api/ops-alm-evt-srv/v1/events?$top=1","/api/ops-ihm-srv/v1/healthStatus?$top=1","/api/calm-analytics/v1/providers","/api/imp-cdm-srv/v1/transportRequests?$top=1"];
  const results={};
  for (const path of testPaths) {
    try { const data=await fetchFromALM(path); results[path]={ ok:true, keys:Object.keys(data||{}), count:data?.value?.length??0 }; }
    catch(err){ results[path]={ ok:false, status:err.response?.status||"ERR", body:JSON.stringify(err.response?.data||{}).slice(0,200) }; }
  }
  const working=Object.entries(results).filter(([,v])=>v.ok).map(([k])=>k);
  res.json({ resolvedBaseUrl:resolvedBase, summary:working.length>0?`✅ ${working.length} paths working`:"❌ No paths working", working, all:results });
});

app.get("/api/calm/debug", async (req, res) => {
  const result={ timestamp:new Date().toISOString(), steps:{} };
  result.steps["1_destination_credentials"]={ loaded:!!destinationCredentials, uri:destinationCredentials?.uri||"MISSING", url:destinationCredentials?.url||"MISSING" };
  try { const token=await getBTPToken(); result.steps["2_btp_token"]={ ok:true, tokenLength:token?.length }; } catch(e){ result.steps["2_btp_token"]={ ok:false, error:e.message }; return res.json(result); }
  try { const dest=await resolveCALMDestination(); result.steps["3_calm_destination"]={ ok:true, baseUrl:dest.baseUrl, hasToken:!!dest.authToken, tokenType:dest.tokenType }; } catch(e){ result.steps["3_calm_destination"]={ ok:false, error:e.message, destinationName:CALM_DESTINATION_NAME }; return res.json(result); }
  try { const data=await fetchFromALM("/api/calm-health/v0/events?$top=1"); result.steps["4_calm_api_call"]={ ok:true, responseKeys:Object.keys(data||{}), recordCount:data?.value?.length??0 }; } catch(e){ result.steps["4_calm_api_call"]={ ok:false, error:e.message }; }
  try { const data=await fetchFromALM("/api/calm-requirements/v0/changeRequests?$top=1"); result.steps["5_change_mgmt_api"]={ ok:true, recordCount:data?.value?.length??0 }; } catch(e){ result.steps["5_change_mgmt_api"]={ ok:false, error:e.message }; }
  try { const data=await fetchFromALM("/api/calm-operations/v0/deploymentOperations?$top=1"); result.steps["6_transport_mgmt_api"]={ ok:true, recordCount:data?.value?.length??0 }; } catch(e){ result.steps["6_transport_mgmt_api"]={ ok:false, error:e.message }; }
  res.json(result);
});

app.get("/api/calm/health", async (req, res) => {
  const timer=setTimeout(()=>{ if (!res.headersSent) res.json({ criticalAlerts:0,warningAlerts:0,transportManagement:{pendingCount:0,failedCount:0,pipelineStatus:"UNKNOWN",lastDeployment:null},changeManagement:{openCount:0,pendingApproval:0,approvedCount:0,rejectedCount:0,deployedCount:0,complianceRate:100,projectCount:0,taskCount:0},healthMonitoring:{criticalCount:0,warningCount:0,prodAvailability:"99.9",systemsMonitored:0},alerts:[],projects:[],error:"timeout" }); },9000);
  try {
    const projectsRaw=await tryALMPaths(["/api/calm-projects/v1/projects?$top=100","/api/imp-pjm-srv/v1/projects?$top=100"]);
    const projects=parseALMResponse(projectsRaw);
    const [featRaw,hmRaw]=await Promise.all([tryALMPaths(["/api/imp-cdm-srv/v1/features?$top=100","/api/imp-cdm-srv/v0/features?$top=100"]).catch(()=>null),tryALMPaths(["/api/ops-alm-evt-srv/v1/events?$top=50","/api/calm-health/v1/events?$top=50"]).catch(()=>null)]);
    const features=parseALMResponse(featRaw), hmAlerts=parseALMResponse(hmRaw);
    let allTasks=[];
    if (projects.length>0) { const taskResults=await Promise.all(projects.slice(0,3).map(async proj=>{ const pid=proj.id||proj.projectId; if (!pid) return []; const r=await tryALMPaths([`/api/calm-tasks/v1/tasks?projectId=${pid}&$top=30`]).catch(()=>null); return parseALMResponse(r); })); allTasks=taskResults.flat(); }
    const tmFailed=features.filter(i=>["FAILED","ERROR","ABORTED"].includes(i.status)).length;
    const tmPending=features.filter(i=>["READY","PENDING","IN_PROGRESS"].includes(i.status)).length;
    const pipelineStatus=tmFailed>0?"BLOCKED":tmPending>5?"DEGRADED":projects.length>0?"OK":"UNKNOWN";
    const cmSource=allTasks.length>0?allTasks:projects;
    const cmOpen=cmSource.filter(i=>["OPEN","O","IN_PROGRESS"].includes(i.status)).length;
    const cmClosed=cmSource.filter(i=>["CLOSED","C","DONE","COMPLETED"].includes(i.status)).length;
    const cmPending=cmSource.filter(i=>["PENDING","PENDING_APPROVAL"].includes(i.status)).length;
    const cmTotal=cmSource.length;
    const cmCompliance=cmTotal>0?Math.round(((cmTotal-cmSource.filter(i=>i.status==="REJECTED").length)/cmTotal)*100):100;
    const hmCritical=hmAlerts.filter(a=>["CRITICAL","ERROR"].includes(a.severity)).length;
    const hmWarning=hmAlerts.filter(a=>a.severity==="WARNING").length;
    const prodAvail=hmCritical>0?String(Math.max(85,100-hmCritical*3).toFixed(1)):"99.9";
    clearTimeout(timer);
    if (res.headersSent) return;
    res.json({ criticalAlerts:hmCritical,warningAlerts:hmWarning,transportManagement:{pendingCount:tmPending,failedCount:tmFailed,pipelineStatus,lastDeployment:null,featuresCount:features.length},changeManagement:{openCount:cmOpen,pendingApproval:cmPending,approvedCount:cmClosed,rejectedCount:0,deployedCount:cmClosed,complianceRate:cmCompliance,projectCount:projects.length,taskCount:allTasks.length},healthMonitoring:{criticalCount:hmCritical,warningCount:hmWarning,prodAvailability:prodAvail,systemsMonitored:[...new Set(hmAlerts.map(a=>a.serviceId||a.systemId).filter(Boolean))].length},alerts:hmAlerts.slice(0,50).map(a=>({id:a.id,severity:a.severity,systemId:a.serviceId||a.systemId||"SYSTEM",message:a.description||a.name||"Alert",type:a.alertType||a.type,createdAt:a.createdAt})),projects:projects.slice(0,96).map(p=>({id:p.id||p.projectId,title:p.name||p.title||"",status:p.status||"OPEN",type:p.type||p.projectType||"PROJECT",currentPhase:p.currentPhase||p.phase,startDate:p.startDate,endDate:p.endDate,createdAt:p.createdAt||p.createDate,operationalStatus:p.operationalStatus,purpose:p.purpose})) });
  } catch(err) { clearTimeout(timer); if (!res.headersSent) res.json({ criticalAlerts:0,warningAlerts:0,transportManagement:{pendingCount:0,failedCount:0,pipelineStatus:"UNKNOWN",lastDeployment:null},changeManagement:{openCount:0,pendingApproval:0,approvedCount:0,rejectedCount:0,deployedCount:0,complianceRate:100,projectCount:0,taskCount:0},healthMonitoring:{criticalCount:0,warningCount:0,prodAvailability:"99.9",systemsMonitored:0},alerts:[],projects:[],error:err.message }); }
});

app.get("/api/calm/changes/all", async (req, res) => {
  try {
    const projectsRaw=await tryALMPaths(["/api/calm-projects/v1/projects?$top=100","/api/imp-pjm-srv/v1/projects?$top=100"]);
    const projects=parseALMResponse(projectsRaw);
    let allTasks=[];
    for (const proj of projects.slice(0,10)) {
      const pid=proj.id||proj.projectId; if (!pid) continue;
      const tasksRaw=await tryALMPaths([`/api/calm-tasks/v1/tasks?projectId=${pid}&$top=100`,`/api/imp-tkm-srv/v1/tasks?projectId=${pid}&$top=100`]);
      allTasks=allTasks.concat(parseALMResponse(tasksRaw).map(t=>({...t,projectName:proj.name||proj.title||pid})));
    }
    const source=allTasks.length>0?allTasks:projects;
    const items=source.map(item=>({ id:item.id||item.projectId||"",title:item.title||item.name||item.subject||"",status:item.status||"OPEN",assigneeId:item.assigneeId||item.assignee||item.responsible||"",priority:item.priority||"",description:item.description||item.projectName||"",externalId:item.externalId||"",dueDate:item.dueDate||item.plannedEndDate||null,createdAt:item.createdAt||item.createDate,changedAt:item.changedAt||item.lastChangedDate }));
    res.json({ d:{ results:items } });
  } catch(err){ res.status(500).json({ error:err.message }); }
});

app.get("/api/calm/changes/:trkorr", async (req, res) => {
  const { trkorr }=req.params;
  if (trkorr==="all") return res.json({ status:"none", id:null });
  try {
    const data=await fetchFromALM(`/api/calm-requirements/v0/changeRequests?$filter=externalId eq '${trkorr}' or contains(title,'${trkorr}')&$top=1&$orderby=createdAt desc`);
    const items=parseALMResponse(data);
    if (!items.length) return res.json({ status:"none", id:null });
    const cr=items[0];
    res.json({ id:cr.id,status:cr.status,title:cr.title||cr.name,description:cr.description||"",approver:cr.assigneeId||cr.approver||"",priority:cr.priority||"",dueDate:cr.dueDate||cr.plannedEndDate||null,createdAt:cr.createdAt,updatedAt:cr.changedAt||cr.updatedAt,externalId:cr.externalId||trkorr });
  } catch(err){ res.json({ status:"none", id:null, error:err.message }); }
});

app.patch("/api/calm/changes/:changeId/deploy", async (req, res) => {
  const { changeId }=req.params;
  try { await patchToALM(`/api/calm-requirements/v0/changeRequests/${changeId}`,{ status:"DEPLOYED", deployedAt:new Date().toISOString(), comment:`Deployed via TransTrack Pro at ${new Date().toISOString()}` }); res.json({ success:true, message:`CR ${changeId} updated to DEPLOYED in Cloud ALM.` }); }
  catch(err){ res.status(500).json({ error:err.message }); }
});

app.get("/api/calm/tm/deployments", async (req, res) => {
  try {
    const data=await tryALMPaths(["/api/imp-cdm-srv/v1/features?$top=100","/api/imp-cdm-srv/v0/features?$top=100","/api/calm-cdm/v1/features?$top=100","/api/imp-tkm-srv/v1/tasks?$top=100"]);
    if (!data) throw new Error("All deployment paths returned 404.");
    const items=parseALMResponse(data).map(d=>({ id:d.id,title:d.title||d.name||d.featureName||"",status:d.status||d.featureStatus||"",target:d.targetSystemId||d.target||"",createdAt:d.createdAt||d.createDate,deployedAt:d.deployedAt||d.finishedAt,transports:(d.transportRequests||d.transports||[]).map(c=>c.transportRequest||c.externalId||c.id) }));
    res.json({ d:{ results:items } });
  } catch(err){ res.status(500).json({ error:err.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  SAP AI CORE
// ═════════════════════════════════════════════════════════════════════════════
let aiCoreToken       = null;
let aiCoreTokenExpiry = 0;

async function getAICoreToken() {
  if (aiCoreToken && Date.now() < aiCoreTokenExpiry - 30000) return aiCoreToken;
  let clientId, clientSecret, tokenUrl;
  try { const vcap=JSON.parse(process.env.VCAP_SERVICES||"{}"); const aicore=vcap["aicore"]?.[0]?.credentials||vcap["ai-core"]?.[0]?.credentials||vcap["sap-aicore"]?.[0]?.credentials; if (aicore) { clientId=aicore.clientid||aicore.client_id; clientSecret=aicore.clientsecret||aicore.client_secret; tokenUrl=aicore.url||aicore.uaa?.url; } } catch {}
  clientId=clientId||process.env.AI_CORE_CLIENT_ID; clientSecret=clientSecret||process.env.AI_CORE_CLIENT_SECRET; tokenUrl=tokenUrl||process.env.AI_CORE_TOKEN_URL;
  if (!clientId||!clientSecret||!tokenUrl) throw new Error("SAP AI Core credentials not configured.");
  const fullTokenUrl=tokenUrl.endsWith("/oauth/token")?tokenUrl:`${tokenUrl}/oauth/token`;
  const res=await axios.post(fullTokenUrl,new URLSearchParams({ grant_type:"client_credentials",client_id:clientId,client_secret:clientSecret }),{ headers:{ "Content-Type":"application/x-www-form-urlencoded" }, httpsAgent });
  aiCoreToken=res.data.access_token; aiCoreTokenExpiry=Date.now()+(res.data.expires_in||3600)*1000;
  console.log("✅ SAP AI Core token fetched"); return aiCoreToken;
}

function getAICoreBaseUrl() {
  try { const vcap=JSON.parse(process.env.VCAP_SERVICES||"{}"); const aicore=vcap["aicore"]?.[0]?.credentials||vcap["ai-core"]?.[0]?.credentials; if (aicore?.serviceurls?.AI_API_URL) return aicore.serviceurls.AI_API_URL; } catch {}
  return process.env.AI_CORE_BASE_URL||"";
}

async function callAICore(messages, systemPrompt, maxTokens=800) {
  const { deploymentId, resourceGroup, baseUrl, modelName }=await discoverAICoreDeployment();
  const token=await getAICoreToken();
  const model=modelName||AI_CORE_MODEL_NAME;
  const endpoints=[`${baseUrl}/v2/inference/deployments/${deploymentId}/chat/completions?api-version=2024-12-01`,`${baseUrl}/v2/inference/deployments/${deploymentId}/chat/completions`,`${baseUrl}/v2/lm/deployments/${deploymentId}/chat/completions`];
  const payload={ model, max_tokens:maxTokens, temperature:0.2, messages:[{ role:"system",content:systemPrompt },...messages] };
  for (const endpoint of endpoints) {
    try { const res=await axios.post(endpoint,payload,{ headers:{ Authorization:`Bearer ${token}`,"AI-Resource-Group":resourceGroup,"Content-Type":"application/json" }, httpsAgent, timeout:30000 }); return res.data?.choices?.[0]?.message?.content||""; }
    catch(err){ if (endpoint===endpoints[endpoints.length-1]) throw err; }
  }
}

function localRiskScore(input) {
  const { criticalAlerts=0,warningAlerts=0,failedDeployments=0,pendingDeployments=0,pipelineStatus="OK",prodAvailability=99.9,pendingApprovals=0,rejectedCRs=0,complianceRate=100 }=input;
  const importRisk=Math.min(98,Math.max(2,criticalAlerts*20+warningAlerts*7+failedDeployments*12+(pipelineStatus==="BLOCKED"?25:pipelineStatus==="DEGRADED"?12:0)+((100-prodAvailability)*2.5)+pendingApprovals*3+rejectedCRs*8));
  const healthScore=Math.round(Math.max(0,Math.min(100,100-criticalAlerts*15-warningAlerts*5-failedDeployments*8-(pendingDeployments>10?8:0)-((100-complianceRate)*0.5))));
  const approvalRate=Math.min(99,Math.max(50,complianceRate));
  const factors=[];
  if (criticalAlerts>0) factors.push({ factor:"Critical health alerts",impact:"HIGH",value:criticalAlerts });
  if (warningAlerts>0)  factors.push({ factor:"Warning alerts active",impact:warningAlerts>3?"HIGH":"MEDIUM",value:warningAlerts });
  if (failedDeployments>0) factors.push({ factor:"Failed deployments",impact:"HIGH",value:failedDeployments });
  const level=importRisk>=65?"HIGH":importRisk>=35?"MEDIUM":"LOW";
  const recommendation=level==="HIGH"?`Do not proceed with imports. ${criticalAlerts} critical alert(s) active on PROD.`:level==="MEDIUM"?"Proceed with caution. Run import simulation in STMS.":"System is stable. Safe to proceed with planned imports.";
  return { healthScore,importRisk,importRiskLevel:level,approvalRate,factors,recommendation,trend:healthScore>=80?"STABLE":healthScore>=60?"DEGRADING":"CRITICAL",modelVersion:"local-fallback-v1",aiPowered:false };
}

app.post("/api/ai/predict", async (req, res) => {
  const { criticalAlerts=0,warningAlerts=0,failedDeployments=0,pendingDeployments=0,pipelineStatus="OK",prodAvailability=99.9,pendingApprovals=0,rejectedCRs=0,complianceRate=100,recentAlerts=[],recentCRs=[] }=req.body;
  const local=localRiskScore({ criticalAlerts,warningAlerts,failedDeployments,pendingDeployments,pipelineStatus,prodAvailability,pendingApprovals,rejectedCRs,complianceRate });
  try {
    const systemPrompt=`You are SAP Core AI. Analyse SAP system metrics and return JSON ONLY.\nSchema: { "healthScore":<0-100>,"importRisk":<0-100>,"importRiskLevel":"LOW"|"MEDIUM"|"HIGH","approvalRate":<0-100>,"trend":"IMPROVING"|"STABLE"|"DEGRADING"|"CRITICAL","recommendation":"<2-3 sentences>","factors":[{"factor":"","impact":"HIGH"|"MEDIUM"|"LOW","value":<number>}],"insight":"<1 sentence>","modelVersion":"sap-core-ai-v2.4","aiPowered":true }`;
    const userMessage=`SAP metrics: criticalAlerts=${criticalAlerts}, warningAlerts=${warningAlerts}, failedDeployments=${failedDeployments}, pendingDeployments=${pendingDeployments}, pipelineStatus=${pipelineStatus}, prodAvailability=${prodAvailability}%, pendingApprovals=${pendingApprovals}, rejectedCRs=${rejectedCRs}, complianceRate=${complianceRate}%`;
    const raw=await callAICore([{ role:"user",content:userMessage }],systemPrompt,600);
    const parsed=JSON.parse(raw.replace(/```json|```/g,"").trim());
    return res.json({ ...parsed, aiPowered:true, modelVersion:"sap-core-ai-v2.4" });
  } catch(aiErr){ return res.json({ ...local, aiPowered:false, modelVersion:"local-fallback-v1" }); }
});

app.post("/api/ai/predict/transport", async (req, res) => {
  const { trkorr="",owner="",status="",objectCount=0,objectTypes=[],failedObjects=0,logErrors=0,crStatus="NONE",prodHealthOk=true }=req.body;
  let score=20;
  if (status==="Modifiable") score+=20; if (status==="Failed") score+=35;
  score+=Math.min(failedObjects*12,36); score+=Math.min(logErrors*8,24);
  if (objectCount>10) score+=10; if (objectTypes.includes("PROG")||objectTypes.includes("FUGR")) score+=8;
  if (objectTypes.includes("AUTH")) score+=10; if (crStatus==="REJECTED") score+=15; if (!prodHealthOk) score+=12;
  const localScore=Math.min(98,Math.max(5,score));
  const localLevel=localScore>=65?"HIGH":localScore>=40?"MEDIUM":"LOW";
  try {
    const systemPrompt=`You are SAP Core AI. Return ONLY JSON: { "riskScore":<0-100>,"riskLevel":"LOW"|"MEDIUM"|"HIGH","recommendation":"<2 sentences>","aiPowered":true }`;
    const userMessage=`Transport: ${trkorr}, Owner: ${owner}, Status: ${status}, Objects: ${objectCount}, Failed: ${failedObjects}, Errors: ${logErrors}, CR: ${crStatus}`;
    const raw=await callAICore([{ role:"user",content:userMessage }],systemPrompt,200);
    const parsed=JSON.parse(raw.replace(/```json|```/g,"").trim());
    return res.json({ ...parsed, aiPowered:true });
  } catch(aiErr){ return res.json({ riskScore:localScore,riskLevel:localLevel,recommendation:localLevel==="HIGH"?"High risk. Resolve errors and ensure CR is approved.":"Safe to proceed with standard monitoring.",aiPowered:false }); }
});

app.get("/api/ai/status", async (req, res) => {
  const baseUrl=getAICoreBaseUrl();
  if (!baseUrl) return res.json({ configured:false,reachable:false,mode:"local-fallback" });
  try { const dep=await discoverAICoreDeployment(); res.json({ configured:true,reachable:true,mode:"sap-core-ai",baseUrl,deploymentId:dep.deploymentId,resourceGroup:dep.resourceGroup,model:AI_CORE_MODEL_NAME }); }
  catch(err){ res.json({ configured:true,reachable:false,mode:"local-fallback",message:err.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  SAP CLOUD TRANSPORT MANAGEMENT
//  Uses direct token from CLOUD_TM_SERVICE_KEY (destination token has wrong audience)
// ═════════════════════════════════════════════════════════════════════════════
const CLOUD_TM_DEST_NAME = process.env.CLOUD_TM_DEST_NAME || "CLOUD_TM_DEST";

let cloudTmToken       = null;
let cloudTmTokenExpiry = 0;

async function getCloudTmToken() {
  if (cloudTmToken && Date.now() < cloudTmTokenExpiry - 30000) return cloudTmToken;
  let clientId, clientSecret, tokenUrl;
  if (process.env.CLOUD_TM_SERVICE_KEY) {
    try { const k=JSON.parse(process.env.CLOUD_TM_SERVICE_KEY); clientId=k.uaa?.clientid||k.clientid; clientSecret=k.uaa?.clientsecret||k.clientsecret; tokenUrl=k.uaa?.url||k.url; if (!process.env.CLOUD_TM_URL&&k.uri) process.env.CLOUD_TM_URL=k.uri; } catch {}
  }
  clientId=clientId||process.env.CLOUD_TM_CLIENT_ID; clientSecret=clientSecret||process.env.CLOUD_TM_CLIENT_SECRET; tokenUrl=tokenUrl||process.env.CLOUD_TM_TOKEN_URL;
  if (!clientId) throw new Error("Cloud TM credentials not configured. Set CLOUD_TM_SERVICE_KEY env var.");
  const fullUrl=tokenUrl.endsWith("/oauth/token")?tokenUrl:`${tokenUrl}/oauth/token`;
  const r=await axios.post(fullUrl,new URLSearchParams({ grant_type:"client_credentials",client_id:clientId,client_secret:clientSecret }),{ headers:{ "Content-Type":"application/x-www-form-urlencoded" }, httpsAgent });
  cloudTmToken=r.data.access_token; cloudTmTokenExpiry=Date.now()+(r.data.expires_in||3600)*1000;
  console.log("✅ Cloud TM token fetched"); return cloudTmToken;
}

function getCloudTmBaseUrl() {
  if (process.env.CLOUD_TM_SERVICE_KEY) { try { return JSON.parse(process.env.CLOUD_TM_SERVICE_KEY).uri||null; } catch {} }
  return process.env.CLOUD_TM_URL||"https://hcl-integrationsuite-qxeoz78m.ts.cfapps.eu10.hana.ondemand.com";
}

async function callCloudTm(path, params={}) {
  const baseUrl=getCloudTmBaseUrl();
  const qs=Object.keys(params).length?"?"+new URLSearchParams(params).toString():"";
  const url=`${baseUrl}/v1${path}${qs}`;
  const token=await getCloudTmToken();
  const r=await axios.get(url,{ headers:{ Authorization:`Bearer ${token}`, Accept:"application/json" }, httpsAgent, timeout:12000 });
  return r.data;
}

function mapTmRequest(r) {
  return { id:r.id||"—", name:r.description||r.id||"—", description:r.description||"—", status:r.state||r.status||"Initial", owner:r.owner||r.createdBy||"—", createdAt:r.createdAt||null, targetNode:r.origin||r.targetNode||"—", contentType:r.preferredContentType||r.contentType||"MTA" };
}

function inferEnv(name) {
  const n=(name||"").toUpperCase();
  if (n.includes("PROD")||n.includes("PRD")) return "PROD";
  if (n.includes("QAS")||n.includes("TEST")) return "QAS";
  if (n.includes("DEV")) return "DEV";
  return "—";
}

function mockTmNodes()    { return [{ id:"node-dev",name:"HCL-BTP-DEV",env:"DEV",type:"MTA",queueCount:6 },{ id:"node-qas",name:"HCL-BTP-QAS",env:"QAS",type:"MTA",queueCount:3 },{ id:"node-prod",name:"HCL-BTP-PROD",env:"PROD",type:"MTA",queueCount:1 }]; }
function mockTmRequests() { return [{ id:"TQ-0042",name:"transport-dashboard-v3.1.2",status:"Initial",owner:"RBASIS",createdAt:new Date().toISOString(),targetNode:"HCL-BTP-DEV",contentType:"MTA" },{ id:"TQ-0041",name:"cloud-alm-backend-v2.4",status:"Imported",owner:"RDEV01",createdAt:new Date().toISOString(),targetNode:"HCL-BTP-QAS",contentType:"MTA" }]; }
function mockTmSummary()  { return { totalNodes:3,totalPending:4,totalRequests:6,imported:3,failed:1,initial:2,timestamp:new Date().toISOString(),isMock:true }; }

app.get("/api/cloudtm/debug", async (req, res) => {
  const result={ step1_hasKey:!!(process.env.CLOUD_TM_SERVICE_KEY), step2_baseUrl:getCloudTmBaseUrl(), step3_token:false, step4_nodes:null, step5_requests:null, step5_error:null };
  try { await getCloudTmToken(); result.step3_token=true; } catch(e){ result.step5_error="Token: "+e.message; return res.json(result); }
  try { result.step4_nodes=await callCloudTm("/nodes"); } catch(e){ result.step4_nodes={ error:e.message }; }
  try { result.step5_requests=await callCloudTm("/transportRequests",{ pageSize:5 }); } catch(e){ result.step5_error=e.message; }
  res.json(result);
});

app.get("/api/cloudtm/status", async (req, res) => {
  try { await getCloudTmToken(); res.json({ configured:true,reachable:true,baseUrl:getCloudTmBaseUrl() }); }
  catch(e){ res.json({ configured:!!process.env.CLOUD_TM_SERVICE_KEY,reachable:false,error:e.message }); }
});

app.get("/api/cloudtm/nodes", async (req, res) => {
  try { const data=await callCloudTm("/nodes"); const nodes=(data.nodes||data.value||[]).map(n=>({ id:n.nodeId||n.id,name:n.nodeName||n.name,type:n.contentType||"MTA",env:inferEnv(n.nodeName||n.name) })); res.json({ nodes,count:nodes.length }); }
  catch(e){ res.status(502).json({ error:e.message }); }
});

app.get("/api/cloudtm/requests", async (req, res) => {
  const { limit=50 }=req.query;
  try { const data=await callCloudTm("/transportRequests",{ pageSize:limit }); const requests=(data.transports||data.transportRequests||data.collection||data.value||[]).map(mapTmRequest); res.json({ requests,count:requests.length }); }
  catch(e){ res.status(502).json({ error:e.message }); }
});

app.get("/api/cloudtm/requests/:id", async (req, res) => {
  try { const data=await callCloudTm("/transportRequests/"+req.params.id); res.json(mapTmRequest(data)); }
  catch(e){ res.status(502).json({ error:e.message }); }
});

app.get("/api/cloudtm/dashboard", async (req, res) => {
  const hasKey=!!(process.env.CLOUD_TM_SERVICE_KEY||process.env.CLOUD_TM_CLIENT_ID||process.env.CLOUD_TM_URL);
  if (!hasKey) return res.json({ configured:false, message:"Set CLOUD_TM_SERVICE_KEY env var", nodes:mockTmNodes(),queues:[],requests:mockTmRequests(),summary:mockTmSummary() });
  try {
    const [nodesData,requestsData]=await Promise.all([callCloudTm("/nodes").catch(()=>({})),callCloudTm("/transportRequests",{ pageSize:100 })]);
    const nodes=(nodesData.nodes||nodesData.value||nodesData.transportNodes||[]);
    const requests=(requestsData.transports||requestsData.transportRequests||requestsData.collection||requestsData.value||[]).map(mapTmRequest);
    const queueResults=await Promise.allSettled(nodes.map(async n=>{ const nodeId=n.nodeId||n.id; try { const qd=await callCloudTm(`/nodes/${nodeId}/transportRequests`); return { node:n.nodeName||n.name,nodeId,env:inferEnv(n.nodeName||n.name),entries:(qd.transportRequests||qd.transports||qd.value||qd||[]).map(mapTmRequest) }; } catch { return { node:n.nodeName||n.name,nodeId,env:inferEnv(n.nodeName||n.name),entries:[] }; } }));
    const queues=queueResults.map(r=>r.status==="fulfilled"?r.value:{ entries:[] });
    const totalPending=queues.reduce((s,q)=>s+q.entries.length,0);
    const summary={ totalNodes:nodes.length,totalPending,totalRequests:requests.length,imported:requests.filter(r=>r.status==="Imported").length,failed:requests.filter(r=>r.status==="Failed").length,initial:requests.filter(r=>r.status==="Initial").length,timestamp:new Date().toISOString() };
    res.json({ configured:true,nodes:nodes.map(n=>({ id:n.nodeId||n.id,name:n.nodeName||n.name,type:n.contentType||"MTA",env:inferEnv(n.nodeName||n.name),queueCount:queues.find(q=>q.nodeId===(n.nodeId||n.id))?.entries?.length??0 })),queues,requests:requests.slice(0,50),summary });
  } catch(err){ console.error("Cloud TM dashboard:",err.message); res.json({ configured:true,error:err.message,nodes:mockTmNodes(),queues:[],requests:mockTmRequests(),summary:mockTmSummary() }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  SAP BTP DEPLOYMENT STATUS + GITHUB ACTIONS
// ═════════════════════════════════════════════════════════════════════════════
const GITHUB_REPO = process.env.GITHUB_REPO || "ravirok/transport-dashboard";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

async function callGitHub(path) {
  const headers={ Accept:"application/vnd.github+json","User-Agent":"TransTrack-Pro" };
  if (GITHUB_TOKEN) headers["Authorization"]=`Bearer ${GITHUB_TOKEN}`;
  const r=await axios.get(`https://api.github.com/repos/${GITHUB_REPO}${path}`,{ headers, timeout:10000 });
  return r.data;
}

function formatUptime(seconds) {
  if (!seconds) return "—";
  const d=Math.floor(seconds/86400), h=Math.floor((seconds%86400)/3600), m=Math.floor((seconds%3600)/60);
  if (d>0) return `${d}d ${h}h`; if (h>0) return `${h}h ${m}m`; return `${m}m`;
}

function timeAgo(date) {
  const diff=Date.now()-date.getTime(), mins=Math.floor(diff/60000);
  if (mins<1)  return "just now";
  if (mins<60) return `${mins} min ago`;
  const hrs=Math.floor(mins/60);
  if (hrs<24)  return `${hrs} hr${hrs>1?"s":""} ago`;
  return `${Math.floor(hrs/24)} day${Math.floor(hrs/24)>1?"s":""} ago`;
}

// GET /api/btp/status — reads VCAP_APPLICATION (auto-injected by CF, no credentials needed)
app.get("/api/btp/status", async (req, res) => {
  let vcapApp={};
  try { vcapApp=JSON.parse(process.env.VCAP_APPLICATION||"{}"); } catch {}
  const memUsed=Math.round(process.memoryUsage().rss/1024/1024);
  const uptime=formatUptime(Math.floor(process.uptime()));
  let lastDeploy=null;
  try { const ghData=await callGitHub("/actions/runs?per_page=1&branch=main&status=success"); const run=(ghData.workflow_runs||[])[0]; if (run) lastDeploy={ type:"CI/CD pipeline",actor:run.actor?.login||"GitHub Actions",time:run.created_at,timeAgo:timeAgo(new Date(run.created_at)),url:run.html_url,runNumber:run.run_number }; } catch {}
  res.json({
    configured: true,
    app: { name:vcapApp.application_name||"hcl-america-solutions-inc--hclbuild-g03o2ijo",guid:vcapApp.application_id||"",state:"STARTED",uri:(vcapApp.application_uris||[])[0]||null },
    process: { instances:1, memoryMB:vcapApp.limits?.mem||256, diskMB:vcapApp.limits?.disk||1024 },
    instances: [{ index:vcapApp.instance_index||0, state:"RUNNING", memMB:memUsed, memLimit:vcapApp.limits?.mem||256, uptime }],
    lastDeploy,
    environment: { org:vcapApp.organization_name||"HCL America Solutions Inc.", space:vcapApp.space_name||"dev", region:"eu10-004", url:(vcapApp.application_uris||[])[0]?`https://${vcapApp.application_uris[0]}`:null },
  });
});

// GET /api/btp/pipelines — GitHub Actions workflow runs
app.get("/api/btp/pipelines", async (req, res) => {
  try {
    const data=await callGitHub("/actions/runs?per_page=10&branch=main");
    const runs=(data.workflow_runs||[]).map(r=>({ id:r.run_number, name:r.name||r.display_title, status:r.conclusion==="success"?"success":r.status==="in_progress"?"running":r.conclusion==="failure"?"failed":"pending", branch:r.head_branch, commit:(r.head_sha||"").slice(0,7), time:r.created_at?timeAgo(new Date(r.created_at)):"—", url:r.html_url, duration:(r.created_at&&r.updated_at)?formatDuration(new Date(r.updated_at)-new Date(r.created_at)):"—" }));
    res.json({ runs, total:data.total_count||runs.length });
  } catch(e){ res.json({ runs:[], error:e.message }); }
});

function formatDuration(ms) {
  if (!ms) return "—";
  const s=Math.floor(ms/1000), m=Math.floor(s/60);
  return m>0?`${m}m ${s%60}s`:`${s}s`;
}

// ═════════════════════════════════════════════════════════════════════════════
//  SERVE FRONTEND
// ═════════════════════════════════════════════════════════════════════════════
app.use((req, res, next) => {
  if (req.path.endsWith('.html')||req.path==='/'||req.path==='/alm') { res.set('Cache-Control','no-store, no-cache, must-revalidate'); res.set('Pragma','no-cache'); res.set('Expires','0'); }
  next();
});

app.use(express.static(path.join(__dirname, "../frontend")));
app.get("/alm",           (req,res)=>res.sendFile(path.join(__dirname,"../frontend/cloud_alm.html")));
app.get("/cloud_alm.html",(req,res)=>res.sendFile(path.join(__dirname,"../frontend/cloud_alm.html")));
app.get(/^\/(?!api|debug).*/, (req,res)=>res.sendFile(path.join(__dirname,"../frontend/index.html")));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 SAP Destination:       ${DESTINATION_NAME}`);
  console.log(`☁️  Cloud ALM Destination: ${CALM_DESTINATION_NAME}`);
  console.log(`🧠 AI Core URL:           ${getAICoreBaseUrl()||"not configured"}`);
  console.log(`🧠 AI Core Model:         ${AI_CORE_MODEL_NAME}`);
  console.log(`🐙 GitHub Repo:           ${GITHUB_REPO}`);
  console.log(`☁️  Cloud TM URL:          ${getCloudTmBaseUrl()}`);
  console.log(`☁️  Cloud TM Key:          ${!!process.env.CLOUD_TM_SERVICE_KEY}`);
});
