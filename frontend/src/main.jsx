import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

// Tailwind CSS
import "../tailwind.css";

// React 18 root
const container = document.getElementById("root");
const root = createRoot(container);
root.render(<App />);
