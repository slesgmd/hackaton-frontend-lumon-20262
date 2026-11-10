import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { z } from "zod";
import { apiRequest, isApiError, messageFor } from "./api";
import { revokeSession, useAuth } from "./auth";
import { env } from "./env";
import { TicketSchema } from "./schemasCp4";
import type { RealtimeEvent } from "./types";

export type ConnectionStatus = "connecting" | "open" | "closed" | "unavailable";

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
const LOCK_NAME = "lumon-sse";
const DEAD_AFTER_MS = 45000;
const SEEN_LIMIT = 800;

const ContingencySchema = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  message: z.string().optional(),
});
const ResolvedSchema = z.object({ id: z.number().int() });
const RevokedSchema = z.object({ reason: z.string().optional() });

type ContingencyPayload = z.infer<typeof ContingencySchema>;

type ChannelMessage =
  | { type: "event"; event: RealtimeEvent }
  | { type: "status"; status: ConnectionStatus }
  | { type: "hello" }
  | { type: "ack"; id: number };

function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

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

function ContingencyModal({
  contingency,
  error,
  busy,
  onAck,
}: {
  contingency: ContingencyPayload;
  error: string | null;
  busy: boolean;
  onAck: () => void;
}): JSX.Element {
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Foco atrapado: el resto de la app queda inerte mientras el aviso esté abierto.
  useEffect(() => {
    const root = document.getElementById("root");
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root?.setAttribute("inert", "");
    root?.setAttribute("aria-hidden", "true");
    buttonRef.current?.focus();
    return () => {
      root?.removeAttribute("inert");
      root?.removeAttribute("aria-hidden");
      previous?.focus?.();
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Tab") {
      event.preventDefault();
      buttonRef.current?.focus();
    }
    // Solo se cierra confirmando en el servidor: Escape no hace nada.
    if (event.key === "Escape") event.preventDefault();
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onKeyDown={onKeyDown}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="contingency-title"
        aria-describedby="contingency-desc"
        className="w-full max-w-lg rounded-lg border border-lumon-amber/60 bg-lumon-panel p-6 shadow-2xl"
      >
        <h2 id="contingency-title" className="text-lg font-semibold text-lumon-amber">
          Contingencia de horas extra
        </h2>
        <p id="contingency-desc" className="mt-3 text-sm text-lumon-mint/80">
          {contingency.message ?? "Lumon requiere que confirmes esta contingencia."} El aviso permanece abierto hasta que
          el servidor registre tu confirmación.
        </p>
        {error ? (
          <p role="alert" className="mt-3 rounded border border-lumon-danger/50 p-2 text-sm text-lumon-danger">
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end">
          <button
            ref={buttonRef}
            type="button"
            onClick={onAck}
            disabled={busy}
            className="rounded bg-lumon-amber px-4 py-2 text-sm font-semibold text-lumon-ink disabled:opacity-60"
          >
            {busy ? "Confirmando…" : "Confirmar contingencia"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function RealtimeProvider({ children }: { children: ReactNode }): JSX.Element {
  const { status: authStatus, user } = useAuth();
  const userIdRef = useRef<number | null>(null);
  userIdRef.current = user?.id ?? null;
  const cleared = user?.clearance.granted === true;

  const [status, setStatus] = useState<ConnectionStatus>("closed");
  const statusRef = useRef<ConnectionStatus>("closed");
  const isLeader = useRef(false);
  const listeners = useRef(new Set<(event: RealtimeEvent) => void>());
  const channelRef = useRef<BroadcastChannel | null>(null);
  const seen = useRef({ ids: new Set<string>(), order: [] as string[] });
  const [contingency, setContingency] = useState<ContingencyPayload | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);
  const [ackBusy, setAckBusy] = useState(false);
  const ackBusyRef = useRef(false);

  const subscribe = useCallback((listener: (event: RealtimeEvent) => void) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);

  const applyStatus = useCallback((next: ConnectionStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  /** Camino único para TODAS las pestañas (líder y seguidoras): deduplica por id, aplica efectos y notifica. */
  const processEvent = useCallback((event: RealtimeEvent) => {
    if (event.id) {
      const registry = seen.current;
      if (registry.ids.has(event.id)) return;
      registry.ids.add(event.id);
      registry.order.push(event.id);
      if (registry.order.length > SEEN_LIMIT) {
        const old = registry.order.shift();
        if (old) registry.ids.delete(old);
      }
    }
    if (event.event === "contingency.activated") {
      const parsed = ContingencySchema.safeParse(event.data);
      if (parsed.success && parsed.data.userId === userIdRef.current) {
        setAckError(null);
        setContingency(parsed.data);
      }
    } else if (event.event === "contingency.resolved") {
      const parsed = ResolvedSchema.safeParse(event.data);
      if (parsed.success) setContingency((current) => (current && current.id === parsed.data.id ? null : current));
    } else if (event.event === "session.revoked") {
      const parsed = RevokedSchema.safeParse(event.data);
      revokeSession(parsed.success && parsed.data.reason === "REFRESH_REUSED" ? "REFRESH_REUSED" : "SESSION_REVOKED");
    }
    listeners.current.forEach((listener) => listener(event));
  }, []);

  const post = useCallback((message: ChannelMessage) => {
    channelRef.current?.postMessage(message);
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = channel;
    channel.addEventListener("message", (message: MessageEvent<ChannelMessage>) => {
      const payload = message.data;
      if (!payload || typeof payload !== "object") return;
      if (payload.type === "event") processEvent(payload.event);
      else if (payload.type === "status") applyStatus(payload.status);
      else if (payload.type === "hello") {
        if (isLeader.current) channel.postMessage({ type: "status", status: statusRef.current } satisfies ChannelMessage);
      } else if (payload.type === "ack") {
        // Confirmada en otra pestaña: se cierra aquí también.
        setContingency((current) => (current && current.id === payload.id ? null : current));
      }
    });
    // Una pestaña recién abierta pide el estado actual de la conexión al líder.
    channel.postMessage({ type: "hello" } satisfies ChannelMessage);
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [processEvent, applyStatus]);

  useEffect(() => {
    if (authStatus !== "authenticated") {
      applyStatus("closed");
      setContingency(null);
      return;
    }
    // No se abre ningún stream hasta que /auth/me indique clearance.granted.
    if (!cleared) {
      applyStatus("unavailable");
      return;
    }

    const abort = new AbortController();
    let disposed = false;
    let lastEventId: string | null = null;
    let backoffMs = 1000;
    let supersededCount = 0;
    let quietReconnect = false;

    const setAndBroadcast = (next: ConnectionStatus): void => {
      if (disposed) return;
      applyStatus(next);
      post({ type: "status", status: next });
    };

    const runLeader = async (): Promise<void> => {
      isLeader.current = true;
      try {
        while (!abort.signal.aborted) {
          if (!quietReconnect) setAndBroadcast("connecting");
          quietReconnect = false;
          // Un ticket nuevo justo antes de cada conexión: son de un solo uso.
          let ticket: string;
          try {
            const raw = await apiRequest<unknown>("/events/tickets", { method: "POST", signal: abort.signal, retries: 0 });
            ticket = TicketSchema.parse(raw).ticket;
          } catch (error) {
            if (abort.signal.aborted) return;
            if (isApiError(error) && error.status === 423) {
              setAndBroadcast("unavailable");
              await sleep(jitter(20000), abort.signal);
              continue;
            }
            if (isApiError(error) && (error.status === 401 || error.status === 403)) {
              setAndBroadcast("closed");
              return;
            }
            setAndBroadcast("closed");
            await sleep(jitter(backoffMs), abort.signal);
            backoffMs = Math.min(30000, backoffMs * 2);
            continue;
          }

          const url = new URL(`${env.apiBaseUrl}/events/stream`);
          url.searchParams.set("ticket", ticket);
          if (lastEventId) url.searchParams.set("lastEventId", lastEventId);

          let superseded = false;
          let silent = false;
          await new Promise<void>((resolve) => {
            const source = new EventSource(url.toString());
            let lastActivity = Date.now();
            let finished = false;
            // Sin datos ni heartbeat en 45 s la conexión está muerta.
            const watchdog = window.setInterval(() => {
              if (Date.now() - lastActivity > DEAD_AFTER_MS) {
                silent = true;
                finish();
              }
            }, 5000);

            function finish(): void {
              if (finished) return;
              finished = true;
              window.clearInterval(watchdog);
              source.close();
              resolve();
            }

            source.onopen = () => {
              lastActivity = Date.now();
              backoffMs = 1000;
              setAndBroadcast("open");
            };
            // Los comentarios ": hb" no llegan a JavaScript: cualquier actividad (open, evento) refresca el reloj,
            // y tras 45 s sin nada se reconecta con lastEventId (no se pierde nada).
            const handle = (name: string) => (message: Event) => {
              if (!(message instanceof MessageEvent)) return;
              lastActivity = Date.now();
              if (disposed) return;
              if (message.lastEventId) lastEventId = message.lastEventId;
              let data: unknown = null;
              try {
                data = typeof message.data === "string" && message.data ? (JSON.parse(message.data) as unknown) : null;
              } catch {
                data = message.data;
              }
              const event: RealtimeEvent = { event: name, data, id: message.lastEventId || null };
              if (name === "stream.superseded") {
                superseded = true;
                finish();
                return;
              }
              processEvent(event);
              post({ type: "event", event });
            };
            for (const type of EVENT_TYPES) source.addEventListener(type, handle(type));
            source.onmessage = handle("message");
            // EventSource reintentaría solo con la MISMA URL (ticket gastado): se cierra y se reconecta con ticket nuevo.
            source.onerror = () => finish();
            abort.signal.addEventListener("abort", finish, { once: true });
          });

          if (abort.signal.aborted) return;
          if (silent && !superseded) {
            quietReconnect = true;
            await sleep(jitter(300), abort.signal);
            continue;
          }
          if (superseded) {
            // Otra conexión de esta sesión tomó el stream: no se pelea. Espera creciente larga antes de reintentar.
            supersededCount += 1;
            setAndBroadcast("closed");
            await sleep(jitter(Math.min(60000, 5000 * 2 ** supersededCount)), abort.signal);
            continue;
          }
          supersededCount = 0;
          setAndBroadcast("closed");
          await sleep(jitter(backoffMs), abort.signal);
          backoffMs = Math.min(30000, backoffMs * 2);
        }
      } finally {
        isLeader.current = false;
      }
    };

    // Una sola conexión por navegador: la pestaña que tiene el lock es el líder; si se cierra, otra lo toma.
    const start = async (): Promise<void> => {
      if (typeof navigator !== "undefined" && "locks" in navigator) {
        await navigator.locks.request(LOCK_NAME, { signal: abort.signal }, async () => {
          if (abort.signal.aborted) return;
          await runLeader();
        });
      } else {
        await runLeader();
      }
    };

    applyStatus("connecting");
    void start().catch(() => {
      if (!disposed && !abort.signal.aborted) setAndBroadcast("closed");
    });

    return () => {
      disposed = true;
      abort.abort();
    };
  }, [authStatus, cleared, user?.id, processEvent, applyStatus, post]);

  const ack = useCallback(async () => {
    if (!contingency || ackBusyRef.current) return;
    ackBusyRef.current = true;
    setAckBusy(true);
    setAckError(null);
    try {
      await apiRequest<void>(`/contingency/${contingency.id}/ack`, { method: "POST", retries: 3 });
      setContingency(null);
      post({ type: "ack", id: contingency.id });
    } catch (error) {
      // El modal sigue abierto con el error; se puede reintentar.
      setAckError(`No se pudo confirmar: ${messageFor(error)} Reintenta.`);
    } finally {
      ackBusyRef.current = false;
      setAckBusy(false);
    }
  }, [contingency, post]);

  const value = useMemo<RealtimeContextValue>(() => ({ status, subscribe }), [status, subscribe]);

  return (
    <RealtimeContext.Provider value={value}>
      {children}
      {contingency ? <ContingencyModal contingency={contingency} error={ackError} busy={ackBusy} onAck={() => void ack()} /> : null}
    </RealtimeContext.Provider>
  );
}

export function useRealtime(): RealtimeContextValue {
  const context = useContext(RealtimeContext);
  if (!context) throw new Error("useRealtime debe usarse dentro de RealtimeProvider");
  return context;
}

export function useRealtimeEvent(eventName: string, handler: (event: RealtimeEvent) => void): void {
  const { subscribe } = useRealtime();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    return subscribe((event) => {
      if (event.event === eventName) handlerRef.current(event);
    });
  }, [eventName, subscribe]);
}
