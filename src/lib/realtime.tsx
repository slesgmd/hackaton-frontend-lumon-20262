import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { apiRequest, isApiError } from "./api";
import { useAuth } from "./auth";
import { env } from "./env";
import type {
  ContingencyEvent,
  RealtimeEvent,
  SessionRevokedEvent,
  StreamTicket,
} from "./types";

type ConnectionStatus = "connecting" | "open" | "closed" | "unavailable";

interface RealtimeContextValue {
  status: ConnectionStatus;
  subscribe: (listener: (event: RealtimeEvent) => void) => () => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

const EVENT_TYPES = [
  "refiner.updated",
  "refinement.created",
  "file.completed",
  "contingency.activated",
  "contingency.resolved",
  "session.revoked",
  "stream.reset",
  "stream.superseded",
] as const;

const CHANNEL_NAME = "lumon.events";
const LOCK_NAME = "lumon.sse.leader";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function RealtimeProvider({ children }: { children: ReactNode }): JSX.Element {
  const { status: authStatus, user, logout } = useAuth();
  const [status, setStatus] = useState<ConnectionStatus>("closed");
  const listeners = useRef(new Set<(event: RealtimeEvent) => void>());
  const channelRef = useRef<BroadcastChannel | null>(null);
  const [contingency, setContingency] = useState<ContingencyEvent | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);
  const [ackBusy, setAckBusy] = useState(false);

  const subscribe = useCallback((listener: (event: RealtimeEvent) => void) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);

  const emit = useCallback((event: RealtimeEvent) => {
    listeners.current.forEach((listener) => listener(event));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !("BroadcastChannel" in window)) return;
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = channel;
    channel.addEventListener("message", (message: MessageEvent<unknown>) => {
      const payload = message.data;
      if (typeof payload !== "object" || payload === null) return;
      const record = payload as Record<string, unknown>;
      if (record.type === "event") {
        const event = record.event as RealtimeEvent | undefined;
        if (event) emit(event);
      } else if (record.type === "status") {
        setStatus(record.status as ConnectionStatus);
      }
    });
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [emit]);

  const cleared = user?.clearance.granted === true;

  useEffect(() => {
    if (authStatus !== "authenticated") {
      setStatus("closed");
      return;
    }
    // No se abre ningún stream hasta que /auth/me indique clearance.granted.
    if (!cleared) {
      setStatus("unavailable");
      return;
    }

    const abort = new AbortController();
    let disposed = false;
    let lastEventId: string | null = null;
    let backoffMs = 1000;

    const setAndBroadcastStatus = (next: ConnectionStatus) => {
      if (disposed) return;
      setStatus(next);
      channelRef.current?.postMessage({ type: "status", status: next });
    };

    const handleEvent = (eventName: string, message: MessageEvent<string>) => {
      if (disposed) return;
      if (message.lastEventId) lastEventId = message.lastEventId;
      let data: unknown = null;
      try {
        data = message.data ? (JSON.parse(message.data) as unknown) : null;
      } catch {
        data = message.data;
      }
      const event: RealtimeEvent = { event: eventName, data, id: message.lastEventId || null };
      emit(event);
      channelRef.current?.postMessage({ type: "event", event });

      if (eventName === "stream.reset") {
        lastEventId = null;
      }
      if (eventName === "contingency.activated") {
        const payload = data as ContingencyEvent;
        if (payload && payload.userId === user?.id) {
          setAckError(null);
          setContingency(payload);
        }
      }
      if (eventName === "contingency.resolved") {
        const payload = data as ContingencyEvent;
        setContingency((current) => (current && payload && current.id === payload.id ? null : current));
      }
      if (eventName === "session.revoked") {
        const payload = data as SessionRevokedEvent;
        setStatus("closed");
        void logout().then(() => {
          window.dispatchEvent(new CustomEvent("lumon:session-revoked", { detail: payload?.reason }));
        });
      }
    };

    const runLeader = async (): Promise<void> => {
      while (!abort.signal.aborted) {
        setAndBroadcastStatus("connecting");
        let ticket: StreamTicket;
        try {
          ticket = await apiRequest<StreamTicket>("/events/tickets", {
            method: "POST",
            signal: abort.signal,
          });
        } catch (error) {
          if (abort.signal.aborted) return;
          if (isApiError(error) && error.status === 423) {
            setAndBroadcastStatus("unavailable");
            await sleep(20000, abort.signal);
            continue;
          }
          if (isApiError(error) && (error.status === 401 || error.status === 403)) {
            setAndBroadcastStatus("closed");
            return;
          }
          setAndBroadcastStatus("closed");
          await sleep(backoffMs, abort.signal);
          backoffMs = Math.min(30000, backoffMs * 2);
          continue;
        }

        const url = new URL(`${env.apiBaseUrl}/events/stream`);
        url.searchParams.set("ticket", ticket.ticket);
        if (lastEventId) url.searchParams.set("lastEventId", lastEventId);

        const source = new EventSource(url.toString());
        let closed = false;
        let lastActivity = Date.now();
        let watchdog = 0;

        const close = () => {
          if (closed) return;
          closed = true;
          window.clearInterval(watchdog);
          source.close();
        };

        await new Promise<void>((resolve) => {
          watchdog = window.setInterval(() => {
            if (Date.now() - lastActivity > 45000) {
              close();
              resolve();
            }
          }, 5000);

          source.onopen = () => {
            lastActivity = Date.now();
            backoffMs = 1000;
            setAndBroadcastStatus("open");
          };

          for (const type of EVENT_TYPES) {
            source.addEventListener(type, (event: Event) => {
              if (!(event instanceof MessageEvent)) return;
              lastActivity = Date.now();
              handleEvent(type, event);
            });
          }

          source.onmessage = (event: MessageEvent<string>) => {
            lastActivity = Date.now();
            handleEvent("message", event);
          };

          source.onerror = () => {
            close();
            resolve();
          };

          abort.signal.addEventListener(
            "abort",
            () => {
              close();
              resolve();
            },
            { once: true },
          );
        });

        if (abort.signal.aborted) return;
        setAndBroadcastStatus("closed");
        await sleep(backoffMs, abort.signal);
        backoffMs = Math.min(30000, backoffMs * 2);
      }
    };

    const start = async (): Promise<void> => {
      if (typeof navigator !== "undefined" && "locks" in navigator) {
        await navigator.locks.request(LOCK_NAME, { signal: abort.signal }, async () => {
          await runLeader();
        });
      } else {
        await runLeader();
      }
    };

    void start().catch(() => {
      if (!disposed) setAndBroadcastStatus("closed");
    });

    return () => {
      disposed = true;
      abort.abort();
      setStatus("closed");
    };
  }, [authStatus, cleared, emit, logout, user?.id]);

  const ack = useCallback(async () => {
    if (!contingency) return;
    setAckBusy(true);
    setAckError(null);
    try {
      await apiRequest<void>(`/contingency/${contingency.id}/ack`, { method: "POST", retries: 3 });
      setContingency(null);
    } catch (error) {
      setAckError(error instanceof Error ? error.message : "No se pudo confirmar. Reintenta.");
    } finally {
      setAckBusy(false);
    }
  }, [contingency]);

  const value = useMemo<RealtimeContextValue>(() => ({ status, subscribe }), [status, subscribe]);

  return (
    <RealtimeContext.Provider value={value}>
      {children}
      {contingency ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="contingency-title"
          aria-describedby="contingency-desc"
        >
          <div className="w-full max-w-lg rounded-lg border border-lumon-amber/60 bg-lumon-panel p-6 shadow-2xl">
            <h2 id="contingency-title" className="text-lg font-semibold text-lumon-amber">
              Contingencia de horas extra
            </h2>
            <p id="contingency-desc" className="mt-3 text-sm text-lumon-mint/80">
              Lumon requiere que confirmes esta contingencia. El aviso permanecerá abierto hasta que la
              confirmes en el servidor.
            </p>
            {ackError ? (
              <p role="alert" className="mt-3 rounded border border-lumon-danger/50 p-2 text-sm text-lumon-danger">
                {ackError}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                autoFocus
                onClick={() => void ack()}
                disabled={ackBusy}
                className="rounded bg-lumon-amber px-4 py-2 text-sm font-semibold text-lumon-ink disabled:opacity-60"
              >
                {ackBusy ? "Confirmando…" : "Confirmar contingencia"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </RealtimeContext.Provider>
  );
}

export function useRealtime(): RealtimeContextValue {
  const context = useContext(RealtimeContext);
  if (!context) throw new Error("useRealtime debe usarse dentro de RealtimeProvider");
  return context;
}

export function useRealtimeEvent(
  eventName: string,
  handler: (event: RealtimeEvent) => void,
): void {
  const { subscribe } = useRealtime();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    return subscribe((event) => {
      if (event.event === eventName) handlerRef.current(event);
    });
  }, [eventName, subscribe]);
}
