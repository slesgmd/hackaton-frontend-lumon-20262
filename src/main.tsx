import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { HealthGate } from "./components/HealthGate";
import { AuthProvider } from "./lib/auth";
import { RealtimeProvider } from "./lib/realtime";
import { clearReloadMarkLater, reloadOnce } from "./lib/reload";
import "./index.css";

window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  reloadOnce();
});
clearReloadMarkLater();

const root = document.getElementById("root");
if (!root) throw new Error("No se encontró #root");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <HealthGate>
          <AuthProvider>
            <RealtimeProvider>
              <App />
            </RealtimeProvider>
          </AuthProvider>
        </HealthGate>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
