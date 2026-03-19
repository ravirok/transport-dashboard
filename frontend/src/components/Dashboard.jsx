import React, { useEffect, useState } from "react";
import axios from "axios";

export default function Dashboard() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [aiRisk, setAiRisk] = useState(0);

  // Pagination
  const [top, setTop] = useState(50);
  const [skip, setSkip] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  const fetchLogs = async (topRows = 50, skipRows = 0) => {
    setLoading(true);
    setError(null);
    try {
      const res = await axios.get(`/api/logs?top=${topRows}&skip=${skipRows}`);
      const data = res.data;
      const results = data?.d?.results || [];
      setLogs(results);
      setTotalCount(data?.d?.__count || results.length);
      setLoading(false);

      const failedCount = results.length;
      setAiRisk(Math.min(100, failedCount * 2));
    } catch (err) {
      console.error(err);
      setError("Failed to fetch logs");
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs(top, skip);
  }, [top, skip]);

  const handleNext = () => {
    if (skip + top < totalCount) setSkip(skip + top);
  };
  const handlePrev = () => {
    if (skip - top >= 0) setSkip(skip - top);
  };

  return (
    <div className="p-5 font-sans">
      <h1>TransTrack Pro Dashboard</h1>

      <div
        className={`p-4 mb-5 rounded border ${
          aiRisk > 50 ? "bg-red-100" : "bg-blue-100"
        }`}
      >
        <h2>AI Risk Analysis</h2>
        <p className="font-bold">Risk score: {aiRisk}%</p>
      </div>

      {loading && <p>Loading logs...</p>}
      {error && <p className="text-red-600">{error}</p>}

      {!loading && !error && logs.length > 0 && (
        <>
          <table className="w-full border-collapse mb-3">
            <thead className="bg-gray-200">
              <tr>
                <th className="p-2 border-b">Transport</th>
                <th className="p-2 border-b">Log ID</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.object_name + log.log_id}>
                  <td className="p-2 border-b">{log.object_name}</td>
                  <td className="p-2 border-b">{log.log_id}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex justify-between w-48">
            <button onClick={handlePrev} disabled={skip === 0}>
              Previous
            </button>
            <button onClick={handleNext} disabled={skip + top >= totalCount}>
              Next
            </button>
          </div>
          <p className="mt-2">
            Showing {skip + 1}-{Math.min(skip + top, totalCount)} of {totalCount} logs
          </p>
        </>
      )}

      {!loading && !error && logs.length === 0 && <p>No logs found.</p>}
    </div>
  );
}
