import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiRequest, isAbortError, messageFor } from "../lib/api";
import { formatDate, percent, readInt } from "../lib/format";
import { useRealtimeEvent } from "../lib/realtime";
import { FilePageSchema } from "../lib/schemas";
import type { DataFile, FilePage, FileStatus } from "../lib/types";
import { ErrorNotice, Loading } from "../components/Loading";

const SIZES = [10, 25, 50] as const;
const SORTS = ["updatedAt,desc", "progress,desc", "name,asc"] as const;

function isSize(value: number): value is (typeof SIZES)[number] {
  return SIZES.includes(value as (typeof SIZES)[number]);
}

function ProgressBar({ value, label }: { value: number; label: string }): JSX.Element {
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-lumon-mint/60">
        <span>{label}</span>
        <span>{percent(value)}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded bg-lumon-line" role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full bg-lumon-mint" style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
      </div>
    </div>
  );
}

export function FilesPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const page = Math.max(0, readInt(params.get("page"), 0));
  const rawSize = readInt(params.get("size"), 10);
  const size = isSize(rawSize) ? rawSize : 10;
  const statusParam = params.get("status");
  const status: FileStatus | "" = statusParam === "ACTIVE" || statusParam === "COMPLETE" ? statusParam : "";
  const sortParam = params.get("sort") ?? "updatedAt,desc";
  const sort = (SORTS as readonly string[]).includes(sortParam) ? sortParam : "updatedAt,desc";
  const query = (params.get("q") ?? "").slice(0, 60);

  const [search, setSearch] = useState(query);
  const [data, setData] = useState<FilePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const requestSeq = useRef(0);

  useEffect(() => {
    setSearch(query);
  }, [query]);

  // Una URL inválida se normaliza a valores por defecto con replace, sin romper la vista.
  useEffect(() => {
    const expected = new URLSearchParams(params);
    const fix = (key: string, valid: boolean, value: string): void => {
      const raw = params.get(key);
      if (raw === null) return;
      if (!valid || raw !== value) {
        if (valid && value) expected.set(key, value);
        else expected.delete(key);
      }
    };
    fix("page", /^d+$/.test(params.get("page") ?? "0"), String(page));
    fix("size", isSize(Number(params.get("size"))), String(size));
    fix("status", status !== "" || params.get("status") === null, status);
    fix("sort", (SORTS as readonly string[]).includes(params.get("sort") ?? SORTS[0]), sort);
    fix("q", true, query);
    if (expected.toString() !== params.toString()) setParams(expected, { replace: true });
  }, [params, page, size, status, sort, query, setParams]);

  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === query) return;
    const timer = window.setTimeout(() => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (trimmed) next.set("q", trimmed);
          else next.delete("q");
          next.set("page", "0");
          return next;
        },
        { replace: true },
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search, query, setParams]);

  useEffect(() => {
    const controller = new AbortController();
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setLoading(true);
    setError(null);

    const searchParams = new URLSearchParams();
    searchParams.set("page", String(page));
    searchParams.set("size", String(size));
    searchParams.set("sort", sort);
    if (status) searchParams.set("status", status);
    if (query) searchParams.set("q", query);

    apiRequest<unknown>(`/files?${searchParams.toString()}`, { signal: controller.signal })
      .then((raw) => FilePageSchema.parse(raw) as FilePage)
      .then((result) => {
        if (requestSeq.current !== seq) return;
        setData(result);
        if (result.totalPages > 0 && page > result.totalPages - 1) {
          setParams(
            (current) => {
              const next = new URLSearchParams(current);
              next.set("page", String(result.totalPages - 1));
              return next;
            },
            { replace: true },
          );
        }
      })
      .catch((caught: unknown) => {
        if (isAbortError(caught) || requestSeq.current !== seq) return;
        setError(messageFor(caught));
      })
      .finally(() => {
        if (requestSeq.current === seq) setLoading(false);
      });

    return () => controller.abort();
  }, [page, size, sort, status, query, reloadKey, setParams]);

  useRealtimeEvent("refinement.created", () => setReloadKey((value) => value + 1));
  useRealtimeEvent("file.completed", () => setReloadKey((value) => value + 1));

  const update = (key: string, value: string | null): void => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        if (key !== "page") next.set("page", "0");
        return next;
      },
      { replace: true },
    );
  };

  const totalPages = data?.totalPages ?? 0;

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-lumon-mint">Archivos de datos</h1>
          <p className="text-sm text-lumon-mint/60">Selecciona un archivo para refinar sus números.</p>
        </div>
        <div className="text-right font-mono text-xs text-lumon-mint/50">
          {data ? `${data.totalElements} archivos` : "—"}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <label htmlFor="search" className="block text-xs text-lumon-mint/60">
            Buscar
          </label>
          <input
            id="search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Nombre del archivo"
            className="mt-1 w-full rounded border border-lumon-line bg-lumon-panel px-3 py-2 text-sm text-lumon-mint outline-none focus:border-lumon-mint"
          />
        </div>
        <div>
          <label htmlFor="status" className="block text-xs text-lumon-mint/60">
            Estado
          </label>
          <select
            id="status"
            value={status}
            onChange={(event) => update("status", event.target.value || null)}
            className="mt-1 rounded border border-lumon-line bg-lumon-panel px-3 py-2 text-sm text-lumon-mint"
          >
            <option value="">Todos</option>
            <option value="ACTIVE">Activos</option>
            <option value="COMPLETE">Completos</option>
          </select>
        </div>
        <div>
          <label htmlFor="sort" className="block text-xs text-lumon-mint/60">
            Orden
          </label>
          <select
            id="sort"
            value={sort}
            onChange={(event) => update("sort", event.target.value)}
            className="mt-1 rounded border border-lumon-line bg-lumon-panel px-3 py-2 text-sm text-lumon-mint"
          >
            <option value="updatedAt,desc">Actualización</option>
            <option value="progress,desc">Progreso</option>
            <option value="name,asc">Nombre</option>
          </select>
        </div>
        <div>
          <label htmlFor="size" className="block text-xs text-lumon-mint/60">
            Por página
          </label>
          <select
            id="size"
            value={size}
            onChange={(event) => update("size", event.target.value)}
            className="mt-1 rounded border border-lumon-line bg-lumon-panel px-3 py-2 text-sm text-lumon-mint"
          >
            {SIZES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? (
        <div className="mt-5">
          <ErrorNotice message={error} onRetry={() => setReloadKey((value) => value + 1)} />
        </div>
      ) : null}

      <div className="mt-5 overflow-x-auto rounded border border-lumon-line">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <caption className="sr-only">Listado paginado de archivos de datos</caption>
          <thead className="bg-lumon-panel text-xs uppercase tracking-wider text-lumon-mint/50">
            <tr>
              <th scope="col" className="px-4 py-3">Archivo</th>
              <th scope="col" className="px-4 py-3">Dimensiones</th>
              <th scope="col" className="px-4 py-3">Progreso</th>
              <th scope="col" className="px-4 py-3">Grupos</th>
              <th scope="col" className="px-4 py-3">Errores</th>
              <th scope="col" className="px-4 py-3">Actualizado</th>
              <th scope="col" className="px-4 py-3"><span className="sr-only">Abrir</span></th>
            </tr>
          </thead>
          <tbody>
            {loading && !data ? (
              <tr>
                <td colSpan={7}>
                  <Loading label="Cargando archivos…" />
                </td>
              </tr>
            ) : null}
            {!loading && data?.content.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-lumon-mint/60">
                  No hay archivos que coincidan con el filtro.
                </td>
              </tr>
            ) : null}
            {data?.content.map((file: DataFile) => (
              <tr key={file.id} className="border-t border-lumon-line/70">
                <td className="px-4 py-3">
                  <p className="font-medium text-lumon-mint">{file.name}</p>
                  <p className="font-mono text-[11px] text-lumon-mint/40">
                    #{file.id} · {file.status === "COMPLETE" ? "Completo" : "Activo"}
                  </p>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-lumon-mint/70">
                  {file.rows} × {file.cols}
                </td>
                <td className="w-48 px-4 py-3">
                  <ProgressBar value={file.progress.overall} label="Total" />
                </td>
                <td className="px-4 py-3 font-mono text-xs text-lumon-mint/70">
                  {file.refinedGroups}/{file.totalGroups}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-lumon-mint/70">{file.mistakes}</td>
                <td className="px-4 py-3 text-xs text-lumon-mint/60">{formatDate(file.updatedAt)}</td>
                <td className="px-4 py-3 text-right">
                  <Link
                    to={`/files/${file.id}/refine`}
                    className="rounded border border-lumon-mint/30 px-3 py-1.5 text-xs text-lumon-mint hover:bg-lumon-mint/10"
                  >
                    Refinar
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <nav aria-label="Paginación" className="mt-4 flex items-center justify-between text-sm">
        <button
          type="button"
          onClick={() => update("page", String(Math.max(0, page - 1)))}
          disabled={page <= 0 || loading}
          className="rounded border border-lumon-line px-3 py-1.5 text-lumon-mint/80 disabled:opacity-40"
        >
          Anterior
        </button>
        <span className="font-mono text-xs text-lumon-mint/60">
          Página {totalPages === 0 ? 0 : page + 1} de {totalPages}
        </span>
        <button
          type="button"
          onClick={() => update("page", String(page + 1))}
          disabled={loading || page + 1 >= totalPages}
          className="rounded border border-lumon-line px-3 py-1.5 text-lumon-mint/80 disabled:opacity-40"
        >
          Siguiente
        </button>
      </nav>
    </section>
  );
}
