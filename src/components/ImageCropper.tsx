import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { clampCrop, initialCrop, type CropRect } from "../lib/imageTools";

const VIEW = 320;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

/** Recorte cuadrado: arrastre con el puntero, zoom con deslizador/rueda y teclado (flechas y + / -). */
export function ImageCropper({
  image,
  onChange,
}: {
  image: HTMLImageElement;
  onChange: (crop: CropRect) => void;
}): JSX.Element {
  const naturalW = image.naturalWidth;
  const naturalH = image.naturalHeight;
  const [crop, setCrop] = useState<CropRect>(() => initialCrop(image));
  const dragRef = useRef<{ x: number; y: number; crop: CropRect } | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const base = Math.min(naturalW, naturalH);
  const zoom = base / crop.side;

  useEffect(() => {
    setCrop(initialCrop(image));
  }, [image]);

  useEffect(() => {
    onChangeRef.current(crop);
  }, [crop]);

  const update = useCallback(
    (next: CropRect): void => setCrop(clampCrop(next, naturalW, naturalH)),
    [naturalW, naturalH],
  );

  /** Cambia el zoom manteniendo el centro del recorte. */
  const setZoom = useCallback(
    (value: number): void => {
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
      setCrop((current) => {
        const side = base / z;
        const cx = current.x + current.side / 2;
        const cy = current.y + current.side / 2;
        return clampCrop({ side, x: cx - side / 2, y: cy - side / 2 }, naturalW, naturalH);
      });
    },
    [base, naturalW, naturalH],
  );

  const scale = VIEW / crop.side;

  return (
    <div className="space-y-3">
      <div
        role="group"
        tabIndex={0}
        aria-label="Recorte cuadrado de la imagen. Flechas para mover, más y menos para el zoom."
        aria-describedby="crop-help"
        className="relative touch-none select-none overflow-hidden rounded border-2 border-lumon-mint/60 bg-black outline-none focus-visible:ring-2 focus-visible:ring-lumon-amber"
        style={{ width: VIEW, height: VIEW, cursor: "grab" }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { x: event.clientX, y: event.clientY, crop };
        }}
        onPointerMove={(event) => {
          const start = dragRef.current;
          if (!start) return;
          const dx = (event.clientX - start.x) / scale;
          const dy = (event.clientY - start.y) / scale;
          update({ ...start.crop, x: start.crop.x - dx, y: start.crop.y - dy });
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onWheel={(event) => {
          event.preventDefault();
          setZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
        }}
        onKeyDown={(event) => {
          const step = crop.side * (event.shiftKey ? 0.1 : 0.03);
          switch (event.key) {
            case "ArrowLeft":
              update({ ...crop, x: crop.x - step });
              break;
            case "ArrowRight":
              update({ ...crop, x: crop.x + step });
              break;
            case "ArrowUp":
              update({ ...crop, y: crop.y - step });
              break;
            case "ArrowDown":
              update({ ...crop, y: crop.y + step });
              break;
            case "+":
            case "=":
              setZoom(zoom * 1.1);
              break;
            case "-":
            case "_":
              setZoom(zoom / 1.1);
              break;
            default:
              return;
          }
          event.preventDefault();
        }}
      >
        <img
          src={image.src}
          alt="Imagen que se está recortando"
          draggable={false}
          width={naturalW}
          height={naturalH}
          style={{
            position: "absolute",
            maxWidth: "none",
            width: naturalW * scale,
            height: naturalH * scale,
            left: -crop.x * scale,
            top: -crop.y * scale,
          }}
        />
      </div>
      <p id="crop-help" className="text-xs text-lumon-mint/60">
        Arrastra para encuadrar. Con el recuadro enfocado: flechas para mover (Shift para más) y + / − para el zoom.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setZoom(zoom / 1.2)}
          aria-label="Alejar"
          className="h-8 w-8 rounded border border-lumon-line text-lumon-mint"
        >
          −
        </button>
        <input
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}
          aria-label="Zoom"
          aria-valuetext={`${Math.round(zoom * 100)}%`}
          className="flex-1"
        />
        <button
          type="button"
          onClick={() => setZoom(zoom * 1.2)}
          aria-label="Acercar"
          className="h-8 w-8 rounded border border-lumon-line text-lumon-mint"
        >
          +
        </button>
        <span className="w-12 text-right font-mono text-xs text-lumon-mint/60" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
      </div>
    </div>
  );
}
