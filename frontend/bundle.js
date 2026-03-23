const root = document.getElementById('root');

// Fetch API
fetch('https://hcl-america-solutions-inc--hclbuild-g03o2ijo-dev-transp28ffac8d.cfapps.eu10-004.hana.ondemand.com/api/transports')
  .then(res => res.json())
  .then(data => {
    const transports = data && data.d && data.d.results ? data.d.results : [];

    // No data case
    if (transports.length === 0) {
      root.innerHTML = "<p>No transports found</p>";
      return;
    }

    // Build table
    let html = `
      <h2>Transport Details</h2>
      <table border="1" cellpadding="10" cellspacing="0">
        <tr>
          <th>Transport ID</th>
          <th>Description</th>
          <th>Status</th>
          <th>Risk</th>
        </tr>
    `;

    transports.forEach(t => {
      html += `
        <tr>
          <td>${t.Transport}</td>
          <td>${t.Description}</td>
          <td>${t.Status}</td>
          <td>${t.RiskScore}</td>
        </tr>
      `;
    });

    html += "</table>";

    root.innerHTML = html;
  })
  .catch(err => {
    console.error("FETCH ERROR:", err);
    root.innerHTML = `<p style="color:red;">Error loading data</p>`;
  });
