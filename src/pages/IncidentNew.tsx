import { useRef, useState, type FormEvent, type JSX } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ErrorNotice } from "../components/Loading";
import { ImageDropZone, UploadList } from "../components/UploadParts";
import { apiRequest, isApiError, messageFor } from "../lib/api";
import { isBusy, useUploads } from "../lib/useUploads";
import type { Severity } from "../lib/types";

const SEVERITIES: Array<{ value: Severity; label: string }> = [
  { value: "LOW", label: "Baja" },
  { value: "MEDIUM", label: "Media" },
  { value: "HIGH", label: "Alta" },
  { value: "CRITICAL", label: "Crítica" },
];

const REASON_TEXT: Record<string, string> = {
  NOT_FOUND: "no se encontró",
  WRONG_PURPOSE: "no es una imagen de incidencia",
  ALREADY_USED: "ya se usó en otro reporte",
};

export function IncidentNewPage(): JSX.Element {
  const navigate = useNavigate();
  const uploads = useUploads("INCIDENT", 3);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<Severity>("MEDIUM");
  const [fileId, setFileId] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  const done = uploads.items.filter((item) => item.status === "done" && item.mediaId !== null);
  const allConfirmed = uploads.items.length > 0 && uploads.items.every((item) => item.status === "done");
  const anyBusy = uploads.items.some(isBusy);
  const canSubmit = allConfirmed && !sending && title.trim().length >= 3 && description.trim().length >= 1;

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSubmit || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    setFields({});
    try {
      const parsedFile = fileId.trim() === "" ? null : Number(fileId);
      if (parsedFile !== null && (!Number.isInteger(parsedFile) || parsedFile < 1)) {
        setFields({ fileId: "Debe ser un número de archivo válido." });
        return;
      }
      await apiRequest<unknown>("/incidents", {
        method: "POST",
        body: {
          title: title.trim(),
          description: description.trim(),
          severity,
          ...(parsedFile !== null ? { fileId: parsedFile } : {}),
          mediaIds: done.map((item) => item.mediaId),
        },
        retries: 0,
      });
      navigate("/incidents", { replace: true });
    } catch (caught) {
      // Un error al enviar no borra el formulario ni las fotos ya confirmadas.
      if (isApiError(caught) && caught.code === "VALIDATION_ERROR") {
        setFields((caught.details as { fields?: Record<string, string> } | null)?.fields ?? {});
        setError("Revisa los campos marcados.");
      } else if (isApiError(caught) && caught.code === "MEDIA_NOT_USABLE") {
        const reasons = (caught.details as { reasons?: Record<string, string> } | null)?.reasons ?? {};
        const lines = Object.entries(reasons).map(([mediaId, reason]) => {
          const item = uploads.items.find((candidate) => String(candidate.mediaId) === mediaId);
          return `${item?.name ?? `Imagen ${mediaId}`}: ${REASON_TEXT[reason] ?? reason}`;
        });
        setError(`Alguna foto no se puede usar. Quítala y sube otra. ${lines.join("; ")}`);
      } else if (isApiError(caught) && caught.status === 503) {
        setError("El servicio está ocupado y no guardó nada. Tus datos y fotos siguen aquí: vuelve a enviar.");
      } else {
        setError(messageFor(caught));
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const input =
    "mt-1 w-full rounded border border-lumon-line bg-lumon-ink px-3 py-2 text-sm text-lumon-mint aria-[invalid=true]:border-lumon-danger";

  return (
    <section className="mx-auto max-w-2xl space-y-5">
      <div>
        <Link to="/incidents" className="text-xs text-lumon-mint/60 underline">
          ← Reportes
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-lumon-mint">Nuevo reporte de incidencia</h1>
        <p className="text-sm text-lumon-mint/60">De 1 a 3 fotos. El reporte se puede enviar cuando todas estén confirmadas.</p>
      </div>

      {error ? <ErrorNotice message={error} /> : null}

      <form onSubmit={(event) => void onSubmit(event)} className="space-y-4" noValidate>
        <div>
          <label htmlFor="title" className="block text-xs text-lumon-mint/60">
            Título (3 a 120 caracteres)
          </label>
          <input
            id="title"
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            aria-invalid={fields.title ? true : undefined}
            aria-describedby={fields.title ? "title-error" : undefined}
            className={input}
          />
          {fields.title ? <p id="title-error" className="mt-1 text-xs text-lumon-danger">{fields.title}</p> : null}
        </div>
        <div>
          <label htmlFor="description" className="block text-xs text-lumon-mint/60">
            Descripción
          </label>
          <textarea
            id="description"
            rows={5}
            maxLength={4000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            aria-invalid={fields.description ? true : undefined}
            aria-describedby={fields.description ? "description-error" : undefined}
            className={input}
          />
          {fields.description ? <p id="description-error" className="mt-1 text-xs text-lumon-danger">{fields.description}</p> : null}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="severity" className="block text-xs text-lumon-mint/60">
              Severidad
            </label>
            <select id="severity" value={severity} onChange={(event) => setSeverity(event.target.value as Severity)} className={input}>
              {SEVERITIES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="fileId" className="block text-xs text-lumon-mint/60">
              Archivo relacionado (opcional)
            </label>
            <input
              id="fileId"
              inputMode="numeric"
              value={fileId}
              onChange={(event) => setFileId(event.target.value)}
              aria-invalid={fields.fileId ? true : undefined}
              aria-describedby={fields.fileId ? "fileId-error" : undefined}
              className={input}
            />
            {fields.fileId ? <p id="fileId-error" className="mt-1 text-xs text-lumon-danger">{fields.fileId}</p> : null}
          </div>
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-lumon-mint">Fotos ({uploads.items.length}/3)</h2>
          <ImageDropZone
            onFiles={(files) => void uploads.add(files)}
            multiple
            disabled={uploads.items.length >= 3}
            label="Agrega las fotos de la incidencia"
          />
          <UploadList items={uploads.items} onCancel={uploads.cancel} onRetry={uploads.retry} onRemove={uploads.remove} />
          {fields.mediaIds ? <p className="text-xs text-lumon-danger">{fields.mediaIds}</p> : null}
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-lumon-mint/60" role="status">
            {uploads.items.length === 0
              ? "Agrega al menos una foto."
              : anyBusy
                ? "Esperando que terminen las subidas…"
                : allConfirmed
                  ? "Todas las fotos están confirmadas."
                  : "Hay fotos con error: reintenta o quítalas."}
          </span>
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded bg-lumon-mint px-4 py-2 text-sm font-semibold text-lumon-ink disabled:opacity-50"
          >
            {sending ? "Enviando…" : "Enviar reporte"}
          </button>
        </div>
      </form>
    </section>
  );
}
