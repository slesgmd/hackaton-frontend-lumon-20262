import { useEffect, useRef, useState, type JSX } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ErrorNotice, Loading } from "../components/Loading";
import { apiRequest, isAbortError, messageFor } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDate, readInt, safeExternalUrl } from "../lib/format";
import { IncidentPageSchema } from "../lib/schemasCp4";
import type { IncidentPage } from "../lib/types";

const SIZES = [10, 25, 50] as const;
const SEVERITY_TEXT = { LOW: "Baja", MEDIUM: "Media", HIGH: "Alta", CRITICAL: "Crítica" } as const;
const SEVERITY_CLASS = {
  LOW: "border-lumon-line text-lumon-mint/70",
  MEDIUM: "border-lumon-mint/50 text-lumon-mint",
  HIGH: "border-lumon-amber/60 text-lumon-amber",
  CRITICAL: "border-lumon-danger/70 text-lumon-danger",
} as const;

function isSize(value: number): value is (typeof SIZES)[number] {
  return SIZES.includes(value as (typeof SIZES)[number]);
}

export function IncidentsPage(): JSX.Element {
  const { hasPermission } = useAuth();
  const [params, setParams] = useSearchParams();
  const page = Math.max(0, readInt(params.get("page"), 0));
  const rawSize = readInt(params.get("size"), 10);
  const size = isSize(rawSize) ? rawSize : 10;
  const [data, setData] = useState<IncidentPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const request = seq.current + 1;
    seq.current = request;
    setLoading(true);
    setError(null);
    apiRequest<unknown>(`/incidents?page=${page}&size=${size}`, { signal: controller.signal })
      .then((raw) => IncidentPageSchema.parse(raw) as IncidentPage)
      .then((result) => {
        if (seq.current !== request) return;
        setData(result);
        if (result.totalPages > 0 && page > result.totalPages - 1) {
          setParams({ page: String(result.totalPages - 1), size: String(size) }, { replace: true });
        }
      })
      .catch((caught: unknown) => {
        if (isAbortError(caught) || seq.current !== request) return;
        setError(messageFor(caught));
      })
      .finally(() => {
        if (seq.current === request) setLoading(false);
      });
    return () => controller.abort();
  }, [page, size, reloadKey, setParams]);

  const go = (next: number): void => setParams({ page: String(Math.max(0, next)), size: String(size) }, { replace: true });

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-lumon-mint">Reportes de incidencia</h1>
          <p className="text-sm text-lumon-mint/60">Del más nuevo al más viejo, con sus fotos.</p>
        </div>
        <div className="flex items-center gap-3">
          <p className="font-mono text-xs text-lumon-mint/50">{data ? `${data.totalElements} reportes` : "—"}</p>
          {hasPermission("incidents:create") ? (
            <Link to="/incidents/new" className="rounded bg-lumon-mint px-3 py-1.5 text-sm font-semibold text-lumon-ink">
              Nuevo reporte
            </Link>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="mt-5">
          <ErrorNotice message={error} onRetry={() => setReloadKey((value) => value + 1)} />
        </div>
      ) : null}
      {loading && !data ? <Loading label="Cargando reportes…" /> : null}

      <ul className="mt-5 space-y-4">
        {data?.content.map((incident) => (
          <li key={incident.id} className="rounded border border-lumon-line bg-lumon-panel p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h2 className="break-words font-medium text-lumon-mint">{incident.title}</h2>
              <span className={`rounded border px-2 py-0.5 text-xs ${SEVERITY_CLASS[incident.severity]}`}>
                {SEVERITY_TEXT[incident.severity]}
              </span>
            </div>
            <p className="mt-1 font-mono text-[11px] text-lumon-mint/40">
              {incident.createdBy.displayName} · {formatDate(incident.createdAt)}
              {incident.file ? (
                <>
                  {" · "}
                  <Link to={`/files/${incident.file.id}/refine`} className="underline">
                    {incident.file.name}
                  </Link>
                </>
              ) : null}
            </p>
            {/* El texto viene del exterior: se muestra como texto, nunca como HTML. */}
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-lumon-mint/80">{incident.description}</p>
            {incident.photos.length > 0 ? (
              <ul className="mt-3 flex flex-wrap gap-2" aria-label="Fotos del reporte">
                {incident.photos.map((photo) => {
                  const url = safeExternalUrl(photo.url);
                  return (
                    <li key={photo.mediaId}>
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer noopener">
                          <img
                            src={url}
                            alt={`Foto del reporte “${incident.title}”`}
                            width={160}
                            height={120}
                            loading="lazy"
                            decoding="async"
                            referrerPolicy="no-referrer"
                            className="h-[120px] w-[160px] rounded border border-lumon-line object-cover"
                          />
                        </a>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>

      {!loading && data?.content.length === 0 ? <p className="mt-6 text-center text-sm text-lumon-mint/60">Todavía no hay reportes.</p> : null}

      <nav aria-label="Paginación de reportes" className="mt-4 flex items-center justify-between text-sm">
        <button type="button" onClick={() => go(page - 1)} disabled={page <= 0 || loading} className="rounded border border-lumon-line px-3 py-1.5 text-lumon-mint/80 disabled:opacity-40">
          Anterior
        </button>
        <span className="font-mono text-xs text-lumon-mint/60">
          Página {data?.totalPages === 0 ? 0 : page + 1} de {data?.totalPages ?? 0}
        </span>
        <button
          type="button"
          onClick={() => go(page + 1)}
          disabled={loading || page + 1 >= (data?.totalPages ?? 0)}
          className="rounded border border-lumon-line px-3 py-1.5 text-lumon-mint/80 disabled:opacity-40"
        >
          Siguiente
        </button>
      </nav>
    </section>
  );
}
