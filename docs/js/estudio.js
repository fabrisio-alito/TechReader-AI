/* ==========================================================================
   estudio.js — Las vistas "Glosario" y "Repaso" (tarjetas + cuestionario IA).

   - Glosario: términos técnicos que se juntan solos desde el 📌 Vocabulario
     de cada página traducida, más los que agregues a mano.
   - Tarjetas: repaso espaciado (repaso.js → SM-2). Ves el término en inglés,
     intentas recordarlo, muestras la respuesta y te calificas.
   - Cuestionario con IA: Gemini arma preguntas de opción múltiple con lo
     que ya leíste (traducciones, notas y glosario de ese libro).
   ========================================================================== */

import { $, avisar, escapar, icono, markdownAHtml } from "./util.js";
import * as almacen from "./almacen.js";
import * as gemini from "./gemini.js";
import * as repaso from "./repaso.js";

let ctx = null;
const sesion = { cola: [], actual: null, vistas: 0, aciertos: 0 };
const quiz = { preguntas: [], indice: 0, aciertos: 0, falladas: [] };

export function iniciarEstudio(contexto) {
  ctx = contexto;
  $("filtro-glosario").oninput = pintarGlosario;
  $("filtro-glosario-libro").onchange = pintarGlosario;
  $("form-glosario").onsubmit = async (e) => {
    e.preventDefault();
    const ok = await almacen.glosario.agregar({
      termino: $("g-termino").value, traduccion: $("g-traduccion").value, explicacion: $("g-explicacion").value,
      libroId: ctx.libroId(), pagina: ctx.pagina(),
    }, { manual: true });
    if (!ok) { avisar("Ese término ya está en tu glosario.", "info"); return; }
    e.target.reset();
    avisar("Término agregado ✔", "exito", 2000);
    pintarGlosario();
    actualizarInsignias();
  };
  for (const b of $("repaso-modo").children) b.onclick = () => cambiarModo(b.dataset.modo);
  document.addEventListener("keydown", teclasRepaso);
}

// ───────────── Vocabulario automático ─────────────

/** Agrega al glosario los términos del 📌 Vocabulario de una traducción. */
export async function agregarVocabularioDe(markdown, libroId, pagina) {
  let nuevos = 0;
  for (const t of repaso.extraerVocabulario(markdown)) {
    if (await almacen.glosario.agregar({ ...t, libroId, pagina })) nuevos++;
  }
  if (nuevos) actualizarInsignias();
  return nuevos;
}

/** Revisa TODAS las traducciones guardadas (útil tras importar un respaldo). */
async function completarDesdeTraducciones() {
  let nuevos = 0;
  for (const t of await almacen.traducciones.todas()) nuevos += await agregarVocabularioDe(t.texto, t.libroId, t.pagina);
  return nuevos;
}

export async function actualizarInsignias() {
  const pendientes = repaso.colaDeHoy(await almacen.glosario.todos()).length;
  for (const el of document.querySelectorAll("[data-insignia-repaso]")) {
    el.textContent = pendientes > 99 ? "99+" : pendientes || "";
    el.hidden = !pendientes;
  }
}

// ───────────── Glosario ─────────────
export async function pintarGlosario() {
  const nuevos = await completarDesdeTraducciones();
  if (nuevos) avisar(`${nuevos} términos nuevos agregados desde tus traducciones`, "exito");

  const libros = ctx.libros();
  const filtroLibro = $("filtro-glosario-libro");
  const elegido = filtroLibro.value;
  filtroLibro.innerHTML = '<option value="">Todos los libros</option>' +
    libros.map((l) => `<option value="${escapar(l.id)}">${escapar(l.titulo || l.nombre)}</option>`).join("");
  filtroLibro.value = elegido;

  const q = $("filtro-glosario").value.trim().toLowerCase();
  const todos = await almacen.glosario.todos();
  $("glosario-total").textContent = todos.length || "";
  const lista = todos.filter((g) =>
    (!filtroLibro.value || g.libroId === filtroLibro.value) &&
    (!q || `${g.termino} ${g.traduccion} ${g.explicacion}`.toLowerCase().includes(q)));

  const contenedor = $("lista-glosario");
  contenedor.innerHTML = "";
  if (!lista.length) {
    contenedor.innerHTML = `<div class="nota-vacia">${todos.length ? "Ningún término coincide con tu búsqueda." :
      "Tu glosario está vacío. Traduce una página: los términos del <b>📌 Vocabulario</b> aparecerán aquí solos."}</div>`;
    return;
  }
  const nombreLibro = (id) => { const l = libros.find((x) => x.id === id); return l ? (l.titulo || l.nombre) : (id || "").split("|")[0]; };
  for (const g of lista) {
    const tarjeta = document.createElement("article");
    tarjeta.className = "termino";
    const dias = g.repaso ? Math.max(1, Math.round((new Date(g.repaso.proxima) - Date.now()) / 86400000)) : 0;
    const estadoRepaso = !g.repaso ? "Nuevo" : repaso.toca(g) ? "Toca repasar" : `Repaso en ${dias} ${dias === 1 ? "día" : "días"}`;
    tarjeta.innerHTML = `
      <header>
        <h3></h3>
        <button class="boton-icono pronunciar" title="Pronunciar en inglés">${icono("altavoz")}</button>
        <span class="insignia-repaso ${!g.repaso ? "nuevo" : repaso.toca(g) ? "toca" : ""}">${estadoRepaso}</span>
      </header>
      <p class="traduccion"></p>
      <p class="explicacion"></p>
      <footer>
        <button class="enlace ir"></button>
        <button class="boton-icono borrar" title="Eliminar del glosario">${icono("papelera")}</button>
      </footer>`;
    tarjeta.querySelector("h3").textContent = g.termino;
    tarjeta.querySelector(".traduccion").textContent = g.traduccion;
    tarjeta.querySelector(".explicacion").textContent = g.explicacion || "";
    const ir = tarjeta.querySelector(".ir");
    if (g.libroId && g.pagina) {
      ir.textContent = `${nombreLibro(g.libroId)} · pág. ${g.pagina}`;
      ir.onclick = () => ctx.irALibro(g.libroId, g.pagina);
    } else ir.textContent = "Agregado a mano";
    tarjeta.querySelector(".pronunciar").onclick = () => ctx.decir(g.termino, "en");
    tarjeta.querySelector(".borrar").onclick = async () => {
      if (!confirm(`¿Eliminar «${g.termino}» del glosario?`)) return;
      await almacen.glosario.borrar(g.id);
      pintarGlosario();
      actualizarInsignias();
    };
    contenedor.append(tarjeta);
  }
}

// ───────────── Repaso: tarjetas ─────────────
function cambiarModo(modo) {
  for (const b of $("repaso-modo").children) b.classList.toggle("activo", b.dataset.modo === modo);
  $("repaso-tarjetas").hidden = modo !== "tarjetas";
  $("repaso-cuestionario").hidden = modo !== "cuestionario";
  if (modo === "cuestionario") pintarConfigCuestionario();
}

export async function pintarRepaso() {
  await completarDesdeTraducciones();
  sesion.cola = repaso.colaDeHoy(await almacen.glosario.todos());
  sesion.vistas = 0;
  sesion.aciertos = 0;
  if (!$("repaso-cuestionario").hidden) pintarConfigCuestionario();
  siguienteTarjeta();
}

async function siguienteTarjeta() {
  const caja = $("repaso-tarjetas");
  const total = (await almacen.glosario.todos()).length;
  sesion.actual = sesion.cola.shift() || null;
  if (!sesion.actual) {
    const todos = await almacen.glosario.todos();
    const proximas = todos.filter((g) => g.repaso).map((g) => g.repaso.proxima).sort();
    caja.innerHTML = `
      <div class="repaso-fin">
        <div class="vacio-ilustracion grande">${icono("check-circulo")}</div>
        <h2>${total ? "¡Estás al día! 🎉" : "Aún no hay tarjetas"}</h2>
        <p>${total
          ? `${sesion.vistas ? `Repasaste ${sesion.vistas} tarjetas (${sesion.aciertos} bien). ` : ""}${proximas[0] ? `Próximo repaso: ${new Date(proximas[0]).toLocaleString("es", { weekday: "long", hour: "2-digit", minute: "2-digit" })}.` : ""}`
          : "Traduce páginas o agrega términos al glosario: se convertirán en tarjetas de repaso."}</p>
        ${total ? '<button id="repasar-igual" class="boton-primario secundario">Repasar 10 al azar de todas formas</button>' : ""}
      </div>`;
    $("repasar-igual")?.addEventListener("click", async () => {
      sesion.cola = (await almacen.glosario.todos()).sort(() => Math.random() - 0.5).slice(0, 10);
      siguienteTarjeta();
    });
    actualizarInsignias();
    return;
  }
  const g = sesion.actual;
  caja.innerHTML = `
    <div class="repaso-progreso">Quedan <b>${sesion.cola.length + 1}</b> · ${total} términos en tu glosario</div>
    <div class="tarjeta-repaso">
      <span class="etiqueta">¿Qué significa?</span>
      <h2 class="tr-termino"></h2>
      <button class="boton-chico tr-pronunciar">${icono("altavoz")}Pronunciar</button>
      <div class="tr-dorso" hidden>
        <div class="tr-traduccion"></div>
        <p class="tr-explicacion"></p>
      </div>
      <button class="boton-primario tr-mostrar">Mostrar respuesta <kbd>Espacio</kbd></button>
      <div class="tr-calificar" hidden></div>
    </div>`;
  caja.querySelector(".tr-termino").textContent = g.termino;
  caja.querySelector(".tr-traduccion").textContent = g.traduccion;
  caja.querySelector(".tr-explicacion").textContent = g.explicacion || "";
  caja.querySelector(".tr-pronunciar").onclick = () => ctx.decir(g.termino, "en");
  caja.querySelector(".tr-mostrar").onclick = mostrarRespuesta;
  const calificar = caja.querySelector(".tr-calificar");
  for (const c of repaso.CALIFICACIONES) {
    const b = document.createElement("button");
    b.className = `calificar c${c.valor}`;
    b.innerHTML = `<b>${c.texto}</b><small>${repaso.cuandoVuelve(g.repaso, c.valor)}</small><kbd>${c.tecla}</kbd>`;
    b.onclick = () => calificarTarjeta(c.valor);
    calificar.append(b);
  }
}

function mostrarRespuesta() {
  const caja = $("repaso-tarjetas");
  if (!sesion.actual || !caja.querySelector(".tr-dorso")?.hidden) return;
  caja.querySelector(".tr-dorso").hidden = false;
  caja.querySelector(".tr-mostrar").hidden = true;
  caja.querySelector(".tr-calificar").hidden = false;
}

async function calificarTarjeta(valor) {
  const g = sesion.actual;
  if (!g || $("repaso-tarjetas").querySelector(".tr-calificar")?.hidden) return;
  g.repaso = repaso.repasar(g.repaso, valor);
  await almacen.glosario.guardar(g);
  sesion.vistas++;
  if (valor >= 2) sesion.aciertos++;
  if (valor === 0) sesion.cola.push(g); // "Otra vez": vuelve al final de esta sesión
  siguienteTarjeta();
}

function teclasRepaso(e) {
  if ($("vista-cuestionarios").hidden || $("repaso-tarjetas").hidden || e.target.matches("input, textarea, select")) return;
  if (e.key === " ") { e.preventDefault(); mostrarRespuesta(); }
  const c = repaso.CALIFICACIONES.find((x) => x.tecla === e.key);
  if (c) { e.preventDefault(); calificarTarjeta(c.valor); }
}

// ───────────── Cuestionario con IA ─────────────
async function pintarConfigCuestionario() {
  const libroId = ctx.libroId();
  const traducidas = libroId ? await almacen.traducciones.contar(libroId) : 0;
  const notas = libroId ? (await almacen.notas.todas(libroId)).length : 0;
  $("repaso-cuestionario").innerHTML = `
    <div class="cuestionario-config">
      <h2>📝 Cuestionario con IA</h2>
      <p>Gemini crea preguntas de opción múltiple con lo que ya estudiaste de <b>${escapar(ctx.tituloLibro() || "tu libro")}</b>:
      ${traducidas} páginas traducidas, ${notas} notas y tu glosario.</p>
      <div class="fila">
        <label class="campo"><span>Preguntas:</span>
          <select id="quiz-cantidad"><option>5</option><option selected>8</option><option>12</option></select></label>
        <button id="quiz-crear" class="boton-primario">${icono("chispa")}<span>Crear cuestionario</span></button>
      </div>
      <p class="ayuda">Usa 1 petición de Gemini.</p>
    </div>`;
  $("quiz-crear").onclick = crearCuestionario;
}

async function materialDeEstudio() {
  const libroId = ctx.libroId();
  const partes = [];
  const trad = (await almacen.traducciones.deLibro(libroId)).sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "")).slice(0, 8);
  for (const t of trad) partes.push(`## Página ${t.pagina}\n${t.texto}`);
  const notas = (await almacen.notas.todas(libroId)).slice(0, 12);
  if (notas.length) partes.push("## Notas del estudiante\n" + notas.map((n) => `- ${n.original}\n  ${n.contenido.slice(0, 600)}`).join("\n"));
  const terminos = (await almacen.glosario.todos()).filter((g) => !g.libroId || g.libroId === libroId).slice(0, 40);
  if (terminos.length) partes.push("## Glosario\n" + terminos.map((g) => `- ${g.termino}: ${g.traduccion}. ${g.explicacion || ""}`).join("\n"));
  return partes.join("\n\n");
}

async function crearCuestionario() {
  const material = await materialDeEstudio();
  if (material.length < 200) {
    avisar("Aún hay poco material: traduce algunas páginas o guarda notas de este libro primero.", "info", 6000);
    return;
  }
  const caja = $("repaso-cuestionario");
  caja.innerHTML = `<div class="cuestionario-cargando"><div class="esqueleto">${"<i></i>".repeat(6)}</div><p>Gemini está preparando tus preguntas…</p></div>`;
  const cantidad = Number($("quiz-cantidad")?.value || 8);
  try {
    const r = await gemini.crearCuestionario(material, cantidad);
    Object.assign(quiz, { preguntas: r.preguntas, indice: 0, aciertos: 0, falladas: [] });
    pintarPregunta();
  } catch (e) {
    avisar(e.message, "error", 8000);
    pintarConfigCuestionario();
  }
}

const enLinea = (texto) => markdownAHtml(texto).replace(/^<p>|<\/p>\s*$/g, "");

function pintarPregunta() {
  const caja = $("repaso-cuestionario");
  const p = quiz.preguntas[quiz.indice];
  if (!p) { pintarResultado(); return; }
  caja.innerHTML = `
    <div class="pregunta">
      <div class="repaso-progreso">Pregunta <b>${quiz.indice + 1}</b> de ${quiz.preguntas.length} · ${quiz.aciertos} correctas</div>
      <h2>${enLinea(p.pregunta)}</h2>
      <div class="opciones"></div>
      <div class="explicacion-quiz" hidden></div>
      <button class="boton-primario siguiente" hidden>Siguiente</button>
    </div>`;
  const opciones = caja.querySelector(".opciones");
  p.opciones.forEach((texto, i) => {
    const b = document.createElement("button");
    b.className = "opcion";
    b.innerHTML = `<span class="letra">${"ABCD"[i] || i + 1}</span><span>${enLinea(texto)}</span>`;
    b.onclick = () => responder(i);
    opciones.append(b);
  });
}

function responder(elegida) {
  const caja = $("repaso-cuestionario");
  const p = quiz.preguntas[quiz.indice];
  const botones = [...caja.querySelectorAll(".opcion")];
  if (botones[0].disabled) return;
  botones.forEach((b, i) => {
    b.disabled = true;
    if (i === p.correcta) b.classList.add("correcta");
    else if (i === elegida) b.classList.add("incorrecta");
  });
  const acierto = elegida === p.correcta;
  if (acierto) quiz.aciertos++; else quiz.falladas.push(p);
  const exp = caja.querySelector(".explicacion-quiz");
  exp.hidden = false;
  exp.innerHTML = `<b>${acierto ? "✅ ¡Correcto!" : "❌ No era esa."}</b> ${enLinea(p.explicacion || "")}`;
  const siguiente = caja.querySelector(".siguiente");
  siguiente.hidden = false;
  siguiente.textContent = quiz.indice + 1 < quiz.preguntas.length ? "Siguiente" : "Ver resultado";
  siguiente.onclick = () => { quiz.indice++; pintarPregunta(); };
  siguiente.focus();
}

function pintarResultado() {
  const total = quiz.preguntas.length;
  const pct = Math.round((quiz.aciertos / total) * 100);
  const mensaje = pct === 100 ? "¡Perfecto! 🏆" : pct >= 70 ? "¡Muy bien! 🎉" : pct >= 40 ? "Vas bien, repasa lo que fallaste 💪" : "Vale la pena releer esas páginas 📖";
  $("repaso-cuestionario").innerHTML = `
    <div class="repaso-fin">
      <h2>${quiz.aciertos} de ${total} correctas</h2>
      <p>${mensaje}</p>
      ${quiz.falladas.length ? `<div class="falladas"><h3>Para repasar</h3>${quiz.falladas.map((p) =>
        `<div class="fallada"><b>${enLinea(p.pregunta)}</b><p>✔ ${enLinea(p.opciones[p.correcta])}</p><small>${enLinea(p.explicacion || "")}</small></div>`).join("")}</div>` : ""}
      <button id="quiz-otro" class="boton-primario">Otro cuestionario</button>
    </div>`;
  $("quiz-otro").onclick = pintarConfigCuestionario;
}
