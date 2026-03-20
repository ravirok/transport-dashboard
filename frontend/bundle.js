const username = "YOUR_USER";
const password = "YOUR_PASSWORD";

fetch("http://hclcncs48.hcldigilabs.com:8000/sap/opu/odata/sap/Z_TRANSPORT_SRV_SRV/TransportSet?$format=json", {
  headers: {
    "Authorization": "Basic " + btoa(username + ":" + password)
  }
})
.then(res => res.text())
.then(text => {
  console.log("RAW:", text);

  document.getElementById("root").innerHTML =
    `<pre>${text}</pre>`;
})
.catch(err => {
  console.error(err);
  document.getElementById("root").innerHTML =
    `<p style="color:red;">${err.message}</p>`;
});
