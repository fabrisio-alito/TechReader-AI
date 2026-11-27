/* ==========================================================================
   sincronizar.js — Sincroniza tus datos entre dispositivos usando GitHub.

   ¿Dónde se guardan? En un archivo "techreader.json" dentro de un
   repositorio PRIVADO tuyo (por ejemplo fabrisio-alito/techreader-datos).
   Cada dispositivo:
     1. descarga ese archivo,
     2. lo FUSIONA con lo local (almacen.fusionar: gana lo más reciente,
        nada se pierde, lo que borraste se respeta gracias a las "lápidas"),
     3. si después de fusionar tiene algo que el archivo no tiene, lo sube.

   Usamos la API REST de GitHub ("contents"), que acepta llamadas desde el
   navegador (CORS). El permiso lo da un "token" que solo puede tocar ESE
   repositorio. No se suben los PDF ni tu clave de Gemini.

   Si dos dispositivos suben a la vez, GitHub rechaza al segundo (409):
   entonces vuelve a descargar, fusiona y reintenta.
   ========================================================================== */

import * as almacen from "./almacen.js";
import { huella } from "./util.js";

const API = "https://api.github.com";
const ARCHIVO = "techreader.json";

export const eventos = new EventTarget(); // "estado": { estado, mensaje, resumen }
let enCurso = null;
let sucio = false;
let temporizador = null;

export class ErrorSync extends Error {}

export async function configuracion() {
  return {
    repo: await almacen.config.obtener("sincRepo", ""),
    token: await almacen.config.obtener("sincToken", ""),
    auto: await almacen.config.obtener("sincAuto", true),
    ultima: await almacen.config.obtener("sincUltima", null),
  };
}

export async function guardarConfiguracion({ repo, token, auto }) {
  if (repo !== undefined) await almacen.config.guardar("sincRepo", repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$|\/$/g, ""));
  if (token !== undefined) await almacen.config.guardar("sincToken", token.trim());
  if (auto !== undefined) await almacen.config.guardar("sincAuto", auto);
}

export async function desconectar() {
  for (const c of ["sincRepo", "sincToken", "sincUltima", "sincHuella"]) await almacen.config.borrar(c);
  avisarEstado("apagado", "Sincronización desactivada");
}

const cabeceras = (token, extra = {}) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  ...extra,
});

// Texto <-> base64 respetando tildes y emojis (UTF-8).
function aBase64(texto) {
  const bytes = new TextEncoder().encode(texto);
  let binario = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binario);
}
const desdeBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

async function explicarError(r, repo) {
  const datos = await r.json().catch(() => ({}));
  if (r.status === 401) return "El token no es válido o ya venció. Crea uno nuevo en GitHub.";
  if (r.status === 403) return /rate limit/i.test(datos.message || "") ? "GitHub limitó las peticiones; intenta en unos minutos." : "El token no tiene permiso de «Contents: Read and write» en ese repositorio.";
  if (r.status === 404) return `No encuentro el repositorio «${repo}» o el token no tiene acceso a él.`;
  return `GitHub respondió ${r.status}: ${datos.message || r.statusText}`;
}

async function leerRemoto(repo, token) {
  let r;
  try {
    r = await fetch(`${API}/repos/${repo}/contents/${ARCHIVO}`, { headers: cabeceras(token), cache: "no-store" });
  } catch { throw new ErrorSync("Sin conexión a internet."); }
  if (r.status === 404) {
    // ¿No existe el archivo (primera vez) o no existe el repositorio?
    const repoOk = await fetch(`${API}/repos/${repo}`, { headers: cabeceras(token), cache: "no-store" });
    if (!repoOk.ok) throw new ErrorSync(await explicarError(repoOk, repo));
    return { sha: null, datos: null };
  }
  if (!r.ok) throw new ErrorSync(await explicarError(r, repo));
  const meta = await r.json();
  let texto;
  if (meta.content && meta.encoding === "base64") texto = desdeBase64(meta.content);
  else {
    // Archivos de más de 1 MB: la API no trae el contenido, se pide "crudo".
    const crudo = await fetch(`${API}/repos/${repo}/contents/${ARCHIVO}`, { headers: cabeceras(token, { Accept: "application/vnd.github.raw+json" }), cache: "no-store" });
    if (!crudo.ok) throw new ErrorSync(await explicarError(crudo, repo));
    texto = await crudo.text();
  }
  try { return { sha: meta.sha, datos: JSON.parse(texto) }; }
  catch { throw new ErrorSync("El archivo de sincronización en GitHub está dañado."); }
}

async function escribirRemoto(repo, token, datos, sha) {
  const r = await fetch(`${API}/repos/${repo}/contents/${ARCHIVO}`, {
    method: "PUT",
    headers: cabeceras(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      message: `Sincronización desde ${navigator.userAgentData?.platform || "un dispositivo"} · ${new Date().toLocaleString("es")}`,
      content: aBase64(JSON.stringify(datos)),
      ...(sha ? { sha } : {}),
    }),
  });
  if (r.status === 409 || r.status === 422) return false; // otro dispositivo subió antes: reintentar
  if (!r.ok) throw new ErrorSync(await explicarError(r, repo));
  return true;
}

/** Huella de lo que IMPORTA para sincronizar (claves y fechas), ignorando el
 *  orden y los detalles propios de cada dispositivo (tamaño del PDF, fecha
 *  de exportación…). Si local y remoto tienen la misma huella, no subimos nada.
 *  Sin esto, dos dispositivos se "corregirían" mutuamente cada 5 minutos. */
function huellaDatos(d) {
  const claves = (lista, f) => (lista || []).map(f).sort();
  return huella(JSON.stringify([
    claves(d.libros, (x) => `${x.id}|${x.ultimaPagina}|${x.actualizado}`),
    claves(d.traducciones, (x) => `${x.libroId}|${x.pagina}|${x.fecha}`),
    claves(d.asistente, (x) => `${x.libroId}|${x.accion}|${x.original}`),
    claves(d.notas, (x) => x.uid || `${x.libroId}|${x.pagina}|${x.original}`),
    claves(d.glosario, (x) => `${x.id}|${x.actualizado}`),
    claves(d.eliminados, (x) => x.clave),
  ]));
}

function avisarEstado(estado, mensaje = "", resumen = null) {
  eventos.dispatchEvent(new CustomEvent("estado", { detail: { estado, mensaje, resumen } }));
}

/** Sincroniza ahora. Devuelve el resumen de lo que llegó de otros dispositivos. */
export function sincronizar() {
  if (enCurso) return enCurso;
  enCurso = (async () => {
    const { repo, token } = await configuracion();
    if (!repo || !token) { avisarEstado("apagado"); return null; }
    avisarEstado("sincronizando", "Sincronizando…");
    sucio = false;
    let resumen = null;
    try {
      for (let intento = 0; intento < 3; intento++) {
        const remoto = await leerRemoto(repo, token);
        if (remoto.datos) resumen = await almacen.fusionar(remoto.datos);
        const local = await almacen.exportarDatos();
        const huellaLocal = huellaDatos(local);
        if (remoto.datos && huellaDatos(remoto.datos) === huellaLocal) break; // ya son iguales
        if (await escribirRemoto(repo, token, local, remoto.sha)) break;
      }
      await almacen.config.guardar("sincUltima", new Date().toISOString());
      avisarEstado("ok", "Sincronizado", resumen);
      return resumen;
    } catch (e) {
      sucio = true;
      avisarEstado("error", e.message);
      throw e;
    } finally {
      enCurso = null;
    }
  })();
  return enCurso;
}

/** Comprueba repo + token y hace la primera sincronización. */
export async function conectar(repo, token) {
  await guardarConfiguracion({ repo, token });
  return sincronizar();
}

/** Sincronización automática:
 *  - al abrir la app,
 *  - 15 s después de cada cambio,
 *  - al cambiar de pestaña o minimizar,
 *  - y cada 5 minutos (para traer lo de otros dispositivos). */
export async function iniciarAutomatica() {
  const programar = (ms) => {
    clearTimeout(temporizador);
    temporizador = setTimeout(async () => {
      const c = await configuracion();
      if (c.repo && c.token && c.auto) sincronizar().catch(() => {});
    }, ms);
  };
  almacen.cambios.addEventListener("cambio", () => { sucio = true; programar(15000); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && sucio) programar(0);
    if (document.visibilityState === "visible") programar(1000);
  });
  setInterval(() => { if (document.visibilityState === "visible") programar(0); }, 5 * 60 * 1000);
  const c = await configuracion();
  if (c.repo && c.token) { if (c.auto) programar(500); else avisarEstado("ok", "Sincronización manual"); }
  else avisarEstado("apagado");
}
