/* ==========================================================================
   gemini.js — Habla con Gemini DIRECTAMENTE desde el navegador.

   En la versión Python, traductor.py usaba la librería google-genai.
   Aquí no hay Python: usamos fetch() contra la API REST de Gemini.

     POST https://generativelanguage.googleapis.com/v1beta/models/MODELO:generateContent
     Cabecera:  x-goog-api-key: TU_CLAVE
     Cuerpo:    { systemInstruction, contents, generationConfig }

   Tu clave se guarda solo en ESTE navegador (almacen.js → config).
   Nunca se sube a GitHub ni a ningún servidor nuestro.
   ========================================================================== */

import { config } from "./almacen.js";

const API = "https://generativelanguage.googleapis.com/v1beta";
const REINTENTAR = new Set([404, 429, 500, 503]); // probar con el siguiente modelo

export class ErrorGemini extends Error {}

// Prompts: los mismos archivos .md de la versión Python (carpeta prompts/).
const cachePrompts = {};
async function leerPrompt(nombre) {
  if (!cachePrompts[nombre]) {
    const r = await fetch(`prompts/${nombre}`);
    if (!r.ok) throw new ErrorGemini(`No encontré el prompt ${nombre}`);
    cachePrompts[nombre] = await r.text();
  }
  return cachePrompts[nombre];
}

export const obtenerClave = () => config.obtener("geminiClave", "");
export const obtenerModelos = () => config.obtener("geminiModelos", []);

/** Pregunta a Google qué modelos puede usar esta clave.
 *  Sirve para comprobar que la clave funciona y elegir modelos automáticamente. */
export async function listarModelos(clave) {
  let r;
  try {
    r = await fetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": clave } });
  } catch {
    throw new ErrorGemini("Sin conexión a internet.");
  }
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = datos?.error?.message || `Error ${r.status}`;
    throw new ErrorGemini(r.status === 400 || r.status === 403 ? `La clave no es válida (${msg})` : msg);
  }
  return (datos.models || [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => n.startsWith("gemini") && !/image|tts|live|embedding|audio|banana|omni|robotics|computer/.test(n));
}

/** Elige el orden de modelos: primero los "flash-lite" (más cuota gratis),
 *  del más nuevo al más viejo, y al final un "flash" normal de respaldo. */
export function elegirModelos(nombres) {
  const version = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const estables = nombres.filter((n) => !/preview|exp|latest/.test(n));
  const lista = estables.length ? estables : nombres;
  const porVersion = (a, b) => version(b) - version(a);
  const lite = lista.filter((n) => /flash-lite/.test(n)).sort(porVersion).slice(0, 2);
  const flash = lista.filter((n) => /flash/.test(n) && !/lite/.test(n)).sort(porVersion).slice(0, 1);
  const elegidos = [...lite, ...flash];
  return elegidos.length ? elegidos : lista.slice(0, 3);
}

/** Llama a Gemini con un prompt y un contenido (texto y/o imagen).
 *  Devuelve { texto, modelo }. */
async function generar(nombrePrompt, partes) {
  const clave = await obtenerClave();
  if (!clave) throw new ErrorGemini("Falta tu clave de Gemini. Ve a ⚙️ Ajustes → Gemini.");
  const modelos = await obtenerModelos();
  if (!modelos.length) throw new ErrorGemini("No hay modelos configurados. Ve a ⚙️ Ajustes → Gemini → Probar clave.");

  const cuerpo = {
    systemInstruction: { parts: [{ text: await leerPrompt(nombrePrompt) }] },
    contents: [{ role: "user", parts: partes }],
    generationConfig: { temperature: 0.2 },
  };

  let ultimoError = "";
  for (const modelo of modelos) {
    let r;
    try {
      r = await fetch(`${API}/models/${modelo}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": clave },
        body: JSON.stringify(cuerpo),
      });
    } catch {
      throw new ErrorGemini("Sin conexión a internet.");
    }
    const datos = await r.json().catch(() => ({}));
    if (r.ok) {
      const texto = (datos.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
      if (texto) return { texto, modelo };
      ultimoError = datos.promptFeedback?.blockReason ? `bloqueado (${datos.promptFeedback.blockReason})` : "respuesta vacía";
      continue;
    }
    ultimoError = `${r.status}: ${datos?.error?.message || r.statusText}`;
    if (REINTENTAR.has(r.status)) continue;
    throw new ErrorGemini(`Gemini rechazó la petición (${ultimoError})`);
  }
  throw new ErrorGemini(
    `Ningún modelo pudo responder. Último error: ${ultimoError}. ` +
    "Si es 429, alcanzaste el límite gratuito: espera un minuto o hasta mañana."
  );
}

/** Traduce una página. imagenBase64 = PNG de la página (opcional). */
export function traducirPagina(texto, imagenBase64) {
  const partes = [];
  if (imagenBase64) partes.push({ inlineData: { mimeType: "image/png", data: imagenBase64 } });
  partes.push({ text: texto ? `Texto extraído de la página:\n\n${texto}` : "Traduce el contenido de esta página (es una imagen)." });
  return generar("traducir_pagina.md", partes);
}

const PROMPTS_ASISTENTE = {
  traducir: "traducir_seleccion.md",
  explicar: "explicar.md",
  resumir: "resumir.md",
  ejemplo: "ejemplo.md",
};

/** Traducir / Explicar / Resumir / Ejemplo sobre un fragmento seleccionado. */
export function usarAsistente(texto, accion, libro = "") {
  if (!PROMPTS_ASISTENTE[accion]) throw new ErrorGemini(`Acción desconocida: ${accion}`);
  if (texto.length > 6000) throw new ErrorGemini("La selección es muy larga. Para eso usa «Traducir página».");
  const contexto = libro ? `Libro: ${libro}\n\n` : "";
  return generar(PROMPTS_ASISTENTE[accion], [{ text: `${contexto}Fragmento seleccionado:\n\n${texto}` }]);
}
