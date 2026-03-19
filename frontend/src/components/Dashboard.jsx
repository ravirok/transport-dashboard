// frontend/src/components/Dashboard.jsx
import React, { useEffect, useState } from "react";
import axios from "axios";

export default function Dashboard() {
  const [transports, setTransports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [aiRisk, setAiRisk] = useState(0);

  // Pagination
  const [top, setTop] = useState(10); // rows per page
  const [skip, setSkip] = useState(0); // offset
  const [totalCount, setTotalCount] = useState(0);

  // Fetch transports from backend
  const fetchTransports = async (topRows = 10, skipRows = 0) => {
    setLoading(true);
    setError(null);
    try {
      // Make sure the route matches your backend
      const res = await axios.get("/api/transports", {
        params: { top: topRows, skip: skipRows }
      });
      const data = res.data || []; // raw array from backend

      setTransports(data);
      setTotalCount(data.length);

      // Simple AI Risk calculation (example: failedCount * 2, capped at 100)
      const failedCount = data.filter(t => t.TRSTATUS === "E").length;
      setAiRisk(Math.min(100, failedCount * 2));

      setLoading(false);
    } catch (err) {
      console.error(err);
      setError("Failed to fetch transports");
      setLoading(false);
    }
  };

  // Initial fetch
  useEffect(() => {
    fetchTransports(top, skip);
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
        <p style={{ fontWeight: "bold" }}>Risk Score: {aiRisk}%</p>
      </div>

      {/* Loading / Error */}
      {loading && <p>Loading transports...</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}

      {/* Transports Table */}
      {!loading && !error && transports.length > 0 && (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "10px" }}>
            <thead style={{ backgroundColor: "#f0f0f0" }}>
              <tr>
                <th style={{ padding: "10px", borderBottom: "1px solid #ccc" }}>Transport</th>
                <th style={{ padding: "10px", borderBottom: "1px solid #ccc" }}>Log ID</th>
                <th style={{ padding: "10px", borderBottom: "1px solid #ccc" }}>Object Name</th>
                <th style={{ padding: "10px", borderBottom: "1px solid #ccc" }}>Object Type</th>
              </tr>
            </thead>
            <tbody>
              {transports.slice(skip, skip + top).map((t, index) => (
                t.logs.map((log, i) => (
                  <tr key={`${t.TRKORR}-${log.log_id}-${i}`}>
                    <td style={{ padding: "10px", borderBottom: "1px solid #eee" }}>{t.TRKORR}</td>
                    <td style={{ padding: "10px", borderBottom: "1px solid #eee" }}>{log.log_id}</td>
                    <td style={{ padding: "10px", borderBottom: "1px solid #eee" }}>
                      {t.objects[i]?.obj_name || "-"}
                    </td>
                    <td style={{ padding: "10px", borderBottom: "1px solid #eee" }}>
                      {t.objects[i]?.object || "-"}
                    </td>
                  </tr>
                ))
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
            Showing {skip + 1}-{Math.min(skip + top, totalCount)} of {totalCount} transports
          </p>
        </>
      )}

      {!loading && !error && transports.length === 0 && <p>No transports found.</p>}
    </div>
  );
}
