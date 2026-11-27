/* ==========================================================================
   TechReader AI — versión web (funciona 100 % en el navegador)

   Diferencia con la versión Python (carpeta static/ + servidor.py):
     antes:  navegador ──fetch──► servidor.py ──► PyMuPDF / Gemini / SQLite
     ahora:  navegador ──► lector.js (PDF.js) / gemini.js / almacen.js (IndexedDB)
   No hay servidor: por eso se puede publicar gratis en GitHub Pages.

   Índice del archivo:
     1. Librerías y utilidades          7. Selección + Asistente IA
     2. Estado y ajustes visuales       8. Notas
     3. Vistas, pestañas y celular      9. Búsqueda en el libro
     4. Libros (agregar, abrir, borrar) 10. Ajustes: clave, PIN, respaldo
     5. Páginas (dibujar, progreso)     11. Controles, teclado, arrastrar PDF
     6. Traducir página completa        12. Arranque
   ========================================================================== */

// ───────────── 1. Librerías y utilidades ─────────────
import * as pdfjsLib from "./vendor/pdf.min.js?v=1";
import { marked } from "./vendor/marked.esm.js?v=1";
import DOMPurify from "./vendor/purify.es.js?v=1";
import hljs from "./vendor/highlight.min.js?v=1";
import * as almacen from "./js/almacen.js";
import * as gemini from "./js/gemini.js";
import * as lector from "./js/lector.js";
import * as voz from "./js/voz.js";

window.appLista = true;
pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.js?v=1";

const $ = (id) => document.getElementById(id);
const limitar = (v, min, max) => Math.min(Math.max(v, min), max);
const icono = (nombre) => `<svg><use href="#i-${nombre}"/></svg>`;
const escapar = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const esMovil = () => matchMedia("(max-width: 900px)").matches;

/** Markdown -> HTML seguro (DOMPurify quita cualquier script malicioso). */
function pintarMarkdown(elemento, md) {
  elemento.innerHTML = DOMPurify.sanitize(marked.parse(md || ""));
  elemento.querySelectorAll("pre code").forEach((b) => hljs.highlightElement(b));
}

/** Aviso pequeño abajo de la pantalla. tipo: info | exito | error */
function avisar(texto, tipo = "info", ms = 4000) {
  const div = document.createElement("div");
  div.className = `aviso-flotante ${tipo}`;
  div.textContent = texto;
  $("avisos").append(div);
  setTimeout(() => div.remove(), ms);
  return div;
}

/** Ventana que pide un texto (contraseña). Devuelve el texto o null si cancelas. */
function pedirTexto(titulo, explicacion) {
  return new Promise((resolver) => {
    $("dialogo-titulo").textContent = titulo;
    $("dialogo-texto").textContent = explicacion;
    $("dialogo-entrada").value = "";
    $("dialogo").hidden = false;
    $("dialogo-entrada").focus();
    const terminar = (valor) => { $("dialogo").hidden = true; resolver(valor); };
    $("dialogo-form").onsubmit = (e) => { e.preventDefault(); terminar($("dialogo-entrada").value); };
    $("dialogo-cancelar").onclick = () => terminar(null);
  });
}

/** Descarga un texto como archivo (sirve en PC y en celular). */
function descargar(nombre, contenido, tipo = "application/json") {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const a = Object.assign(document.createElement("a"), { href: url, download: nombre });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ───────────── 2. Estado y ajustes visuales ─────────────
const estado = {
  vista: "lector",
  libros: [],
  libro: null,          // el libro abierto (fila de almacen.libros)
  pdf: null,            // documento de PDF.js
  tareaPdf: null,       // "tarea de carga" de PDF.js (sirve para cerrarlo)
  total: 0,
  pagina: 1,
  rotacion: 0,
  info: null,           // { pagina, capitulo, traducidas, traduccion, modelo, tieneTexto, ... }
  extraidas: new Map(), // caché de texto extraído por página
  indice: [],
  textosBusqueda: null,
  idDibujo: 0,
  tareaRender: null,
  traduciendo: new Set(),
  seleccion: null,
  fragmento: null,      // { texto, pagina, resultados: {accion: {...}}, notaId }
  notas: [],
  libroPendiente: null, // libro importado al que le falta el PDF
};

const AJUSTES_INICIALES = {
  tema: "oscuro", letra: 18, interlineado: 1.65, fuente: "sans",
  pdfOscuro: false, auto: false, conImagen: false, split: 52, zoom: 1,
  nombre: "Fabrisio", ultimoLibro: null,
  vozEs: null, vozEn: null, velocidadVoz: 1, seguirLeyendo: false,
};
function cargarAjustes() {
  try { return { ...AJUSTES_INICIALES, ...JSON.parse(localStorage.getItem("techreader-web") || "{}") }; }
  catch { return { ...AJUSTES_INICIALES }; }
}
function guardarAjustes() {
  try { localStorage.setItem("techreader-web", JSON.stringify(ajustes)); } catch { /* ignorar */ }
}
const ajustes = cargarAjustes();

function aplicarAjustes() {
  const raiz = document.documentElement;
  raiz.dataset.tema = ajustes.tema;
  raiz.dataset.fuente = ajustes.fuente;
  raiz.dataset.pdfOscuro = ajustes.pdfOscuro ? "si" : "no";
  raiz.style.setProperty("--letra", `${ajustes.letra}px`);
  raiz.style.setProperty("--interlineado", ajustes.interlineado);
  raiz.style.setProperty("--split", `${ajustes.split}%`);
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(raiz).getPropertyValue("--fondo").trim() || "#0a1020";

  $("ajuste-letra").value = ajustes.letra;
  $("ajuste-letra-valor").textContent = `${ajustes.letra} px`;
  $("ajuste-interlineado").value = ajustes.interlineado;
  $("ajuste-interlineado-valor").textContent = Number(ajustes.interlineado).toFixed(1);
  $("pdf-oscuro").checked = ajustes.pdfOscuro;
  $("auto").checked = ajustes.auto;
  $("ajuste-nombre").value = ajustes.nombre;
  $("avatar").textContent = (ajustes.nombre.trim()[0] || "?").toUpperCase();
  $("zoom-valor").textContent = `${Math.round(ajustes.zoom * 100)}%`;
  for (const b of $("tema").children) b.classList.toggle("activo", b.dataset.valor === ajustes.tema);
  for (const b of $("fuente").children) b.classList.toggle("activo", b.dataset.valor === ajustes.fuente);
  $("rep-velocidad").value = String(ajustes.velocidadVoz);
  $("rep-seguir").checked = ajustes.seguirLeyendo;
  $("modo-texto").setAttribute("aria-checked", String(!ajustes.conImagen));
  $("modo-imagen").setAttribute("aria-checked", String(ajustes.conImagen));
  if (estado.info) mostrarAviso(estado.info);
}

function cambiarAjuste(clave, valor) {
  ajustes[clave] = valor;
  aplicarAjustes();
  guardarAjustes();
}

// ───────────── 3. Vistas, pestañas y celular ─────────────
function cambiarVista(vista) {
  estado.vista = vista;
  for (const b of document.querySelectorAll(".nav-item")) b.classList.toggle("activo", b.dataset.vista === vista);
  for (const v of ["lector", "notas", "glosario", "cuestionarios"]) $(`vista-${v}`).hidden = v !== vista;
  ocultarBarraSeleccion();
  if (vista === "notas") pintarTodasLasNotas();
  marcarBarraMovil();
}

function cambiarPestana(nombre) {
  for (const p of document.querySelectorAll(".pestana")) p.classList.toggle("activa", p.dataset.pestana === nombre);
  for (const n of ["asistente", "pagina", "apuntes"]) $(`panel-${n}`).hidden = n !== nombre;
}

/** En el celular se ve un panel a la vez: "pdf", "asistente" o la vista "notas". */
function cambiarPanelMovil(panel) {
  if (panel === "notas") { cambiarVista("notas"); return; }
  if (estado.vista !== "lector") cambiarVista("lector");
  $("area").dataset.panelMovil = panel;
  marcarBarraMovil();
}

function marcarBarraMovil() {
  const activo = estado.vista === "notas" ? "notas" : $("area").dataset.panelMovil;
  for (const b of document.querySelectorAll(".barra-movil button")) b.classList.toggle("activo", b.dataset.movil === activo);
}

// ───────────── 4. Libros ─────────────
async function cargarLibros(seleccionar) {
  estado.libros = (await almacen.libros.todos()).sort((a, b) => (b.actualizado || "").localeCompare(a.actualizado || ""));
  pintarMenuLibros();
  $("bienvenida").hidden = estado.libros.length > 0;
  if (!estado.libros.length) { actualizarPasoClave(); return; }
  let elegido = seleccionar || ajustes.ultimoLibro;
  if (!estado.libros.some((l) => l.id === elegido)) elegido = estado.libros[0].id;
  await abrirLibro(elegido);
}

function pintarMenuLibros() {
  const lista = $("lista-libros");
  lista.innerHTML = "";
  if (!estado.libros.length) lista.innerHTML = '<div class="resultado-info">Todavía no tienes libros en este dispositivo.</div>';
  for (const libro of estado.libros) {
    const fila = document.createElement("div");
    fila.className = "item-libro-fila";
    const avance = Math.round(((libro.ultimaPagina || 1) / libro.paginas) * 100);
    const boton = document.createElement("button");
    boton.className = "item-libro" + (libro.id === estado.libro?.id ? " activo" : "");
    boton.innerHTML = `${icono("carpeta")}<b></b>
      <small>${libro.paginas} págs. · vas en la ${libro.ultimaPagina || 1}${libro.archivo ? "" : " · ⚠️ falta el PDF aquí"}</small>
      <span class="mini-barra"><i style="width:${avance}%"></i></span>`;
    boton.querySelector("b").textContent = libro.titulo || libro.nombre;
    boton.onclick = () => { alternarMenuLibros(false); abrirLibro(libro.id); };
    const borrar = document.createElement("button");
    borrar.className = "boton-icono";
    borrar.title = "Quitar el PDF de este dispositivo";
    borrar.innerHTML = icono("papelera");
    borrar.onclick = () => quitarLibro(libro);
    fila.append(boton, borrar);
    lista.append(fila);
  }
  $("filtro-libro").innerHTML = '<option value="">Todos los libros</option>' +
    estado.libros.map((l) => `<option value="${escapar(l.id)}">${escapar(l.titulo || l.nombre)}</option>`).join("");
}

function alternarMenuLibros(mostrar = $("menu-libros").hidden) {
  $("menu-libros").hidden = !mostrar;
  $("btn-libro").setAttribute("aria-expanded", String(mostrar));
}

async function abrirLibro(id) {
  const libro = await almacen.libros.obtener(id);
  if (!libro) return;
  // Cerramos el libro anterior (en PDF.js v6 se cierra con la "tarea de carga").
  if (estado.tareaPdf) { await estado.tareaPdf.destroy().catch(() => {}); estado.tareaPdf = null; estado.pdf = null; }
  lectorVoz.detener();
  Object.assign(estado, { libro, rotacion: 0, fragmento: null, indice: [], textosBusqueda: null, extraidas: new Map(), info: null });
  ajustes.ultimoLibro = id;
  guardarAjustes();
  $("titulo-libro").textContent = libro.titulo || libro.nombre;
  document.title = `${libro.titulo || libro.nombre} · TechReader AI`;
  $("busqueda").value = "";
  pintarAsistente();
  pintarMenuLibros();
  cargarApuntes();

  // Libro que vino en un respaldo pero sin el PDF: pedimos el archivo.
  const falta = !libro.archivo;
  $("sin-pdf").hidden = !falta;
  $("pagina").hidden = falta;
  if (falta) {
    estado.libroPendiente = libro;
    estado.total = libro.paginas;
    $("total").textContent = $("pie-total").textContent = libro.paginas;
    return;
  }

  try {
    const datos = await libro.archivo.arrayBuffer();
    estado.tareaPdf = pdfjsLib.getDocument({ data: datos });
    estado.pdf = await estado.tareaPdf.promise;
  } catch (e) {
    avisar(`No pude abrir el PDF: ${e.message}`, "error", 8000);
    return;
  }
  estado.total = estado.pdf.numPages;
  $("total").textContent = $("pie-total").textContent = estado.total;
  $("numero").max = $("deslizador").max = estado.total;
  lector.leerIndice(estado.pdf).then((i) => { estado.indice = i; actualizarProgreso(); }).catch(() => {});
  await irA(libro.ultimaPagina || 1, { forzar: true });
}

/** Agrega un PDF a este dispositivo (o completa uno que vino en un respaldo). */
async function agregarPdf(archivo) {
  if (!archivo) return;
  if (!/\.pdf$/i.test(archivo.name) && archivo.type !== "application/pdf") { avisar("Solo puedo abrir archivos PDF.", "error"); return; }
  const aviso = avisar(`Guardando «${archivo.name}» en este dispositivo…`, "info", 120000);
  try {
    // Abrimos el PDF una vez solo para contar sus páginas.
    const tareaPrueba = pdfjsLib.getDocument({ data: await archivo.arrayBuffer() });
    const paginas = (await tareaPrueba.promise).numPages;
    await tareaPrueba.destroy();

    let id = almacen.idLibro(archivo.name, paginas);
    const pendiente = estado.libroPendiente;
    // Si estabas completando un libro importado con el mismo nº de páginas, lo unimos aunque cambie el nombre.
    if (pendiente && pendiente.paginas === paginas) id = pendiente.id;
    const existente = await almacen.libros.obtener(id);
    const titulo = existente?.titulo || archivo.name.replace(/\.pdf$/i, "");
    await almacen.libros.guardar({
      id, nombre: archivo.name, titulo, paginas,
      archivo, tamano: archivo.size,
      ultimaPagina: existente?.ultimaPagina || 1,
      agregado: existente?.agregado || new Date().toISOString(),
      actualizado: new Date().toISOString(),
    });
    estado.libroPendiente = null;
    await almacen.pedirPersistencia();
    aviso.remove();
    avisar("Libro guardado en este dispositivo ✔", "exito");
    cambiarVista("lector");
    await cargarLibros(id);
  } catch (e) {
    aviso.remove();
    const sinEspacio = e?.name === "QuotaExceededError";
    avisar(sinEspacio ? "No hay espacio suficiente en este dispositivo para guardar el PDF." : `No pude guardar el PDF: ${e.message}`, "error", 8000);
  }
}

async function quitarLibro(libro) {
  if (!confirm(`¿Quitar «${libro.titulo || libro.nombre}» de este dispositivo?\n\nSe borra el PDF y su progreso aquí. Tus notas se conservan.`)) return;
  await almacen.libros.borrar(libro.id);
  if (estado.libro?.id === libro.id) { estado.libro = null; ajustes.ultimoLibro = null; guardarAjustes(); }
  alternarMenuLibros(false);
  await cargarLibros();
}

// ───────────── 5. Páginas ─────────────
async function irA(numero, { forzar = false, desdeLectura = false } = {}) {
  if (!estado.pdf) return;
  numero = limitar(Math.round(Number(numero) || 1), 1, estado.total);
  if (numero === estado.pagina && !forzar) return;
  if (!desdeLectura && lectorVoz.estado !== "detenido" && contextoVoz?.tipo !== "tarjeta") lectorVoz.detener();
  estado.pagina = numero;
  $("numero").value = numero;
  $("deslizador").value = numero;
  $("pie-pagina").textContent = numero;
  actualizarProgreso();
  ocultarBarraSeleccion();
  $("pdf-scroll").scrollTop = 0;
  $("panel-pagina").scrollTop = 0;
  await Promise.all([dibujarPagina(numero), cargarInfo(numero)]);
}

/** Dibuja la página con PDF.js: canvas (imagen) + capa de texto (seleccionable). */
async function dibujarPagina(numero) {
  if (!estado.pdf) return;
  const id = ++estado.idDibujo;
  estado.tareaRender?.cancel();
  const pagina = await estado.pdf.getPage(numero);
  if (id !== estado.idDibujo) return;

  const disponible = $("pdf-scroll").clientWidth - (esMovil() ? 12 : 40);
  if (disponible <= 0) return; // panel oculto (celular): se dibuja al mostrarlo
  const rotacion = (pagina.rotate + estado.rotacion) % 360;
  const base = pagina.getViewport({ scale: 1, rotation: rotacion });
  const escala = Math.max(0.2, (disponible / base.width) * ajustes.zoom);
  const viewport = pagina.getViewport({ scale: escala, rotation: rotacion });

  const ratio = window.devicePixelRatio || 1;
  const lienzo = document.createElement("canvas");
  lienzo.id = "lienzo";
  lienzo.width = Math.floor(viewport.width * ratio);
  lienzo.height = Math.floor(viewport.height * ratio);
  lienzo.style.width = `${Math.floor(viewport.width)}px`;
  lienzo.style.height = `${Math.floor(viewport.height)}px`;

  estado.tareaRender = pagina.render({
    canvasContext: lienzo.getContext("2d"),
    viewport,
    transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
  });
  try { await estado.tareaRender.promise; }
  catch (e) { if (e?.name === "RenderingCancelledException") return; throw e; }
  if (id !== estado.idDibujo) return;

  const div = $("pagina");
  div.style.width = lienzo.style.width;
  div.style.height = lienzo.style.height;
  div.style.setProperty("--scale-factor", escala);
  div.style.setProperty("--total-scale-factor", escala);
  div.style.setProperty("--scale-round-x", "1px");
  div.style.setProperty("--scale-round-y", "1px");

  const capa = document.createElement("div");
  capa.className = "textLayer";
  capa.id = "capa-texto";
  await new pdfjsLib.TextLayer({ textContentSource: pagina.streamTextContent(), container: capa, viewport }).render();
  const fin = document.createElement("div");
  fin.className = "endOfContent";
  capa.append(fin);
  capa.addEventListener("mousedown", () => capa.classList.add("seleccionando"));
  if (id !== estado.idDibujo) return;
  $("lienzo").replaceWith(lienzo);
  $("capa-texto").replaceWith(capa);
}

async function extraer(numero) {
  if (!estado.extraidas.has(numero)) {
    estado.extraidas.set(numero, await lector.extraerPagina(await estado.pdf.getPage(numero), pdfjsLib));
  }
  return estado.extraidas.get(numero);
}

async function cargarInfo(numero) {
  const libro = estado.libro;
  try {
    const [datos, guardada, traducidas] = await Promise.all([
      extraer(numero),
      almacen.traducciones.obtener(libro.id, numero),
      almacen.traducciones.contar(libro.id),
    ]);
    almacen.libros.marcarPagina(libro.id, numero);
    libro.ultimaPagina = numero;
    if (libro !== estado.libro || numero !== estado.pagina) return;
    estado.info = {
      pagina: numero,
      traducidas,
      traduccion: guardada?.texto || null,
      modelo: guardada?.modelo || null,
      ...datos,
    };
    $("texto-extraido").textContent = datos.texto || "(sin texto: página escaneada o en blanco)";
    mostrarTraduccionPagina();
    actualizarProgreso();
    if (!estado.info.traduccion && ajustes.auto) traducirPagina();
  } catch (e) {
    avisar(e.message, "error");
  }
}

function actualizarProgreso() {
  if (!estado.total) return;
  const pct = Math.round((estado.pagina / estado.total) * 100);
  $("progreso-relleno").style.width = `${pct}%`;
  $("progreso-porcentaje").textContent = `${pct}%`;
  const partes = [];
  const cap = lector.capitulo(estado.indice, estado.pagina);
  if (cap) partes.push(cap);
  partes.push(`Página ${estado.pagina} de ${estado.total}`);
  if (estado.info) partes.push(`${estado.info.traducidas} traducidas`);
  $("progreso-detalle").textContent = $("progreso-detalle").title = partes.join(" • ");
}

function pintarIndice() {
  const menu = $("menu-indice");
  if (!estado.indice.length) { menu.innerHTML = '<div class="resultado-info">Este PDF no trae índice.</div>'; return; }
  menu.innerHTML = "";
  const actual = lector.capitulo(estado.indice, estado.pagina).toLowerCase();
  for (const e of estado.indice) {
    const b = document.createElement("button");
    b.className = `item-indice nivel-${e.nivel}`;
    if (actual && e.titulo.toLowerCase() === actual) b.classList.add("actual");
    b.innerHTML = "<span></span><span></span>";
    b.children[0].textContent = e.titulo;
    b.children[1].textContent = e.pagina;
    b.onclick = () => { menu.hidden = true; irA(e.pagina); };
    menu.append(b);
  }
  menu.querySelector(".actual")?.scrollIntoView({ block: "center" });
}

// ───────────── 6. Traducir página completa ─────────────
function mostrarAviso(info) {
  let texto = "";
  if (!info.tieneTexto) texto = "📷 Esta página no tiene texto seleccionable (escaneada o figura): se enviará como imagen.";
  else if (info.tieneImagenes && !ajustes.conImagen) texto = "🖼️ Esta página tiene figuras. Elige «Texto + imagen» para que Gemini también las explique.";
  $("aviso").textContent = texto;
  $("aviso").hidden = !texto;
}

function mostrarTraduccionPagina() {
  const info = estado.info;
  if (!info) return;
  mostrarAviso(info);
  const trabajando = estado.traduciendo.has(`${estado.libro.id}|${info.pagina}`);
  const boton = $("btn-traducir");
  boton.disabled = trabajando;
  boton.classList.toggle("secundario", Boolean(info.traduccion));
  boton.querySelector("span").textContent = trabajando ? "Traduciendo…" : info.traduccion ? "Volver a traducir" : "Traducir página";

  const est = $("estado-pagina");
  if (trabajando) {
    est.className = "estado-pagina trabajando";
    est.innerHTML = '<span class="punto"></span>Traduciendo la página con Gemini…';
    $("traduccion").innerHTML = `<div class="esqueleto">${"<i></i>".repeat(12)}</div>`;
  } else if (info.traduccion) {
    est.className = "estado-pagina guardada";
    est.innerHTML = '<span class="punto"></span>';
    est.append(`Página ${info.pagina} traducida · ${info.modelo || ""}`);
    pintarMarkdown($("traduccion"), info.traduccion);
  } else {
    est.className = "estado-pagina";
    est.innerHTML = `<span class="punto"></span>La página ${info.pagina} aún no está traducida.`;
    $("traduccion").innerHTML = "";
  }
}

/** Dibuja la página en un canvas aparte y la devuelve como PNG en base64. */
async function imagenDePagina(numero) {
  const pagina = await estado.pdf.getPage(numero);
  const viewport = pagina.getViewport({ scale: 1.6 });
  const lienzo = document.createElement("canvas");
  lienzo.width = Math.floor(viewport.width);
  lienzo.height = Math.floor(viewport.height);
  await pagina.render({ canvasContext: lienzo.getContext("2d"), viewport }).promise;
  return lienzo.toDataURL("image/png").split(",")[1];
}

async function traducirPagina() {
  if (!estado.info || !estado.pdf) return;
  cambiarPestana("pagina");
  if (esMovil()) cambiarPanelMovil("asistente");
  const { libro, pagina: numero } = estado;
  const clave = `${libro.id}|${numero}`;
  if (estado.traduciendo.has(clave)) return;
  estado.traduciendo.add(clave);
  mostrarTraduccionPagina();
  try {
    const datos = await extraer(numero);
    const conImagen = ajustes.conImagen || !datos.tieneTexto;
    const png = conImagen ? await imagenDePagina(numero) : null;
    const r = await gemini.traducirPagina(datos.tieneTexto ? datos.texto : null, png);
    await almacen.traducciones.guardar(libro.id, numero, r.texto, r.modelo);
    if (libro === estado.libro && numero === estado.pagina) {
      Object.assign(estado.info, { traduccion: r.texto, modelo: r.modelo, traducidas: await almacen.traducciones.contar(libro.id) });
      actualizarProgreso();
    } else {
      avisar(`Página ${numero} traducida ✔`, "exito");
    }
  } catch (e) {
    avisar(e.message, "error", 8000);
  } finally {
    estado.traduciendo.delete(clave);
    if (libro === estado.libro && numero === estado.pagina) mostrarTraduccionPagina();
  }
}

// ───────────── 7. Selección + Asistente IA ─────────────
const ACCIONES = {
  traducir: { titulo: "Traducción al Español", icono: "check", copiar: "Copiar" },
  explicar: { titulo: "Explicación Sencilla", icono: "bombilla", copiar: "Copiar" },
  ejemplo: { titulo: "Ejemplo de código", icono: "codigo", copiar: "Copiar código" },
  resumir: { titulo: "Resumen del Concepto", icono: "esquema", copiar: "Copiar" },
};
const BOTONES_MAS = { traducir: ["traducir", "Traducir"], explicar: ["bombilla", "Explicar"], ejemplo: ["codigo", "Ejemplo"], resumir: ["documento", "Resumir"] };

// En la PC: al soltar el mouse. En el celular: cuando cambia la selección (pulsación larga).
document.addEventListener("mouseup", (e) => {
  $("capa-texto")?.classList.remove("seleccionando");
  if (esMovil() || e.target.closest("#barra-seleccion")) return;
  if (!e.target.closest("#pdf-scroll")) { ocultarBarraSeleccion(); return; }
  setTimeout(revisarSeleccion, 0);
});
let temporizadorSeleccion = null;
document.addEventListener("selectionchange", () => {
  if (!esMovil()) return;
  clearTimeout(temporizadorSeleccion);
  temporizadorSeleccion = setTimeout(revisarSeleccion, 350);
});

/** El texto copiado de un PDF trae saltos de línea en medio de las frases.
 *  Lo unimos, salvo que parezca código. */
function limpiarSeleccion(texto) {
  const lineas = texto.split("\n");
  const pareceCodigo = lineas.filter((l) => /^\s{2,}|[{};<>]|^\s*(def|function|const|let|var|import|return)\b/.test(l)).length > lineas.length / 3;
  if (pareceCodigo) return texto.trim();
  return texto
    .replace(/(\w)[-­]\n(?=[a-záéíóúñ])/g, "$1")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function revisarSeleccion() {
  const sel = window.getSelection();
  const texto = limpiarSeleccion(sel?.toString() || "");
  if (texto.length < 2 || !sel.rangeCount || !$("capa-texto").contains(sel.anchorNode)) {
    ocultarBarraSeleccion();
    return;
  }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  estado.seleccion = { texto, rect };
  const barra = $("barra-seleccion");
  barra.hidden = false;
  if (esMovil()) return; // en el celular la barra va fija abajo (CSS)
  const { offsetWidth: ancho, offsetHeight: alto } = barra;
  let arriba = rect.bottom + 12;
  if (arriba + alto > innerHeight - 10) arriba = rect.top - alto - 12;
  barra.style.top = `${limitar(arriba, 10, innerHeight - alto - 10)}px`;
  barra.style.left = `${limitar(rect.left + rect.width / 2 - ancho / 2, 10, innerWidth - ancho - 10)}px`;
}

function ocultarBarraSeleccion() { $("barra-seleccion").hidden = true; }

function accionDesdeSeleccion(accion) {
  const sel = estado.seleccion;
  if (!sel) return;
  ocultarBarraSeleccion();
  if (!estado.fragmento || estado.fragmento.texto !== sel.texto) {
    estado.fragmento = { texto: sel.texto, pagina: estado.pagina, resultados: {}, notaId: null };
  }
  cambiarPestana("asistente");
  if (esMovil()) { window.getSelection()?.removeAllRanges(); cambiarPanelMovil("asistente"); }
  if (accion === "guardar") guardarFragmento();
  else pedirAccion(accion);
}

function mostrarTarjeta(accion) {
  requestAnimationFrame(() => document.querySelector(`.tipo-${accion}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
}

async function pedirAccion(accion) {
  const frag = estado.fragmento;
  if (!frag || frag.resultados[accion]?.estado === "cargando") return;
  frag.resultados[accion] = { estado: "cargando" };
  pintarAsistente();
  mostrarTarjeta(accion);
  const libroId = estado.libro.id;
  try {
    const guardado = await almacen.asistente.buscar(libroId, accion, frag.texto);
    if (guardado) {
      frag.resultados[accion] = { estado: "listo", md: guardado.resultado, modelo: guardado.modelo, cache: true };
    } else {
      const r = await gemini.usarAsistente(frag.texto, accion, estado.libro.titulo || "");
      await almacen.asistente.guardar({ libroId, pagina: frag.pagina, accion, original: frag.texto, resultado: r.texto, modelo: r.modelo });
      frag.resultados[accion] = { estado: "listo", md: r.texto, modelo: r.modelo };
    }
  } catch (e) {
    frag.resultados[accion] = { estado: "error", md: e.message };
  }
  if (estado.fragmento === frag) { pintarAsistente(); mostrarTarjeta(accion); }
}

function pintarAsistente() {
  const frag = estado.fragmento;
  $("asistente-vacio").hidden = Boolean(frag);
  $("asistente-contenido").hidden = !frag;
  if (!frag) return;
  $("fragmento-pagina").textContent = frag.pagina;
  $("fragmento-texto").textContent = frag.texto;

  const contenedor = $("tarjetas");
  contenedor.innerHTML = "";
  for (const [accion, def] of Object.entries(ACCIONES)) {
    const res = frag.resultados[accion];
    if (!res) continue;
    const tarjeta = document.createElement("article");
    tarjeta.className = `resultado-ia tipo-${accion}` + (res.estado === "error" ? " error" : "");
    tarjeta.innerHTML = `<header>${icono(def.icono)}<h4>${def.titulo}</h4></header><div class="cuerpo"></div>`;
    const cuerpo = tarjeta.querySelector(".cuerpo");
    if (res.estado === "cargando") {
      cuerpo.innerHTML = `<div class="esqueleto">${"<i></i>".repeat(3)}</div>`;
    } else if (res.estado === "error") {
      cuerpo.textContent = `⚠️ ${res.md}`;
      const reintentar = document.createElement("button");
      reintentar.className = "boton-chico";
      reintentar.textContent = "Reintentar";
      reintentar.onclick = () => pedirAccion(accion);
      tarjeta.querySelector("header").append(reintentar);
    } else {
      pintarMarkdown(cuerpo, res.md);
      if (voz.disponible) {
        const escuchar = document.createElement("button");
        escuchar.className = "boton-chico voz";
        escuchar.title = "Escuchar";
        escuchar.innerHTML = icono("altavoz");
        escuchar.onclick = () => escucharElemento(cuerpo, def.titulo);
        tarjeta.querySelector("header").append(escuchar);
      }
      const copiar = document.createElement("button");
      copiar.className = "boton-chico";
      copiar.innerHTML = `${icono("copiar")}${def.copiar}`;
      copiar.onclick = () => copiarTexto(accion === "ejemplo" ? (cuerpo.querySelector("pre")?.textContent || res.md) : res.md);
      tarjeta.querySelector("header").append(copiar);
      const pie = document.createElement("div");
      pie.className = "modelo";
      pie.textContent = res.cache ? `Guardado antes · ${res.modelo}` : res.modelo;
      tarjeta.append(pie);
    }
    contenedor.append(tarjeta);
  }

  const mas = $("mas-acciones");
  mas.innerHTML = "";
  for (const [accion, [ic, texto]] of Object.entries(BOTONES_MAS)) {
    if (frag.resultados[accion]) continue;
    const b = document.createElement("button");
    b.innerHTML = `${icono(ic)}${texto}`;
    b.onclick = () => pedirAccion(accion);
    mas.append(b);
  }
  const guardar = document.createElement("button");
  guardar.className = "guardar" + (frag.notaId ? " hecho" : "");
  guardar.innerHTML = frag.notaId ? `${icono("check-circulo")}Guardado en notas` : `${icono("marcador")}Guardar en notas`;
  guardar.onclick = guardarFragmento;
  mas.append(guardar);
}

async function copiarTexto(texto) {
  try { await navigator.clipboard.writeText(texto); avisar("Copiado ✔", "exito", 1800); }
  catch { avisar("No se pudo copiar", "error"); }
}

// ───────────── 8. Notas ─────────────
async function guardarFragmento() {
  const frag = estado.fragmento;
  if (!frag) return;
  const contenido = Object.entries(ACCIONES)
    .filter(([accion]) => frag.resultados[accion]?.estado === "listo")
    .map(([accion, def]) => `**${def.titulo}**\n\n${frag.resultados[accion].md}`)
    .join("\n\n");
  try {
    if (frag.notaId) await almacen.notas.borrar(frag.notaId); // reemplazamos (por si agregaste tarjetas)
    frag.notaId = await almacen.notas.guardar({
      libroId: estado.libro.id, libroNombre: estado.libro.titulo || estado.libro.nombre,
      pagina: frag.pagina, original: frag.texto, contenido,
    });
    avisar("Guardado en tus notas ✔", "exito", 2200);
    pintarAsistente();
    cargarApuntes();
  } catch (e) {
    avisar(e.message, "error");
  }
}

async function cargarApuntes() {
  if (!estado.libro) return;
  const lista = await almacen.notas.todas(estado.libro.id);
  $("contador-apuntes").textContent = lista.length || "";
  pintarNotas($("lista-apuntes"), lista, false);
}

async function pintarTodasLasNotas() {
  estado.notas = await almacen.notas.todas();
  filtrarNotas();
}

function filtrarNotas() {
  const q = $("filtro-notas").value.trim().toLowerCase();
  const libro = $("filtro-libro").value;
  pintarNotas($("todas-notas"), estado.notas.filter((n) =>
    (!libro || n.libroId === libro) && (!q || (n.original + n.contenido).toLowerCase().includes(q))), true);
}

function pintarNotas(contenedor, lista, mostrarLibro) {
  contenedor.innerHTML = "";
  if (!lista.length) {
    contenedor.innerHTML = '<div class="nota-vacia">Aún no hay notas. Selecciona texto en el libro y pulsa <b>Guardar</b>.</div>';
    return;
  }
  for (const n of lista) {
    const div = document.createElement("article");
    div.className = "nota";
    div.innerHTML = `
      <header>
        ${mostrarLibro ? '<span class="libro-nota"></span> ·' : ""}
        <span>Página ${n.pagina}</span>
        <span class="acciones-nota">
          <button class="boton-chico ir">Ir a la página</button>
          <button class="boton-chico borrar" title="Eliminar nota">${icono("papelera")}</button>
        </span>
      </header>
      <blockquote></blockquote>
      <div class="prosa"></div>`;
    if (mostrarLibro) div.querySelector(".libro-nota").textContent = n.libroNombre || n.libroId.split("|")[0];
    div.querySelector("blockquote").textContent = n.original;
    pintarMarkdown(div.querySelector(".prosa"), n.contenido || "_(sin traducción guardada)_");
    div.querySelector(".ir").onclick = async () => {
      if (!(await almacen.libros.obtener(n.libroId))) { avisar("Ese libro no está en este dispositivo. Agrégalo primero.", "error"); return; }
      cambiarPanelMovil("pdf");
      cambiarVista("lector");
      if (n.libroId !== estado.libro?.id) await abrirLibro(n.libroId);
      irA(n.pagina);
    };
    div.querySelector(".borrar").onclick = async () => {
      if (!confirm("¿Eliminar esta nota?")) return;
      await almacen.notas.borrar(n.id);
      if (estado.fragmento?.notaId === n.id) { estado.fragmento.notaId = null; pintarAsistente(); }
      cargarApuntes();
      if (estado.vista === "notas") pintarTodasLasNotas();
    };
    contenedor.append(div);
  }
}

// ───────────── 9. Búsqueda en el libro ─────────────
let temporizadorBusqueda = null;
let resultadosBusqueda = [];

/** Prepara el texto de todo el libro (una sola vez por dispositivo; luego se guarda). */
async function prepararBusqueda(caja) {
  if (estado.textosBusqueda) return estado.textosBusqueda;
  const libro = estado.libro;
  const guardado = await almacen.textos.obtener(libro.id);
  if (guardado) return (estado.textosBusqueda = guardado.paginas);
  const textos = await lector.textosParaBuscar(estado.pdf, (n, total) => {
    caja.innerHTML = `<div class="resultado-info">Preparando la búsqueda (solo la primera vez): ${Math.round((n / total) * 100)}%</div>`;
  });
  await almacen.textos.guardar(libro.id, textos);
  if (libro === estado.libro) estado.textosBusqueda = textos;
  return textos;
}

async function buscar() {
  const q = $("busqueda").value.trim();
  const caja = $("resultados");
  if (q.length < 2 || !estado.pdf) { caja.hidden = true; return; }
  caja.hidden = false;
  caja.innerHTML = '<div class="resultado-info">Buscando…</div>';
  const textos = await prepararBusqueda(caja);
  if ($("busqueda").value.trim() !== q) return;
  resultadosBusqueda = lector.buscar(textos, q);
  if (!resultadosBusqueda.length) { caja.innerHTML = `<div class="resultado-info">Sin resultados para «${escapar(q)}».</div>`; return; }
  const patron = new RegExp(escapar(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  caja.innerHTML = resultadosBusqueda
    .map((x) => `<button class="resultado" data-pagina="${x.pagina}"><b>Página ${x.pagina}</b>…${escapar(x.fragmento).replace(patron, (m) => `<mark>${m}</mark>`)}…</button>`)
    .join("");
  for (const b of caja.querySelectorAll(".resultado")) b.onclick = () => irDesdeBusqueda(b.dataset.pagina);
}

function irDesdeBusqueda(pagina) {
  $("resultados").hidden = true;
  $("buscador").classList.remove("abierto");
  cambiarPanelMovil("pdf");
  irA(pagina);
}

$("busqueda").addEventListener("input", () => { clearTimeout(temporizadorBusqueda); temporizadorBusqueda = setTimeout(buscar, 300); });
$("busqueda").addEventListener("focus", () => { if ($("busqueda").value.trim().length >= 2) buscar(); });
$("busqueda").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && resultadosBusqueda[0]) irDesdeBusqueda(resultadosBusqueda[0].pagina);
  if (e.key === "Escape") { $("resultados").hidden = true; $("buscador").classList.remove("abierto"); e.target.blur(); }
});
$("btn-buscar-movil").onclick = () => { $("buscador").classList.add("abierto"); $("busqueda").focus(); };

// ───────────── 9b. Lectura en voz alta ─────────────
let contextoVoz = null;     // { tipo: "pagina" | "ingles" | "tarjeta", pagina, titulo }
let bloqueResaltado = null;
let bloqueoPantalla = null; // "wake lock": evita que el celular apague la pantalla

const lectorVoz = new voz.Lector({
  alCambiar(indice, total) {
    bloqueResaltado?.classList.remove("leyendo");
    const bloque = lectorVoz.bloques[indice];
    if (bloque?.elemento?.isConnected) {
      bloqueResaltado = bloque.elemento;
      bloqueResaltado.classList.add("leyendo");
      bloqueResaltado.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    $("rep-avance").textContent = `Párrafo ${indice + 1} de ${total}`;
  },
  alEstado(e) {
    $("reproductor").hidden = e === "detenido";
    $("rep-play").innerHTML = icono(e === "leyendo" ? "pausa" : "play");
    if (e === "leyendo") mantenerPantalla(true);
    else mantenerPantalla(false);
  },
  alTerminar(completo) {
    bloqueResaltado?.classList.remove("leyendo");
    bloqueResaltado = null;
    if (completo && contextoVoz?.tipo !== "tarjeta" && ajustes.seguirLeyendo) seguirConLaSiguiente();
  },
});

async function mantenerPantalla(activar) {
  try {
    if (activar && !bloqueoPantalla && navigator.wakeLock) bloqueoPantalla = await navigator.wakeLock.request("screen");
    if (!activar && bloqueoPantalla) { await bloqueoPantalla.release(); bloqueoPantalla = null; }
  } catch { /* no todos los navegadores lo permiten */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && lectorVoz.estado === "leyendo") { bloqueoPantalla = null; mantenerPantalla(true); }
});

async function vozElegida(idioma) {
  const lista = await voz.voces(idioma);
  return voz.mejorVoz(lista, idioma === "es" ? ajustes.vozEs : ajustes.vozEn);
}

function avisarSinVoz() {
  avisar("Tu navegador no tiene lectura en voz alta. Prueba con Chrome, Edge o Safari actualizados.", "error", 6000);
}

/** Lee en voz alta cualquier contenedor ya dibujado (traducción, tarjeta…). */
async function escucharElemento(contenedor, titulo, tipo = "tarjeta") {
  if (!voz.disponible) { avisarSinVoz(); return; }
  const bloques = voz.bloquesDe(contenedor);
  if (!bloques.length) { avisar("No hay texto para leer.", "info"); return; }
  contextoVoz = { tipo, pagina: estado.pagina, titulo };
  $("rep-titulo").textContent = titulo;
  lectorVoz.leer(bloques, { voz: await vozElegida("es"), velocidad: ajustes.velocidadVoz, idioma: "es-ES" });
}

/** Escucha la traducción de la página actual (si no existe, la traduce antes). */
async function escucharPagina() {
  if (!voz.disponible) { avisarSinVoz(); return; }
  if (!estado.info) return;
  cambiarPestana("pagina");
  if (esMovil()) cambiarPanelMovil("asistente");
  if (!estado.info.traduccion) {
    await traducirPagina();
    await esperarTraduccion();
    if (!estado.info?.traduccion) return; // falló la traducción (ya se mostró el error)
  }
  await escucharElemento($("traduccion"), `Página ${estado.pagina} · traducción`, "pagina");
}

/** Espera a que termine una traducción que ya estaba en curso (máx. 90 s). */
async function esperarTraduccion() {
  const clave = () => `${estado.libro?.id}|${estado.pagina}`;
  for (let i = 0; i < 300 && estado.traduciendo.has(clave()); i++) await new Promise((r) => setTimeout(r, 300));
}

/** Escucha el texto ORIGINAL en inglés (para practicar pronunciación). */
async function escucharIngles() {
  if (!voz.disponible) { avisarSinVoz(); return; }
  const datos = await extraer(estado.pagina);
  if (!datos.tieneTexto) { avisar("Esta página no tiene texto para leer.", "info"); return; }
  const temporal = document.createElement("div");
  temporal.innerHTML = DOMPurify.sanitize(marked.parse(datos.texto.replace(/\[\/?(RECUADRO|FIGURA)\]/g, "")));
  const bloques = voz.bloquesDe(temporal);
  contextoVoz = { tipo: "ingles", pagina: estado.pagina };
  $("rep-titulo").textContent = `Página ${estado.pagina} · original en inglés`;
  const vozEn = await vozElegida("en");
  if (!vozEn) avisar("No encontré una voz en inglés en este dispositivo; se usará la voz por defecto.", "info", 5000);
  lectorVoz.leer(bloques, { voz: vozEn, velocidad: ajustes.velocidadVoz, idioma: "en-US" });
}

/** Modo audiolibro: al terminar una página, pasa a la siguiente y sigue leyendo. */
async function seguirConLaSiguiente() {
  const tipo = contextoVoz?.tipo;
  if (estado.pagina >= estado.total) { avisar("Llegaste al final del libro 🎉", "exito"); return; }
  await irA(estado.pagina + 1, { desdeLectura: true });
  if (tipo === "ingles") escucharIngles();
  else escucharPagina();
}

async function llenarVoces() {
  if (!voz.disponible) return;
  for (const [idioma, id, clave] of [["es", "ajuste-voz-es", "vozEs"], ["en", "ajuste-voz-en", "vozEn"]]) {
    const lista = await voz.voces(idioma);
    const elegida = voz.mejorVoz(lista, ajustes[clave]);
    $(id).innerHTML = lista.length
      ? lista.map((v) => `<option value="${escapar(v.voiceURI)}">${escapar(v.name)} (${escapar(v.lang)})</option>`).join("")
      : '<option value="">(no hay voces en este idioma)</option>';
    if (elegida) $(id).value = elegida.voiceURI;
  }
}

async function probarVoz(idioma) {
  if (!voz.disponible) { avisarSinVoz(); return; }
  const v = await vozElegida(idioma);
  const temporal = document.createElement("p");
  temporal.textContent = idioma === "es"
    ? "Hola. Así suena tu libro traducido al español."
    : "Hello. This is how the original English text sounds.";
  contextoVoz = { tipo: "tarjeta" };
  $("rep-titulo").textContent = "Prueba de voz";
  lectorVoz.leer([{ elemento: null, texto: temporal.textContent }], { voz: v, velocidad: ajustes.velocidadVoz, idioma: idioma === "es" ? "es-ES" : "en-US" });
}

$("btn-escuchar").onclick = escucharPagina;
$("btn-escuchar-ingles").onclick = escucharIngles;
$("rep-play").onclick = () => lectorVoz.alternar();
$("rep-anterior").onclick = () => lectorVoz.saltar(-1);
$("rep-siguiente").onclick = () => lectorVoz.saltar(+1);
$("rep-cerrar").onclick = () => lectorVoz.detener();
$("rep-velocidad").onchange = (e) => { cambiarAjuste("velocidadVoz", Number(e.target.value)); lectorVoz.cambiarVelocidad(ajustes.velocidadVoz); };
$("rep-seguir").onchange = (e) => cambiarAjuste("seguirLeyendo", e.target.checked);
$("ajuste-voz-es").onchange = (e) => cambiarAjuste("vozEs", e.target.value);
$("ajuste-voz-en").onchange = (e) => cambiarAjuste("vozEn", e.target.value);
$("probar-voz-es").onclick = () => probarVoz("es");
$("probar-voz-en").onclick = () => probarVoz("en");
if (!voz.disponible) document.querySelectorAll(".acciones-voz").forEach((e) => e.hidden = true);

// ───────────── 10. Ajustes: clave, PIN, respaldo ─────────────
async function abrirAjustes(mostrar = true) {
  $("ajustes").hidden = !mostrar;
  if (!mostrar) return;
  const clave = await gemini.obtenerClave();
  $("ajuste-clave").value = "";
  $("ajuste-clave").placeholder = clave ? `Guardada (termina en …${clave.slice(-4)})` : "AIza…";
  $("estado-clave").textContent = clave ? "✔ configurada" : "⚠️ falta";
  $("ajuste-modelos").value = (await gemini.obtenerModelos()).join(", ");
  $("estado-pin").textContent = (await almacen.config.obtener("pin")) ? "✔ activado" : "desactivado";
  llenarVoces();
  const esp = await almacen.espacio();
  $("espacio-usado").textContent = esp ? `Usas ${esp.usadoMB} MB de ${esp.totalMB} MB disponibles.` : "";
}

/** Comprueba la clave con Google, elige modelos y la guarda. */
async function guardarClave(clave) {
  clave = clave.trim();
  if (!clave) throw new Error("Pega tu clave primero.");
  const disponibles = await gemini.listarModelos(clave);
  const elegidos = gemini.elegirModelos(disponibles);
  if (!elegidos.length) throw new Error("La clave funciona, pero no encontré modelos de texto disponibles.");
  await almacen.config.guardar("geminiClave", clave);
  await almacen.config.guardar("geminiModelos", elegidos);
  return elegidos;
}

async function actualizarPasoClave() {
  const clave = await gemini.obtenerClave();
  $("paso-clave-estado").textContent = clave ? "✔ lista" : "";
  $("paso-clave").classList.toggle("hecho", Boolean(clave));
}

// Cifrado de la clave para el respaldo: contraseña -> PBKDF2 -> llave AES-GCM.
const aB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const desdeB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function derivarLlave(contrasena, sal) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(contrasena), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: sal, iterations: 250000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function cifrar(texto, contrasena) {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const datos = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await derivarLlave(contrasena, sal), new TextEncoder().encode(texto));
  return { sal: aB64(sal), iv: aB64(iv), datos: aB64(datos) };
}
async function descifrar(paquete, contrasena) {
  const llave = await derivarLlave(contrasena, desdeB64(paquete.sal));
  const plano = await crypto.subtle.decrypt({ name: "AES-GCM", iv: desdeB64(paquete.iv) }, llave, desdeB64(paquete.datos));
  return new TextDecoder().decode(plano);
}
async function hashPin(pin, sal) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${sal}:${pin}`));
  return aB64(bytes);
}

async function exportarRespaldo() {
  const datos = await almacen.exportarDatos();
  datos.modelos = await gemini.obtenerModelos();
  if ($("respaldo-con-clave").checked) {
    const clave = await gemini.obtenerClave();
    if (!clave) { avisar("No hay clave guardada para incluir.", "error"); return; }
    const c1 = await pedirTexto("Contraseña del respaldo", "Con esta contraseña se cifra tu clave de Gemini. La necesitarás al importar el respaldo en otro dispositivo.");
    if (!c1) return;
    const c2 = await pedirTexto("Repite la contraseña", "Escríbela de nuevo para confirmar.");
    if (c1 !== c2) { avisar("Las contraseñas no coinciden.", "error"); return; }
    datos.claveCifrada = await cifrar(clave, c1);
  }
  const fecha = new Date().toISOString().slice(0, 10);
  descargar(`techreader-respaldo-${fecha}.json`, JSON.stringify(datos));
  avisar("Respaldo descargado ✔", "exito");
}

async function importarRespaldo(archivo) {
  if (!archivo) return;
  try {
    const datos = JSON.parse(await archivo.text());
    const r = await almacen.importarDatos(datos);
    if (datos.claveCifrada) {
      const contrasena = await pedirTexto("Contraseña del respaldo", "Este respaldo trae tu clave de Gemini cifrada. Escribe la contraseña que usaste al crearlo.");
      if (contrasena) {
        try {
          await almacen.config.guardar("geminiClave", await descifrar(datos.claveCifrada, contrasena));
          if (datos.modelos?.length) await almacen.config.guardar("geminiModelos", datos.modelos);
          avisar("Clave de Gemini restaurada ✔", "exito");
        } catch { avisar("Contraseña incorrecta: la clave no se restauró (el resto sí).", "error", 7000); }
      }
    } else if (datos.modelos?.length && !(await gemini.obtenerModelos()).length) {
      await almacen.config.guardar("geminiModelos", datos.modelos);
    }
    avisar(`Importado: ${r.libros} libros, ${r.traducciones} páginas traducidas, ${r.asistente} resultados y ${r.notas} notas.`, "exito", 7000);
    abrirAjustes(false);
    await cargarLibros();
  } catch (e) {
    avisar(`No pude importar: ${e.message}`, "error", 8000);
  }
}

async function comprobarPin() {
  const pin = await almacen.config.obtener("pin");
  if (!pin) return true;
  $("bloqueo").hidden = false;
  setTimeout(() => $("pin-entrada").focus(), 50);
  return new Promise((resolver) => {
    $("form-pin").onsubmit = async (e) => {
      e.preventDefault();
      if ((await hashPin($("pin-entrada").value, pin.sal)) === pin.hash) {
        $("bloqueo").hidden = true;
        resolver(true);
      } else {
        $("pin-entrada").value = "";
        avisar("PIN incorrecto", "error", 2000);
      }
    };
  });
}

// ───────────── 11. Controles ─────────────
function cambiarZoom(nuevo) {
  cambiarAjuste("zoom", Math.round(limitar(nuevo, 0.5, 3) * 10) / 10);
  if (estado.pdf) dibujarPagina(estado.pagina);
}
function cambiarLetra(delta) { cambiarAjuste("letra", limitar(ajustes.letra + delta, 14, 30)); }

for (const b of document.querySelectorAll(".nav-item")) b.onclick = () => cambiarVista(b.dataset.vista);
for (const p of document.querySelectorAll(".pestana")) p.onclick = () => cambiarPestana(p.dataset.pestana);
for (const b of document.querySelectorAll(".barra-movil button")) b.onclick = () => cambiarPanelMovil(b.dataset.movil);

$("btn-libro").onclick = (e) => { e.stopPropagation(); alternarMenuLibros(); };
$("btn-agregar").onclick = () => { alternarMenuLibros(false); estado.libroPendiente = null; $("archivo-pdf").click(); };
$("btn-agregar-faltante").onclick = () => $("archivo-pdf").click();
$("bienvenida-pdf").onclick = () => $("archivo-pdf").click();
$("archivo-pdf").onchange = (e) => { agregarPdf(e.target.files[0]); e.target.value = ""; };
$("bienvenida-importar").onclick = () => $("archivo-respaldo").click();
$("btn-importar").onclick = () => $("archivo-respaldo").click();
$("archivo-respaldo").onchange = (e) => { importarRespaldo(e.target.files[0]); e.target.value = ""; };
$("btn-exportar").onclick = exportarRespaldo;

$("anterior").onclick = () => irA(estado.pagina - 1);
$("siguiente").onclick = () => irA(estado.pagina + 1);
$("numero").onchange = (e) => irA(e.target.value);
$("numero").onkeydown = (e) => { if (e.key === "Enter") e.target.blur(); };
$("deslizador").oninput = (e) => { $("pie-pagina").textContent = e.target.value; };
$("deslizador").onchange = (e) => irA(e.target.value);

$("zoom-menos").onclick = () => cambiarZoom(ajustes.zoom - 0.1);
$("zoom-mas").onclick = () => cambiarZoom(ajustes.zoom + 0.1);
$("btn-ajustar").onclick = () => cambiarZoom(1);
$("btn-rotar").onclick = () => { estado.rotacion = (estado.rotacion + 90) % 360; dibujarPagina(estado.pagina); };
$("btn-pantalla").onclick = () => document.fullscreenElement ? document.exitFullscreen() : $("tarjeta-pdf").requestFullscreen();
$("btn-indice").onclick = (e) => { e.stopPropagation(); const m = $("menu-indice"); m.hidden = !m.hidden; if (!m.hidden) pintarIndice(); };

$("btn-traducir").onclick = traducirPagina;
$("modo-texto").onclick = () => cambiarAjuste("conImagen", false);
$("modo-imagen").onclick = () => cambiarAjuste("conImagen", true);
$("letra-menos").onclick = () => cambiarLetra(-1);
$("letra-mas").onclick = () => cambiarLetra(+1);

for (const b of $("barra-seleccion").querySelectorAll("button")) {
  b.onmousedown = (e) => e.preventDefault();       // no perder la selección (PC)
  b.onpointerdown = (e) => e.preventDefault();     // ni en pantallas táctiles
  b.onclick = () => accionDesdeSeleccion(b.dataset.accion);
}

$("filtro-notas").oninput = filtrarNotas;
$("filtro-libro").onchange = filtrarNotas;

// Ajustes
$("btn-ajustes").onclick = () => abrirAjustes(true);
$("avatar").onclick = () => abrirAjustes(true);
$("ajustes-cerrar").onclick = () => abrirAjustes(false);
$("ajustes").onclick = (e) => { if (e.target === $("ajustes")) abrirAjustes(false); };
$("ajuste-letra").oninput = (e) => cambiarAjuste("letra", Number(e.target.value));
$("ajuste-interlineado").oninput = (e) => cambiarAjuste("interlineado", Number(e.target.value));
$("ajuste-nombre").oninput = (e) => cambiarAjuste("nombre", e.target.value);
$("pdf-oscuro").onchange = (e) => cambiarAjuste("pdfOscuro", e.target.checked);
$("auto").onchange = (e) => cambiarAjuste("auto", e.target.checked);
$("tema").onclick = (e) => e.target.dataset.valor && cambiarAjuste("tema", e.target.dataset.valor);
$("fuente").onclick = (e) => e.target.dataset.valor && cambiarAjuste("fuente", e.target.dataset.valor);

async function probarClaveDesde(campo, boton) {
  const original = boton.textContent;
  boton.disabled = true;
  boton.textContent = "Probando…";
  try {
    const modelos = await guardarClave(campo.value || (await gemini.obtenerClave()));
    campo.value = "";
    avisar(`Clave guardada ✔ Modelos: ${modelos.join(", ")}`, "exito", 6000);
    return true;
  } catch (e) {
    avisar(e.message, "error", 8000);
    return false;
  } finally {
    boton.disabled = false;
    boton.textContent = original;
  }
}
$("probar-clave").onclick = async () => { if (await probarClaveDesde($("ajuste-clave"), $("probar-clave"))) abrirAjustes(true); };
$("bienvenida-probar").onclick = async () => { await probarClaveDesde($("bienvenida-clave"), $("bienvenida-probar")); actualizarPasoClave(); };
$("ajuste-modelos").onchange = async (e) => {
  const lista = e.target.value.split(",").map((m) => m.trim()).filter(Boolean);
  await almacen.config.guardar("geminiModelos", lista);
  avisar("Modelos actualizados ✔", "exito", 2000);
};
$("guardar-pin").onclick = async () => {
  const pin = $("ajuste-pin").value.trim();
  if (!/^\d{4,12}$/.test(pin)) { avisar("El PIN debe tener de 4 a 12 dígitos.", "error"); return; }
  const sal = aB64(crypto.getRandomValues(new Uint8Array(16)));
  await almacen.config.guardar("pin", { sal, hash: await hashPin(pin, sal) });
  $("ajuste-pin").value = "";
  avisar("PIN activado ✔", "exito");
  abrirAjustes(true);
};
$("quitar-pin").onclick = async () => { await almacen.config.borrar("pin"); avisar("PIN desactivado", "info"); abrirAjustes(true); };
async function salirDelDispositivo() {
  if (!confirm("¿Borrar TODO de este dispositivo?\n\nSe eliminan tus libros, notas, traducciones, tu clave y el PIN de este navegador. Te recomiendo descargar un respaldo antes.")) return;
  await almacen.borrarTodo();
  try { localStorage.removeItem("techreader-web"); } catch { /* ignorar */ }
  location.reload();
}
$("btn-salir").onclick = salirDelDispositivo;
$("pin-olvide").onclick = salirDelDispositivo;

// Cerrar menús al tocar fuera
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest("#selector-libro")) alternarMenuLibros(false);
  if (!e.target.closest(".buscador")) { $("resultados").hidden = true; $("buscador").classList.remove("abierto"); }
  if (!e.target.closest(".ancla-menu")) $("menu-indice").hidden = true;
});

// Divisor arrastrable (solo PC)
(function () {
  const divisor = $("divisor");
  let arrastrando = false;
  divisor.addEventListener("pointerdown", (e) => { arrastrando = true; divisor.classList.add("arrastrando"); divisor.setPointerCapture(e.pointerId); });
  divisor.addEventListener("pointermove", (e) => {
    if (!arrastrando) return;
    const r = $("area").getBoundingClientRect();
    ajustes.split = Math.round(limitar(((e.clientX - r.left) / r.width) * 100, 30, 72));
    document.documentElement.style.setProperty("--split", `${ajustes.split}%`);
  });
  divisor.addEventListener("pointerup", () => { arrastrando = false; divisor.classList.remove("arrastrando"); guardarAjustes(); });
})();

// Redibujar si cambia el ancho del panel del PDF (girar el celular, mostrar el panel…)
let anchoAnterior = 0;
let temporizadorAncho = null;
new ResizeObserver(([entrada]) => {
  const ancho = Math.round(entrada.contentRect.width);
  if (Math.abs(ancho - anchoAnterior) < 4) return;
  anchoAnterior = ancho;
  clearTimeout(temporizadorAncho);
  temporizadorAncho = setTimeout(() => estado.pdf && dibujarPagina(estado.pagina), 150);
}).observe($("pdf-scroll"));

// Teclado
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && estado.vista === "lector") {
    e.preventDefault(); $("busqueda").focus(); $("busqueda").select(); return;
  }
  if (e.key === "Escape") {
    ocultarBarraSeleccion(); abrirAjustes(false); alternarMenuLibros(false);
    $("menu-indice").hidden = true; $("resultados").hidden = true;
    return;
  }
  if (e.target.matches("input, select, textarea") || e.ctrlKey || e.metaKey || e.altKey || estado.vista !== "lector") return;
  const haySeleccion = !$("barra-seleccion").hidden;
  switch (e.key) {
    case "ArrowLeft": case "PageUp": irA(estado.pagina - 1); break;
    case "ArrowRight": case "PageDown": irA(estado.pagina + 1); break;
    case "t": case "T": haySeleccion ? accionDesdeSeleccion("traducir") : traducirPagina(); break;
    case "e": case "E": if (haySeleccion) accionDesdeSeleccion("explicar"); else return; break;
    case "l": case "L": lectorVoz.estado === "detenido" ? escucharPagina() : lectorVoz.alternar(); break;
    case "+": case "=": cambiarLetra(+1); break;
    case "-": cambiarLetra(-1); break;
    default: return;
  }
  e.preventDefault();
});

// Arrastrar y soltar un PDF (PC)
let contadorArrastre = 0;
addEventListener("dragenter", (e) => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  contadorArrastre++;
  $("soltar").hidden = false;
});
addEventListener("dragleave", () => { if (--contadorArrastre <= 0) { contadorArrastre = 0; $("soltar").hidden = true; } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault();
  contadorArrastre = 0;
  $("soltar").hidden = true;
  const archivo = e.dataTransfer.files[0];
  if (archivo && /\.json$/i.test(archivo.name)) importarRespaldo(archivo);
  else agregarPdf(archivo);
});
document.addEventListener("fullscreenchange", () => estado.pdf && setTimeout(() => dibujarPagina(estado.pagina), 100));

// Instalar como app (Chrome/Edge/Android muestran este evento)
let pedidoInstalacion = null;
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  pedidoInstalacion = e;
  $("btn-instalar").hidden = false;
});
$("btn-instalar").onclick = async () => {
  if (!pedidoInstalacion) return;
  pedidoInstalacion.prompt();
  await pedidoInstalacion.userChoice;
  pedidoInstalacion = null;
  $("btn-instalar").hidden = true;
};

// ───────────── 12. Arranque ─────────────
async function iniciar() {
  aplicarAjustes();
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  await comprobarPin();
  await cargarLibros();
  if (estado.libros.length && !(await gemini.obtenerClave())) {
    avisar("Falta tu clave de Gemini para usar la IA: ⚙️ Ajustes → Gemini.", "info", 7000);
  }
}
iniciar().catch((e) => avisar(`Error al iniciar: ${e.message}`, "error", 15000));
