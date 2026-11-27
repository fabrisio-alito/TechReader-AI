/* ==========================================================================
   util.js — Herramientas pequeñas que usan todos los módulos.

   Antes vivían dentro de app.js. Al crecer la app (laboratorio, chat,
   glosario, sincronización…) las movimos aquí para no repetirlas:
   cada módulo hace `import { $, avisar, pintarMarkdown } from "./util.js"`.
   ========================================================================== */

import { marked } from "../vendor/marked.esm.js?v=1";
import DOMPurify from "../vendor/purify.es.js?v=1";
import hljs from "../vendor/highlight.min.js?v=1";

export const $ = (id) => document.getElementById(id);
export const limitar = (v, min, max) => Math.min(Math.max(v, min), max);
export const icono = (nombre) => `<svg><use href="#i-${nombre}"/></svg>`;
export const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
export const esMovil = () => matchMedia("(max-width: 900px)").matches;
export const escapar = (t) => String(t).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Identificador único (para notas, para que no se dupliquen al sincronizar). */
export const nuevoId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Huella corta y estable de un texto (FNV-1a). Sirve para comparar y deduplicar. */
export function huella(texto) {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) { h ^= texto.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

// "Mejoradores": funciones que otros módulos registran para retocar el HTML
// después de dibujar Markdown (por ejemplo, el laboratorio agrega ▶ Probar
// a cada bloque de código). Así util.js no necesita conocer al laboratorio.
const mejoradores = [];
export const alPintarMarkdown = (fn) => mejoradores.push(fn);

/** Markdown -> HTML seguro (DOMPurify quita cualquier script malicioso). */
export function pintarMarkdown(elemento, md) {
  elemento.innerHTML = DOMPurify.sanitize(marked.parse(md || ""));
  elemento.querySelectorAll("pre code").forEach((b) => hljs.highlightElement(b));
  for (const fn of mejoradores) fn(elemento);
}
export const markdownAHtml = (md) => DOMPurify.sanitize(marked.parse(md || ""));
export const resaltarCodigo = (el) => hljs.highlightElement(el);

/** Aviso pequeño en pantalla. tipo: info | exito | error */
export function avisar(texto, tipo = "info", ms = 4000) {
  const div = document.createElement("div");
  div.className = `aviso-flotante ${tipo}`;
  div.textContent = texto;
  $("avisos").append(div);
  setTimeout(() => div.remove(), ms);
  return div;
}

export async function copiarTexto(texto) {
  try { await navigator.clipboard.writeText(texto); avisar("Copiado ✔", "exito", 1800); }
  catch { avisar("No se pudo copiar", "error"); }
}

/** Fecha relativa amable: "hace 3 min", "ayer"… */
export function haceCuanto(fechaIso) {
  if (!fechaIso) return "nunca";
  const seg = Math.round((Date.now() - new Date(fechaIso).getTime()) / 1000);
  if (seg < 60) return "hace un momento";
  if (seg < 3600) return `hace ${Math.round(seg / 60)} min`;
  if (seg < 86400) return `hace ${Math.round(seg / 3600)} h`;
  return `hace ${Math.round(seg / 86400)} días`;
}
