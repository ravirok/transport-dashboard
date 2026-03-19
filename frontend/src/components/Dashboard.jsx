// frontend/src/components/Dashboard.jsx
import React, { useEffect, useState } from "react";
 
export default function Dashboard() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [aiRisk, setAiRisk] = useState(0);
 
  // Pagination
  const [top, setTop] = useState(50); // number of rows per page
  const [skip, setSkip] = useState(0); // offset
  const [totalCount, setTotalCount] = useState(0);
 
  // Fetch logs from backend
  const fetchLogs = async (topRows = 50, skipRows = 0) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/logs?top=${topRows}&skip=${skipRows}`);
      const data = await res.json();
      const results = data?.d?.results || [];
      setLogs(results);
      setTotalCount(data?.d?.__count || results.length);
      setLoading(false);
 
      // Simple AI Risk calculation (example: failedCount * 2, max 100)
      const failedCount = results.length;
      setAiRisk(Math.min(100, failedCount * 2));
    } catch (err) {
      console.error(err);
      setError("Failed to fetch logs");
      setLoading(false);
    }
  };
 
  // Initial fetch
  useEffect(() => {
    fetchLogs(top, skip);
  }, [top, skip]);
 
  // Pagination handlers
  const handleNext = () => {
    if (skip + top < totalCount) setSkip(skip + top);
  };
  const handlePrev = () => {
    if (skip - top >= 0) setSkip(skip - top);
  };
 
  return (
    <div style={{ padding: "20px", fontFamily: "Arial, sans-serif" }}>
      <h1>TransTrack Pro Dashboard</h1>
 
      {/* AI Risk Panel */}
      <div
        style={{
          padding: "15px",
          marginBottom: "20px",
          border: "1px solid #ccc",
          borderRadius: "8px",
          backgroundColor: aiRisk > 50 ? "#ffe6e6" : "#e6f7ff",
        }}
      >
        <h2>AI Risk Analysis</h2>
        <p style={{ fontWeight: "bold" }}>Risk score: {aiRisk}%</p>
      </div>
 
      {/* Loading / Error */}
      {loading && <p>Loading logs...</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}
 
      {/* Logs Table */}
      {!loading && !error && logs.length > 0 && (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "10px" }}>
            <thead style={{ backgroundColor: "#f0f0f0" }}>
              <tr>
                <th style={{ padding: "10px", borderBottom: "1px solid #ccc" }}>Transport</th>
                <th style={{ padding: "10px", borderBottom: "1px solid #ccc" }}>Log ID</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.object_name + log.log_id}>
                  <td style={{ padding: "10px", borderBottom: "1px solid #eee" }}>{log.object_name}</td>
                  <td style={{ padding: "10px", borderBottom: "1px solid #eee" }}>{log.log_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
 
          {/* Pagination Controls */}
          <div style={{ display: "flex", justifyContent: "space-between", width: "200px" }}>
            <button onClick={handlePrev} disabled={skip === 0}>
              Previous
            </button>
            <button onClick={handleNext} disabled={skip + top >= totalCount}>
              Next
            </button>
          </div>
          <p style={{ marginTop: "10px" }}>
            Showing {skip + 1}-{Math.min(skip + top, totalCount)} of {totalCount} logs
          </p>
        </>
      )}
 
      {!loading && !error && logs.length === 0 && <p>No logs found.</p>}
    </div>
  );
}
