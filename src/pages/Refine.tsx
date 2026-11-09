import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { apiRequest, isAbortError, isApiError, messageFor } from "../lib/api";
import { useAuth } from "../lib/auth";
import { BINS, BIN_NAME, percent, readInt } from "../lib/format";
import { collectGroup, clampCell, TileStore, type GroupResult } from "../lib/grid";
import { useFloor } from "../lib/floor";
import { useRealtimeEvent } from "../lib/realtime";
import type {
  Bin,
  CellRef,
  DataFile,
  RefineResult,
  RefinementCreatedEvent,
  Rules,
} from "../lib/types";
import { ErrorNotice, Loading } from "../components/Loading";
import { VirtualGrid } from "../components/VirtualGrid";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function reasonFrom(error: unknown): string | null {
  if (!isApiError(error)) return null;
  const details = error.details;
  if (typeof details === "object" && details !== null && "reason" in details) {
    const reason = (details as { reason?: unknown }).reason;
    if (typeof reason === "string") return reason;
  }
  return null;
}

async function refineWithRetry(
  fileId: number,
  bin: Bin,
  cells: CellRef[],
  idempotencyKey: string,
): Promise<RefineResult> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await apiRequest<RefineResult>(`/files/${fileId}/refinements`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: { bin, cells },
        retries: 0,
      });
    } catch (error) {
      lastError = error;
      if (isApiError(error) && (error.status === 503 || error.status === 0) && attempt < 3) {
        await sleep(error.retryAfter ?? Math.min(8000, 500 * 2 ** attempt));
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error("No se pudo refinar.");
}

export function RefinePage(): JSX.Element {
  const { id } = useParams();
  const fileId = Number(id);
  const [params] = useSearchParams();
  const { user, hasPermission } = useAuth();
  const canRefine = hasPermission("files:refine");

  const [file, setFile] = useState<DataFile | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  const [store, setStore] = useState<TileStore | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const urlR = readInt(params.get("r"), 0);
  const urlC = readInt(params.get("c"), 0);
  const [focus, setFocus] = useState<CellRef>({ r: urlR, c: urlC });
  const [initialCell, setInitialCell] = useState<CellRef>({ r: urlR, c: urlC });
  const initialised = useRef(false);

  const [selection, setSelection] = useState<GroupResult | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<CellRef | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectError, setSelectError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);

  const selectionRequest = useRef(0);
  const claimRequest = useRef<string | null>(null);
  const [claimPending, setClaimPending] = useState(false);
  const [claimInfo, setClaimInfo] = useState<{ requestId: string; claimId: string; cells: CellRef[] } | null>(null);

  const floor = useFloor({
    fileId: Number.isFinite(fileId) ? fileId : 0,
    enabled: Number.isFinite(fileId) && fileId > 0,
    onClaimGranted: (requestId, claimId, cells) => {
      if (claimRequest.current !== requestId) return;
      setClaimInfo({ requestId, claimId, cells });
      setClaimPending(false);
    },
    onClaimDenied: (denied) => {
      if (claimRequest.current !== denied.requestId) return;
      setClaimPending(false);
      setActionError(
        denied.reason === "HELD" && denied.holder
          ? `Otro refinador (${denied.holder.displayName}) tiene reservado este grupo.`
          : denied.reason === "HELD"
            ? "Otro refinador tiene reservado este grupo."
            : "El piso no reconoció este grupo como válido.",
      );
    },
  });

  useEffect(() => {
    if (!Number.isFinite(fileId) || fileId <= 0) {
      setLoadError("El identificador del archivo no es válido.");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let created: TileStore | null = null;
    setLoading(true);
    setLoadError(null);
    setSelection(null);
    setSelectionAnchor(null);
    setClaimInfo(null);
    setClaimPending(false);
    setActionError(null);
    setActionMessage(null);

    Promise.all([
      apiRequest<DataFile>(`/files/${fileId}`, { signal: controller.signal }),
      apiRequest<Rules>(`/files/${fileId}/rules`, { signal: controller.signal }),
    ])
      .then(([nextFile, nextRules]) => {
        created = new TileStore(nextFile.id, nextFile.rows, nextFile.cols, nextFile.tileSize);
        setStore(created);
        setFile(nextFile);
        setRules(nextRules);
        const clamped = clampCell(urlR, urlC, nextFile.rows, nextFile.cols);
        if (!initialised.current) {
          initialised.current = true;
          setInitialCell(clamped);
        }
        setFocus(clamped);
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        setLoadError(messageFor(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => {
      controller.abort();
      created?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, reloadKey]);

  const clearSelection = useCallback(
    (release: boolean) => {
      selectionRequest.current += 1;
      if (release && claimInfo) floor.release(claimInfo.claimId);
      claimRequest.current = null;
      setClaimInfo(null);
      setClaimPending(false);
      setSelection(null);
      setSelectionAnchor(null);
      setSelecting(false);
    },
    [claimInfo, floor],
  );

  const selectCell = useCallback(
    async (cell: CellRef) => {
      if (!store || !rules || !file) return;
      const current = store.getCell(cell.r, cell.c);
      if (!current || current.tremor < rules.tremorThreshold) {
        clearSelection(true);
        setActionMessage(null);
        return;
      }
      const request = selectionRequest.current + 1;
      selectionRequest.current = request;
      if (claimInfo) floor.release(claimInfo.claimId);
      setClaimInfo(null);
      claimRequest.current = null;
      setClaimPending(false);
      setSelecting(true);
      setSelectError(null);
      setActionError(null);
      setActionMessage(null);
      setSelectionAnchor(cell);
      try {
        const group = await collectGroup(store, rules, file.rows, file.cols, cell);
        if (selectionRequest.current !== request) return;
        setSelection(group);
        if (!group.noise && canRefine && floor.status === "open") {
          setClaimPending(true);
          claimRequest.current = floor.claim(cell.r, cell.c);
        }
      } catch (error) {
        if (selectionRequest.current !== request) return;
        setSelection(null);
        setSelectionAnchor(null);
        setSelectError(messageFor(error));
      } finally {
        if (selectionRequest.current === request) setSelecting(false);
      }
    },
    [store, rules, file, canRefine, floor, claimInfo, clearSelection],
  );

  useEffect(() => {
    if (!claimPending) return;
    const timer = window.setTimeout(() => {
      setClaimPending(false);
      setActionError("El piso compartido no confirmó la reserva a tiempo. Puedes refinar igual.");
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [claimPending]);

  useEffect(() => {
    if (floor.status !== "open" || !selection || selection.noise || !canRefine || claimInfo || claimPending) return;
    if (!selectionAnchor) return;
    setClaimPending(true);
    claimRequest.current = floor.claim(selectionAnchor.r, selectionAnchor.c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floor.status]);

  useEffect(() => {
    return () => {
      if (claimInfo) floor.release(claimInfo.claimId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const claimsByCell = useMemo(() => {
    const map = new Map<string, { userId: number; displayName: string }>();
    const names = new Map(floor.members.map((member) => [member.userId, member.displayName]));
    for (const claim of floor.claims) {
      if (claim.claimId === claimInfo?.claimId) continue;
      if (claim.userId === user?.id) continue;
      const name = names.get(claim.userId) ?? `Refinador ${claim.userId}`;
      for (const cell of claim.cells) map.set(`${cell.r}:${cell.c}`, { userId: claim.userId, displayName: name });
    }
    return map;
  }, [floor.claims, floor.members, claimInfo, user?.id]);

  const selectedClaim = useMemo(() => {
    if (!selection) return null;
    for (const cell of selection.cells) {
      const claim = claimsByCell.get(`${cell.r}:${cell.c}`);
      if (claim) return claim;
    }
    return null;
  }, [selection, claimsByCell]);

  const selectedKeys = useMemo(() => {
    const keys = new Set<string>();
    if (selection) for (const cell of selection.cells) keys.add(`${cell.r}:${cell.c}`);
    return keys;
  }, [selection]);

  const refine = useCallback(
    async (bin: Bin) => {
      if (!selection || selection.noise || !file || !store || busyRef.current) return;
      if (!canRefine) {
        setActionError("Tu rol no tiene permiso para refinar.");
        return;
      }
      if (selectedClaim) {
        setActionError(`El grupo está reservado por ${selectedClaim.displayName}.`);
        return;
      }
      busyRef.current = true;
      setBusy(true);
      setActionError(null);
      setActionMessage(null);
      const key = crypto.randomUUID();
      const cells = selection.cells;
      try {
        const result = await refineWithRetry(file.id, bin, cells, key);
        store.setBin(cells, bin);
        setFile((previous) =>
          previous
            ? {
                ...previous,
                progress: result.file.progress,
                refinedGroups: result.file.refinedGroups,
                totalGroups: result.file.totalGroups,
                mistakes: result.file.mistakes,
                status: result.file.status,
              }
            : previous,
        );
        setActionMessage(`Grupo de ${result.size} celdas llevado a ${BIN_NAME[bin]}.`);
        clearSelection(true);
      } catch (error) {
        if (isApiError(error) && error.status === 409) {
          await store.refreshTilesFor(cells);
          setActionError("Alguna celda ya estaba refinada. Actualizamos los bloques afectados; vuelve a seleccionar el grupo.");
          clearSelection(false);
        } else if (isApiError(error) && error.status === 422) {
          const reason = reasonFrom(error) ?? error.message;
          setActionError(
            error.code === "WRONG_BIN"
              ? `Esa no es la caja correcta: ${reason}. El grupo sigue seleccionado.`
              : `No se pudo refinar: ${reason}.`,
          );
        } else {
          setActionError(messageFor(error));
        }
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [selection, file, store, canRefine, selectedClaim, clearSelection],
  );

  useRealtimeEvent("refinement.created", (event) => {
    const data = event.data as RefinementCreatedEvent | null;
    if (!data || data.fileId !== fileId) return;
    store?.setBin(data.cells, data.bin);
    setFile((previous) => (previous ? { ...previous, progress: data.progress } : previous));
    setSelection((current) => {
      if (!current) return current;
      const affected = current.cells.some((cell) =>
        data.cells.some((other) => other.r === cell.r && other.c === cell.c),
      );
      return affected ? null : current;
    });
  });

  useRealtimeEvent("file.completed", (event) => {
    const data = event.data as { fileId?: number } | null;
    if (data?.fileId !== fileId) return;
    setFile((previous) => (previous ? { ...previous, status: "COMPLETE", progress: { ...previous.progress, overall: 1 } } : previous));
  });

  useRealtimeEvent("stream.reset", () => setReloadKey((value) => value + 1));

  const onPositionChange = useCallback((cell: CellRef) => {
    const url = new URL(window.location.href);
    url.searchParams.set("r", String(cell.r));
    url.searchParams.set("c", String(cell.c));
    window.history.replaceState(null, "", url);
  }, []);

  const onFocusChange = useCallback(
    (cell: CellRef) => {
      setFocus(cell);
      floor.sendCursor(cell.r, cell.c);
    },
    [floor],
  );

  const onDragStart = useCallback(
    (_cell: CellRef, event: React.PointerEvent<HTMLDivElement>) => {
      if (!selection || selection.noise || !canRefine) return;
      event.preventDefault();
      setDrag({ x: event.clientX, y: event.clientY });
      const move = (moveEvent: PointerEvent) => setDrag({ x: moveEvent.clientX, y: moveEvent.clientY });
      const up = (upEvent: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setDrag(null);
        const element = document.elementFromPoint(upEvent.clientX, upEvent.clientY);
        const binElement = element?.closest<HTMLElement>("[data-bin]");
        const bin = binElement?.dataset.bin;
        if (bin === "WO" || bin === "FC" || bin === "DR" || bin === "MA") {
          void refine(bin);
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
    },
    [selection, canRefine, refine],
  );

  if (loading && !file) return <Loading label="Abriendo archivo…" />;
  if (loadError) {
    return (
      <section>
        <ErrorNotice message={loadError} onRetry={() => setReloadKey((value) => value + 1)} />
        <Link to="/files" className="mt-4 inline-block text-sm text-lumon-mint underline">
          Volver a archivos
        </Link>
      </section>
    );
  }
  if (!file || !rules || !store) return <Loading label="Preparando grilla…" />;

  if (file.status === "COMPLETE" || file.progress.overall >= 1) {
    return (
      <section className="mx-auto max-w-xl rounded-lg border border-lumon-mint/40 bg-lumon-panel p-8 text-center">
        <p className="font-mono text-xs tracking-[0.3em] text-lumon-mintDim">ARCHIVO COMPLETADO</p>
        <h1 className="mt-2 text-2xl font-semibold text-lumon-mint">{file.name}</h1>
        <p className="mt-2 text-sm text-lumon-mint/70">
          Todos los grupos encontraron su caja. El trabajo es misterioso e importante.
        </p>
        <Link to="/files" className="mt-6 inline-block rounded bg-lumon-mint px-4 py-2 text-sm font-semibold text-lumon-ink">
          Volver a archivos
        </Link>
      </section>
    );
  }

  const floorLabel =
    floor.status === "open"
      ? "Piso conectado"
      : floor.status === "connecting"
        ? "Conectando al piso"
        : floor.status === "fatal"
          ? "Piso no disponible"
          : "Piso sin conexión";

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/files" className="text-xs text-lumon-mint/60 underline">
            ← Archivos
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-lumon-mint">{file.name}</h1>
          <p className="font-mono text-xs text-lumon-mint/50">
            {file.rows} × {file.cols} · bloques de {file.tileSize} · {file.refinedGroups}/{file.totalGroups} grupos ·{" "}
            {file.mistakes} errores
          </p>
        </div>
        <div className="text-right text-xs text-lumon-mint/60">
          <p>
            <span
              className={`mr-1 inline-block h-2 w-2 rounded-full ${
                floor.status === "open" ? "bg-lumon-mint" : floor.status === "fatal" ? "bg-lumon-danger" : "bg-lumon-amber"
              }`}
              aria-hidden="true"
            />
            {floorLabel}
          </p>
          {floor.fatalMessage ? <p className="mt-1 max-w-xs text-lumon-danger">{floor.fatalMessage}</p> : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {BINS.map((bin) => (
          <div
            key={bin}
            data-bin={bin}
            className={`rounded border p-3 ${
              selection?.bin === bin && !selection.noise
                ? "border-lumon-mint bg-lumon-mint/10"
                : "border-lumon-line bg-lumon-panel"
            }`}
          >
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-lumon-mint">{BIN_NAME[bin]}</span>
              <span className="font-mono text-lumon-mint/50">{bin}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded bg-lumon-line">
              <div className="h-full bg-lumon-mint" style={{ width: percent(file.progress[bin]) }} />
            </div>
            <p className="mt-1 font-mono text-[11px] text-lumon-mint/50">{percent(file.progress[bin])}</p>
            <button
              type="button"
              data-bin={bin}
              onClick={() => void refine(bin)}
              disabled={!selection || selection.noise || busy || !canRefine || Boolean(selectedClaim) || claimPending}
              className="mt-2 w-full rounded border border-lumon-mint/30 px-2 py-1 text-xs text-lumon-mint disabled:opacity-40"
              aria-keyshortcuts={`${BINS.indexOf(bin) + 1}`}
            >
              {busy ? "Enviando…" : `Llevar a ${BIN_NAME[bin]}`}
            </button>
          </div>
        ))}
      </div>

      {selectError ? <ErrorNotice message={selectError} /> : null}
      {actionError ? <ErrorNotice message={actionError} /> : null}
      {actionMessage ? (
        <p role="status" className="rounded border border-lumon-mint/40 bg-lumon-mint/10 p-3 text-sm text-lumon-mint">
          {actionMessage}
        </p>
      ) : null}

      <div className="rounded border border-lumon-line bg-lumon-panel p-3">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <div aria-live="polite">
            {selecting ? (
              <span className="text-lumon-mint/70">Buscando el grupo completo…</span>
            ) : selection ? (
              selection.noise ? (
                <span className="text-lumon-amber">
                  {selection.reason ?? "Es ruido: no se puede refinar."} ({selection.size} celdas)
                </span>
              ) : (
                <span className="text-lumon-mint">
                  Grupo de {selection.size} celdas · caja correcta:{" "}
                  <strong>{selection.bin ? BIN_NAME[selection.bin] : "—"}</strong>
                  {claimPending ? " · reservando…" : ""}
                  {selectedClaim ? ` · reservado por ${selectedClaim.displayName}` : ""}
                </span>
              )
            ) : (
              <span className="text-lumon-mint/60">Elige una celda que tiemble para seleccionar su grupo.</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {selection ? (
              <button
                type="button"
                onClick={() => clearSelection(true)}
                className="rounded border border-lumon-line px-3 py-1 text-xs text-lumon-mint/80"
              >
                Cancelar selección
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <VirtualGrid
        store={store}
        rows={file.rows}
        cols={file.cols}
        threshold={rules.tremorThreshold}
        selected={selectedKeys}
        claims={claimsByCell}
        cursors={floor.cursors}
        focus={focus}
        initialCell={initialCell}
        onFocusChange={onFocusChange}
        onSelect={(cell) => void selectCell(cell)}
        onDragStart={onDragStart}
        onPositionChange={onPositionChange}
      />

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded border border-lumon-line bg-lumon-panel p-3">
          <h2 className="text-sm font-semibold text-lumon-mint">Refinadores en el piso</h2>
          <ul className="mt-2 space-y-1 text-xs text-lumon-mint/70">
            {floor.members.length === 0 ? <li>Nadie más conectado.</li> : null}
            {floor.members.map((member) => {
              const cursor = floor.cursors.find((item) => item.userId === member.userId);
              return (
                <li key={member.userId} className="flex items-center justify-between gap-2">
                  <span>
                    {member.displayName}
                    {member.userId === user?.id ? " (tú)" : ""}
                  </span>
                  {cursor ? (
                    <button
                      type="button"
                      onClick={() => setFocus({ r: cursor.r, c: cursor.c })}
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
        <div className="rounded border border-lumon-line bg-lumon-panel p-3 text-xs text-lumon-mint/60">
          <h2 className="text-sm font-semibold text-lumon-mint">Controles</h2>
          <p className="mt-2">Flechas mueven el foco. PageUp/PageDown saltan páginas. Home/End van al borde.</p>
          <p className="mt-1">Enter selecciona el grupo. Tab llega a las cajas; Enter las envía.</p>
          <p className="mt-1">También puedes arrastrar el grupo seleccionado hasta una caja.</p>
        </div>
      </div>

      {drag ? (
        <div
          className="pointer-events-none fixed z-50 rounded-full bg-lumon-amber px-3 py-1 text-xs font-semibold text-lumon-ink"
          style={{ left: drag.x + 12, top: drag.y + 12 }}
        >
          {selection?.size ?? 0} celdas
        </div>
      ) : null}
    </section>
  );
}
