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

/** Llama a Gemini.
 *  - nombrePrompt: archivo de prompts/ con las instrucciones (system instruction)
 *  - contenidos:   lista de turnos [{ role: "user"|"model", parts: [...] }]
 *  - opciones.extra: texto que se agrega a las instrucciones (ej. el texto de la página)
 *  - opciones.json:  true para pedir la respuesta en JSON (cuestionarios)
 *  Devuelve { texto, modelo }. */
async function generar(nombrePrompt, contenidos, { extra = "", json = false, temperatura } = {}) {
  const clave = await obtenerClave();
  if (!clave) throw new ErrorGemini("Falta tu clave de Gemini. Ve a ⚙️ Ajustes → Gemini.");
  const modelos = await obtenerModelos();
  if (!modelos.length) throw new ErrorGemini("No hay modelos configurados. Ve a ⚙️ Ajustes → Gemini → Probar clave.");

  const cuerpo = {
    systemInstruction: { parts: [{ text: (await leerPrompt(nombrePrompt)) + (extra ? `\n\n${extra}` : "") }] },
    contents: contenidos,
    generationConfig: { temperature: temperatura ?? (json ? 0.4 : 0.2), ...(json ? { responseMimeType: "application/json" } : {}) },
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

const turnoUsuario = (partes) => [{ role: "user", parts: partes }];

/** Traduce una página a partir de su texto. Con imagen = { mime, datos } Gemini
 *  también ve la página (modo "Texto + imagen"): útil para explicar figuras. */
export function traducirPagina(texto, imagen = null) {
  const partes = [];
  if (imagen) partes.push({ inlineData: { mimeType: imagen.mime, data: imagen.datos } });
  partes.push({ text: texto ? `Texto extraído de la página:\n\n${texto}` : "Traduce el contenido de esta página (es una imagen)." });
  return generar("traducir_pagina.md", turnoUsuario(partes));
}

/** Modo "Imagen": Gemini LEE la página mirándola (como un OCR inteligente) y la traduce.
 *  Sirve para PDFs escaneados, diapositivas exportadas como imagen y libros muy visuales.
 *  Pedimos JSON con dos campos para guardar también el texto original en inglés:
 *  así funcionan "Preguntar", "Original en inglés" y el glosario en esas páginas.
 *  Devuelve { texto (traducción), original, modelo }. */
export async function leerPaginaComoImagen(imagen) {
  const r = await generar(
    "leer_imagen.md",
    turnoUsuario([
      { inlineData: { mimeType: imagen.mime, data: imagen.datos } },
      { text: "Lee esta página de libro y tradúcela siguiendo las reglas." },
    ]),
    { json: true, temperatura: 0.2 }
  );
  let datos;
  try { datos = JSON.parse(r.texto); }
  catch { return { texto: r.texto, original: "", modelo: r.modelo }; } // vino Markdown suelto: lo usamos igual
  const traduccion = String(datos.traduccion || "").trim();
  if (!traduccion) throw new ErrorGemini("Gemini no encontró texto en la imagen. Prueba «Volver a traducir».");
  return { texto: traduccion, original: String(datos.original || "").trim(), modelo: r.modelo };
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
  return generar(PROMPTS_ASISTENTE[accion], turnoUsuario([{ text: `${contexto}Fragmento seleccionado:\n\n${texto}` }]));
}

/** "Pregúntale al libro": conversación con el texto de la página como contexto.
 *  historial = [{ rol: "usuario"|"ia", texto }] (el último es tu pregunta). */
export function conversar(historial, { libro, pagina, textoPagina, fragmento }) {
  const extra = [
    `LIBRO: ${libro}`,
    `PÁGINA QUE ESTÁ LEYENDO: ${pagina}`,
    fragmento ? `FRAGMENTO QUE SELECCIONÓ ANTES:\n${fragmento}` : "",
    `TEXTO DE LA PÁGINA (en inglés, extraído del PDF):\n"""\n${(textoPagina || "(página sin texto)").slice(0, 12000)}\n"""`,
  ].filter(Boolean).join("\n\n");
  const contenidos = historial.map((m) => ({ role: m.rol === "ia" ? "model" : "user", parts: [{ text: m.texto }] }));
  return generar("preguntar.md", contenidos, { extra });
}

/** Cuestionario de opción múltiple sobre lo que leíste. Devuelve un arreglo de preguntas. */
export async function crearCuestionario(material, cantidad = 5) {
  const r = await generar("cuestionario.md",
    turnoUsuario([{ text: `Crea ${cantidad} preguntas a partir de este material:\n\n${material.slice(0, 24000)}` }]),
    { json: true });
  let datos;
  try {
    datos = JSON.parse(r.texto.replace(/^```(json)?|```$/g, "").trim());
  } catch {
    throw new ErrorGemini("La IA no devolvió el cuestionario en el formato esperado. Intenta de nuevo.");
  }
  const preguntas = (Array.isArray(datos) ? datos : datos.preguntas || []).filter((p) =>
    p?.pregunta && Array.isArray(p.opciones) && p.opciones.length >= 2 && Number.isInteger(p.correcta) && p.correcta >= 0 && p.correcta < p.opciones.length);
  if (!preguntas.length) throw new ErrorGemini("La IA no generó preguntas válidas. Intenta de nuevo.");
  return { preguntas, modelo: r.modelo };
}

/** Convierte un fragmento de código en un ejemplo completo que se pueda ejecutar. */
export async function hacerEjecutable(codigo, lenguaje) {
  const r = await generar("laboratorio.md",
    turnoUsuario([{ text: `Lenguaje: ${lenguaje}\n\nFragmento:\n\`\`\`\n${codigo}\n\`\`\`` }]));
  const bloque = r.texto.match(/```(\w*)\n([\s\S]*?)```/);
  return { codigo: bloque ? bloque[2].trimEnd() : r.texto, lenguaje: bloque?.[1] || lenguaje, explicacion: r.texto.replace(/```[\s\S]*?```/, "").trim(), modelo: r.modelo };
}
