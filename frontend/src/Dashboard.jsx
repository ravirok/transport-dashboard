import React, { useEffect, useState } from "react";
import { PieChart, Pie, Cell, Tooltip, Legend } from "recharts";
import axios from "axios";

const COLORS = ["#0088FE", "#00C49F", "#FFBB28", "#FF8042"];

export default function Dashboard() {
  const [transports, setTransports] = useState([]);
  
  useEffect(() => {
    axios.get("/api/transports")
      .then(res => setTransports(res.data))
      .catch(err => console.error(err));
  }, []);

  // Example pie chart data: count of failed vs successful
  const data = [
    { name: "Failed", value: transports.filter(t => t.status === "FAILED").length },
    { name: "Success", value: transports.filter(t => t.status !== "FAILED").length }
  ];

  return (
    <div>
      <h2 className="text-xl font-semibold mb-2">Transport Status</h2>
      <PieChart width={300} height={300}>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          outerRadius={100}
          label
        >
          {data.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
          ))}
        </Pie>
        <Tooltip />
        <Legend />
      </PieChart>

      <h3 className="text-lg font-semibold mt-4">Transport Logs</h3>
      <ul className="list-disc ml-5">
        {transports.map((t, i) => (
          <li key={i}>{t.id} - {t.status}</li>
        ))}
      </ul>
    </div>
  );
}
