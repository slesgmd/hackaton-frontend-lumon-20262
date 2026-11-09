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
import { apiRequest, isApiError, rawFetch, setRefreshHandler, setRevokedHandler } from "./api";
import { session } from "./session";
import type { LoginResponse, Me, Permission, RegisterResponse, TokenPair } from "./types";

const REFRESH_KEY = "lumon.refresh";
const CHANNEL_NAME = "lumon.auth";
const LOCK_NAME = "lumon.refresh.lock";

type Status = "loading" | "authenticated" | "anonymous";

interface AuthContextValue {
  status: Status;
  user: Me | null;
  revokedMessage: string | null;
  login: (email: string, password: string) => Promise<Me>;
  register: (teamName: string, email: string, password: string) => Promise<Me>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<Me | null>;
  hasPermission: (permission: Permission) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readRefreshToken(): string | null {
  try {
    return window.localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

function writeRefreshToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(REFRESH_KEY, token);
    else window.localStorage.removeItem(REFRESH_KEY);
  } catch {
    /* almacenamiento no disponible */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function applyTokens(tokens: TokenPair): void {
  session.setTokens(tokens.accessToken, tokens.expiresIn);
  writeRefreshToken(tokens.refreshToken);
}

let refreshInFlight: Promise<boolean> | null = null;
let tokenStamp = 0;
let notifyRevoked: ((code: string) => void) | null = null;

const REVOKED_CODES = new Set(["REFRESH_REUSED", "SESSION_REVOKED", "TOKEN_INVALID", "REFRESH_INVALID"]);

const REVOKED_MESSAGES: Record<string, string> = {
  REFRESH_REUSED:
    "Se detectó que tu token de sesión se usó dos veces, así que por seguridad cerramos tu sesión en todas las pestañas. Inicia sesión de nuevo.",
  SESSION_REVOKED: "Tu sesión fue revocada desde el servidor. Inicia sesión de nuevo.",
  TOKEN_INVALID: "Tu credencial no es válida o es de otro equipo. Inicia sesión de nuevo.",
  REFRESH_INVALID: "Tu sesión venció. Inicia sesión de nuevo.",
};

function revokedText(code: string): string {
  return REVOKED_MESSAGES[code] ?? REVOKED_MESSAGES.SESSION_REVOKED ?? "";
}

function revoke(code: string): void {
  session.clear();
  writeRefreshToken(null);
  channel?.postMessage({ type: "revoked", reason: code });
  notifyRevoked?.(code);
}

/** Un único intento por refresh token; solo 429/503 se reintentan. Nunca se reusa un token tras error de red o 401. */
async function refreshLocked(stamp: number): Promise<boolean> {
  // Otra pestaña ya renovó mientras esperábamos el lock: usamos su access token.
  if (tokenStamp !== stamp && session.getAccessToken()) return true;

  const current = readRefreshToken();
  if (!current) return false;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await rawFetch("/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: current }),
      });
    } catch {
      return false;
    }

    if (response.ok) {
      const tokens = (await response.json()) as TokenPair;
      applyTokens(tokens); // guarda el refresh nuevo antes de soltar el lock
      channel?.postMessage({ type: "tokens", tokens });
      return true;
    }

    let code = `HTTP_${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      code = body.error ?? code;
    } catch {
      /* sin cuerpo */
    }

    if (REVOKED_CODES.has(code) || response.status === 401) {
      revoke(REVOKED_CODES.has(code) ? code : "REFRESH_INVALID");
      return false;
    }

    if ((response.status === 429 || response.status === 503) && attempt < 2) {
      const header = Number(response.headers.get("Retry-After"));
      await sleep(Number.isFinite(header) && header > 0 ? header * 1000 : 500 * 2 ** attempt);
      continue;
    }
    return false;
  }
  return false;
}

async function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const stamp = tokenStamp;

  const run = async (): Promise<boolean> => {
    if (typeof navigator !== "undefined" && "locks" in navigator) {
      return navigator.locks.request(LOCK_NAME, async () => refreshLocked(stamp));
    }
    return refreshLocked(stamp);
  };

  refreshInFlight = run().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

let channel: BroadcastChannel | null = null;
if (typeof window !== "undefined" && "BroadcastChannel" in window) {
  channel = new BroadcastChannel(CHANNEL_NAME);
}

interface BootResult {
  me: Me | null;
}

let bootPromise: Promise<BootResult> | null = null;

async function boot(): Promise<BootResult> {
  if (!readRefreshToken()) return { me: null };
  const ok = await refreshSession();
  if (!ok) return { me: null };
  try {
    const me = await apiRequest<Me>("/auth/me");
    return { me };
  } catch {
    return { me: null };
  }
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<Me | null>(null);
  const [revokedMessage, setRevokedMessage] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    setRefreshHandler(refreshSession);
    setRevokedHandler((reason) => revoke(reason));
    notifyRevoked = (code) => {
      if (!mounted.current) return;
      setUser(null);
      setStatus("anonymous");
      setRevokedMessage(revokedText(code));
    };
    const onStorage = (event: StorageEvent): void => {
      // Respaldo si BroadcastChannel no existe: el refresh token desaparece = logout en otra pestaña.
      if (event.key === REFRESH_KEY && event.newValue === null) {
        session.clear();
        if (mounted.current) {
          setUser(null);
          setStatus("anonymous");
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      notifyRevoked = null;
      mounted.current = false;
      setRefreshHandler(null);
      setRevokedHandler(null);
    };
  }, []);

  useEffect(() => {
    bootPromise ??= boot();
    let cancelled = false;
    bootPromise.then((result) => {
      if (cancelled || !mounted.current) return;
      if (result.me) {
        setUser(result.me);
        setStatus("authenticated");
      } else {
        setStatus("anonymous");
        
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!channel) return;
    const onMessage = (event: MessageEvent<unknown>) => {
      const payload = event.data;
      if (typeof payload !== "object" || payload === null) return;
      const record = payload as Record<string, unknown>;
      const type = record.type;
      if (type === "tokens") {
        const tokens = record.tokens as TokenPair | undefined;
        if (tokens) {
          tokenStamp += 1;
          applyTokens(tokens);
          if (mounted.current && status === "authenticated") {
            apiRequest<Me>("/auth/me")
              .then((me) => {
                if (mounted.current) setUser(me);
              })
              .catch(() => undefined);
          }
        }
      } else if (type === "logout") {
        session.clear();
        writeRefreshToken(null);
        if (mounted.current) {
          setUser(null);
          setStatus("anonymous");
        }
      } else if (type === "revoked") {
        session.clear();
        writeRefreshToken(null);
        if (mounted.current) {
          setUser(null);
          setStatus("anonymous");
          setRevokedMessage(revokedText(String(record.reason ?? "SESSION_REVOKED")));
        }
      }
    };
    channel.addEventListener("message", onMessage);
    return () => channel?.removeEventListener("message", onMessage);
  }, [status]);

  const finishAuth = useCallback(async (tokens: TokenPair): Promise<Me> => {
    applyTokens(tokens);
    const me = await apiRequest<Me>("/auth/me");
    channel?.postMessage({ type: "tokens", tokens });
    setUser(me);
    setStatus("authenticated");
    setRevokedMessage(null);
    bootPromise = Promise.resolve({ me });
    return me;
  }, []);

  const login = useCallback(
    async (email: string, password: string): Promise<Me> => {
      const response = await apiRequest<LoginResponse>("/auth/login", {
        method: "POST",
        body: { email, password },
        anonymous: true,
        skipAuthRefresh: true,
      });
      return finishAuth(response);
    },
    [finishAuth],
  );

  const register = useCallback(
    async (teamName: string, email: string, password: string): Promise<Me> => {
      const response = await apiRequest<RegisterResponse>("/auth/register", {
        method: "POST",
        body: { teamName, email, password },
        anonymous: true,
        skipAuthRefresh: true,
      });
      return finishAuth(response);
    },
    [finishAuth],
  );

  const logout = useCallback(async (): Promise<void> => {
    const refreshToken = readRefreshToken();
    try {
      if (refreshToken) {
        await rawFetch("/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
      }
    } catch {
      /* el cierre local no depende del servidor */
    }
    session.clear();
    writeRefreshToken(null);
    channel?.postMessage({ type: "logout" });
    bootPromise = Promise.resolve({ me: null });
    setUser(null);
    setStatus("anonymous");
  }, []);

  const refreshMe = useCallback(async (): Promise<Me | null> => {
    try {
      const me = await apiRequest<Me>("/auth/me");
      setUser(me);
      return me;
    } catch {
      return null;
    }
  }, []);

  const hasPermission = useCallback(
    (permission: Permission): boolean => user?.permissions.includes(permission) ?? false,
    [user],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      revokedMessage,
      login,
      register,
      logout,
      refreshMe,
      hasPermission,
    }),
    [status, user, revokedMessage, login, register, logout, refreshMe, hasPermission],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth debe usarse dentro de AuthProvider");
  return context;
}

export function usePermission(permission: Permission): boolean {
  return useAuth().hasPermission(permission);
}

export { isApiError };
