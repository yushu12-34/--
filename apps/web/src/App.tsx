import { ReactFlowProvider } from "@xyflow/react";
import { CanvasPage } from "./pages/CanvasPage";

function BlockedCustomerRoute() {
  return (
    <main className="blocked-customer-route">
      <section>
        <strong>入口不可用</strong>
        <span>客户创作端不提供此页面。</span>
        <button type="button" onClick={() => window.location.assign("/")}>
          返回画布
        </button>
      </section>
    </main>
  );
}

export function App() {
  if (window.location.pathname.startsWith("/admin")) {
    return <BlockedCustomerRoute />;
  }

  return (
    <ReactFlowProvider>
      <CanvasPage />
    </ReactFlowProvider>
  );
}
