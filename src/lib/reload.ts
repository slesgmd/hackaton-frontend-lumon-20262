const MARK = "lumon.chunk-reload";

/** Un chunk viejo (tras un deploy) ya no existe: se recarga la página UNA sola vez, sin bucles. */
export function reloadOnce(): boolean {
  try {
    if (sessionStorage.getItem(MARK)) return false;
    sessionStorage.setItem(MARK, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** Si la página cargó bien, libera la marca para que un deploy futuro pueda recargar de nuevo. */
export function clearReloadMarkLater(): void {
  window.setTimeout(() => {
    try {
      sessionStorage.removeItem(MARK);
    } catch {
      /* sin sessionStorage */
    }
  }, 15000);
}

export function isChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Failed to fetch dynamically imported module") ||
    message.includes("Importing a module script failed") ||
    message.includes("error loading dynamically imported module")
  );
}
