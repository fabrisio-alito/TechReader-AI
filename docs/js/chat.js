/* ==========================================================================
   chat.js — "Pregúntale al libro": conversación sobre la página actual.

   Cada página tiene su propia conversación (se guarda mientras la app
   está abierta). En cada pregunta le mandamos a Gemini:
     - las instrucciones (prompts/preguntar.md)
     - el texto de la página que estás leyendo (como contexto)
     - toda la conversación hasta ahora (para que entienda "¿y eso por qué?")

   app.js le pasa un objeto "ctx" con lo que necesita saber del lector
   (libro, página, texto…). Así este módulo no depende del resto.
   ========================================================================== */

import { $, avisar, copiarTexto, icono, pintarMarkdown } from "./util.js";
import * as gemini from "./gemini.js";

const SUGERENCIAS = [
  "Explícame esta página en palabras sencillas",
  "Dame un ejemplo práctico de lo que explica",
  "¿Qué es lo más importante que debo recordar?",
  "Hazme una pregunta para comprobar si entendí",
];

let ctx = null;
const conversaciones = new Map(); // "libroId|pagina" -> [{ rol, texto, modelo }]
let enviando = false;

const clave = () => `${ctx.libroId()}|${ctx.pagina()}`;
const conversacion = () => {
  if (!conversaciones.has(clave())) conversaciones.set(clave(), []);
  return conversaciones.get(clave());
};

export function iniciarChat(contexto) {
  ctx = contexto;
  $("chat-form").onsubmit = (e) => { e.preventDefault(); enviar($("chat-entrada").value); };
  $("chat-entrada").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar($("chat-entrada").value); }
  });
  $("chat-entrada").addEventListener("input", ajustarAltura);
  $("chat-nueva").onclick = () => { conversaciones.delete(clave()); pintar(); };
}

function ajustarAltura() {
  const t = $("chat-entrada");
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
}

/** Se llama al cambiar de página o de libro. */
export function pintar() {
  if (!ctx?.libroId()) return;
  $("chat-pagina").textContent = ctx.pagina();
  const lista = $("chat-mensajes");
  lista.innerHTML = "";
  const mensajes = conversacion();
  $("chat-nueva").hidden = !mensajes.length;

  if (!mensajes.length) {
    lista.innerHTML = `<div class="chat-bienvenida">
      <div class="vacio-ilustracion">${icono("chat")}</div>
      <p>Pregunta lo que quieras sobre la <b>página ${ctx.pagina()}</b>. Respondo usando el texto de la página.</p></div>`;
  }
  for (const m of mensajes) lista.append(burbuja(m));

  const sugerencias = $("chat-sugerencias");
  sugerencias.innerHTML = "";
  sugerencias.hidden = mensajes.length > 0;
  for (const s of SUGERENCIAS) {
    const b = document.createElement("button");
    b.textContent = s;
    b.onclick = () => enviar(s);
    sugerencias.append(b);
  }
  lista.scrollTop = lista.scrollHeight;
}

function burbuja(m) {
  const div = document.createElement("div");
  div.className = `chat-mensaje ${m.rol}`;
  if (m.rol === "usuario") { div.textContent = m.texto; return div; }
  if (m.rol === "pensando") { div.innerHTML = '<div class="esqueleto"><i></i><i></i><i></i></div>'; return div; }
  if (m.rol === "error") { div.textContent = `⚠️ ${m.texto}`; return div; }
  const cuerpo = document.createElement("div");
  cuerpo.className = "prosa";
  pintarMarkdown(cuerpo, m.texto);
  const acciones = document.createElement("div");
  acciones.className = "chat-acciones";
  const botones = [
    ["altavoz", "Escuchar", () => ctx.escuchar(cuerpo, "Respuesta del libro")],
    ["copiar", "Copiar", () => copiarTexto(m.texto)],
    ["marcador", "Guardar en notas", () => guardar(m)],
  ];
  for (const [ic, texto, accion] of botones) {
    const b = document.createElement("button");
    b.className = "boton-chico";
    b.innerHTML = `${icono(ic)}${texto}`;
    b.onclick = accion;
    acciones.append(b);
  }
  const modelo = document.createElement("span");
  modelo.className = "chat-modelo";
  modelo.textContent = m.modelo || "";
  acciones.append(modelo);
  div.append(cuerpo, acciones);
  return div;
}

async function guardar(respuesta) {
  const mensajes = conversacion();
  const i = mensajes.indexOf(respuesta);
  const pregunta = [...mensajes.slice(0, i)].reverse().find((m) => m.rol === "usuario");
  await ctx.guardarNota(`❓ ${pregunta?.texto || "Pregunta"}`, `**Respuesta**\n\n${respuesta.texto}`);
}

/** Envía una pregunta. Si viene de una selección, la incluye como cita. */
export async function enviar(texto) {
  texto = texto.trim();
  if (!texto || enviando || !ctx.libroId()) return;
  enviando = true;
  $("chat-entrada").value = "";
  ajustarAltura();
  const mensajes = conversacion();
  const claveEnvio = clave();
  mensajes.push({ rol: "usuario", texto });
  mensajes.push({ rol: "pensando" });
  pintar();
  try {
    const textoPagina = await ctx.textoPagina();
    const historial = mensajes.filter((m) => m.rol === "usuario" || m.rol === "ia");
    const r = await gemini.conversar(historial, {
      libro: ctx.tituloLibro(), pagina: ctx.pagina(), textoPagina, fragmento: ctx.fragmento(),
    });
    mensajes.pop();
    mensajes.push({ rol: "ia", texto: r.texto, modelo: r.modelo });
  } catch (e) {
    mensajes.pop();
    mensajes.push({ rol: "error", texto: e.message });
  } finally {
    enviando = false;
    if (clave() === claveEnvio) pintar();
    else avisar("Llegó la respuesta a tu pregunta de la página anterior.", "info");
  }
}

/** Desde la barra de selección: prepara una pregunta sobre el fragmento. */
export function preguntarSobre(fragmento) {
  const corto = fragmento.length > 220 ? `${fragmento.slice(0, 220)}…` : fragmento;
  $("chat-entrada").value = `Sobre este fragmento: «${corto}»\n`;
  ajustarAltura();
  pintar();
  setTimeout(() => { const t = $("chat-entrada"); t.focus(); t.selectionStart = t.selectionEnd = t.value.length; }, 50);
}
