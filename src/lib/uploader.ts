/* Subida de imágenes: ticket -> storage (XMLHttpRequest con progreso real) -> confirmación.
   Se carga solo en las páginas de fotocheck e incidencias (fuera del bundle inicial). */

import { apiRequest, isApiError } from "./api";
import { env } from "./env";
import type { PreparedImage } from "./imageTools";
import { sha256Hex } from "./imageTools";
import { MediaSchema, MediaTicketSchema } from "./schemasCp4";
import type { Media, MediaPurpose, MediaTicket } from "./types";

export interface UploadProgress {
  loaded: number;
  total: number;
}

export type UploadStage = "ticket" | "uploading" | "confirming";

const VERIFICATION_TEXT: Record<string, string> = {
  HOST_MISMATCH: "la URL no pertenece al storage del ticket",
  PATH_MISMATCH: "la ruta subida no es la que indicaba el ticket",
  NOT_FOUND: "el backend no encontró el archivo en el storage",
  NOT_WEBP: "el archivo no es un WebP válido",
  DIMENSIONS: "las dimensiones no coinciden con las declaradas",
  SIZE: "el peso no coincide con el declarado",
  SHA256: "el contenido no coincide con el SHA-256 declarado",
  METADATA_PRESENT: "la imagen todavía trae metadatos (EXIF o XMP)",
};

export class UploadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UploadError";
    this.code = code;
  }
}

function xhrUpload(
  url: string,
  body: XMLHttpRequestBodyInit,
  headers: Record<string, string>,
  onProgress: (progress: UploadProgress) => void,
  signal: AbortSignal,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Subida cancelada", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress({ loaded: event.loaded, total: event.total });
    };
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => reject(new UploadError("STORAGE_NETWORK", "La subida al storage falló por la red."));
    xhr.onabort = () => reject(new DOMException("Subida cancelada", "AbortError"));
    const onAbort = (): void => xhr.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    xhr.onloadend = () => signal.removeEventListener("abort", onAbort);
    xhr.send(body);
  });
}

async function uploadToStorage(
  ticket: MediaTicket,
  blob: Blob,
  onProgress: (progress: UploadProgress) => void,
  signal: AbortSignal,
): Promise<string> {
  if (ticket.provider === "SUPABASE") {
    if (!env.supabaseUrl || !env.supabaseKey) throw new UploadError("CONFIG", "Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY.");
    if (!ticket.bucket || !ticket.objectPath) throw new UploadError("TICKET", "El ticket no trae la ruta de Supabase.");
    const response = await xhrUpload(
      `${env.supabaseUrl}/storage/v1/object/${ticket.bucket}/${ticket.objectPath}`,
      blob,
      {
        Authorization: `Bearer ${env.supabaseKey}`,
        apikey: env.supabaseKey,
        "Content-Type": "image/webp",
        "x-upsert": "false",
      },
      onProgress,
      signal,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new UploadError("STORAGE_REJECTED", `Supabase rechazó la subida (HTTP ${response.status}).`);
    }
    return `${env.supabaseUrl}/storage/v1/object/public/${ticket.bucket}/${ticket.objectPath}`;
  }

  if (!env.cloudinaryCloudName || !env.cloudinaryPreset) {
    throw new UploadError("CONFIG", "Faltan VITE_CLOUDINARY_CLOUD_NAME o VITE_CLOUDINARY_UPLOAD_PRESET.");
  }
  const form = new FormData();
  form.append("file", blob, `${ticket.ticketId}.webp`);
  form.append("upload_preset", env.cloudinaryPreset);
  form.append("public_id", ticket.uploadPublicId ?? ticket.ticketId);
  const response = await xhrUpload(
    `https://api.cloudinary.com/v1_1/${env.cloudinaryCloudName}/image/upload`,
    form,
    {},
    onProgress,
    signal,
  );
  if (response.status < 200 || response.status >= 300) {
    throw new UploadError("STORAGE_REJECTED", `Cloudinary rechazó la subida (HTTP ${response.status}).`);
  }
  let secureUrl: string | undefined;
  try {
    secureUrl = (JSON.parse(response.text) as { secure_url?: string }).secure_url;
  } catch {
    secureUrl = undefined;
  }
  if (!secureUrl) throw new UploadError("STORAGE_REJECTED", "Cloudinary no devolvió la URL de la imagen.");
  // Se confirma la secure_url tal cual, sin transformaciones.
  return secureUrl;
}

function describeConfirmError(error: unknown): UploadError {
  if (isApiError(error)) {
    if (error.status === 422 && error.code === "MEDIA_VERIFICATION_FAILED") {
      const reason = (error.details as { reason?: string } | null)?.reason ?? "";
      return new UploadError("MEDIA_VERIFICATION_FAILED", `El backend rechazó la imagen: ${VERIFICATION_TEXT[reason] ?? reason ?? "verificación fallida"}.`);
    }
    if (error.status === 410) return new UploadError("TICKET_EXPIRED", "El permiso de subida venció. Reintenta para pedir uno nuevo.");
    if (error.status === 424) return new UploadError("STORAGE_NOT_VERIFIED", "El storage todavía no está verificado en el backend (PUT /integrations/storage).");
    if (error.status === 423) return new UploadError("CLEARANCE_REQUIRED", "El Piso de Pruebas todavía no está abierto.");
    return new UploadError(error.code, error.message);
  }
  return error instanceof UploadError ? error : new UploadError("UNKNOWN", error instanceof Error ? error.message : "Error inesperado.");
}

/**
 * Una sesión de subida de UNA imagen. Reintentar:
 * - si ya se subió al storage y solo falló la confirmación, se confirma de nuevo con el mismo ticket (es idempotente);
 * - en cualquier otro caso se pide un ticket nuevo (el storage no permite sobrescribir el mismo public_id).
 */
export class UploadSession {
  private ticket: MediaTicket | null = null;
  private uploadedUrl: string | null = null;
  private sha256: string | null = null;
  readonly purpose: MediaPurpose;
  readonly prepared: PreparedImage;

  constructor(purpose: MediaPurpose, prepared: PreparedImage) {
    this.purpose = purpose;
    this.prepared = prepared;
  }

  private ticketValid(): boolean {
    return this.ticket !== null && Date.parse(this.ticket.expiresAt) - Date.now() > 20000;
  }

  async run(
    onStage: (stage: UploadStage) => void,
    onProgress: (progress: UploadProgress) => void,
    signal: AbortSignal,
  ): Promise<Media> {
    try {
      if (!(this.uploadedUrl && this.ticketValid())) {
        this.uploadedUrl = null;
        this.ticket = null;
        onStage("ticket");
        this.sha256 ??= await sha256Hex(this.prepared.blob);
        const raw = await apiRequest<unknown>("/media/tickets", {
          method: "POST",
          body: {
            purpose: this.purpose,
            contentType: "image/webp",
            bytes: this.prepared.blob.size,
            sha256: this.sha256,
            width: this.prepared.width,
            height: this.prepared.height,
          },
          signal,
        });
        const ticket = MediaTicketSchema.parse(raw);
        if (this.prepared.blob.size > ticket.constraints.maxBytes) {
          throw new UploadError("TOO_LARGE", `La imagen pesa ${Math.round(this.prepared.blob.size / 1024)} KB y el máximo es ${Math.round(ticket.constraints.maxBytes / 1024)} KB.`);
        }
        this.ticket = ticket;
        onStage("uploading");
        this.uploadedUrl = await uploadToStorage(ticket, this.prepared.blob, onProgress, signal);
      }
      if (!this.ticket || !this.uploadedUrl) throw new UploadError("STATE", "Estado de subida inválido.");
      onStage("confirming");
      onProgress({ loaded: this.prepared.blob.size, total: this.prepared.blob.size });
      const raw = await apiRequest<unknown>(`/media/tickets/${this.ticket.ticketId}/confirm`, {
        method: "POST",
        body: { url: this.uploadedUrl },
        signal,
      });
      return MediaSchema.parse(raw);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        // Cancelado: el siguiente intento empieza de cero con un ticket nuevo.
        this.ticket = null;
        this.uploadedUrl = null;
        throw error;
      }
      const described = describeConfirmError(error);
      if (described.code === "TICKET_EXPIRED" || described.code === "MEDIA_VERIFICATION_FAILED") {
        this.ticket = null;
        this.uploadedUrl = null;
      }
      throw described;
    }
  }
}
