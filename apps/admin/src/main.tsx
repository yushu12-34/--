import React from "react";
import ReactDOM from "react-dom/client";
import "weui";
import "./styles.css";
import { AdminPage } from "./pages/AdminPage";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AdminPage />
  </React.StrictMode>,
);
