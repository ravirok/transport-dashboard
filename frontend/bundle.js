// bundle.js
const root = document.getElementById("root");

// Show loading message
root.innerHTML = "<h3>Loading transports...</h3>";

// Fetch data from backend API
fetch("/Transports")
  .then(res => res.json()) // backend returns proper JSON
  .then(data => {
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
  })
  .catch(err => {
    console.error("FETCH ERROR:", err);
    root.innerHTML = `<p style="color:red;">Fetch Error: ${err.message}</p>`;
  });
