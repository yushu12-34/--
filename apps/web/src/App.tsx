import { ReactFlowProvider } from "@xyflow/react";
import { AdminPage } from "./pages/AdminPage";
import { CanvasPage } from "./pages/CanvasPage";

export function App() {
  if (window.location.pathname.startsWith("/admin")) return <AdminPage />;
  return (
    <ReactFlowProvider>
      <CanvasPage />
    </ReactFlowProvider>
  );
}
