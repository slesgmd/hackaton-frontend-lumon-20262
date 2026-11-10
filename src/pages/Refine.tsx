import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ErrorNotice, Loading } from "../components/Loading";
import { VirtualGrid } from "../components/VirtualGrid";
import { apiRequest, apiRequestWithMeta, isAbortError, isApiError, messageFor } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useFloor } from "../lib/floor";
import { BINS, BIN_NAME, percent, readInt } from "../lib/format";
import { UnknownStrategyError, type GroupResult } from "../lib/group";
import { TileStore, clampCell, collectGroup } from "../lib/grid";
import { useRealtimeEvent } from "../lib/realtime";
import { DataFileSchema, RefineResultSchema, RulesSchema } from "../lib/schemas";
import type { Bin, CellRef, DataFile, RefineResult, RefinementCreatedEvent, Rules } from "../lib/types";

const KNOWN_STRATEGIES = ["DIGIT_SUM_MOD", "MAX_DIGIT_MOD"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

function detail<T>(error: unknown, field: string): T | null {
  if (!isApiError(error)) return null;
  const details = error.details;
  if (typeof details !== "object" || details === null || !(field in details)) return null;
  return (details as Record<string, T>)[field] ?? null;
}

const GROUP_INVALID_TEXT: Record<string, string> = {
  BELOW_THRESHOLD: "El grupo incluye celdas que no dan miedo.",
  NOT_CONNECTED: "Las celdas elegidas no forman un grupo conectado.",
  SIZE_OUT_OF_RANGE: "El grupo es ruido por su tamaño: no se puede refinar.",
};

interface Intent {
  key: string;
  bin: Bin;
  cells: CellRef[];
}

/**
 * Envía UNA intención. Los reintentos por red, 503 o 429 reusan la misma Idempotency-Key y el mismo cuerpo.
 * Una intención nueva (otra caja, otro clic) genera otra key en `refine`.
 */
async function submitIntent(fileId: number, intent: Intent): Promise<{ result: RefineResult; replayed: boolean }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await apiRequestWithMeta<unknown>(`/files/${fileId}/refinements`, {
        method: "POST",
        headers: { "Idempotency-Key": intent.key },
        body: { bin: intent.bin, cells: intent.cells },
        retries: 0,
      });
      // Idempotent-Replayed: true también es un éxito.
      return { result: RefineResultSchema.parse(response.data), replayed: response.replayed };
    } catch (error) {
      const retriable = isApiError(error) && (error.status === 503 || error.status === 429 || error.status === 0);
      if (!retriable || attempt >= 5) throw error;
      await sleep(error.retryAfter ?? jitter(Math.min(8000, 500 * 2 ** attempt)));
    }
  }
}

export function RefinePage(): JSX.Element {
  const { id } = useParams();
  const fileId = Number(id);
  const [params, setParams] = useSearchParams();
  const setParamsRef = useRef(setParams);
  setParamsRef.current = setParams;
  const { user, hasPermission } = useAuth();
  const canRefine = hasPermission("files:refine");
  const cleared = user?.clearance.granted === true;

  const [file, setFile] = useState<DataFile | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  const [store, setStore] = useState<TileStore | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [focus, setFocus] = useState<CellRef>({ r: 0, c: 0 });
  const [initialCell, setInitialCell] = useState<CellRef>({ r: 0, c: 0 });

  const [selection, setSelection] = useState<GroupResult | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<CellRef | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectError, setSelectError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [drag, setDrag] = useState<{ x: number; y: number; over: Bin | null } | null>(null);
  const suppressClick = useRef(false);
  const binRefs = useRef<Record<Bin, HTMLDivElement | null>>({ WO: null, FC: null, DR: null, MA: null });

  const selectionRequest = useRef(0);
  const selectionAbort = useRef<AbortController | null>(null);
  const claimRequest = useRef<string | null>(null);
  const [claimPending, setClaimPending] = useState(false);
  const [claimInfo, setClaimInfo] = useState<{ requestId: string; claimId: string; cells: CellRef[] } | null>(null);

  const floor = useFloor({
    fileId: Number.isFinite(fileId) ? fileId : 0,
    // El piso compartido solo se abre cuando /auth/me indica clearance.granted.
    enabled: Number.isFinite(fileId) && fileId > 0 && cleared,
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

  // Carga del archivo y de sus reglas (nada hardcodeado), validadas con zod.
  useEffect(() => {
    if (!Number.isInteger(fileId) || fileId <= 0) {
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
      apiRequest<unknown>(`/files/${fileId}`, { signal: controller.signal }),
      apiRequest<unknown>(`/files/${fileId}/rules`, { signal: controller.signal }),
    ])
      .then(([rawFile, rawRules]) => {
        const nextFile = DataFileSchema.parse(rawFile);
        const nextRules = RulesSchema.parse(rawRules);
        created = new TileStore(nextFile.id, nextFile.rows, nextFile.cols, nextFile.tileSize);
        setStore(created);
        setFile(nextFile);
        setRules(nextRules);
        // ?r=&c= inválidos se ajustan al rango y se corrigen en la URL con replace.
        const rawR = readInt(params.get("r"), 0);
        const rawC = readInt(params.get("c"), 0);
        const clamped = clampCell(rawR, rawC, nextFile.rows, nextFile.cols);
        setInitialCell(clamped);
        setFocus(clamped);
        if (params.get("r") !== String(clamped.r) || params.get("c") !== String(clamped.c)) {
          setParamsRef.current(
            (current) => {
              const next = new URLSearchParams(current);
              next.set("r", String(clamped.r));
              next.set("c", String(clamped.c));
              return next;
            },
            { replace: true },
          );
        }
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
    // La posición inicial de la URL se lee solo al abrir el archivo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, reloadKey]);

  const strategyError =
    rules && !KNOWN_STRATEGIES.includes(rules.binning.strategy)
      ? `Este archivo usa una estrategia de cajas desconocida ("${rules.binning.strategy}"). No se puede calcular la caja correcta, así que no se ofrece ninguna.`
      : null;

  const clearSelection = useCallback(
    (release: boolean) => {
      selectionRequest.current += 1;
      selectionAbort.current?.abort();
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
      if (suppressClick.current) return;
      if (!store || !rules || !file) return;
      const current = store.getCell(cell.r, cell.c);
      if (current && (current.tremor < rules.tremorThreshold || current.bin !== ".")) {
        clearSelection(true);
        setActionMessage(null);
        return;
      }
      const request = selectionRequest.current + 1;
      selectionRequest.current = request;
      selectionAbort.current?.abort();
      const controller = new AbortController();
      selectionAbort.current = controller;
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
        const group = await collectGroup(store, rules, cell, controller.signal);
        if (selectionRequest.current !== request) return;
        if (group.size === 0) {
          setSelection(null);
          setSelectionAnchor(null);
          return;
        }
        setSelection(group);
        if (!group.noise && canRefine && floor.status === "open") {
          setClaimPending(true);
          claimRequest.current = floor.claim(cell.r, cell.c);
        }
      } catch (error) {
        if (selectionRequest.current !== request || isAbortError(error)) return;
        setSelection(null);
        setSelectionAnchor(null);
        setSelectError(error instanceof UnknownStrategyError ? error.message : messageFor(error));
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
    // Solo al (re)conectar el piso.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floor.status]);

  useEffect(() => {
    return () => {
      selectionAbort.current?.abort();
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
      // Bloqueo con ref: un doble clic o un doble Enter no envían nada.
      if (busyRef.current) return;
      if (!selection || selection.noise || !file || !store || strategyError) return;
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
      // Una key por intención del usuario (esta pulsación), creada una sola vez.
      const intent: Intent = {
        key: crypto.randomUUID(),
        bin,
        cells: selection.cells.map(({ r, c }) => ({ r, c })),
      };
      try {
        const { result, replayed } = await submitIntent(file.id, intent);
        store.setBin(intent.cells, result.bin);
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
        setActionMessage(
          `Grupo de ${result.size} celdas llevado a ${BIN_NAME[result.bin]}${replayed ? " (ya estaba registrado)" : ""}.`,
        );
        clearSelection(true);
      } catch (error) {
        if (isApiError(error) && error.status === 409 && error.code === "GROUP_CLAIMED") {
          const holder = detail<{ displayName?: string }>(error, "holder");
          setActionError(
            `Otro refinador${holder?.displayName ? ` (${holder.displayName})` : ""} tiene reservado este grupo. Espera a que lo libere.`,
          );
        } else if (isApiError(error) && error.status === 409) {
          // ALREADY_REFINED: vuelve a pedir los bloques afectados y limpia la selección.
          const tiles = detail<Array<[number, number]>>(error, "tiles");
          if (tiles && tiles.length > 0) await store.refreshTiles(tiles);
          else await store.refreshTilesFor(intent.cells);
          clearSelection(false);
          setActionError("Alguna celda ya estaba refinada. Actualizamos los bloques afectados; elige el grupo de nuevo.");
        } else if (isApiError(error) && error.status === 422 && error.code === "WRONG_BIN") {
          const mistakes = detail<number>(error, "mistakes");
          if (mistakes !== null) setFile((previous) => (previous ? { ...previous, mistakes } : previous));
          setActionError(
            `Esa no es la caja correcta (${BIN_NAME[bin]}). Lumon anotó el error${mistakes !== null ? `: ${mistakes} en este archivo` : ""}. Revisa la caja sugerida y prueba otra.`,
          );
        } else if (isApiError(error) && error.status === 422 && error.code === "GROUP_INVALID") {
          const reason = detail<string>(error, "reason");
          const missing = detail<number>(error, "missing");
          setActionError(
            reason === "INCOMPLETE"
              ? `Al grupo le faltan ${missing ?? "algunas"} celdas conectadas. Vuelve a seleccionarlo.`
              : (reason && GROUP_INVALID_TEXT[reason]) || "El servidor no aceptó este grupo.",
          );
          if (reason === "INCOMPLETE" || reason === "BELOW_THRESHOLD") clearSelection(false);
        } else {
          setActionError(messageFor(error));
        }
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [selection, file, store, canRefine, selectedClaim, clearSelection, strategyError],
  );

  // Teclas 1 a 4 llevan el grupo seleccionado a cada caja; Escape cancela la selección.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape" && selection && !drag) {
        clearSelection(true);
        return;
      }
      const index = ["1", "2", "3", "4"].indexOf(event.key);
      const bin = index >= 0 ? BINS[index] : undefined;
      if (bin && selection && !selection.noise) {
        event.preventDefault();
        void refine(bin);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, drag, refine, clearSelection]);

  useRealtimeEvent("refinement.created", (event) => {
    const data = event.data as RefinementCreatedEvent | null;
    if (!data || data.fileId !== fileId) return;
    store?.setBin(data.cells, data.bin);
    setFile((previous) => (previous ? { ...previous, progress: data.progress } : previous));
    setSelection((current) => {
      if (!current) return current;
      const affected = current.cells.some((cell) => data.cells.some((other) => other.r === cell.r && other.c === cell.c));
      return affected ? null : current;
    });
  });

  useRealtimeEvent("file.completed", (event) => {
    const data = event.data as { fileId?: number } | null;
    if (data?.fileId !== fileId) return;
    setFile((previous) => (previous ? { ...previous, status: "COMPLETE", progress: { ...previous.progress, overall: 1 } } : previous));
  });

  useRealtimeEvent("stream.reset", () => setReloadKey((value) => value + 1));

  // ?r=&c= se actualiza con replace y debounce: no llena el historial.
  const positionTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(positionTimer.current), []);
  const onPositionChange = useCallback((cell: CellRef) => {
    window.clearTimeout(positionTimer.current);
    positionTimer.current = window.setTimeout(() => {
      setParamsRef.current(
        (current) => {
          if (current.get("r") === String(cell.r) && current.get("c") === String(cell.c)) return current;
          const next = new URLSearchParams(current);
          next.set("r", String(cell.r));
          next.set("c", String(cell.c));
          return next;
        },
        { replace: true },
      );
    }, 250);
  }, []);

  const onFocusChange = useCallback(
    (cell: CellRef) => {
      setFocus(cell);
      floor.sendCursor(cell.r, cell.c);
    },
    [floor],
  );

  // Arrastre con Pointer Events: captura, fantasma, hit test con getBoundingClientRect y Escape para cancelar.
  const onDragStart = useCallback(
    (_cell: CellRef, event: React.PointerEvent<HTMLDivElement>) => {
      if (!selection || selection.noise || !canRefine || busyRef.current || strategyError) return;
      event.preventDefault();
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      try {
        target.setPointerCapture(pointerId);
      } catch {
        /* el puntero ya no está activo */
      }
      const hit = (x: number, y: number): Bin | null => {
        for (const bin of BINS) {
          const element = binRefs.current[bin];
          if (!element) continue;
          const rect = element.getBoundingClientRect();
          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return bin;
        }
        return null;
      };
      const finish = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", key, true);
        try {
          target.releasePointerCapture(pointerId);
        } catch {
          /* ya liberado */
        }
        setDrag(null);
        window.setTimeout(() => {
          suppressClick.current = false;
        }, 0);
      };
      const move = (moveEvent: PointerEvent): void => {
        setDrag({ x: moveEvent.clientX, y: moveEvent.clientY, over: hit(moveEvent.clientX, moveEvent.clientY) });
      };
      const up = (upEvent: PointerEvent): void => {
        const bin = hit(upEvent.clientX, upEvent.clientY);
        finish();
        if (bin) void refine(bin);
      };
      const cancel = (): void => finish();
      const key = (keyEvent: KeyboardEvent): void => {
        if (keyEvent.key === "Escape") {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          finish();
        }
      };
      suppressClick.current = true;
      setDrag({ x: event.clientX, y: event.clientY, over: null });
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", key, true);
    },
    [selection, canRefine, refine, strategyError],
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
          Todos los grupos encontraron su caja. {file.mistakes} {file.mistakes === 1 ? "error" : "errores"} de refinamiento. El trabajo es
          misterioso e importante.
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
          : cleared
            ? "Piso sin conexión"
            : "Piso cerrado (sin clearance)";

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/files" className="text-xs text-lumon-mint/60 underline">
            ← Archivos
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-lumon-mint">{file.name}</h1>
          <p className="font-mono text-xs text-lumon-mint/50">
            {file.rows} × {file.cols} · bloques de {file.tileSize} · {file.refinedGroups}/{file.totalGroups} grupos · {file.mistakes}{" "}
            errores
          </p>
          <p className="font-mono text-[11px] text-lumon-mint/40">
            Reglas: temblor ≥ {rules.tremorThreshold} · conectividad {rules.connectivity} · grupo de {rules.minGroupSize} a{" "}
            {rules.maxGroupSize} celdas · {rules.binning.strategy}
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

      {strategyError ? <ErrorNotice message={strategyError} /> : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" role="group" aria-label="Cajas">
        {BINS.map((bin, index) => (
          <div
            key={bin}
            ref={(element) => {
              binRefs.current[bin] = element;
            }}
            data-bin={bin}
            className={`rounded border p-3 ${
              drag?.over === bin
                ? "border-lumon-amber bg-lumon-amber/15"
                : selection?.bin === bin && !selection.noise
                  ? "border-lumon-mint bg-lumon-mint/10"
                  : "border-lumon-line bg-lumon-panel"
            }`}
          >
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-lumon-mint">{BIN_NAME[bin]}</span>
              <span className="font-mono text-lumon-mint/50">
                {bin} · tecla {index + 1}
              </span>
            </div>
            <div
              className="mt-2 h-1.5 overflow-hidden rounded bg-lumon-line"
              role="progressbar"
              aria-label={`Progreso de ${BIN_NAME[bin]}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(file.progress[bin] * 100)}
            >
              <div className="h-full bg-lumon-mint" style={{ width: percent(file.progress[bin]) }} />
            </div>
            <p className="mt-1 font-mono text-[11px] text-lumon-mint/50">{percent(file.progress[bin])}</p>
            <button
              type="button"
              onClick={() => void refine(bin)}
              disabled={!selection || selection.noise || busy || !canRefine || Boolean(selectedClaim) || claimPending || Boolean(strategyError)}
              className="mt-2 w-full rounded border border-lumon-mint/30 px-2 py-1 text-xs text-lumon-mint disabled:opacity-40"
              aria-keyshortcuts={String(index + 1)}
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
                  Ruido · {selection.size}
                  {selection.truncated ? "+" : ""} celdas. {selection.reason}
                </span>
              ) : (
                <span className="text-lumon-mint">
                  Grupo de {selection.size} celdas · caja correcta: <strong>{selection.bin ? BIN_NAME[selection.bin] : "—"}</strong>
                  {claimPending ? " · reservando…" : ""}
                  {selectedClaim ? ` · reservado por ${selectedClaim.displayName}` : ""}
                </span>
              )
            ) : (
              <span className="text-lumon-mint/60">Elige una celda que tiemble para seleccionar su grupo completo.</span>
            )}
          </div>
          {selection ? (
            <button
              type="button"
              onClick={() => clearSelection(true)}
              className="rounded border border-lumon-line px-3 py-1 text-xs text-lumon-mint/80"
            >
              Cancelar selección (Esc)
            </button>
          ) : null}
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
          <p className="mt-2">Flechas mueven el foco; PageUp/PageDown saltan una página; Home/End van al borde de la fila; Ctrl+Home/End al inicio y al final.</p>
          <p className="mt-1">Enter o clic selecciona el grupo. Las teclas 1 a 4 lo llevan a Woe, Frolic, Dread o Malice. Esc cancela.</p>
          <p className="mt-1">También puedes arrastrar el grupo seleccionado hasta una caja.</p>
        </div>
      </div>

      {drag ? (
        <div
          className="pointer-events-none fixed z-50 rounded-full bg-lumon-amber px-3 py-1 text-xs font-semibold text-lumon-ink"
          style={{ left: drag.x + 12, top: drag.y + 12 }}
          aria-hidden="true"
        >
          {selection?.size ?? 0} celdas{drag.over ? ` → ${BIN_NAME[drag.over]}` : ""}
        </div>
      ) : null}
    </section>
  );
}
