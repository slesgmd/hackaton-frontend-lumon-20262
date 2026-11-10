import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiRequestWithMeta, isAbortError, messageFor } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDate, safeExternalUrl } from "../lib/format";
import { useRealtimeEvent } from "../lib/realtime";
import { isNewer, reconcile } from "../lib/refinerStore";
import { RefinerSchema, RefinerUpdatedEventSchema } from "../lib/schemasCp4";
import type { Refiner } from "../lib/types";
import { ErrorNotice, Loading } from "../components/Loading";

export function RefinerDetailPage(): JSX.Element {
  const { id } = useParams();
  const refinerId = Number(id);
  const { hasPermission } = useAuth();
  const [refiner, setRefiner] = useState<Refiner | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!Number.isFinite(refinerId) || refinerId <= 0) {
      setError("El expediente no existe.");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    apiRequestWithMeta<unknown>(`/refiners/${refinerId}`, { signal: controller.signal })
      .then((result) => {
        setRefiner(reconcile(RefinerSchema.parse(result.data)));
        setEtag(result.etag);
      })
      .catch((caught: unknown) => {
        if (!isAbortError(caught)) setError(messageFor(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refinerId, reloadKey]);

  // Solo se aplica si la versión del evento es mayor; se vuelve a pedir para conservar el ETag exacto.
  useRealtimeEvent("refiner.updated", (event) => {
    const parsed = RefinerUpdatedEventSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.id !== refinerId) return;
    if (!isNewer(refinerId, parsed.data.version)) return;
    reconcile(parsed.data.refiner);
    setRefiner(parsed.data.refiner);
    setEtag(`"${parsed.data.version}"`);
    setReloadKey((value) => value + 1);
  });
  useRealtimeEvent("stream.reset", () => setReloadKey((value) => value + 1));

  if (loading && !refiner) return <Loading label="Abriendo expediente…" />;
  if (error) {
    return (
      <section>
        <ErrorNotice message={error} onRetry={() => setReloadKey((value) => value + 1)} />
        <Link to="/refiners" className="mt-4 inline-block text-sm text-lumon-mint underline">
          Volver al directorio
        </Link>
      </section>
    );
  }
  if (!refiner) return <Loading />;

  const badgeUrl = safeExternalUrl(refiner.badge?.url);
  const profileUrl = safeExternalUrl(refiner.profileUrl);

  return (
    <section className="mx-auto max-w-3xl space-y-5">
      <div>
        <Link to="/refiners" className="text-xs text-lumon-mint/60 underline">
          ← Expedientes
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-lumon-mint">{refiner.fullName}</h1>
            <p className="text-sm text-lumon-mint/60">{refiner.title}</p>
            <p className="font-mono text-xs text-lumon-mint/40">
              {refiner.department.name} · ext. {refiner.extension} · versión {refiner.version}
            </p>
          </div>
          <div className="flex gap-2">
            {hasPermission("refiners:write") ? (
              <Link
                to={`/refiners/${refiner.id}/edit`}
                className="rounded border border-lumon-mint/30 px-3 py-1.5 text-sm text-lumon-mint"
              >
                Editar
              </Link>
            ) : null}
            {hasPermission("media:upload") ? (
              <Link
                to={`/refiners/${refiner.id}/badge`}
                className="rounded bg-lumon-mint px-3 py-1.5 text-sm font-semibold text-lumon-ink"
              >
                Fotocheck
              </Link>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
        <div className="h-40 w-40 overflow-hidden rounded border border-lumon-line bg-lumon-panel">
          {badgeUrl ? (
            <img
              src={badgeUrl}
              alt={`Fotocheck de ${refiner.fullName}`}
              width={refiner.badge?.width ?? 512}
              height={refiner.badge?.height ?? 512}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="h-40 w-40 object-cover"
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center font-mono text-xs text-lumon-mint/40">
              SIN FOTOCHECK
            </span>
          )}
        </div>
        <dl className="space-y-3 rounded border border-lumon-line bg-lumon-panel p-4 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-lumon-mint/40">Biografía</dt>
            <dd className="mt-1 whitespace-pre-wrap break-words text-lumon-mint/80">{refiner.bio}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-lumon-mint/40">Perfil externo</dt>
            <dd className="mt-1 break-all text-lumon-mint/80">
              {profileUrl ? (
                <a href={profileUrl} target="_blank" rel="noreferrer noopener" className="underline">
                  {profileUrl}
                </a>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-lumon-mint/40">Actualizado</dt>
            <dd className="mt-1 text-lumon-mint/70">{formatDate(refiner.updatedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-lumon-mint/40">ETag</dt>
            <dd className="mt-1 font-mono text-xs text-lumon-mint/50">{etag ?? "—"}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
