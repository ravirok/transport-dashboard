import React, { useEffect, useState } from "react";
import axios from "axios";
import { PieChart, Pie, Cell, Tooltip, Legend } from "recharts";

const COLORS = ["#0088FE", "#00C49F", "#FFBB28", "#FF8042", "#A28DD0"];

export default function Dashboard() {
  const [transports, setTransports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    axios.get("/api/transports")  // backend URL
      .then(res => {
        setTransports(res.data || []);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) return <p>Loading transports...</p>;
  if (error) return <p className="text-red-600">Error: {error}</p>;

  // Prepare Pie chart data: success vs failed transports
  const pieData = [
    { name: "Success", value: transports.filter(t => t.status === "Success").length },
    { name: "Failed", value: transports.filter(t => t.status === "Failed").length }
  ];

  // Logs only for failed
  const failedTransports = transports.filter(t => t.status === "Failed");

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">Transport Dashboard</h2>

      <div className="flex flex-col md:flex-row gap-8">
        {/* Pie Chart */}
        <div>
          <h3 className="text-xl font-semibold mb-2">Transport Status</h3>
          <PieChart width={300} height={300}>
            <Pie
              data={pieData}
              cx={150}
              cy={150}
              innerRadius={60}
              outerRadius={100}
              fill="#8884d8"
              dataKey="value"
              label
            >
              {pieData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip />
            <Legend />
          </PieChart>
        </div>

        {/* Failed Transports Table */}
        <div className="flex-1">
          <h3 className="text-xl font-semibold mb-2">Failed Transports</h3>
          {failedTransports.length === 0 ? (
            <p>No failed transports</p>
          ) : (
            <table className="min-w-full border border-gray-300">
              <thead className="bg-gray-200">
                <tr>
                  <th className="p-2 border">ID</th>
                  <th className="p-2 border">Object</th>
                  <th className="p-2 border">Log</th>
                </tr>
              </thead>
              <tbody>
                {failedTransports.map((t, idx) => (
                  <tr key={idx} className="text-center">
                    <td className="p-2 border">{t.id}</td>
                    <td className="p-2 border">{t.object}</td>
                    <td className="p-2 border">{t.log}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
