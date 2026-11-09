import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "../lib/api";

type Health = "checking" | "ok" | "down";

const DELAYS = [1000, 2000, 4000, 8000, 15000];

function nextDelay(failures: number): number {
  const base = DELAYS[Math.min(failures - 1, DELAYS.length - 1)] ?? 15000;
  return Math.round(base * (0.85 + Math.random() * 0.3));
}

export function HealthGate({ children }: { children: React.ReactNode }): JSX.Element {
  const [health, setHealth] = useState<Health>("checking");
  const [secondsLeft, setSecondsLeft] = useState(0);
  const timer = useRef<number>(0);
  const ticker = useRef<number>(0);
  const failures = useRef(0);
  const alive = useRef(true);

  const clearTimers = useCallback((): void => {
    window.clearTimeout(timer.current);
    window.clearInterval(ticker.current);
  }, []);

  const check = useCallback(async (): Promise<void> => {
    clearTimers();
    setHealth((current) => (current === "ok" ? current : "checking"));
    setSecondsLeft(0);
    try {
      await apiRequest<unknown>("/meta/health", { anonymous: true, retries: 0, skipAuthRefresh: true });
      if (alive.current) setHealth("ok");
    } catch {
      if (!alive.current) return;
      failures.current += 1;
      const wait = nextDelay(failures.current);
      setHealth("down");
      setSecondsLeft(Math.ceil(wait / 1000));
      ticker.current = window.setInterval(() => setSecondsLeft((value) => Math.max(0, value - 1)), 1000);
      timer.current = window.setTimeout(() => void check(), wait);
    }
  }, [clearTimers]);

  useEffect(() => {
    alive.current = true;
    void check();
    return () => {
      alive.current = false;
      clearTimers();
    };
  }, [check, clearTimers]);

  if (health === "ok") return <>{children}</>;

  return (
    <main className="flex min-h-screen items-center justify-center bg-lumon-ink p-6">
      <div className="w-full max-w-md rounded-lg border border-lumon-line bg-lumon-panel p-8 text-center">
        <h1 className="text-lg font-semibold text-lumon-mint">Conectando con Lumon…</h1>
        <p className="mt-3 text-sm text-lumon-mint/70" role="status" aria-live="polite">
          {health === "down"
            ? `La API no responde todavía. Reintentando en ${secondsLeft} s.`
            : "Verificando el estado del servicio."}
        </p>
        {health === "down" ? (
          <button
            type="button"
            onClick={() => {
              failures.current = 0;
              void check();
            }}
            className="mt-5 rounded bg-lumon-mint px-4 py-2 text-sm font-semibold text-lumon-ink"
          >
            Reintentar ahora
          </button>
        ) : null}
      </div>
    </main>
  );
}
