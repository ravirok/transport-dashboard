// bundle.js
const root = document.getElementById("root");

root.innerHTML = "<h3>Loading Transports...</h3>";

fetch("/api/transports")
  .then(res => res.json())
  .then(data => {
    const transports = data?.d?.results || [];
    if(transports.length === 0){
      root.innerHTML = "<p>No transports found</p>";
      return;
    }

    let html = `<h2>Total Transports: ${transports.length}</h2><ul>`;
    transports.forEach(t => {
      html += `<li>ID: ${t.Transport || t.TransportNumber}, Description: ${t.Description || t.Text || 'N/A'}</li>`;
    });
    html += "</ul>";

    root.innerHTML = html;
  })
  .catch(err => {
    console.error(err);
    root.innerHTML = `<p style="color:red;">${err.message}</p>`;
  });
