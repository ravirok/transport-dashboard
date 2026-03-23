const root = document.getElementById('root');
const modal = document.getElementById('modal');
const modalContent = document.getElementById('modalContent');
const closeModal = document.getElementById('closeModal');
const riskContainer = document.getElementById('risk-container');

closeModal.onclick = () => { modal.style.display = 'none'; };
window.onclick = e => { if(e.target == modal) modal.style.display = 'none'; };

fetch('/api/transports')
  .then(res => res.json())
  .then(data => {
    const transports = data?.d?.results || [];

    // AI Risk Summary
    const riskSummary = { high: 0, medium: 0, low: 0 };
    transports.forEach(t => {
      if(t.RiskScore >= 0.7) riskSummary.high++;
      else if(t.RiskScore >= 0.4) riskSummary.medium++;
      else riskSummary.low++;
    });

    riskContainer.innerHTML = `
      <div class="risk-card risk-high">High Risk: ${riskSummary.high}</div>
      <div class="risk-card risk-medium">Medium Risk: ${riskSummary.medium}</div>
      <div class="risk-card risk-low">Low Risk: ${riskSummary.low}</div>
    `;

    if(transports.length === 0) {
      root.innerHTML = '<p>No transports found</p>';
      return;
    }

    // Table
    let html = '<table><tr><th>Transport ID</th><th>Description</th><th>Status</th></tr>';
    transports.forEach(t => {
      const rowClass = t.Status === 'Failed' ? 'failed' : '';
      html += `<tr class='${rowClass}' data-transport='${JSON.stringify(t)}'>` +
              `<td>${t.Transport}</td><td>${t.Description}</td><td>${t.Status}</td></tr>`;
    });
    html += '</table>';
    root.innerHTML = html;

    // Click failed transport to show modal
    document.querySelectorAll('tr.failed').forEach(tr => {
      tr.onclick = () => {
        const t = JSON.parse(tr.getAttribute('data-transport'));
        let content = `<h3>Failed Transport: ${t.Transport}</h3>`;
        content += '<h4>Failed Objects:</h4><ul>';
        t.FailedObjects.forEach(o => {
          content += `<li>${o.ObjectName} (${o.Type}): ${o.Error}</li>`;
        });
        content += '</ul><h4>Logs:</h4><ul>';
        t.Logs.forEach(l => { content += `<li>${l}</li>`; });
        content += '</ul>';
        modalContent.innerHTML = content;
        modal.style.display = 'block';
      };
    });
  })
  .catch(err => {
    console.error('FETCH ERROR:', err);
    root.innerHTML = `<p style='color:red;'>${err.message}</p>`;
  });
