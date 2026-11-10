// Un asset que no existe debe responder 404 (no el index.html de la SPA):
// así un chunk viejo falla de forma explícita y la app puede recargar una sola vez.
export async function onRequest({ request, env }) {
  const response = await env.ASSETS.fetch(request);
  const type = response.headers.get("content-type") ?? "";
  if (response.status === 404 || type.includes("text/html")) {
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return response;
}
