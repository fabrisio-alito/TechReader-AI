/* ==========================================================================
   sw.js — Service worker: permite instalar la app y abrirla sin internet.

   Estrategia "RED PRIMERO": siempre intenta descargar la versión más nueva
   de cada archivo; solo si no hay internet usa la copia guardada.
   (Así evitamos el problema que tuvimos: el navegador usando archivos viejos.)

   Los PDF y tus datos NO pasan por aquí: viven en IndexedDB.
   Las llamadas a Gemini tampoco se guardan (son de otro dominio).
   ========================================================================== */

const CACHE = "techreader-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (evento) => {
  evento.waitUntil((async () => {
    for (const nombre of await caches.keys()) if (nombre !== CACHE) await caches.delete(nombre);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (evento) => {
  const pedido = evento.request;
  if (pedido.method !== "GET" || new URL(pedido.url).origin !== location.origin) return;
  evento.respondWith((async () => {
    try {
      const respuesta = await fetch(pedido, { cache: "no-cache" });
      if (respuesta.ok) (await caches.open(CACHE)).put(pedido, respuesta.clone());
      return respuesta;
    } catch {
      const guardada = await caches.match(pedido, { ignoreSearch: true });
      return guardada || new Response("Sin conexión", { status: 503 });
    }
  })());
});
