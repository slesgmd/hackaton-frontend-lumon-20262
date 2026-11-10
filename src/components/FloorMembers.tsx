import { useSyncExternalStore, type JSX } from "react";
import type { CursorStore, FloorMember } from "../lib/floor";
import type { CellRef } from "../lib/types";

/** Lista de presentes (sin duplicados por userId) con un botón para ir a la posición de cada uno. */
export function FloorMembers({
  members,
  store,
  selfId,
  onGo,
}: {
  members: FloorMember[];
  store: CursorStore;
  selfId: number | null;
  onGo: (cell: CellRef) => void;
}): JSX.Element {
  const cursors = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const unique = [...new Map(members.map((member) => [member.userId, member])).values()];
  return (
    <div className="rounded border border-lumon-line bg-lumon-panel p-3">
      <h2 className="text-sm font-semibold text-lumon-mint">Refinadores en el piso</h2>
      <ul className="mt-2 space-y-1 text-xs text-lumon-mint/70">
        {unique.length === 0 ? <li>Nadie más conectado.</li> : null}
        {unique.map((member) => {
          const cursor = cursors.find((item) => item.userId === member.userId);
          return (
            <li key={member.userId} className="flex items-center justify-between gap-2">
              <span>
                {member.displayName}
                {member.userId === selfId ? " (tú)" : ""}
              </span>
              {cursor ? (
                <button
                  type="button"
                  onClick={() => onGo({ r: cursor.r, c: cursor.c })}
                  className="rounded border border-lumon-line px-2 py-0.5 text-[11px]"
                >
                  Ir a {cursor.r + 1},{cursor.c + 1}
                </button>
              ) : (
                <span className="text-lumon-mint/40">sin cursor</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
