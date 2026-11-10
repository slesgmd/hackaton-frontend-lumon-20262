/* Cálculo puro del rango visible de la grilla virtualizada (sin React ni DOM). */

export const MAX_DOM_CELLS = 2500;
/** Margen de celdas que la grilla nunca usa: la celda con foco se renderiza aparte, siempre. */
const RESERVED = 1;

export interface ViewportInput {
  scrollTop: number;
  scrollLeft: number;
  width: number;
  height: number;
  cellSize: number;
  rows: number;
  cols: number;
  overscan: number;
}

export interface Range {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export function rangeCount(range: Range): number {
  return (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
}

/** Tamaño de celda: 28 px, o más grande si el contenedor haría pasar el límite de celdas en el DOM. */
export function chooseCellSize(width: number, height: number, base = 28, target = 1800): number {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  if ((w / base) * (h / base) <= target) return base;
  return Math.ceil(Math.sqrt((w * h) / target));
}

/**
 * Rango [startRow..endRow] × [startCol..endCol] a renderizar. Garantiza por cálculo
 * rangeCount(range) <= MAX_DOM_CELLS - 1 (queda 1 para la celda con foco).
 */
export function computeRange(input: ViewportInput): Range {
  const { cellSize, rows, cols } = input;
  const limit = MAX_DOM_CELLS - RESERVED;
  const top = Math.max(0, input.scrollTop);
  const left = Math.max(0, input.scrollLeft);
  const visibleStartRow = Math.min(rows - 1, Math.floor(top / cellSize));
  const visibleStartCol = Math.min(cols - 1, Math.floor(left / cellSize));
  const visibleEndRow = Math.min(rows - 1, Math.ceil((top + input.height) / cellSize));
  const visibleEndCol = Math.min(cols - 1, Math.ceil((left + input.width) / cellSize));

  const build = (overscan: number): Range => ({
    startRow: Math.max(0, visibleStartRow - overscan),
    endRow: Math.min(rows - 1, visibleEndRow + overscan),
    startCol: Math.max(0, visibleStartCol - overscan),
    endCol: Math.min(cols - 1, visibleEndCol + overscan),
  });

  // 1) Reduce el overscan hasta que quepa.
  for (let overscan = Math.max(0, input.overscan); overscan >= 0; overscan -= 1) {
    const range = build(overscan);
    if (rangeCount(range) <= limit) return range;
  }
  // 2) Último recurso (contenedor enorme con celdas chicas): recorta el lado más largo.
  const range = build(0);
  while (rangeCount(range) > limit) {
    if (range.endRow - range.startRow >= range.endCol - range.startCol) range.endRow -= 1;
    else range.endCol -= 1;
  }
  return range;
}

export function inRange(range: Range, r: number, c: number): boolean {
  return r >= range.startRow && r <= range.endRow && c >= range.startCol && c <= range.endCol;
}
