import { memo, useSyncExternalStore, type JSX } from "react";
import type { CursorStore } from "../lib/floor";

/**
 * Cursores de los demás refinadores. Se suscribe directamente al store externo, así que un cursor nuevo
 * solo vuelve a pintar ESTA capa (con transform), nunca la grilla.
 */
export const CursorLayer = memo(function CursorLayer({
  store,
  cellSize,
}: {
  store: CursorStore;
  cellSize: number;
}): JSX.Element {
  const cursors = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <>
      {cursors.map((cursor) => (
        <div
          key={cursor.userId}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 z-30 rounded-sm border border-lumon-amber bg-lumon-amber/20"
          style={{
            width: cellSize,
            height: cellSize,
            transform: `translate(${cursor.c * cellSize}px, ${cursor.r * cellSize}px)`,
            willChange: "transform",
          }}
        >
          <span className="absolute -top-4 left-0 whitespace-nowrap rounded bg-lumon-amber px-1 text-[9px] font-semibold text-lumon-ink">
            {cursor.displayName.slice(0, 12)}
          </span>
        </div>
      ))}
    </>
  );
});
