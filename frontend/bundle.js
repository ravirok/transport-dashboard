const root = document.getElementById("root");

root.innerHTML = `
  <h2 style="font-size:20px; font-weight:bold;">Dashboard Loaded ✅</h2>
  <p>Fetching transports...</p>
`;

fetch("https://hcl-america-solutions-inc--hclbuild-g03o2ijo-dev-transp28ffac8d.cfapps.eu10-004.hana.ondemand.com/api/Transports")
  .then(res => res.json())
  .then(data => {
    console.log("Data:", data);

    root.innerHTML += `<pre>${JSON.stringify(data, null, 2)}</pre>`;
  })
  .catch(err => {
    console.error(err);
    root.innerHTML += `<p style="color:red;">Error loading data</p>`;
  });
