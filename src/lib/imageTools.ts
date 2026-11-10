/* Procesamiento de imágenes en el navegador, sin librerías: recorte, WebP, límite de peso y SHA-256.
   Re-codificar con canvas elimina los metadatos (EXIF, XMP, ubicación). */

export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
}

export interface CropRect {
  /** Esquina superior izquierda y lado del cuadrado, en píxeles de la imagen original. */
  x: number;
  y: number;
  side: number;
}

export const BADGE_SIZE = 512;
export const BADGE_MAX_BYTES = 120 * 1024;
export const INCIDENT_MIN_SIDE = 800;
export const INCIDENT_MAX_SIDE = 1600;
export const INCIDENT_MAX_BYTES = 300 * 1024;

export function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("No se pudo leer la imagen. Elige un archivo JPG, PNG, WebP o similar."));
    };
    image.src = url;
  });
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("El navegador no pudo generar la imagen."));
          return;
        }
        // Si el navegador no soporta WebP, devuelve PNG: se avisa con un error claro.
        if (blob.type !== "image/webp") {
          reject(
            new Error(
              `Tu navegador no puede generar imágenes WebP (devolvió ${blob.type || "otro formato"}). Usa una versión reciente de Chrome, Edge o Firefox.`,
            ),
          );
          return;
        }
        resolve(blob);
      },
      "image/webp",
      quality,
    );
  });
}

/** Baja la calidad en un bucle hasta que el WebP pese menos que `maxBytes`. */
async function encodeUnderLimit(canvas: HTMLCanvasElement, maxBytes: number): Promise<Blob> {
  let quality = 0.92;
  let blob = await toBlob(canvas, quality);
  while (blob.size > maxBytes && quality > 0.2) {
    quality = Math.max(0.2, quality - 0.08);
    blob = await toBlob(canvas, quality);
  }
  if (blob.size > maxBytes) throw new Error(`La imagen sigue pesando ${Math.round(blob.size / 1024)} KB incluso con la calidad mínima.`);
  return blob;
}

function makeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No se pudo preparar el lienzo de dibujo.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  return { canvas, context };
}

/** Fotocheck: exactamente 512 × 512, WebP, 120 KB como máximo. */
export async function renderBadge(image: HTMLImageElement, crop: CropRect): Promise<PreparedImage> {
  const { canvas, context } = makeCanvas(BADGE_SIZE, BADGE_SIZE);
  context.drawImage(image, crop.x, crop.y, crop.side, crop.side, 0, 0, BADGE_SIZE, BADGE_SIZE);
  const blob = await encodeUnderLimit(canvas, BADGE_MAX_BYTES);
  return { blob, width: BADGE_SIZE, height: BADGE_SIZE };
}

/** Incidencia: lado mayor entre 800 y 1600, WebP, 300 KB como máximo. */
export async function renderIncident(image: HTMLImageElement): Promise<PreparedImage> {
  const naturalW = image.naturalWidth;
  const naturalH = image.naturalHeight;
  const long = Math.max(naturalW, naturalH);
  let target = Math.min(INCIDENT_MAX_SIDE, Math.max(INCIDENT_MIN_SIDE, long));
  for (;;) {
    const scale = target / long;
    const width = Math.max(1, Math.round(naturalW * scale));
    const height = Math.max(1, Math.round(naturalH * scale));
    const { canvas, context } = makeCanvas(width, height);
    context.drawImage(image, 0, 0, width, height);
    try {
      const blob = await encodeUnderLimit(canvas, INCIDENT_MAX_BYTES);
      return { blob, width, height };
    } catch (error) {
      // Si ni con la calidad mínima cabe, se reduce el lado mayor (sin bajar de 800).
      if (target <= INCIDENT_MIN_SIDE) throw error;
      target = Math.max(INCIDENT_MIN_SIDE, Math.round(target * 0.85));
    }
  }
}

/** Recorte inicial: cuadrado centrado que cubre el lado menor. */
export function initialCrop(image: HTMLImageElement): CropRect {
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  return { x: (image.naturalWidth - side) / 2, y: (image.naturalHeight - side) / 2, side };
}

export function clampCrop(crop: CropRect, naturalW: number, naturalH: number): CropRect {
  const maxSide = Math.min(naturalW, naturalH);
  const side = Math.min(maxSide, Math.max(16, crop.side));
  return {
    side,
    x: Math.min(naturalW - side, Math.max(0, crop.x)),
    y: Math.min(naturalH - side, Math.max(0, crop.y)),
  };
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/** Archivos desde un evento de pegado (portapapeles). */
export function imagesFromClipboard(event: ClipboardEvent): File[] {
  const files: File[] = [];
  for (const item of event.clipboardData?.items ?? []) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}
