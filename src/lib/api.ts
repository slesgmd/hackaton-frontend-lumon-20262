import { apiUrl, env } from "./env";
import { session } from "./session";
import type { ApiErrorBody, ValidationErrorDetails } from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly retryAfter: number | null;
  readonly etag: string | null;

  constructor(
    status: number,
    code: string,
    message: string,
    details: unknown,
    retryAfter: number | null,
    etag: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
    this.etag = etag;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function fieldErrors(error: unknown): Record<string, string> {
  if (!isApiError(error)) return {};
  const details = error.details;
  if (typeof details !== "object" || details === null) return {};
  const candidate = (details as ValidationErrorDetails).fields;
  return candidate && typeof candidate === "object" ? candidate : {};
}

type RefreshHandler = () => Promise<boolean>;
type RevokedHandler = (reason: string) => void;

let refreshHandler: RefreshHandler | null = null;
let revokedHandler: RevokedHandler | null = null;

export function setRefreshHandler(handler: RefreshHandler | null): void {
  refreshHandler = handler;
}

export function setRevokedHandler(handler: RevokedHandler | null): void {
  revokedHandler = handler;
}

const REVOKED_CODES = new Set(["REFRESH_REUSED", "SESSION_REVOKED", "TOKEN_INVALID"]);

function parseRetryAfter(response: Response): number | null {
  const value = response.headers.get("Retry-After");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

async function parseErrorBody(response: Response): Promise<ApiError> {
  let body: ApiErrorBody | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = null;
  }
  const code = body?.error ?? `HTTP_${response.status}`;
  const message = body?.message ?? `La solicitud falló (${response.status}).`;
  return new ApiError(
    response.status,
    code,
    message,
    body?.details ?? null,
    parseRetryAfter(response),
    response.headers.get("ETag"),
  );
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  skipAuthRefresh?: boolean;
  /** Reintentos para 429/503 y fallos de red. Por defecto: 2 en GET, 0 en el resto. */
  retries?: number;
  anonymous?: boolean;
}

function baseHeaders(hasJsonBody: boolean): Headers {
  const headers = new Headers({ Accept: "application/json", "X-Lumon-Build": env.build });
  if (hasJsonBody) headers.set("Content-Type", "application/json");
  return headers;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function backoff(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt);
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const retries = options.retries ?? (method === "GET" ? 2 : 0);
  const hasJsonBody = options.body !== undefined;
  let attempt = 0;
  let refreshed = false;

  for (;;) {
    const headers = baseHeaders(hasJsonBody);
    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) headers.set(key, value);
    }
    const token = session.getAccessToken();
    if (token && !options.anonymous) headers.set("Authorization", `Bearer ${token}`);

    let response: Response;
    try {
      response = await fetch(apiUrl(path), {
        method,
        headers,
        signal: options.signal,
        body: hasJsonBody ? JSON.stringify(options.body) : undefined,
      });
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw error;
      if (attempt < retries) {
        await delay(backoff(attempt), options.signal);
        attempt += 1;
        continue;
      }
      throw new ApiError(0, "NETWORK_ERROR", "No se pudo conectar con Lumon.", null, null);
    }

    if (response.status === 401) {
      const apiError = await parseErrorBody(response);
      if (REVOKED_CODES.has(apiError.code)) {
        revokedHandler?.(apiError.code);
        throw apiError;
      }
      if (apiError.code === "TOKEN_EXPIRED" && !options.skipAuthRefresh && !refreshed && refreshHandler) {
        refreshed = true;
        const ok = await refreshHandler();
        if (ok) continue;
      }
      throw apiError;
    }

    if ((response.status === 429 || response.status === 503) && attempt < retries) {
      const wait = parseRetryAfter(response) ?? backoff(attempt);
      await delay(wait, options.signal);
      attempt += 1;
      continue;
    }

    if (!response.ok) throw await parseErrorBody(response);

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json")) return JSON.parse(text) as T;
    return text as T;
  }
}

export interface ResponseWithMeta<T> {
  data: T;
  etag: string | null;
  replayed: boolean;
}

export async function apiRequestWithMeta<T>(path: string, options: RequestOptions = {}): Promise<ResponseWithMeta<T>> {
  const method = (options.method ?? "GET").toUpperCase();
  const retries = options.retries ?? (method === "GET" ? 2 : 0);
  let attempt = 0;
  let refreshed = false;

  for (;;) {
    const headers = baseHeaders(options.body !== undefined);
    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) headers.set(key, value);
    }
    const token = session.getAccessToken();
    if (token && !options.anonymous) headers.set("Authorization", `Bearer ${token}`);

    let response: Response;
    try {
      response = await fetch(apiUrl(path), {
        method,
        headers,
        signal: options.signal,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw error;
      if (attempt < retries) {
        await delay(backoff(attempt), options.signal);
        attempt += 1;
        continue;
      }
      throw new ApiError(0, "NETWORK_ERROR", "No se pudo conectar con Lumon.", null, null);
    }

    if (response.status === 401) {
      const apiError = await parseErrorBody(response);
      if (REVOKED_CODES.has(apiError.code)) {
        revokedHandler?.(apiError.code);
        throw apiError;
      }
      if (apiError.code === "TOKEN_EXPIRED" && !options.skipAuthRefresh && !refreshed && refreshHandler) {
        refreshed = true;
        const ok = await refreshHandler();
        if (ok) continue;
      }
      throw apiError;
    }

    if ((response.status === 429 || response.status === 503) && attempt < retries) {
      const wait = parseRetryAfter(response) ?? backoff(attempt);
      await delay(wait, options.signal);
      attempt += 1;
      continue;
    }

    if (!response.ok) throw await parseErrorBody(response);
    const text = await response.text();
    const data = text ? (JSON.parse(text) as T) : (undefined as T);
    return {
      data,
      etag: response.headers.get("ETag"),
      replayed: response.headers.get("Idempotent-Replayed") === "true",
    };
  }
}

export async function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Lumon-Build", env.build);
  return fetch(apiUrl(path), { ...init, headers });
}

export function messageFor(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 423) return "El Piso de Pruebas todavía no está abierto.";
    if (error.status === 424) return "El storage aún no está verificado.";
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "Ocurrió un error inesperado.";
}
