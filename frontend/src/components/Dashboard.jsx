// frontend/src/components/Dashboard.jsx
import React, { useEffect, useState } from "react";
 
// Optional: you can add CSS classes or Tailwind later for styling
export default function Dashboard() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
 
  // AI Risk score (mock for demo)
  const [aiRisk, setAiRisk] = useState(0);
 
  useEffect(() => {
    // Fetch logs from backend
    fetch("/api/logs?top=50")
      .then((res) => res.json())
      .then((data) => {
        // Assuming OData v2 format: data.d.results
        const results = data?.d?.results || [];
        setLogs(results);
        setLoading(false);
 
        // Mock AI risk calculation
        if (results.length > 0) {
          const failedCount = results.length;
          const riskScore = Math.min(100, failedCount * 2); // simple example
          setAiRisk(riskScore);
        }
      })
      .catch((err) => {
        console.error(err);
        setError("Failed to fetch logs");
        setLoading(false);
      });
  }, []);
 
  return (
    <div className="dashboard-container" style={{ padding: "20px", fontFamily: "Arial, sans-serif" }}>
      <h1 style={{ marginBottom: "20px" }}>TransTrack Pro Dashboard</h1>
 
      {/* AI Risk Panel */}
      <div
        className="ai-risk-panel"
        style={{
          padding: "15px",
          marginBottom: "20px",
          border: "1px solid #ccc",
          borderRadius: "8px",
          backgroundColor: aiRisk > 50 ? "#ffe6e6" : "#e6f7ff",
        }}
      >
        <h2 style={{ margin: 0, marginBottom: "5px" }}>AI Risk Analysis</h2>
        <p style={{ fontSize: "18px", fontWeight: "bold", margin: 0 }}>
          Risk score for failed transports: {aiRisk}%
        </p>
      </div>
 
      {/* Error / Loading */}
      {loading && <p>Loading logs...</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}
 
      {/* Logs Table */}
      {!loading && !error && (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
          }}
        >
          <thead style={{ backgroundColor: "#f0f0f0" }}>
            <tr>
              <th style={{ padding: "10px", borderBottom: "1px solid #ccc" }}>Transport</th>
              <th style={{ padding: "10px", borderBottom: "1px solid #ccc" }}>Log ID</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.object_name}>
                <td style={{ padding: "10px", borderBottom: "1px solid #eee" }}>{log.object_name}</td>
                <td style={{ padding: "10px", borderBottom: "1px solid #eee" }}>{log.log_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
