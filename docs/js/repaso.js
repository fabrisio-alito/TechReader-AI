/* ==========================================================================
   repaso.js — La lógica (sin interfaz) del glosario y del repaso espaciado.

   1) extraerVocabulario(): lee la sección "📌 Vocabulario" que Gemini agrega
      al traducir una página y saca los términos:
         - `closure` — cierre — función que recuerda variables de afuera
   2) repasar(): el algoritmo SM-2 (el mismo que usa Anki).
      Idea: si recuerdas bien una tarjeta, la próxima vez aparece más tarde
      (1 día, 3 días, 8 días, 20…). Si la olvidas, vuelve a empezar.
      Así repasas cada cosa JUSTO antes de olvidarla.
   ========================================================================== */

/** Saca los términos de la sección "Vocabulario" de una traducción. */
export function extraerVocabulario(markdown) {
  const terminos = [];
  let dentro = false;
  for (const linea of (markdown || "").split("\n")) {
    if (/^#{1,6}\s/.test(linea)) { dentro = /vocabulario/i.test(linea); continue; }
    if (!dentro) continue;
    const item = linea.match(/^\s*[-*]\s+(.+)$/);
    if (!item) continue;
    let partes = item[1].split(/\s+[—–]\s+/);
    if (partes.length < 2) partes = item[1].split(/\s+-\s+/);
    if (partes.length < 2) partes = item[1].split(/:\s+/);
    if (partes.length < 2) continue;
    const termino = partes[0].replace(/[`*_]/g, "").trim();
    const traduccion = partes[1].replace(/[`*_]/g, "").trim();
    if (!termino || !traduccion || termino.length > 60) continue;
    terminos.push({ termino, traduccion, explicacion: partes.slice(2).join(" — ").replace(/[*_]/g, "").trim() });
  }
  return terminos;
}

const MINUTO = 60 * 1000;
const DIA = 24 * 60 * MINUTO;

/** Calificaciones posibles al repasar una tarjeta. */
export const CALIFICACIONES = [
  { valor: 0, texto: "Otra vez", tecla: "1" },
  { valor: 1, texto: "Difícil", tecla: "2" },
  { valor: 2, texto: "Bien", tecla: "3" },
  { valor: 3, texto: "Fácil", tecla: "4" },
];

/** SM-2. Recibe el estado de repaso de una tarjeta y tu calificación (0-3).
 *  Devuelve el estado nuevo, con la fecha "proxima" en que debe volver. */
export function repasar(estado, calificacion, hoy = Date.now()) {
  let { repeticiones = 0, intervalo = 0, facilidad = 2.5 } = estado || {};
  const q = [1, 3, 4, 5][calificacion];               // escala original de SM-2 (0 a 5)
  if (q < 3) {
    repeticiones = 0;
    intervalo = 0;                                    // la volverás a ver en 10 minutos
  } else {
    repeticiones += 1;
    if (repeticiones === 1) intervalo = calificacion === 3 ? 3 : 1;
    else if (repeticiones === 2) intervalo = calificacion === 3 ? 6 : calificacion === 1 ? 2 : 3;
    else intervalo = Math.max(intervalo + 1, Math.round(intervalo * facilidad * (calificacion === 1 ? 0.8 : calificacion === 3 ? 1.3 : 1)));
  }
  facilidad = Math.max(1.3, facilidad + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  const proxima = new Date(hoy + (intervalo === 0 ? 10 * MINUTO : intervalo * DIA)).toISOString();
  return { repeticiones, intervalo, facilidad: Math.round(facilidad * 100) / 100, proxima, ultimo: new Date(hoy).toISOString() };
}

/** ¿Toca repasar esta tarjeta? (las nuevas siempre tocan) */
export const toca = (entrada, hoy = Date.now()) => !entrada.repaso || new Date(entrada.repaso.proxima).getTime() <= hoy;

/** Texto corto del tiempo hasta el próximo repaso, para los botones. */
export function cuandoVuelve(estado, calificacion) {
  const r = repasar(estado, calificacion);
  if (r.intervalo === 0) return "10 min";
  return r.intervalo === 1 ? "1 día" : `${r.intervalo} días`;
}

/** Ordena las tarjetas pendientes: primero las atrasadas, luego las nuevas. */
export function colaDeHoy(entradas, maximoNuevas = 20) {
  const vencidas = entradas.filter((e) => e.repaso && toca(e)).sort((a, b) => a.repaso.proxima.localeCompare(b.repaso.proxima));
  const nuevas = entradas.filter((e) => !e.repaso).slice(0, maximoNuevas);
  return [...vencidas, ...nuevas];
}
