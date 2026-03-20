// bundle.js

const root = document.getElementById("root");

// Show loading
root.innerHTML = "<h3>Loading Transports...</h3>";

// Use your working ABAP HTTPS URL with $format=json
const ABAP_URL = "https://hclcncs48.hcldigilabs.com:44300/sap/opu/odata/sap/Z_TRANSPORT_SRV_SRV/Transports?$format=json";

// If authentication required
const username = "52213818";
const password = "BTsolman@1234567";

fetch(ABAP_URL, {
  headers: {
    "Authorization": "Basic " + btoa(username + ":" + password),
    "Accept": "application/json"
  }
})
  .then(res => res.text())  // read raw text first
  .then(text => {
    console.log("RAW RESPONSE:", text);

    try {
      const data = JSON.parse(text); // parse JSON safely
      const transports = data?.d?.results || [];

      if (transports.length === 0) {
        root.innerHTML = "<p>No transports found</p>";
        return;
      }

      // Build dashboard HTML
      let html = `<h2>Total Transports: ${transports.length}</h2><ul>`;
      transports.forEach(t => {
        html += `<li>ID: ${t.Transport}, Description: ${t.Description || 'N/A'}</li>`;
      });
      html += "</ul>";

      root.innerHTML = html;
    } catch (err) {
      console.error("JSON PARSE ERROR:", err);
      root.innerHTML = `<p style="color:red;">JSON Parse Error: ${err.message}</p>`;
    }
  })
  .catch(err => {
    console.error("FETCH ERROR:", err);
    root.innerHTML = `<p style="color:red;">Fetch Error: ${err.message}</p>`;
  });
