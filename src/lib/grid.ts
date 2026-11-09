import { apiRequest, isAbortError, isApiError } from "./api";
import { BIN_CHAR, clamp } from "./format";
import type { Bin, BinChar, CellRef, Rules, Tile } from "./types";

export interface GridCell {
  digit: number;
  tremor: number;
  bin: BinChar;
}

interface DecodedTile {
  rows: number;
  cols: number;
  originRow: number;
  originCol: number;
  values: Uint8Array;
  tremor: Uint8Array;
  bins: string;
  version: number;
}

const TREMOR_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64(value: string): Uint8Array {
  if (!value) return new Uint8Array(0);
  if (!TREMOR_BASE64.test(value)) return new Uint8Array(0);
  try {
    const binary = window.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

function decodeTile(tile: Tile): DecodedTile {
  const values = new Uint8Array(tile.values.length);
  for (let i = 0; i < tile.values.length; i += 1) {
    const code = tile.values.charCodeAt(i) - 48;
    values[i] = code >= 0 && code <= 9 ? code : 0;
  }
  return {
    rows: tile.rows,
    cols: tile.cols,
    originRow: tile.originRow,
    originCol: tile.originCol,
    values,
    tremor: decodeBase64(tile.tremor),
    bins: tile.bins,
    version: tile.version,
  };
}

function tileKey(tileRow: number, tileCol: number): string {
  return `${tileRow}:${tileCol}`;
}

export class TileStore {
  readonly fileId: number;
  readonly tileSize: number;
  readonly tileRows: number;
  readonly tileCols: number;

  private decoded = new Map<string, DecodedTile>();
  private inflight = new Map<string, Promise<DecodedTile | null>>();
  private controllers = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  private pinned = new Set<string>();
  private gateUntil = 0;
  private disposed = false;

  constructor(fileId: number, rows: number, cols: number, tileSize: number) {
    this.fileId = fileId;
    this.tileSize = Math.max(1, tileSize);
    this.tileRows = Math.max(1, Math.ceil(rows / this.tileSize));
    this.tileCols = Math.max(1, Math.ceil(cols / this.tileSize));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  hasTile(tileRow: number, tileCol: number): boolean {
    return this.decoded.has(tileKey(tileRow, tileCol));
  }

  getCell(r: number, c: number): GridCell | null {
    const tr = Math.floor(r / this.tileSize);
    const tc = Math.floor(c / this.tileSize);
    const tile = this.decoded.get(tileKey(tr, tc));
    if (!tile) return null;
    const localR = r - tile.originRow;
    const localC = c - tile.originCol;
    if (localR < 0 || localC < 0 || localR >= tile.rows || localC >= tile.cols) return null;
    const index = localR * tile.cols + localC;
    const bin = tile.bins.charAt(index);
    return {
      digit: tile.values[index] ?? 0,
      tremor: tile.tremor[index] ?? 0,
      bin: bin === "W" || bin === "F" || bin === "D" || bin === "M" ? bin : ".",
    };
  }

  setWanted(keys: Set<string>): void {
    for (const [key, controller] of this.controllers) {
      if (!keys.has(key) && !this.pinned.has(key)) {
        controller.abort();
        this.controllers.delete(key);
      }
    }
  }

  pin(keys: Iterable<string>): () => void {
    const added: string[] = [];
    for (const key of keys) {
      if (!this.pinned.has(key)) {
        this.pinned.add(key);
        added.push(key);
      }
    }
    return () => {
      for (const key of added) this.pinned.delete(key);
    };
  }

  private async waitGate(signal: AbortSignal): Promise<void> {
    const wait = this.gateUntil - Date.now();
    if (wait <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, wait);
      const onAbort = () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async load(tileRow: number, tileCol: number, force = false): Promise<DecodedTile | null> {
    const key = tileKey(tileRow, tileCol);
    if (!force && this.decoded.has(key)) return this.decoded.get(key) ?? null;
    if (!force) {
      const pending = this.inflight.get(key);
      if (pending) return pending;
    }
    if (tileRow < 0 || tileCol < 0 || tileRow >= this.tileRows || tileCol >= this.tileCols) return null;

    const controller = new AbortController();
    this.controllers.set(key, controller);

    const promise = (async (): Promise<DecodedTile | null> => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (this.disposed) return null;
        try {
          await this.waitGate(controller.signal);
          const tile = await apiRequest<Tile>(
            `/files/${this.fileId}/tiles/${tileRow}/${tileCol}`,
            { signal: controller.signal, retries: 0 },
          );
          const result = decodeTile(tile);
          if (!this.disposed) {
            this.decoded.set(key, result);
            this.notify();
          }
          return result;
        } catch (error) {
          if (this.disposed || isAbortError(error) || controller.signal.aborted) return null;
          if (isApiError(error) && error.status === 429) {
            const wait = error.retryAfter ?? 1000;
            this.gateUntil = Math.max(this.gateUntil, Date.now() + wait);
            continue;
          }
          if (isApiError(error) && (error.status === 503 || error.status === 0)) {
            const wait = error.retryAfter ?? Math.min(8000, 500 * 2 ** attempt);
            await new Promise<void>((resolve) => window.setTimeout(resolve, wait));
            continue;
          }
          if (isApiError(error) && error.status === 404) return null;
          return null;
        }
      }
      return null;
    })();

    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
      this.controllers.delete(key);
    }
  }

  async ensureCell(r: number, c: number): Promise<GridCell | null> {
    const existing = this.getCell(r, c);
    if (existing) return existing;
    const tr = Math.floor(r / this.tileSize);
    const tc = Math.floor(c / this.tileSize);
    await this.load(tr, tc);
    return this.getCell(r, c);
  }

  setBin(cells: CellRef[], bin: Bin): void {
    const char = BIN_CHAR[bin];
    const changed = new Set<string>();
    for (const { r, c } of cells) {
      const tr = Math.floor(r / this.tileSize);
      const tc = Math.floor(c / this.tileSize);
      const key = tileKey(tr, tc);
      const tile = this.decoded.get(key);
      if (!tile) continue;
      const localR = r - tile.originRow;
      const localC = c - tile.originCol;
      if (localR < 0 || localC < 0 || localR >= tile.rows || localC >= tile.cols) continue;
      const index = localR * tile.cols + localC;
      const bins = tile.bins.split("");
      bins[index] = char;
      tile.bins = bins.join("");
      changed.add(key);
    }
    if (changed.size > 0) this.notify();
  }

  async refreshTilesFor(cells: CellRef[]): Promise<void> {
    const keys = new Set<string>();
    for (const { r, c } of cells) {
      keys.add(tileKey(Math.floor(r / this.tileSize), Math.floor(c / this.tileSize)));
    }
    await Promise.all(
      [...keys].map((key) => {
        const [row, col] = key.split(":");
        return this.load(Number(row), Number(col), true);
      }),
    );
  }

  tileKeyFor(r: number, c: number): string {
    return tileKey(Math.floor(r / this.tileSize), Math.floor(c / this.tileSize));
  }

  visibleTileKeys(startRow: number, endRow: number, startCol: number, endCol: number): Set<string> {
    const keys = new Set<string>();
    const firstRow = Math.floor(startRow / this.tileSize);
    const lastRow = Math.floor(endRow / this.tileSize);
    const firstCol = Math.floor(startCol / this.tileSize);
    const lastCol = Math.floor(endCol / this.tileSize);
    for (let tr = firstRow; tr <= lastRow; tr += 1) {
      for (let tc = firstCol; tc <= lastCol; tc += 1) keys.add(tileKey(tr, tc));
    }
    return keys;
  }

  dispose(): void {
    this.disposed = true;
    this.controllers.forEach((controller) => controller.abort());
    this.controllers.clear();
    this.inflight.clear();
    this.listeners.clear();
  }
}

export interface GroupResult {
  cells: CellRef[];
  size: number;
  bin: Bin | null;
  noise: boolean;
  reason: string | null;
}

const NEIGHBOURS_4: Array<[number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

const NEIGHBOURS_8: Array<[number, number]> = [
  ...NEIGHBOURS_4,
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

const MAX_GROUP_CELLS = 10000;

export function binForGroup(cells: CellRef[], store: TileStore, rules: Rules): Bin | null {
  let sum = 0;
  let max = 0;
  for (const { r, c } of cells) {
    const cell = store.getCell(r, c);
    if (!cell) return null;
    sum += cell.digit;
    max = Math.max(max, cell.digit);
  }
  const index =
    rules.binning.strategy === "DIGIT_SUM_MOD" ? sum % 4 : max % 4;
  return rules.binning.order[index] ?? null;
}

export async function collectGroup(
  store: TileStore,
  rules: Rules,
  rows: number,
  cols: number,
  start: CellRef,
  signal?: AbortSignal,
): Promise<GroupResult> {
  const startCell = await store.ensureCell(start.r, start.c);
  if (!startCell) throw new Error("No se pudo cargar el bloque de la celda.");
  if (startCell.tremor < rules.tremorThreshold) {
    return { cells: [], size: 0, bin: null, noise: false, reason: null };
  }

  const offsets = rules.connectivity === 8 ? NEIGHBOURS_8 : NEIGHBOURS_4;
  const visited = new Set<string>();
  const cells: CellRef[] = [];
  const queue: CellRef[] = [{ r: start.r, c: start.c }];
  const touchedTiles = new Set<string>();
  visited.add(`${start.r}:${start.c}`);

  const unpin = store.pin([store.tileKeyFor(start.r, start.c)]);
  try {
    while (queue.length > 0) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const current = queue.shift();
      if (!current) break;
      const cell = await store.ensureCell(current.r, current.c);
      if (!cell) throw new Error("Se perdió un bloque durante la selección.");
      if (cell.tremor < rules.tremorThreshold) continue;
      cells.push(current);
      touchedTiles.add(store.tileKeyFor(current.r, current.c));
      if (cells.length > MAX_GROUP_CELLS) {
        return {
          cells,
          size: cells.length,
          bin: null,
          noise: true,
          reason: "El grupo es demasiado grande para refinarse.",
        };
      }
      for (const [dr, dc] of offsets) {
        const nr = current.r + dr;
        const nc = current.c + dc;
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const key = `${nr}:${nc}`;
        if (visited.has(key)) continue;
        visited.add(key);
        const neighbourTile = store.tileKeyFor(nr, nc);
        if (!store.hasTile(Math.floor(nr / store.tileSize), Math.floor(nc / store.tileSize))) {
          unpin();
          const extra = store.pin([neighbourTile]);
          try {
            const loaded = await store.ensureCell(nr, nc);
            if (!loaded) continue;
          } finally {
            extra();
          }
        }
        queue.push({ r: nr, c: nc });
      }
    }
  } finally {
    unpin();
  }

  const size = cells.length;
  if (size < rules.minGroupSize || size > rules.maxGroupSize) {
    return {
      cells,
      size,
      bin: null,
      noise: true,
      reason:
        size < rules.minGroupSize
          ? `Es ruido: el grupo tiene ${size} celdas y el mínimo es ${rules.minGroupSize}.`
          : `Es ruido: el grupo tiene ${size} celdas y el máximo es ${rules.maxGroupSize}.`,
    };
  }

  const bin = binForGroup(cells, store, rules);
  return { cells, size, bin, noise: false, reason: null };
}

export function clampCell(r: number, c: number, rows: number, cols: number): CellRef {
  return {
    r: clamp(Math.trunc(r), 0, Math.max(0, rows - 1)),
    c: clamp(Math.trunc(c), 0, Math.max(0, cols - 1)),
  };
}
