const root = document.getElementById("root");

root.innerHTML = `
  <h2>Dashboard Loaded ✅</h2>
  <p>Fetching transports...</p>
`;

fetch("https://hcl-america-solutions-inc--hclbuild-g03o2ijo-dev-transp28ffac8d.cfapps.eu10-004.hana.ondemand.com/api/Transports")
  .then(res => res.json())
  .then(data => {
    console.log("FULL API RESPONSE:", data);

    // Handle SAP OData structure
    let transports = [];

    if (data?.d?.results) {
      transports = data.d.results;
    } else if (Array.isArray(data)) {
      transports = data;
    } else {
      transports = [];
    }

    if (transports.length === 0) {
      root.innerHTML += `<p>No data found</p>`;
      return;
    }

    root.innerHTML += `
      <h3>Total Records: ${transports.length}</h3>
      <pre>${JSON.stringify(transports, null, 2)}</pre>
    `;
  })
  .catch(err => {
    console.error("ERROR:", err);
    root.innerHTML += `<p style="color:red;">Error loading data</p>`;
  });
