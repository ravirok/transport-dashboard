const root          = document.getElementById('root');
const modal         = document.getElementById('modal');
const modalContent  = document.getElementById('modalContent');
const closeModal    = document.getElementById('closeModal');
const riskContainer = document.getElementById('risk-container');
const loading       = document.getElementById('loading');
const chartWrapper  = document.getElementById('chartWrapper');
const tableWrapper  = document.getElementById('tableWrapper');

closeModal.onclick = () => { modal.style.display = 'none'; };
window.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };

// ─── Helpers ─────────────────────────────────────────

function formatDate(raw) {
  if (!raw || raw.length !== 8) return raw || '-';
  return `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`;
}

function statusBadge(status) {
  if (status === 'R') return '<span class="badge badge-released">Released</span>';
  if (status === 'D') return '<span class="badge badge-modifiable">Modifiable</span>';
  return `<span class="badge badge-unknown">${status || 'Unknown'}</span>`;
}

function renderTable(rows) {
  if (!rows || rows.length === 0) {
    return '<p style="color:#888; margin-top:8px;">No records found.</p>';
  }

  const keys = Object.keys(rows[0]).filter(k => k !== '__metadata');

  let html = '<table style="width:100%; font-size:13px; border-collapse:collapse; margin-top:8px;">';

  html += '<tr>' + keys.map(k =>
    `<th style="background:#f2f2f2; padding:6px 10px; border:1px solid #ddd;">${k}</th>`
  ).join('') + '</tr>';

  rows.forEach(row => {
    html += '<tr>' + keys.map(k =>
      `<td style="padding:6px 10px; border:1px solid #ddd;">${row[k] ?? '-'}</td>`
    ).join('') + '</tr>';
  });

  html += '</table>';
  return html;
}

// ─── MODAL ───────────────────────────────────────────

async function showTransportModal(t) {

  modalContent.innerHTML = `
    <h3>📦 ${t.TRKORR}</h3>
    <p><strong>Owner:</strong> ${t.OWNER || '-'}</p>
    <p><strong>Created:</strong> ${formatDate(t.CREATED_ON)}</p>
    <p><strong>Status:</strong> ${t.STATUS || '-'}</p>
    <hr>
    <div id="modal-objects"><p>⏳ Loading objects...</p></div>
    <div id="modal-logs" style="margin-top:15px;"><p>⏳ Loading logs...</p></div>
  `;

  modal.style.display = 'block';

  try {
    const trkorr = encodeURIComponent(t.TRKORR);

    const [objRes, logRes] = await Promise.all([
      fetch(`/api/transports/${trkorr}/objects`),
      fetch(`/api/transports/${trkorr}/logs`)
    ]);

    // ✅ SAFE JSON parsing
    const objJson = await objRes.json().catch(() => ({}));
    const logJson = await logRes.json().catch(() => ({}));

    const objects = objJson?.d?.results || [];
    const logs    = logJson?.d?.results || [];

    // ✅ OBJECTS RENDER
    document.getElementById('modal-objects').innerHTML =
      `<h4>📁 Objects (${objects.length})</h4>` + renderTable(objects);

    // ✅ LOGS RENDER (MAIN FIX 🔥)
    document.getElementById('modal-logs').innerHTML =
      `<h4>📋 Logs (${logs.length})</h4>` + renderTable(logs);

  } catch (err) {
    console.error("MODAL ERROR:", err);

    document.getElementById('modal-objects').innerHTML =
      `<p style="color:red;">❌ Failed to load objects</p>`;

    document.getElementById('modal-logs').innerHTML =
      `<p style="color:red;">❌ Failed to load logs</p>`;
  }
}

// ─── MAIN FETCH ──────────────────────────────────────

fetch('/api/transports')
  .then(res => res.json())
  .then(data => {

    loading.style.display = 'none';

    const transports = data?.d?.results || [];

    if (transports.length === 0) {
      root.innerHTML = '<p>No transports found</p>';
      return;
    }

    // Risk summary
    const riskSummary = { high: 0, medium: 0, low: 0 };

    transports.forEach(t => {
      if (t.STATUS === 'D') riskSummary.high++;
      else if (t.STATUS === 'R') riskSummary.low++;
      else riskSummary.medium++;
    });

    riskContainer.innerHTML = `
      <div class="risk-card risk-high">🔴 ${riskSummary.high}</div>
      <div class="risk-card risk-medium">🟡 ${riskSummary.medium}</div>
      <div class="risk-card risk-low">🟢 ${riskSummary.low}</div>
    `;

    // Chart
    chartWrapper.style.display = 'block';

    new Chart(document.getElementById('statusChart'), {
      type: 'doughnut',
      data: {
        labels: ['Released', 'Modifiable', 'Other'],
        datasets: [{
          data: [riskSummary.low, riskSummary.high, riskSummary.medium]
        }]
      }
    });

    // Table
    let html = `
      <table>
        <tr>
          <th>Transport</th>
          <th>Owner</th>
          <th>Date</th>
          <th>Status</th>
        </tr>
    `;

    transports.forEach(t => {
      html += `
        <tr data-trkorr="${t.TRKORR}">
          <td>${t.TRKORR}</td>
          <td>${t.OWNER}</td>
          <td>${formatDate(t.CREATED_ON)}</td>
          <td>${statusBadge(t.STATUS)}</td>
        </tr>
      `;
    });

    html += '</table>';
    root.innerHTML = html;

    // Click event
    document.querySelectorAll('tr[data-trkorr]').forEach(tr => {
      tr.onclick = () => {
        const t = transports.find(x => x.TRKORR === tr.dataset.trkorr);
        if (t) showTransportModal(t);
      };
    });

  })
  .catch(err => {
    console.error(err);
    loading.style.display = 'none';
    root.innerHTML = `<p style="color:red;">❌ Error loading data</p>`;
  });
