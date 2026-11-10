/* Lógica pura del CP2 (sin React ni red): BFS de grupos y cálculo de la caja.
   Se mantiene libre de imports en tiempo de ejecución para poder probarla con `node --test`. */

export type BinCode = "WO" | "FC" | "DR" | "MA";

export interface GroupRules {
  tremorThreshold: number;
  connectivity: 4 | 8;
  minGroupSize: number;
  maxGroupSize: number;
  binning: { strategy: string; order: BinCode[] };
}

export interface CellData {
  digit: number;
  tremor: number;
  /** "." sin refinar, o W/F/D/M si ya está en una caja. */
  bin: string;
}

export interface CellPos {
  r: number;
  c: number;
}

export interface GroupSource {
  rows: number;
  cols: number;
  tileSize: number;
  /** Lectura síncrona desde la caché; null si el bloque aún no está cargado. */
  getCell(r: number, c: number): CellData | null;
  /** Asegura que el bloque (tileRow, tileCol) esté en la caché. */
  ensureTile(tileRow: number, tileCol: number, signal?: AbortSignal): Promise<void>;
}

export interface GroupResult {
  cells: CellPos[];
  size: number;
  bin: BinCode | null;
  noise: boolean;
  /** true si el BFS se cortó al pasar de maxGroupSize. */
  truncated: boolean;
  reason: string | null;
}

export class UnknownStrategyError extends Error {
  readonly strategy: string;
  constructor(strategy: string) {
    super(`Estrategia de cajas desconocida: "${strategy}". No se adivina la caja.`);
    this.name = "UnknownStrategyError";
    this.strategy = strategy;
  }
}

const NEIGHBOURS_4: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];
const NEIGHBOURS_8: ReadonlyArray<readonly [number, number]> = [
  ...NEIGHBOURS_4,
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

/** Caja = order[índice]. DIGIT_SUM_MOD: suma % 4. MAX_DIGIT_MOD: dígito máximo % 4. */
export function binForDigits(rules: GroupRules, digits: readonly number[]): BinCode {
  let sum = 0;
  let max = 0;
  for (const digit of digits) {
    sum += digit;
    if (digit > max) max = digit;
  }
  let index: number;
  if (rules.binning.strategy === "DIGIT_SUM_MOD") index = sum % 4;
  else if (rules.binning.strategy === "MAX_DIGIT_MOD") index = max % 4;
  else throw new UnknownStrategyError(rules.binning.strategy);
  const bin = rules.binning.order[index];
  if (!bin) throw new Error("El orden de cajas de las reglas está incompleto.");
  return bin;
}

export function isScary(cell: CellData, rules: GroupRules): boolean {
  return cell.tremor >= rules.tremorThreshold && cell.bin === ".";
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

async function cellAt(src: GroupSource, r: number, c: number, signal?: AbortSignal): Promise<CellData> {
  let cell = src.getCell(r, c);
  if (cell) return cell;
  await src.ensureTile(Math.floor(r / src.tileSize), Math.floor(c / src.tileSize), signal);
  cell = src.getCell(r, c);
  if (!cell) throw new Error(`No se pudo cargar el bloque de la celda (${r + 1}, ${c + 1}).`);
  return cell;
}

/**
 * BFS del grupo completo desde `start`, con la conectividad de las reglas, cruzando bloques.
 * Excluye celdas ya refinadas. Corta en maxGroupSize + 1 y marca el grupo como ruido.
 */
export async function collectGroup(
  src: GroupSource,
  rules: GroupRules,
  start: CellPos,
  signal?: AbortSignal,
): Promise<GroupResult> {
  const empty: GroupResult = { cells: [], size: 0, bin: null, noise: false, truncated: false, reason: null };
  if (start.r < 0 || start.c < 0 || start.r >= src.rows || start.c >= src.cols) return empty;

  const first = await cellAt(src, start.r, start.c, signal);
  if (!isScary(first, rules)) return empty;

  const offsets = rules.connectivity === 8 ? NEIGHBOURS_8 : NEIGHBOURS_4;
  const cap = rules.maxGroupSize + 1;
  const seen = new Set<number>();
  const key = (r: number, c: number): number => r * src.cols + c;
  const cells: CellPos[] = [];
  const digits: number[] = [];
  const queue: CellPos[] = [{ r: start.r, c: start.c }];
  seen.add(key(start.r, start.c));
  let head = 0;
  let truncated = false;

  while (head < queue.length) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const current = queue[head++] as CellPos;
    const cell = await cellAt(src, current.r, current.c, signal);
    if (!isScary(cell, rules)) continue;
    cells.push(current);
    digits.push(cell.digit);
    if (cells.length >= cap) {
      truncated = true;
      break;
    }
    for (const [dr, dc] of offsets) {
      const nr = current.r + dr;
      const nc = current.c + dc;
      if (nr < 0 || nc < 0 || nr >= src.rows || nc >= src.cols) continue;
      const k = key(nr, nc);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push({ r: nr, c: nc });
    }
  }

  const size = cells.length;
  if (size < rules.minGroupSize || size > rules.maxGroupSize) {
    return {
      cells,
      size,
      bin: null,
      noise: true,
      truncated,
      reason:
        size < rules.minGroupSize
          ? `Es ruido: tiene ${size} celdas y el mínimo es ${rules.minGroupSize}.`
          : `Es ruido: supera el máximo de ${rules.maxGroupSize} celdas.`,
    };
  }
  return { cells, size, bin: binForDigits(rules, digits), noise: false, truncated: false, reason: null };
}
