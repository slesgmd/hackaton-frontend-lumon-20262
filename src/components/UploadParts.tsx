import { useEffect, useRef, useState, type JSX } from "react";
import { imagesFromClipboard, isImageFile } from "../lib/imageTools";
import { isBusy, type UploadItem } from "../lib/useUploads";

const STATUS_TEXT: Record<UploadItem["status"], string> = {
  preparing: "Preparando imagen…",
  ticket: "Pidiendo permiso de subida…",
  uploading: "Subiendo…",
  confirming: "Verificando en Lumon…",
  done: "Confirmada",
  error: "Error",
  canceled: "Cancelada",
};

/** Entrada de imágenes: selector de archivos, arrastrar y soltar (eventos nativos) y pegar desde el portapapeles. */
export function ImageDropZone({
  onFiles,
  multiple,
  disabled,
  label,
}: {
  onFiles: (files: File[]) => void;
  multiple: boolean;
  disabled?: boolean;
  label: string;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);
  const handlerRef = useRef(onFiles);
  handlerRef.current = onFiles;

  useEffect(() => {
    if (disabled) return;
    const onPaste = (event: ClipboardEvent): void => {
      const files = imagesFromClipboard(event);
      if (files.length > 0) {
        event.preventDefault();
        handlerRef.current(multiple ? files : files.slice(0, 1));
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [disabled, multiple]);

  const accept = (list: FileList | null): void => {
    if (!list) return;
    const files = [...list].filter(isImageFile);
    if (files.length > 0) onFiles(multiple ? files : files.slice(0, 1));
  };

  return (
    <div
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        if (!disabled) accept(event.dataTransfer.files);
      }}
      className={`rounded border-2 border-dashed p-6 text-center text-sm ${
        over ? "border-lumon-mint bg-lumon-mint/10" : "border-lumon-line bg-lumon-panel"
      } ${disabled ? "opacity-50" : ""}`}
    >
      <p className="text-lumon-mint/80">{label}</p>
      <p className="mt-1 text-xs text-lumon-mint/50">Arrastra aquí, pega con Ctrl+V o elige un archivo.</p>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple={multiple}
        disabled={disabled}
        className="sr-only"
        id="image-input"
        onChange={(event) => {
          accept(event.target.files);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="mt-3 rounded bg-lumon-mint px-4 py-2 text-sm font-semibold text-lumon-ink disabled:opacity-50"
      >
        Elegir imagen
      </button>
    </div>
  );
}

/** Lista de subidas: progreso real, cancelar, reintentar y quitar. */
export function UploadList({
  items,
  onCancel,
  onRetry,
  onRemove,
}: {
  items: UploadItem[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-3" aria-label="Fotos del reporte">
      {items.map((item) => {
        const percent = Math.round(item.progress * 100);
        return (
          <li key={item.id} className="flex gap-3 rounded border border-lumon-line bg-lumon-panel p-3">
            <img
              src={item.previewUrl}
              alt=""
              width={64}
              height={64}
              className="h-16 w-16 shrink-0 rounded border border-lumon-line object-cover"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-lumon-mint">{item.name}</p>
              <p
                className={`text-xs ${item.status === "error" ? "text-lumon-danger" : item.status === "done" ? "text-lumon-mint" : "text-lumon-mint/60"}`}
                role={item.status === "error" ? "alert" : "status"}
              >
                {STATUS_TEXT[item.status]}
                {item.status === "uploading" ? ` ${percent}%` : ""}
                {item.error ? `: ${item.error}` : ""}
              </p>
              <div
                className="mt-2 h-1.5 overflow-hidden rounded bg-lumon-line"
                role="progressbar"
                aria-label={`Subida de ${item.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <div className="h-full bg-lumon-mint transition-[width]" style={{ width: `${percent}%` }} />
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {isBusy(item) && item.status !== "preparing" ? (
                  <button type="button" onClick={() => onCancel(item.id)} className="rounded border border-lumon-line px-2 py-1 text-xs text-lumon-mint">
                    Cancelar
                  </button>
                ) : null}
                {(item.status === "error" || item.status === "canceled") && item.retryable ? (
                  <button type="button" onClick={() => onRetry(item.id)} className="rounded border border-lumon-mint/40 px-2 py-1 text-xs text-lumon-mint">
                    Reintentar
                  </button>
                ) : null}
                {item.status !== "preparing" ? (
                  <button type="button" onClick={() => onRemove(item.id)} className="rounded border border-lumon-line px-2 py-1 text-xs text-lumon-mint/70">
                    Quitar
                  </button>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
