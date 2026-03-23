const root = document.getElementById('root');
const modal = document.getElementById('modal');
const modalContent = document.getElementById('modalContent');
const closeModal = document.getElementById('closeModal');
const riskContainer = document.getElementById('risk-container');

closeModal.onclick = () => { modal.style.display = 'none'; };
window.onclick = e => { if (e.target == modal) modal.style.display = 'none'; };

fetch('/api/transports')
  .then(res => res.json())
  .then(data => {
    const transports = data?.d?.results || [];

    // ✅ Risk Summary based on STATUS field
    // R = Released, D = Modifiable, others treated as unknown
    const riskSummary = { high: 0, medium: 0, low: 0 };
    transports.forEach(t => {
      if (t.STATUS === 'D') riskSummary.high++;        // Modifiable = still open = high risk
      else if (t.STATUS === 'R') riskSummary.low++;    // Released = done = low risk
      else riskSummary.medium++;                        // Unknown status = medium
    });

    riskContainer.innerHTML = `
      <div class="risk-card risk-high">High Risk: ${riskSummary.high}</div>
      <div class="risk-card risk-medium">Medium Risk: ${riskSummary.medium}</div>
      <div class="risk-card risk-low">Low Risk: ${riskSummary.low}</div>
    `;

    if (transports.length === 0) {
      root.innerHTML = '<p>No transports found</p>';
      return;
    }

    // ✅ Table with correct SAP field names
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
      // Format date from "20150615" → "2015-06-15"
      const rawDate = t.CREATED_ON || "";
      const formattedDate = rawDate.length === 8
        ? `${rawDate.slice(0,4)}-${rawDate.slice(4,6)}-${rawDate.slice(6,8)}`
        : rawDate;

      // Status label
      const statusLabel = t.STATUS === 'R' ? 'Released'
                        : t.STATUS === 'D' ? 'Modifiable'
                        : t.STATUS || 'Unknown';

      const rowClass = t.STATUS === 'D' ? 'failed' : '';

      html += `<tr class='${rowClass}' data-transport='${JSON.stringify(t)}'>
                <td>${t.TRKORR     || '-'}</td>
                <td>${t.OWNER      || '-'}</td>
                <td>${formattedDate || '-'}</td>
                <td>${statusLabel}</td>
               </tr>`;
    });

    html += '</table>';
    root.innerHTML = html;

    // ✅ Click modifiable (high risk) transport to show modal
    document.querySelectorAll('tr.failed').forEach(tr => {
      tr.onclick = () => {
        const t = JSON.parse(tr.getAttribute('data-transport'));
        let content = `<h3>Transport: ${t.TRKORR}</h3>`;
        content += `<p><strong>Owner:</strong> ${t.OWNER || '-'}</p>`;
        content += `<p><strong>Created On:</strong> ${t.CREATED_ON || '-'}</p>`;
        content += `<p><strong>Status:</strong> ${t.STATUS || '-'}</p>`;

        if (t.FailedObjects && t.FailedObjects.length > 0) {
          content += '<h4>Failed Objects:</h4><ul>';
          t.FailedObjects.forEach(o => {
            content += `<li>${o.ObjectName} (${o.Type}): ${o.Error}</li>`;
          });
          content += '</ul>';
        }

        if (t.Logs && t.Logs.length > 0) {
          content += '<h4>Logs:</h4><ul>';
          t.Logs.forEach(l => { content += `<li>${l}</li>`; });
          content += '</ul>';
        }

        modalContent.innerHTML = content;
        modal.style.display = 'block';
      };
    });
  })
  .catch(err => {
    console.error('FETCH ERROR:', err);
    root.innerHTML = `<p style='color:red;'>${err.message}</p>`;
  });
