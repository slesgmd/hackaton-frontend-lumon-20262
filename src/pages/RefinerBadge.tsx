import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { ErrorNotice, Loading } from "../components/Loading";
import { ImageCropper } from "../components/ImageCropper";
import { ImageDropZone, UploadList } from "../components/UploadParts";
import { apiRequestWithMeta, isAbortError, isApiError, messageFor } from "../lib/api";
import { useAuth } from "../lib/auth";
import { safeExternalUrl } from "../lib/format";
import { loadImage, renderBadge, type CropRect } from "../lib/imageTools";
import { reconcile } from "../lib/refinerStore";
import { RefinerSchema } from "../lib/schemasCp4";
import { useUploads } from "../lib/useUploads";
import type { Refiner } from "../lib/types";

function Badge({ refiner, size }: { refiner: Refiner; size: number }): JSX.Element {
  const url = safeExternalUrl(refiner.badge?.url);
  return url ? (
    <img
      src={url}
      alt={`Fotocheck de ${refiner.fullName}`}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className="rounded border border-lumon-line object-cover"
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      className="flex items-center justify-center rounded border border-lumon-line bg-lumon-panel font-mono text-xs text-lumon-mint/40"
      style={{ width: size, height: size }}
    >
      SIN FOTOCHECK
    </span>
  );
}

export function RefinerBadgePage(): JSX.Element {
  const { id } = useParams();
  const refinerId = Number(id);
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("refiners:write");

  const [refiner, setRefiner] = useState<Refiner | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageName, setImageName] = useState("");
  const cropRef = useRef<CropRect | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const uploads = useUploads("BADGE", 1);
  const item = uploads.items[0] ?? null;

  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const appliedMedia = useRef<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ current: Refiner; etag: string; mediaId: number } | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!Number.isInteger(refinerId) || refinerId <= 0) {
      setError("El expediente no existe.");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    apiRequestWithMeta<unknown>(`/refiners/${refinerId}`, { signal: controller.signal })
      .then((result) => {
        const parsed = reconcile(RefinerSchema.parse(result.data));
        setRefiner(parsed);
        setEtag(result.etag ?? `"${parsed.version}"`);
      })
      .catch((caught: unknown) => {
        if (!isAbortError(caught)) setError(messageFor(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refinerId, reloadKey]);

  const chooseFile = useCallback(async (files: File[]): Promise<void> => {
    const file = files[0];
    if (!file) return;
    setLocalError(null);
    try {
      const loaded = await loadImage(file);
      setImageName(file.name);
      setImage(loaded);
    } catch (caught) {
      setLocalError(messageFor(caught));
    }
  }, []);

  const startUpload = async (): Promise<void> => {
    if (!image || !cropRef.current || preparing) return;
    setPreparing(true);
    setLocalError(null);
    setSaved(false);
    try {
      const prepared = await renderBadge(image, cropRef.current);
      uploads.reset();
      appliedMedia.current = null;
      uploads.addPrepared(prepared, imageName || "fotocheck", URL.createObjectURL(prepared.blob));
    } catch (caught) {
      setLocalError(messageFor(caught));
    } finally {
      setPreparing(false);
    }
  };

  /** PATCH del expediente con el If-Match real (el ETag leído), nunca "*". */
  const applyBadge = useCallback(
    async (mediaId: number, match: string): Promise<void> => {
      if (savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      setSaveError(null);
      try {
        const result = await apiRequestWithMeta<unknown>(`/refiners/${refinerId}`, {
          method: "PATCH",
          headers: { "If-Match": match },
          body: { badgeMediaId: mediaId },
          retries: 0,
        });
        const updated = reconcile(RefinerSchema.parse(result.data));
        setRefiner(updated);
        setEtag(result.etag ?? `"${updated.version}"`);
        setConflict(null);
        setSaved(true);
      } catch (caught) {
        if (isApiError(caught) && caught.status === 412) {
          const parsed = RefinerSchema.safeParse((caught.details as { current?: unknown } | null)?.current);
          if (parsed.success) {
            const current = reconcile(parsed.data);
            setConflict({ current, etag: caught.etag ?? `"${current.version}"`, mediaId });
            return;
          }
        }
        if (isApiError(caught) && caught.status === 422 && caught.code === "MEDIA_NOT_USABLE") {
          setSaveError("Esa imagen ya no se puede usar (ya se aplicó o no es un fotocheck). Sube otra.");
          return;
        }
        setSaveError(messageFor(caught));
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [refinerId],
  );

  // Al confirmarse la imagen, se guarda en el expediente automáticamente (una sola vez por mediaId).
  useEffect(() => {
    if (!item || item.status !== "done" || item.mediaId === null || !etag || !canWrite) return;
    if (appliedMedia.current === item.mediaId) return;
    appliedMedia.current = item.mediaId;
    void applyBadge(item.mediaId, etag);
  }, [item, etag, canWrite, applyBadge]);

  if (loading && !refiner) return <Loading label="Cargando expediente…" />;
  if (error && !refiner) {
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

  const uploading = Boolean(item && item.status !== "done" && item.status !== "error" && item.status !== "canceled");

  return (
    <section className="mx-auto max-w-3xl space-y-5">
      <div>
        <Link to={`/refiners/${refinerId}`} className="text-xs text-lumon-mint/60 underline">
          ← Expediente
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-lumon-mint">Fotocheck de {refiner.fullName}</h1>
        <p className="font-mono text-xs text-lumon-mint/40">
          Versión {refiner.version} · ETag {etag ?? "—"} · 512 × 512 · WebP · máx. 120 KB
        </p>
      </div>

      {!canWrite ? (
        <p role="alert" className="rounded border border-lumon-amber/50 bg-lumon-amber/10 p-3 text-sm text-lumon-amber">
          Tu rol puede subir imágenes pero no modificar expedientes (falta refiners:write): el fotocheck no se podrá aplicar.
        </p>
      ) : null}

      <div className="flex flex-wrap items-start gap-6">
        <div>
          <p className="mb-1 text-xs text-lumon-mint/50">Actual</p>
          <Badge refiner={refiner} size={160} />
        </div>
        <div className="min-w-[260px] flex-1 space-y-4">
          <ImageDropZone onFiles={(files) => void chooseFile(files)} multiple={false} label="Elige la foto del fotocheck" disabled={uploading || saving} />
          {localError ? <ErrorNotice message={localError} /> : null}
          {image ? (
            <>
              <ImageCropper image={image} onChange={(crop) => (cropRef.current = crop)} />
              <button
                type="button"
                onClick={() => void startUpload()}
                disabled={preparing || uploading || saving}
                className="rounded bg-lumon-mint px-4 py-2 text-sm font-semibold text-lumon-ink disabled:opacity-50"
              >
                {preparing ? "Preparando…" : "Subir fotocheck"}
              </button>
            </>
          ) : null}
          <UploadList items={uploads.items} onCancel={uploads.cancel} onRetry={uploads.retry} onRemove={uploads.remove} />
          {saving ? <p role="status" className="text-sm text-lumon-mint/70">Guardando en el expediente…</p> : null}
          {saved && !conflict ? (
            <p role="status" className="rounded border border-lumon-mint/40 bg-lumon-mint/10 p-3 text-sm text-lumon-mint">
              Fotocheck actualizado. Ya se ve arriba, sin recargar.
            </p>
          ) : null}
          {saveError ? <ErrorNotice message={saveError} onRetry={item?.mediaId ? () => void applyBadge(item.mediaId as number, etag ?? "") : undefined} /> : null}
        </div>
      </div>

      {conflict ? (
        <div role="alert" className="rounded border border-lumon-danger/50 bg-lumon-danger/10 p-4">
          <h2 className="text-sm font-semibold text-lumon-danger">El expediente cambió mientras subías la imagen</h2>
          <p className="mt-1 text-sm text-lumon-mint/80">
            Ahora está en la versión {conflict.current.version}. Para no pisar el trabajo de otra persona, confirma si quieres reemplazar su fotocheck.
          </p>
          <div className="mt-3 flex flex-wrap items-start gap-6">
            <div>
              <p className="mb-1 text-xs text-lumon-mint/50">En el servidor</p>
              <Badge refiner={conflict.current} size={96} />
            </div>
            {item?.previewUrl ? (
              <div>
                <p className="mb-1 text-xs text-lumon-mint/50">El tuyo</p>
                <img src={item.previewUrl} alt="Tu fotocheck nuevo" width={96} height={96} className="h-24 w-24 rounded border border-lumon-line object-cover" />
              </div>
            ) : null}
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setRefiner(conflict.current);
                setEtag(conflict.etag);
                void applyBadge(conflict.mediaId, conflict.etag);
              }}
              disabled={saving}
              className="rounded bg-lumon-danger px-3 py-1.5 text-sm font-semibold text-lumon-ink disabled:opacity-50"
            >
              Reemplazar con el mío
            </button>
            <button
              type="button"
              onClick={() => {
                setRefiner(conflict.current);
                setEtag(conflict.etag);
                setConflict(null);
              }}
              className="rounded border border-lumon-line px-3 py-1.5 text-sm text-lumon-mint"
            >
              Conservar el del servidor
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
