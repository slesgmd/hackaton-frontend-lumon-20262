import { apiRequest, isAbortError, isApiError } from "./api";
import { BIN_CHAR, clamp } from "./format";
import type { CellData, GroupSource } from "./group";
import { TileSchema } from "./schemas";
import type { Bin, CellRef } from "./types";

export type { GroupResult } from "./group";
export { collectGroup } from "./group";

export interface GridCell extends CellData {
  digit: number;
  tremor: number;
}

interface DecodedTile {
  rows: number;
  cols: number;
  originRow: number;
  originCol: number;
  values: Uint8Array;
  tremor: Uint8Array;
  /** Código de carácter de cada celda: "." W F D M. */
  bins: Uint8Array;
  version: number;
}

interface Job {
  key: string;
  tileRow: number;
  tileCol: number;
  controller: AbortController;
  resolve: (tile: DecodedTile | null) => void;
}

const MAX_CONCURRENT = 4;
const MAX_ATTEMPTS = 7;
const DOT = ".".charCodeAt(0);

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeTile(raw: unknown): DecodedTile {
  const tile = TileSchema.parse(raw);
  const count = tile.rows * tile.cols;
  if (tile.values.length !== count || tile.bins.length !== count) {
    throw new Error("El bloque llegó con un tamaño que no coincide con rows × cols.");
  }
  const tremor = decodeBase64(tile.tremor);
  if (tremor.length !== count) throw new Error("El temblor del bloque no coincide con rows × cols.");
  const values = new Uint8Array(count);
  const bins = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    const digit = tile.values.charCodeAt(i) - 48;
    values[i] = digit >= 0 && digit <= 9 ? digit : 0;
    bins[i] = tile.bins.charCodeAt(i);
  }
  return {
    rows: tile.rows,
    cols: tile.cols,
    originRow: tile.originRow,
    originCol: tile.originCol,
    values,
    tremor,
    bins,
    version: tile.version,
  };
}

export function tileKey(tileRow: number, tileCol: number): string {
  return `${tileRow}:${tileCol}`;
}

function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class TileStore implements GroupSource {
  readonly fileId: number;
  readonly rows: number;
  readonly cols: number;
  readonly tileSize: number;
  readonly tileRows: number;
  readonly tileCols: number;

  private decoded = new Map<string, DecodedTile>();
  /** Un solo request por bloque: nunca hay dos en vuelo (ni en cola) para la misma clave. */
  private inflight = new Map<string, { promise: Promise<DecodedTile | null>; controller: AbortController }>();
  private queue: Job[] = [];
  private active = 0;
  private pauseUntil = 0;
  private pinned = new Map<string, number>();
  private listeners = new Set<() => void>();
  private notifyScheduled = false;
  private disposed = false;
  /** Para pruebas y para el indicador: peticiones de red realmente iniciadas. */
  requestsStarted = 0;

  constructor(fileId: number, rows: number, cols: number, tileSize: number) {
    this.fileId = fileId;
    this.rows = rows;
    this.cols = cols;
    this.tileSize = Math.max(1, tileSize);
    this.tileRows = Math.max(1, Math.ceil(rows / this.tileSize));
    this.tileCols = Math.max(1, Math.ceil(cols / this.tileSize));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Agrupa las notificaciones en un frame para no renderizar la grilla por cada bloque. */
  private notify(): void {
    if (this.notifyScheduled || this.disposed) return;
    this.notifyScheduled = true;
    window.requestAnimationFrame(() => {
      this.notifyScheduled = false;
      if (!this.disposed) this.listeners.forEach((listener) => listener());
    });
  }

  hasTile(tileRow: number, tileCol: number): boolean {
    return this.decoded.has(tileKey(tileRow, tileCol));
  }

  getCell(r: number, c: number): GridCell | null {
    const tile = this.decoded.get(tileKey(Math.floor(r / this.tileSize), Math.floor(c / this.tileSize)));
    if (!tile) return null;
    const localR = r - tile.originRow;
    const localC = c - tile.originCol;
    if (localR < 0 || localC < 0 || localR >= tile.rows || localC >= tile.cols) return null;
    const index = localR * tile.cols + localC;
    const code = tile.bins[index] ?? DOT;
    return {
      digit: tile.values[index] ?? 0,
      tremor: tile.tremor[index] ?? 0,
      bin: String.fromCharCode(code),
    };
  }

  /** Cancela lo que salió de la vista, salvo los bloques fijados por una selección en curso. */
  setWanted(wanted: Set<string>): void {
    for (const [key, entry] of this.inflight) {
      if (!wanted.has(key) && !this.pinned.has(key)) entry.controller.abort();
    }
  }

  pin(keys: Iterable<string>): () => void {
    const added: string[] = [];
    for (const key of keys) {
      this.pinned.set(key, (this.pinned.get(key) ?? 0) + 1);
      added.push(key);
    }
    return () => {
      for (const key of added) {
        const count = (this.pinned.get(key) ?? 1) - 1;
        if (count <= 0) this.pinned.delete(key);
        else this.pinned.set(key, count);
      }
    };
  }

  load(tileRow: number, tileCol: number, force = false): Promise<DecodedTile | null> {
    if (this.disposed) return Promise.resolve(null);
    if (tileRow < 0 || tileCol < 0 || tileRow >= this.tileRows || tileCol >= this.tileCols) {
      return Promise.resolve(null);
    }
    const key = tileKey(tileRow, tileCol);
    if (!force) {
      const cached = this.decoded.get(key);
      if (cached) return Promise.resolve(cached);
    }
    const existing = this.inflight.get(key);
    if (existing && !existing.controller.signal.aborted) return existing.promise;

    const controller = new AbortController();
    const promise = new Promise<DecodedTile | null>((resolve) => {
      this.queue.push({ key, tileRow, tileCol, controller, resolve });
    });
    const entry = { promise, controller };
    this.inflight.set(key, entry);
    void promise.then(() => {
      if (this.inflight.get(key) === entry) this.inflight.delete(key);
    });
    this.pump();
    return promise;
  }

  private pump(): void {
    while (!this.disposed && this.active < MAX_CONCURRENT && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) break;
      if (job.controller.signal.aborted) {
        job.resolve(null);
        continue;
      }
      this.active += 1;
      void this.run(job).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    const { controller } = job;
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        if (this.disposed || controller.signal.aborted) break;
        // Un 429 pausa TODOS los pedidos hasta que pase Retry-After.
        const pause = this.pauseUntil - Date.now();
        if (pause > 0) await abortableSleep(pause, controller.signal);
        try {
          this.requestsStarted += 1;
          const raw = await apiRequest<unknown>(`/files/${this.fileId}/tiles/${job.tileRow}/${job.tileCol}`, {
            signal: controller.signal,
            retries: 0,
          });
          const tile = decodeTile(raw);
          const previous = this.decoded.get(job.key);
          // Una respuesta vieja nunca pisa a una nueva.
          if (!previous || tile.version >= previous.version) this.decoded.set(job.key, tile);
          this.notify();
          job.resolve(this.decoded.get(job.key) ?? tile);
          return;
        } catch (error) {
          if (isAbortError(error) || controller.signal.aborted) break;
          if (isApiError(error) && error.status === 429) {
            this.pauseUntil = Math.max(this.pauseUntil, Date.now() + (error.retryAfter ?? 1000));
            continue;
          }
          if (isApiError(error) && (error.status === 503 || error.status === 0)) {
            const wait = error.retryAfter ?? jitter(Math.min(8000, 500 * 2 ** attempt));
            await abortableSleep(wait, controller.signal);
            continue;
          }
          break;
        }
      }
    } catch {
      /* cancelado mientras esperaba */
    }
    job.resolve(null);
  }

  /** Asegura un bloque y lo fija mientras dure la espera para que no se cancele. */
  async ensureTile(tileRow: number, tileCol: number, signal?: AbortSignal): Promise<void> {
    const unpin = this.pin([tileKey(tileRow, tileCol)]);
    try {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await this.load(tileRow, tileCol);
    } finally {
      unpin();
    }
  }

  setBin(cells: CellRef[], bin: Bin): void {
    const code = BIN_CHAR[bin].charCodeAt(0);
    let changed = false;
    for (const { r, c } of cells) {
      const tile = this.decoded.get(tileKey(Math.floor(r / this.tileSize), Math.floor(c / this.tileSize)));
      if (!tile) continue;
      const localR = r - tile.originRow;
      const localC = c - tile.originCol;
      if (localR < 0 || localC < 0 || localR >= tile.rows || localC >= tile.cols) continue;
      tile.bins[localR * tile.cols + localC] = code;
      changed = true;
    }
    if (changed) this.notify();
  }

  /** Vuelve a pedir bloques concretos (por ejemplo, tras un 409 ALREADY_REFINED). */
  async refreshTiles(keys: Array<[number, number]>): Promise<void> {
    await Promise.all(keys.map(([row, col]) => this.load(row, col, true)));
  }

  async refreshTilesFor(cells: CellRef[]): Promise<void> {
    const unique = new Map<string, [number, number]>();
    for (const { r, c } of cells) {
      const row = Math.floor(r / this.tileSize);
      const col = Math.floor(c / this.tileSize);
      unique.set(tileKey(row, col), [row, col]);
    }
    await this.refreshTiles([...unique.values()]);
  }

  tileKeyFor(r: number, c: number): string {
    return tileKey(Math.floor(r / this.tileSize), Math.floor(c / this.tileSize));
  }

  visibleTileKeys(startRow: number, endRow: number, startCol: number, endCol: number): Set<string> {
    const keys = new Set<string>();
    const firstRow = Math.max(0, Math.floor(startRow / this.tileSize));
    const lastRow = Math.min(this.tileRows - 1, Math.floor(endRow / this.tileSize));
    const firstCol = Math.max(0, Math.floor(startCol / this.tileSize));
    const lastCol = Math.min(this.tileCols - 1, Math.floor(endCol / this.tileSize));
    for (let tr = firstRow; tr <= lastRow; tr += 1) {
      for (let tc = firstCol; tc <= lastCol; tc += 1) keys.add(tileKey(tr, tc));
    }
    return keys;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.inflight.values()) entry.controller.abort();
    for (const job of this.queue) job.resolve(null);
    this.queue = [];
    this.inflight.clear();
    this.listeners.clear();
  }
}

export function clampCell(r: number, c: number, rows: number, cols: number): CellRef {
  return {
    r: clamp(Math.trunc(r), 0, Math.max(0, rows - 1)),
    c: clamp(Math.trunc(c), 0, Math.max(0, cols - 1)),
  };
}
