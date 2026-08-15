import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

if (navigator.userAgent.includes("Windows")) {
  document.documentElement.dataset.os = "windows";
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
