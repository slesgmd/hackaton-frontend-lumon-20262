import type { Refiner } from "./types";

/**
 * Regla del Tablero para los expedientes: una versión vieja nunca pisa a una nueva,
 * llegue por el stream (SSE) o por una respuesta HTTP (lista, detalle, PATCH).
 */
const latest = new Map<number, Refiner>();

/** Devuelve el expediente más nuevo que conozcamos (el recibido, o uno que ya teníamos con más versión). */
export function reconcile(refiner: Refiner): Refiner {
  const known = latest.get(refiner.id);
  if (known && known.version > refiner.version) return known;
  latest.set(refiner.id, refiner);
  return refiner;
}

/** true solo si `version` es estrictamente mayor que la que ya conocemos. */
export function isNewer(id: number, version: number): boolean {
  const known = latest.get(id);
  return !known || version > known.version;
}

export function knownVersion(id: number): number | null {
  return latest.get(id)?.version ?? null;
}

export function reconcileAll(list: Refiner[]): Refiner[] {
  return list.map(reconcile);
}

export function clearRefinerStore(): void {
  latest.clear();
}
