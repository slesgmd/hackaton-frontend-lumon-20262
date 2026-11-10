import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { apiRequest, isApiError } from "./api";
import { env } from "./env";
import { TicketSchema } from "./schemasCp4";
import type { CellRef } from "./types";

export type FloorStatus = "idle" | "connecting" | "open" | "closed" | "fatal";

/* ---------- mensajes del servidor (validados con zod) ---------- */

const CellSchema = z.object({ r: z.number(), c: z.number() });
const MemberSchema = z.object({
  userId: z.number(),
  displayName: z.string(),
  r: z.number().nullable().optional(),
  c: z.number().nullable().optional(),
});
const ClaimSchema = z.object({
  claimId: z.string(),
  userId: z.number(),
  displayName: z.string().optional(),
  cells: z.array(CellSchema),
  expiresAt: z.string().optional(),
});

const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), seq: z.number(), members: z.array(MemberSchema), claims: z.array(ClaimSchema) }),
  z.object({ type: z.literal("member.joined"), seq: z.number(), userId: z.number(), displayName: z.string() }),
  z.object({ type: z.literal("member.left"), seq: z.number(), userId: z.number(), displayName: z.string().optional() }),
  z.object({ type: z.literal("cursor"), userId: z.number(), r: z.number(), c: z.number() }),
  z.object({
    type: z.literal("claim.granted"),
    seq: z.number(),
    requestId: z.union([z.string(), z.number()]),
    claimId: z.string(),
    userId: z.number().optional(),
    displayName: z.string().optional(),
    cells: z.array(CellSchema),
    expiresAt: z.string().optional(),
  }),
  z.object({
    type: z.literal("claim.denied"),
    requestId: z.union([z.string(), z.number()]),
    reason: z.string(),
    holder: z.object({ userId: z.number(), displayName: z.string() }).nullable().optional(),
  }),
  z.object({
    type: z.literal("claim.updated"),
    seq: z.number(),
    claimId: z.string(),
    userId: z.number(),
    displayName: z.string().optional(),
    cells: z.array(CellSchema),
    expiresAt: z.string().optional(),
  }),
  z.object({
    type: z.literal("claim.released"),
    seq: z.number().optional(),
    claimId: z.string(),
    userId: z.number().optional(),
  }),
  z.object({ type: z.literal("pong"), t: z.union([z.number(), z.string()]) }),
]);

export type FloorMember = z.infer<typeof MemberSchema>;
export type FloorClaim = z.infer<typeof ClaimSchema>;

export interface FloorCursor {
  userId: number;
  displayName: string;
  r: number;
  c: number;
}

export interface ClaimDenied {
  requestId: string;
  reason: "HELD" | "NOT_A_GROUP" | string;
  holder: { userId: number; displayName: string } | null;
}

/* ---------- store externo de cursores: no pasa por el estado de React ---------- */

export class CursorStore {
  private map = new Map<number, FloorCursor>();
  private listeners = new Set<() => void>();
  private snapshot: FloorCursor[] = [];
  private scheduled = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): FloorCursor[] => this.snapshot;

  set(cursor: FloorCursor): void {
    this.map.set(cursor.userId, cursor);
    this.schedule();
  }

  delete(userId: number): void {
    if (this.map.delete(userId)) this.schedule();
  }

  clear(): void {
    this.map.clear();
    this.schedule();
  }

  get(userId: number): FloorCursor | undefined {
    return this.map.get(userId);
  }

  /** Un solo aviso por frame, sin importar cuántos cursores lleguen. */
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    window.requestAnimationFrame(() => {
      this.scheduled = false;
      this.snapshot = [...this.map.values()];
      this.listeners.forEach((listener) => listener());
    });
  }
}

/* ---------- hook ---------- */

interface UseFloorOptions {
  fileId: number;
  enabled: boolean;
  onClaimGranted?: (requestId: string, claimId: string, cells: CellRef[]) => void;
  onClaimDenied?: (denied: ClaimDenied) => void;
}

interface UseFloorResult {
  status: FloorStatus;
  fatalMessage: string | null;
  members: FloorMember[];
  claims: FloorClaim[];
  cursorStore: CursorStore;
  sendCursor: (r: number, c: number) => void;
  claim: (r: number, c: number) => string;
  release: (claimId: string) => void;
  resync: () => void;
}

const DEFINITIVE: Record<number, string> = {
  4400: "El piso rechazó un mensaje de esta app (error interno). No se reconecta.",
  4403: "Sin permiso para entrar al piso compartido (origen no verificado o sesión revocada).",
  4404: "El archivo no existe.",
  4423: "El Piso de Pruebas todavía no está abierto.",
};

const RENEW_MS = 5000;
const PING_MS = 15000;
const CURSOR_MIN_GAP_MS = 100;

function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

export function useFloor({ fileId, enabled, onClaimGranted, onClaimDenied }: UseFloorOptions): UseFloorResult {
  const [status, setStatus] = useState<FloorStatus>("idle");
  const [fatalMessage, setFatalMessage] = useState<string | null>(null);
  const [members, setMembers] = useState<FloorMember[]>([]);
  const [claims, setClaims] = useState<FloorClaim[]>([]);
  const cursorStoreRef = useRef<CursorStore | null>(null);
  cursorStoreRef.current ??= new CursorStore();
  const cursorStore = cursorStoreRef.current;

  const wsRef = useRef<WebSocket | null>(null);
  const claimIdRef = useRef<string | null>(null);
  const renewTimer = useRef(0);
  const lastCursor = useRef({ r: -1, c: -1, at: 0 });
  const grantedRef = useRef(onClaimGranted);
  const deniedRef = useRef(onClaimDenied);
  grantedRef.current = onClaimGranted;
  deniedRef.current = onClaimDenied;

  const send = useCallback((payload: Record<string, unknown>): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }, []);

  const stopRenew = useCallback((): void => {
    window.clearInterval(renewTimer.current);
    renewTimer.current = 0;
  }, []);

  const release = useCallback(
    (claimId: string): void => {
      if (claimIdRef.current === claimId) {
        claimIdRef.current = null;
        stopRenew();
      }
      send({ type: "release", claimId });
    },
    [send, stopRenew],
  );

  useEffect(() => {
    if (!enabled || !Number.isInteger(fileId) || fileId <= 0) {
      setStatus("idle");
      return;
    }

    let disposed = false;
    let reconnectTimer = 0;
    let pingTimer = 0;
    let pendingPongs = 0;
    let backoff = 1000;
    let ticketRetried = false;
    let seq = 0;
    const memberMap = new Map<number, FloorMember>();
    setFatalMessage(null);
    setStatus("connecting");

    const clearTimers = (): void => {
      window.clearTimeout(reconnectTimer);
      window.clearInterval(pingTimer);
      stopRenew();
    };

    const publishMembers = (): void => setMembers([...memberMap.values()]);

    const applySnapshot = (message: Extract<z.infer<typeof ServerMessageSchema>, { type: "snapshot" }>): void => {
      seq = message.seq;
      memberMap.clear();
      cursorStore.clear();
      for (const member of message.members) {
        memberMap.set(member.userId, member);
        if (typeof member.r === "number" && typeof member.c === "number") {
          cursorStore.set({ userId: member.userId, displayName: member.displayName, r: member.r, c: member.c });
        }
      }
      publishMembers();
      setClaims(message.claims);
      // Si mi reserva ya no existe en el servidor, se descarta: nada de reservas fantasma.
      if (claimIdRef.current && !message.claims.some((claim) => claim.claimId === claimIdRef.current)) {
        claimIdRef.current = null;
        stopRenew();
      }
    };

    const handleMessage = (event: MessageEvent<unknown>): void => {
      if (typeof event.data !== "string") return;
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = ServerMessageSchema.safeParse(raw);
      if (!parsed.success) return;
      const message = parsed.data;

      // seq crece de uno en uno: un salto significa que se perdió algo -> resync y se reconstruye desde snapshot.
      if ("seq" in message && typeof message.seq === "number" && message.type !== "snapshot") {
        if (message.seq <= seq) return;
        if (message.seq > seq + 1) {
          send({ type: "resync" });
          return;
        }
        seq = message.seq;
      }

      switch (message.type) {
        case "snapshot":
          applySnapshot(message);
          break;
        case "member.joined":
          memberMap.set(message.userId, { userId: message.userId, displayName: message.displayName });
          publishMembers();
          break;
        case "member.left":
          memberMap.delete(message.userId);
          cursorStore.delete(message.userId);
          publishMembers();
          setClaims((current) => current.filter((claim) => claim.userId !== message.userId));
          break;
        case "cursor": {
          const name = memberMap.get(message.userId)?.displayName ?? `Refinador ${message.userId}`;
          cursorStore.set({ userId: message.userId, displayName: name, r: message.r, c: message.c });
          break;
        }
        case "claim.granted": {
          claimIdRef.current = message.claimId;
          stopRenew();
          // Se renueva cada 5 s mientras la reserva esté viva (vence a los 15 s).
          renewTimer.current = window.setInterval(() => send({ type: "renew", claimId: message.claimId }), RENEW_MS);
          setClaims((current) => [
            ...current.filter((claim) => claim.claimId !== message.claimId),
            {
              claimId: message.claimId,
              userId: message.userId ?? -1,
              displayName: message.displayName,
              cells: message.cells,
              expiresAt: message.expiresAt,
            },
          ]);
          grantedRef.current?.(String(message.requestId), message.claimId, message.cells);
          break;
        }
        case "claim.denied":
          deniedRef.current?.({ requestId: String(message.requestId), reason: message.reason, holder: message.holder ?? null });
          break;
        case "claim.updated":
          // Reserva nueva o renovada de otra persona: se agrega o se actualiza.
          setClaims((current) => [
            ...current.filter((claim) => claim.claimId !== message.claimId),
            {
              claimId: message.claimId,
              userId: message.userId,
              displayName: message.displayName,
              cells: message.cells,
              expiresAt: message.expiresAt,
            },
          ]);
          break;
        case "claim.released":
          setClaims((current) => current.filter((claim) => claim.claimId !== message.claimId));
          if (claimIdRef.current === message.claimId) {
            claimIdRef.current = null;
            stopRenew();
          }
          break;
        case "pong":
          pendingPongs = 0;
          break;
      }
    };

    const scheduleReconnect = (wait: number): void => {
      setStatus("closed");
      reconnectTimer = window.setTimeout(() => void connect(), wait);
    };

    const handleClose = (event: CloseEvent): void => {
      clearTimers();
      wsRef.current = null;
      // Las reservas se liberan al cortarse la conexión: al reconectar hay que volver a pedirlas.
      claimIdRef.current = null;
      pendingPongs = 0;
      if (disposed) return;

      const definitive = DEFINITIVE[event.code];
      if (definitive) {
        setStatus("fatal");
        setFatalMessage(definitive);
        return;
      }
      if (event.code === 4401) {
        // Ticket inválido o vencido: un ticket nuevo una sola vez; si vuelve a fallar, no se insiste.
        if (ticketRetried) {
          setStatus("fatal");
          setFatalMessage("El piso rechazó el ticket de conexión dos veces seguidas. Recarga la página.");
          return;
        }
        ticketRetried = true;
        scheduleReconnect(0);
        return;
      }
      if (event.code === 4429) {
        scheduleReconnect(jitter(10000));
        return;
      }
      if (event.code === 4408) {
        scheduleReconnect(0);
        return;
      }
      scheduleReconnect(jitter(backoff));
      backoff = Math.min(30000, backoff * 2);
    };

    const connect = async (): Promise<void> => {
      if (disposed) return;
      setStatus("connecting");
      let ticket: string;
      try {
        // Un ticket nuevo antes de CADA conexión.
        const raw = await apiRequest<unknown>("/floor/tickets", { method: "POST", body: { fileId }, retries: 0 });
        ticket = TicketSchema.parse(raw).ticket;
      } catch (error) {
        if (disposed) return;
        if (isApiError(error) && (error.status === 423 || error.status === 403 || error.status === 404)) {
          setStatus("fatal");
          setFatalMessage(
            error.status === 423
              ? DEFINITIVE[4423] ?? "El Piso de Pruebas no está abierto."
              : error.status === 403
                ? DEFINITIVE[4403] ?? "Sin permiso."
                : DEFINITIVE[4404] ?? "El archivo no existe.",
          );
          return;
        }
        scheduleReconnect(jitter(backoff));
        backoff = Math.min(30000, backoff * 2);
        return;
      }
      if (disposed) return;

      const url = new URL(`${env.wsBaseUrl}/floor/ws`);
      url.searchParams.set("ticket", ticket);
      const ws = new WebSocket(url.toString());
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        ticketRetried = false;
        backoff = 1000;
        pendingPongs = 0;
        seq = 0;
        setStatus("open");
        setFatalMessage(null);
        // Latido cada 15 s; si faltan dos pong, la conexión está muerta: se cierra y se reconecta.
        pingTimer = window.setInterval(() => {
          if (pendingPongs >= 2) {
            ws.close(4000, "sin pong");
            return;
          }
          pendingPongs += 1;
          send({ type: "ping", t: Date.now() });
        }, PING_MS);
      };
      ws.onmessage = handleMessage;
      ws.onclose = handleClose;
      ws.onerror = () => {
        /* onclose decide qué hacer */
      };
    };

    void connect();

    return () => {
      disposed = true;
      clearTimers();
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        if (claimIdRef.current) ws.send(JSON.stringify({ type: "release", claimId: claimIdRef.current }));
        ws.close(1000, "salida");
      } else if (ws) {
        ws.close();
      }
      wsRef.current = null;
      claimIdRef.current = null;
      cursorStore.clear();
      setMembers([]);
      setClaims([]);
    };
  }, [enabled, fileId, send, stopRenew, cursorStore]);

  const sendCursor = useCallback(
    (r: number, c: number): void => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      const previous = lastCursor.current;
      if (previous.r === r && previous.c === c) return;
      // Máximo 10 mensajes por segundo.
      if (now - previous.at < CURSOR_MIN_GAP_MS) return;
      lastCursor.current = { r, c, at: now };
      send({ type: "cursor", r, c });
    },
    [send],
  );

  const claim = useCallback(
    (r: number, c: number): string => {
      const requestId = crypto.randomUUID();
      // Cada conexión tiene como máximo una reserva: pedir otra libera la anterior.
      if (claimIdRef.current) {
        send({ type: "release", claimId: claimIdRef.current });
        claimIdRef.current = null;
        stopRenew();
      }
      send({ type: "claim", requestId, r, c });
      return requestId;
    },
    [send, stopRenew],
  );

  const resync = useCallback((): void => {
    send({ type: "resync" });
  }, [send]);

  return { status, fatalMessage, members, claims, cursorStore, sendCursor, claim, release, resync };
}
