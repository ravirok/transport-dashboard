const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 4000;

console.log("SERVER STARTED 🚀");

// API
app.get("/api/transports", (req, res) => {
  res.json({ message: "API WORKING ✅" });
});

// static
app.use(express.static(path.join(__dirname, "../frontend")));

// catch-all
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
