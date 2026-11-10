import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";
import { BIN_NAME, binFromChar } from "../lib/format";
import { clampCell, type TileStore } from "../lib/grid";
import { chooseCellSize, computeRange, inRange } from "../lib/viewport";
import type { CellRef, FloorCursor } from "../lib/types";

const OVERSCAN = 3;

interface ClaimInfo {
  userId: number;
  displayName: string;
}

interface VirtualGridProps {
  store: TileStore;
  rows: number;
  cols: number;
  threshold: number;
  selected: Set<string>;
  claims: Map<string, ClaimInfo>;
  cursors: FloorCursor[];
  focus: CellRef;
  /** Celda que debe quedar arriba a la izquierda al abrir (viene de ?r=&c=). */
  initialCell: CellRef;
  onFocusChange: (cell: CellRef) => void;
  onSelect: (cell: CellRef) => void;
  onDragStart?: (cell: CellRef, event: React.PointerEvent<HTMLDivElement>) => void;
  /** Celda arriba a la izquierda de la vista; el padre decide cuándo escribirla en la URL. */
  onPositionChange?: (cell: CellRef) => void;
}

function binClass(bin: string): string {
  switch (bin) {
    case "W":
      return "bg-lumon-mint/25 text-lumon-mint";
    case "F":
      return "bg-lumon-amber/25 text-lumon-amber";
    case "D":
      return "bg-lumon-danger/25 text-lumon-danger";
    case "M":
      return "bg-fuchsia-400/25 text-fuchsia-300";
    default:
      return "";
  }
}

export function VirtualGrid({
  store,
  rows,
  cols,
  threshold,
  selected,
  claims,
  cursors,
  focus,
  initialCell,
  onFocusChange,
  onSelect,
  onDragStart,
  onPositionChange,
}: VirtualGridProps): JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [scroll, setScroll] = useState<{ top: number; left: number } | null>(null);
  const [, setVersion] = useState(0);
  const rafRef = useRef(0);
  const hasFocus = useRef(false);
  const lastPosition = useRef<string>("");

  const cellSize = size ? chooseCellSize(size.width, size.height) : 28;

  // Los bloques nuevos repintan la grilla (el store ya agrupa las notificaciones por frame).
  useEffect(() => store.subscribe(() => setVersion((value) => value + 1)), [store]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setSize({ width: Math.max(1, Math.floor(entry.contentRect.width)), height: Math.max(1, Math.floor(entry.contentRect.height)) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Posición inicial: una sola vez, cuando ya conocemos el tamaño del contenedor.
  const initialised = useRef(false);
  useEffect(() => {
    const element = viewportRef.current;
    if (!size || !element || initialised.current) return;
    initialised.current = true;
    element.scrollTo({ left: initialCell.c * cellSize, top: initialCell.r * cellSize });
    setScroll({ top: element.scrollTop, left: element.scrollLeft });
  }, [size, cellSize, initialCell.r, initialCell.c]);

  // Throttle por requestAnimationFrame: un solo setState por frame, sin importar cuántos eventos de scroll.
  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>): void => {
    const target = event.currentTarget;
    if (rafRef.current) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0;
      setScroll({ top: target.scrollTop, left: target.scrollLeft });
    });
  }, []);
  useEffect(() => () => window.cancelAnimationFrame(rafRef.current), []);

  const range = useMemo(() => {
    if (!size || !scroll) return null;
    return computeRange({
      scrollTop: scroll.top,
      scrollLeft: scroll.left,
      width: size.width,
      height: size.height,
      cellSize,
      rows,
      cols,
      overscan: OVERSCAN,
    });
  }, [size, scroll, cellSize, rows, cols]);

  // Pide los bloques visibles y cancela los que salieron de la vista.
  useEffect(() => {
    if (!range) return;
    const keys = store.visibleTileKeys(range.startRow, range.endRow, range.startCol, range.endCol);
    store.setWanted(keys);
    for (const key of keys) {
      const [row, col] = key.split(":");
      if (row !== undefined && col !== undefined) void store.load(Number(row), Number(col));
    }
  }, [store, range]);

  useEffect(() => {
    if (!scroll) return;
    const cell = clampCell(Math.floor(scroll.top / cellSize), Math.floor(scroll.left / cellSize), rows, cols);
    const id = `${cell.r}:${cell.c}`;
    if (id === lastPosition.current) return;
    lastPosition.current = id;
    onPositionChange?.(cell);
  }, [scroll, cellSize, rows, cols, onPositionChange]);

  const scrollToCell = useCallback(
    (cell: CellRef): void => {
      const element = viewportRef.current;
      if (!element) return;
      const x = cell.c * cellSize;
      const y = cell.r * cellSize;
      let left = element.scrollLeft;
      let top = element.scrollTop;
      if (x < left) left = x;
      else if (x + cellSize > left + element.clientWidth) left = x + cellSize - element.clientWidth;
      if (y < top) top = y;
      else if (y + cellSize > top + element.clientHeight) top = y + cellSize - element.clientHeight;
      if (left !== element.scrollLeft || top !== element.scrollTop) element.scrollTo({ left, top });
    },
    [cellSize],
  );

  // El foco (por teclado, por "Ir a…" o por URL) siempre queda visible.
  useEffect(() => {
    if (initialised.current) scrollToCell(focus);
  }, [focus.r, focus.c, scrollToCell, focus]);

  // Roving tabindex: si la grilla tiene el foco, el DOM sigue a la celda activa.
  useEffect(() => {
    if (!hasFocus.current) return;
    const element = document.getElementById(`cell-${focus.r}-${focus.c}`);
    if (element && document.activeElement !== element) element.focus({ preventScroll: true });
  });

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const pageRows = Math.max(1, Math.floor((size?.height ?? 400) / cellSize) - 1);
    let next: CellRef | null = null;
    switch (event.key) {
      case "ArrowUp":
        next = { r: focus.r - 1, c: focus.c };
        break;
      case "ArrowDown":
        next = { r: focus.r + 1, c: focus.c };
        break;
      case "ArrowLeft":
        next = { r: focus.r, c: focus.c - 1 };
        break;
      case "ArrowRight":
        next = { r: focus.r, c: focus.c + 1 };
        break;
      case "PageUp":
        next = { r: focus.r - pageRows, c: focus.c };
        break;
      case "PageDown":
        next = { r: focus.r + pageRows, c: focus.c };
        break;
      case "Home":
        next = event.ctrlKey ? { r: 0, c: 0 } : { r: focus.r, c: 0 };
        break;
      case "End":
        next = event.ctrlKey ? { r: rows - 1, c: cols - 1 } : { r: focus.r, c: cols - 1 };
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        onSelect(focus);
        return;
      default:
        return;
    }
    event.preventDefault();
    const clamped = clampCell(next.r, next.c, rows, cols);
    onFocusChange(clamped);
    scrollToCell(clamped);
  };

  // Filas con role="row": rango visible + la celda con foco aunque quede fuera del rango.
  const rowElements: JSX.Element[] = [];
  if (range) {
    const cellsByRow = new Map<number, JSX.Element[]>();
    const push = (r: number, element: JSX.Element): void => {
      const list = cellsByRow.get(r);
      if (list) list.push(element);
      else cellsByRow.set(r, [element]);
    };

    const renderCell = (r: number, c: number): JSX.Element => {
      const cell = store.getCell(r, c);
      const key = `${r}:${c}`;
      const isFocus = focus.r === r && focus.c === c;
      const isSelected = selected.has(key);
      const claim = claims.get(key);
      const refinedBin = cell && cell.bin !== "." ? binFromChar(cell.bin) : null;
      const scary = Boolean(cell) && cell !== null && cell.tremor >= threshold && cell.bin === ".";
      const amplitude = cell ? 0.3 + (cell.tremor / 100) * 1.6 : 0;
      const state = !cell
        ? "sin cargar"
        : refinedBin
          ? `refinada en ${BIN_NAME[refinedBin]}`
          : scary
            ? "da miedo"
            : "normal";
      const label = cell
        ? `Fila ${r + 1}, columna ${c + 1}, dígito ${cell.digit}, temblor ${cell.tremor}, ${state}${isSelected ? ", en el grupo seleccionado" : ""}${claim ? `, reservada por ${claim.displayName}` : ""}`
        : `Fila ${r + 1}, columna ${c + 1}, sin cargar`;
      const style: CSSProperties & Record<string, string | number | undefined> = {
        left: c * cellSize,
        width: cellSize,
        height: cellSize,
        cursor: isSelected && onDragStart ? "grab" : scary ? "pointer" : "default",
      };
      if (scary) style["--amp"] = `${amplitude.toFixed(2)}px`;

      return (
        <div
          key={key}
          id={`cell-${r}-${c}`}
          role="gridcell"
          aria-colindex={c + 1}
          aria-selected={isSelected}
          aria-label={label}
          tabIndex={isFocus ? 0 : -1}
          onClick={() => {
            onFocusChange({ r, c });
            onSelect({ r, c });
          }}
          onPointerDown={(event) => {
            if (isSelected && onDragStart) onDragStart({ r, c }, event);
          }}
          className={[
            "absolute top-0 flex select-none items-center justify-center border border-lumon-line/30 font-mono text-[11px]",
            !cell ? "bg-lumon-panel/40 text-transparent" : "",
            cell && !scary && !refinedBin ? "text-lumon-mint/35" : "",
            scary ? "cell-scary cell-tremor bg-lumon-mint/10 text-lumon-mint" : "",
            refinedBin ? binClass(cell?.bin ?? ".") : "",
            isSelected ? "z-10 ring-2 ring-inset ring-lumon-amber" : "",
            claim && !isSelected ? "ring-1 ring-inset ring-lumon-danger/80" : "",
            isFocus ? "z-20 outline outline-2 -outline-offset-2 outline-white" : "",
          ].join(" ")}
          style={style}
        >
          {cell ? cell.digit : ""}
          {claim ? <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-lumon-danger" aria-hidden="true" /> : null}
        </div>
      );
    };

    for (let r = range.startRow; r <= range.endRow; r += 1) {
      for (let c = range.startCol; c <= range.endCol; c += 1) push(r, renderCell(r, c));
    }
    if (!inRange(range, focus.r, focus.c)) push(focus.r, renderCell(focus.r, focus.c));

    for (const r of [...cellsByRow.keys()].sort((a, b) => a - b)) {
      rowElements.push(
        <div
          key={r}
          role="row"
          aria-rowindex={r + 1}
          className="absolute left-0"
          style={{ top: r * cellSize, width: cols * cellSize, height: cellSize }}
        >
          {cellsByRow.get(r)}
        </div>,
      );
    }
  }

  const visibleCursors = range ? cursors.filter((cursor) => inRange(range, cursor.r, cursor.c)) : [];

  return (
    <div
      ref={viewportRef}
      role="grid"
      aria-rowcount={rows}
      aria-colcount={cols}
      aria-label="Grilla de macrodata"
      onKeyDown={onKeyDown}
      onScroll={onScroll}
      onFocus={() => {
        hasFocus.current = true;
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hasFocus.current = false;
      }}
      className="relative h-[70vh] min-h-[320px] overflow-auto rounded border border-lumon-line bg-lumon-ink"
    >
      <div style={{ width: cols * cellSize, height: rows * cellSize, position: "relative" }}>
        {rowElements}
        {visibleCursors.map((cursor) => (
          <div
            key={`cursor-${cursor.userId}`}
            className="pointer-events-none absolute z-30 rounded border border-lumon-amber/80 bg-lumon-amber/20 px-1 text-[9px] text-lumon-amber"
            style={{ left: cursor.c * cellSize, top: cursor.r * cellSize }}
            aria-hidden="true"
          >
            {cursor.displayName?.slice(0, 8) ?? `U${cursor.userId}`}
          </div>
        ))}
      </div>
    </div>
  );
}
