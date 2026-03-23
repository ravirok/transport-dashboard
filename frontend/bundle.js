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

// ─── Format date "20150615" → "2015-06-15" ───────────────────────────────────
function formatDate(raw) {
  if (!raw || raw.length !== 8) return raw || '-';
  return `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`;
}

// ─── Status badge HTML ────────────────────────────────────────────────────────
function statusBadge(status) {
  if (status === 'R') return '<span class="badge badge-released">Released</span>';
  if (status === 'D') return '<span class="badge badge-modifiable">Modifiable</span>';
  return `<span class="badge badge-unknown">${status || 'Unknown'}</span>`;
}

// ─── Show modal with loading state, then fetch Objects + Logs ─────────────────
async function showTransportModal(t) {
  // Show modal immediately with basic info + loading spinner
  modalContent.innerHTML = `
    <h3>📦 ${t.TRKORR}</h3>
    <p><strong>Owner:</strong> ${t.OWNER || '-'}</p>
    <p><strong>Created On:</strong> ${formatDate(t.CREATED_ON)}</p>
    <p><strong>Status:</strong> ${t.STATUS === 'R' ? 'Released' : t.STATUS === 'D' ? 'Modifiable' : t.STATUS || '-'}</p>
    <div id="modal-objects"><p style="color:#888; margin-top:16px;">⏳ Loading objects...</p></div>
    <div id="modal-logs"><p style="color:#888;">⏳ Loading logs...</p></div>
  `;
  modal.style.display = 'block';

  // Fetch Objects and Logs in parallel
  try {
    const [objectsRes, logsRes] = await Promise.all([
      fetch(`/api/transports/${encodeURIComponent(t.TRKORR)}/objects`).then(r => r.json()),
      fetch(`/api/transports/${encodeURIComponent(t.TRKORR)}/logs`).then(r => r.json()),
    ]);

    const objects = objectsRes?.d?.results || [];
    const logs    = logsRes?.d?.results    || [];

    // ── Render Objects ──────────────────────────────────────────────
    const objectsEl = document.getElementById('modal-objects');
    if (objects.length === 0) {
      objectsEl.innerHTML = '<p style="color:#888; margin-top:16px;">No objects found.</p>';
    } else {
      let objHtml = `
        <h4 style="margin-top:16px; margin-bottom:8px;">📁 Objects (${objects.length})</h4>
        <table style="width:100%; font-size:13px;">
          <tr>
            ${Object.keys(objects[0])
              .filter(k => k !== '__metadata')
              .map(k => `<th style="background:#f2f2f2; padding:6px 8px; border:1px solid #ddd;">${k}</th>`)
              .join('')}
          </tr>
      `;
      objects.forEach(o => {
        objHtml += '<tr>';
        Object.entries(o)
          .filter(([k]) => k !== '__metadata')
          .forEach(([, v]) => {
            objHtml += `<td style="padding:6px 8px; border:1px solid #ddd;">${v || '-'}</td>`;
          });
        objHtml += '</tr>';
      });
      objHtml += '</table>';
      objectsEl.innerHTML = objHtml;
    }

    // ── Render Logs ─────────────────────────────────────────────────
    const logsEl = document.getElementById('modal-logs');
    if (logs.length === 0) {
      logsEl.innerHTML = '<p style="color:#888; margin-top:12px;">No logs found.</p>';
    } else {
      let logHtml = `
        <h4 style="margin-top:16px; margin-bottom:8px;">📋 Logs (${logs.length})</h4>
        <table style="width:100%; font-size:13px;">
          <tr>
            ${Object.keys(logs[0])
              .filter(k => k !== '__metadata')
              .map(k => `<th style="background:#f2f2f2; padding:6px 8px; border:1px solid #ddd;">${k}</th>`)
              .join('')}
          </tr>
      `;
      logs.forEach(l => {
        logHtml += '<tr>';
        Object.entries(l)
          .filter(([k]) => k !== '__metadata')
          .forEach(([, v]) => {
            logHtml += `<td style="padding:6px 8px; border:1px solid #ddd;">${v || '-'}</td>`;
          });
        logHtml += '</tr>';
      });
      logHtml += '</table>';
      logsEl.innerHTML = logHtml;
    }

  } catch (err) {
    console.error('Modal fetch error:', err);
    document.getElementById('modal-objects').innerHTML =
      `<p style="color:red; margin-top:12px;">❌ Failed to load details: ${err.message}</p>`;
    document.getElementById('modal-logs').innerHTML = '';
  }
}

// ─── Main fetch ───────────────────────────────────────────────────────────────
fetch('/api/transports')
  .then(res => res.json())
  .then(data => {
    loading.style.display = 'none';

    const transports = data?.d?.results || [];

    if (transports.length === 0) {
      root.innerHTML = '<p style="color:#888;">No transports found.</p>';
      tableWrapper.style.display = 'block';
      return;
    }

    // ── Risk Summary ────────────────────────────────────────────────
    const riskSummary = { high: 0, medium: 0, low: 0 };
    transports.forEach(t => {
      if      (t.STATUS === 'D') riskSummary.high++;
      else if (t.STATUS === 'R') riskSummary.low++;
      else                       riskSummary.medium++;
    });

    riskContainer.innerHTML = `
      <div class="risk-card risk-high">🔴 High Risk: ${riskSummary.high}</div>
      <div class="risk-card risk-medium">🟡 Medium Risk: ${riskSummary.medium}</div>
      <div class="risk-card risk-low">🟢 Low Risk: ${riskSummary.low}</div>
    `;

    // ── Chart ───────────────────────────────────────────────────────
    chartWrapper.style.display = 'block';
    const ctx = document.getElementById('statusChart').getContext('2d');
    new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Released (R)', 'Modifiable (D)', 'Other'],
        datasets: [{
          data: [riskSummary.low, riskSummary.high, riskSummary.medium],
          backgroundColor: ['#27ae60', '#e74c3c', '#f39c12'],
          borderWidth: 1,
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom' } }
      }
    });

    // ── Table ───────────────────────────────────────────────────────
    tableWrapper.style.display = 'block';

    let html = `
      <table>
        <tr>
          <th>Transport ID</th>
          <th>Owner</th>
          <th>Created On</th>
          <th>Status</th>
        </tr>
    `;

    transports.forEach(t => {
      const rowClass = t.STATUS === 'D' ? 'modifiable' : '';
      const title    = t.STATUS === 'D' ? 'title="Click to view objects & logs"' : '';
      html += `
        <tr class="${rowClass}" ${title} data-trkorr="${t.TRKORR}"
            data-owner="${t.OWNER}" data-date="${t.CREATED_ON}" data-status="${t.STATUS}">
          <td>${t.TRKORR     || '-'}</td>
          <td>${t.OWNER      || '-'}</td>
          <td>${formatDate(t.CREATED_ON)}</td>
          <td>${statusBadge(t.STATUS)}</td>
        </tr>
      `;
    });

    html += '</table>';
    root.innerHTML = html;

    // ── Click ANY row to see Objects + Logs ─────────────────────────
    document.querySelectorAll('#root tr[data-trkorr]').forEach(tr => {
      tr.style.cursor = 'pointer';
      tr.onclick = () => {
        const t = {
          TRKORR:     tr.dataset.trkorr,
          OWNER:      tr.dataset.owner,
          CREATED_ON: tr.dataset.date,
          STATUS:     tr.dataset.status,
        };
        showTransportModal(t);
      };
    });
  })
  .catch(err => {
    loading.style.display = 'none';
    console.error('FETCH ERROR:', err);
    root.innerHTML = `<p style="color:red;">❌ Failed to load transports: ${err.message}</p>`;
    tableWrapper.style.display = 'block';
  });
