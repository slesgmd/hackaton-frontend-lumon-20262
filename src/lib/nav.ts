/** Solo rutas internas: empieza con "/" y no con "//" ni "/\" (evita open redirect). */
export function safeNext(raw: string | null | undefined, fallback = "/files"): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  return raw;
}
