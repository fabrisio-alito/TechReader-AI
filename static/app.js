/* ==========================================================================
   TechReader AI — app.js (el "frontend")

   Índice del archivo:
     1. Librerías y utilidades
     2. Estado y ajustes
     3. Vistas (Lector, Mis Notas, Glosario, Cuestionarios)
     4. Libros: menú, abrir, subir
     5. Páginas: dibujar el PDF, progreso, índice
     6. Traducir página completa
     7. Selección + Asistente IA (Traducir, Explicar, Resumir, Ejemplo, Guardar)
     8. Notas
     9. Búsqueda en el libro
    10. Controles: zoom, rotar, divisor, ajustes, teclado, arrastrar PDF
    11. Arranque

   Conceptos clave:
     - fetch() llama a las rutas /api/... de servidor.py y recibe JSON.
     - async/await: esperar algo lento (red, PDF) sin congelar la página.
     - PDF.js dibuja la página en un <canvas> y pone encima una "capa de
       texto" invisible: por eso puedes seleccionar texto sobre una imagen.
   ========================================================================== */

// ───────────── 1. Librerías y utilidades ─────────────
import * as pdfjsLib from "./vendor/pdf.min.js?v=5";
import { marked } from "./vendor/marked.esm.js?v=5";
import DOMPurify from "./vendor/purify.es.js?v=5";
import hljs from "./vendor/highlight.min.js?v=5";

window.appLista = true; // le avisa a index.html que el JavaScript sí cargó
pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.js?v=5";

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;
const limitar = (v, min, max) => Math.min(Math.max(v, min), max);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const icono = (nombre) => `<svg><use href="#i-${nombre}"/></svg>`;
const escapar = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Markdown -> HTML seguro (DOMPurify quita cualquier script malicioso). */
function pintarMarkdown(elemento, md) {
  elemento.innerHTML = DOMPurify.sanitize(marked.parse(md || ""));
  elemento.querySelectorAll("pre code").forEach((bloque) => hljs.highlightElement(bloque));
}

/** Llama a la API. Si el servidor responde con error, lanza un Error con su mensaje. */
async function api(url, opciones = {}) {
  const r = await fetch(url, opciones);
  if (!r.ok) {
    let mensaje = `Error ${r.status}`;
    try { mensaje = (await r.json()).detail || mensaje; } catch { /* sin JSON */ }
    throw new Error(mensaje);
  }
  return r.json();
}
const enviarJson = (url, datos, metodo = "POST") =>
  api(url, { method: metodo, headers: { "Content-Type": "application/json" }, body: JSON.stringify(datos) });

/** Aviso pequeño abajo de la pantalla. tipo: info | exito | error */
function avisar(texto, tipo = "info", ms = 4000) {
  const div = document.createElement("div");
  div.className = `aviso-flotante ${tipo}`;
  div.textContent = texto;
  $("avisos").append(div);
  setTimeout(() => div.remove(), ms);
  return div;
}

// ───────────── 2. Estado y ajustes ─────────────
const estado = {
  vista: "lector",
  libros: [],
  archivo: null,       // nombre del PDF abierto
  pdf: null,           // documento de PDF.js
  total: 0,
  pagina: 1,
  rotacion: 0,
  info: null,          // respuesta de /api/libros/X/paginas/N
  indice: [],
  idDibujo: 0,         // para descartar dibujos viejos si cambias rápido de página
  tareaRender: null,
  traduciendo: new Set(),
  seleccion: null,     // { texto, rect } lo que tienes seleccionado ahora
  fragmento: null,     // { texto, pagina, resultados: {accion: {estado, md, modelo}}, notaId }
  notas: [],
};

const AJUSTES_INICIALES = {
  tema: "oscuro", letra: 18, interlineado: 1.65, fuente: "sans",
  pdfOscuro: false, auto: false, conImagen: false, split: 52, zoom: 1,
  nombre: "Fabrisio", ultimoLibro: null,
};
// localStorage guarda datos en el navegador. Puede fallar (modo privado),
// por eso siempre va dentro de try/catch.
function cargarAjustes() {
  try { return { ...AJUSTES_INICIALES, ...JSON.parse(localStorage.getItem("techreader-v3") || "{}") }; }
  catch { return { ...AJUSTES_INICIALES }; }
}
function guardarAjustes() {
  try { localStorage.setItem("techreader-v3", JSON.stringify(ajustes)); } catch { /* ignorar */ }
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
  $("modo-texto").setAttribute("aria-checked", String(!ajustes.conImagen));
  $("modo-imagen").setAttribute("aria-checked", String(ajustes.conImagen));
  if (estado.info) mostrarAviso(estado.info);
}

function cambiarAjuste(clave, valor) {
  ajustes[clave] = valor;
  aplicarAjustes();
  guardarAjustes();
}

// ───────────── 3. Vistas ─────────────
function cambiarVista(vista) {
  estado.vista = vista;
  for (const b of document.querySelectorAll(".nav-item")) b.classList.toggle("activo", b.dataset.vista === vista);
  for (const v of ["lector", "notas", "glosario", "cuestionarios"]) $(`vista-${v}`).hidden = v !== vista;
  ocultarBarraSeleccion();
  if (vista === "notas") pintarTodasLasNotas();
}

function cambiarPestana(nombre) {
  for (const p of document.querySelectorAll(".pestana")) p.classList.toggle("activa", p.dataset.pestana === nombre);
  for (const n of ["asistente", "pagina", "apuntes"]) $(`panel-${n}`).hidden = n !== nombre;
}

// ───────────── 4. Libros ─────────────
async function cargarLibros(seleccionar) {
  estado.libros = await api("/api/libros");
  pintarMenuLibros();
  $("bienvenida").hidden = estado.libros.length > 0;
  if (!estado.libros.length) return;

  let elegido = seleccionar || ajustes.ultimoLibro;
  if (!estado.libros.some((l) => l.archivo === elegido)) elegido = estado.libros[0].archivo;
  await abrirLibro(elegido);
}

function pintarMenuLibros() {
  const lista = $("lista-libros");
  lista.innerHTML = "";
  if (!estado.libros.length) {
    lista.innerHTML = '<div class="resultado-info">Todavía no tienes libros.</div>';
  }
  for (const libro of estado.libros) {
    const boton = document.createElement("button");
    boton.className = "item-libro" + (libro.archivo === estado.archivo ? " activo" : "");
    const avance = Math.round((libro.ultima_pagina / libro.paginas) * 100);
    boton.innerHTML = `${icono("carpeta")}<b></b>
      <small>${libro.paginas} páginas · vas en la ${libro.ultima_pagina} · ${libro.traducidas} traducidas</small>
      <span class="mini-barra"><i style="width:${avance}%"></i></span>`;
    boton.querySelector("b").textContent = libro.titulo;
    boton.onclick = () => { alternarMenuLibros(false); abrirLibro(libro.archivo); };
    lista.append(boton);
  }
  // filtro de libros en "Mis Notas"
  $("filtro-libro").innerHTML = '<option value="">Todos los libros</option>' +
    estado.libros.map((l) => `<option value="${escapar(l.archivo)}">${escapar(l.titulo)}</option>`).join("");
}

function alternarMenuLibros(mostrar = $("menu-libros").hidden) {
  $("menu-libros").hidden = !mostrar;
  $("btn-libro").setAttribute("aria-expanded", String(mostrar));
}

async function abrirLibro(archivo) {
  const libro = estado.libros.find((l) => l.archivo === archivo);
  if (!libro) return;
  if (estado.tareaPdf) await estado.tareaPdf.destroy().catch(() => {}); // PDF.js v6: se cierra con la tarea de carga
  Object.assign(estado, { archivo, pdf: null, rotacion: 0, fragmento: null, indice: [] });
  ajustes.ultimoLibro = archivo;
  guardarAjustes();
  $("titulo-libro").textContent = libro.titulo;
  document.title = `${libro.titulo} · TechReader AI`;
  $("btn-descargar").href = `/api/libros/${enc(archivo)}/pdf`;
  $("busqueda").value = "";
  pintarAsistente();
  pintarMenuLibros();

  // disableAutoFetch: PDF.js descarga solo las partes que necesita (HTTP Range).
  estado.tareaPdf = pdfjsLib.getDocument({ url: `/api/libros/${enc(archivo)}/pdf`, disableAutoFetch: true });
  estado.pdf = await estado.tareaPdf.promise;
  estado.total = estado.pdf.numPages;
  $("total").textContent = estado.total;
  $("pie-total").textContent = estado.total;
  $("numero").max = estado.total;
  $("deslizador").max = estado.total;

  api(`/api/libros/${enc(archivo)}/indice`).then((i) => { estado.indice = i; }).catch(() => {});
  cargarApuntes();
  await irA(libro.ultima_pagina || 1, { forzar: true });
}

async function subirPdf(archivo) {
  if (!archivo) return;
  if (!/\.pdf$/i.test(archivo.name)) { avisar("Solo puedo abrir archivos PDF.", "error"); return; }
  const aviso = avisar(`Subiendo «${archivo.name}»… (${Math.round(archivo.size / 1048576)} MB)`, "info", 300000);
  const datos = new FormData();
  datos.append("pdf", archivo);
  try {
    const r = await api("/api/libros", { method: "POST", body: datos });
    aviso.remove();
    avisar("Libro agregado ✔", "exito");
    cambiarVista("lector");
    await cargarLibros(r.archivo);
  } catch (e) {
    aviso.remove();
    avisar(e.message, "error", 8000);
  }
}

// ───────────── 5. Páginas ─────────────
async function irA(numero, { forzar = false } = {}) {
  if (!estado.pdf) return;
  numero = limitar(Math.round(Number(numero) || 1), 1, estado.total);
  if (numero === estado.pagina && !forzar) return;
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
  const id = ++estado.idDibujo;
  estado.tareaRender?.cancel();
  const pagina = await estado.pdf.getPage(numero);
  if (id !== estado.idDibujo) return; // mientras tanto pediste otra página

  // Escala = "ajustar al ancho del panel" × tu zoom.
  const disponible = $("pdf-scroll").clientWidth - 40;
  const rotacion = (pagina.rotate + estado.rotacion) % 360;
  const base = pagina.getViewport({ scale: 1, rotation: rotacion });
  const escala = Math.max(0.2, (disponible / base.width) * ajustes.zoom);
  const viewport = pagina.getViewport({ scale: escala, rotation: rotacion });

  // En pantallas de alta densidad dibujamos con más píxeles: texto nítido.
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

  // Variables que usa el CSS de la capa de texto (.textLayer en estilos.css).
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
  fin.className = "endOfContent"; // evita saltos raros al seleccionar
  capa.append(fin);
  capa.addEventListener("mousedown", () => capa.classList.add("seleccionando"));
  if (id !== estado.idDibujo) return;

  // Cambiamos lo viejo por lo nuevo de un golpe: así no hay parpadeo.
  $("lienzo").replaceWith(lienzo);
  $("capa-texto").replaceWith(capa);
}

async function cargarInfo(numero) {
  const archivo = estado.archivo;
  try {
    const info = await api(`/api/libros/${enc(archivo)}/paginas/${numero}`);
    if (archivo !== estado.archivo || numero !== estado.pagina) return; // respuesta vieja
    estado.info = info;
    $("texto-extraido").textContent = info.texto_extraido || "(sin texto: página escaneada o en blanco)";
    mostrarTraduccionPagina();
    actualizarProgreso();
    if (!info.traduccion && ajustes.auto) traducirPagina();
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
  if (estado.info?.capitulo) partes.push(estado.info.capitulo);
  partes.push(`Página ${estado.pagina} de ${estado.total}`);
  if (estado.info) partes.push(`${estado.info.traducidas} traducidas`);
  $("progreso-detalle").textContent = partes.join(" • ");
  $("progreso-detalle").title = partes.join(" • ");
}

function pintarIndice() {
  const menu = $("menu-indice");
  if (!estado.indice.length) {
    menu.innerHTML = '<div class="resultado-info">Este PDF no trae índice.</div>';
    return;
  }
  menu.innerHTML = "";
  for (const e of estado.indice.filter((x) => x.nivel <= 3)) {
    const b = document.createElement("button");
    b.className = `item-indice nivel-${e.nivel}`;
    if (estado.info?.capitulo && e.titulo.toLowerCase() === estado.info.capitulo.toLowerCase()) b.classList.add("actual");
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
  if (!info.tiene_texto) texto = "📷 Esta página no tiene texto seleccionable (escaneada o figura): se enviará como imagen.";
  else if (info.tiene_imagenes && !ajustes.conImagen) texto = "🖼️ Esta página tiene figuras. Elige «Texto + imagen» para que Gemini también las explique.";
  $("aviso").textContent = texto;
  $("aviso").hidden = !texto;
}

function mostrarTraduccionPagina() {
  const info = estado.info;
  if (!info) return;
  mostrarAviso(info);
  const trabajando = estado.traduciendo.has(`${estado.archivo}|${info.pagina}`);
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

async function traducirPagina() {
  if (!estado.info) return;
  cambiarPestana("pagina");
  const { archivo, pagina: numero } = estado;
  const clave = `${archivo}|${numero}`;
  if (estado.traduciendo.has(clave)) return;
  estado.traduciendo.add(clave);
  mostrarTraduccionPagina();
  try {
    const r = await enviarJson(`/api/libros/${enc(archivo)}/paginas/${numero}/traducir`, { con_imagen: ajustes.conImagen });
    if (archivo === estado.archivo && numero === estado.pagina) {
      Object.assign(estado.info, { traduccion: r.traduccion, modelo: r.modelo, traducidas: r.traducidas });
      actualizarProgreso();
    } else {
      avisar(`Página ${numero} traducida ✔`, "exito");
    }
  } catch (e) {
    avisar(e.message, "error", 8000);
  } finally {
    estado.traduciendo.delete(clave);
    if (archivo === estado.archivo && numero === estado.pagina) mostrarTraduccionPagina();
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

document.addEventListener("mouseup", (e) => {
  $("capa-texto")?.classList.remove("seleccionando");
  if (e.target.closest("#barra-seleccion")) return;
  // Solo nos interesa lo que seleccionas sobre el PDF.
  if (!e.target.closest("#pdf-scroll")) { ocultarBarraSeleccion(); return; }
  setTimeout(revisarSeleccion, 0); // esperar a que el navegador termine la selección
});

/** El texto copiado de un PDF trae saltos de línea en medio de las frases y
 *  palabras cortadas con guion. Lo unimos, salvo que parezca código. */
function limpiarSeleccion(texto) {
  const lineas = texto.split("\n");
  const pareceCodigo = lineas.filter((l) => /^\s{2,}|[{};<>]|^\s*(def|function|const|let|var|import|return)\b/.test(l)).length > lineas.length / 3;
  if (pareceCodigo) return texto.trim();
  return texto
    .replace(/(\w)[-\u00ad]\n(?=[a-záéíóúñ])/g, "$1") // "spe-\ncific" -> "specific"
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
  const { offsetWidth: ancho, offsetHeight: alto } = barra;
  let arriba = rect.bottom + 12;                                   // debajo de la selección…
  if (arriba + alto > innerHeight - 10) arriba = rect.top - alto - 12; // …o encima si no cabe
  barra.style.top = `${limitar(arriba, 10, innerHeight - alto - 10)}px`;
  barra.style.left = `${limitar(rect.left + rect.width / 2 - ancho / 2, 10, innerWidth - ancho - 10)}px`;
}

function ocultarBarraSeleccion() {
  $("barra-seleccion").hidden = true;
}

/** Botón de la barra: traducir | explicar | resumir | ejemplo | guardar */
function accionDesdeSeleccion(accion) {
  const sel = estado.seleccion;
  if (!sel) return;
  ocultarBarraSeleccion();
  // ¿Es un fragmento nuevo? Entonces empezamos tarjetas nuevas.
  if (!estado.fragmento || estado.fragmento.texto !== sel.texto) {
    estado.fragmento = { texto: sel.texto, pagina: estado.pagina, resultados: {}, notaId: null };
  }
  cambiarPestana("asistente");
  if (accion === "guardar") guardarFragmento();
  else pedirAccion(accion);
}

/** Lleva a la vista la tarjeta de una acción (para que veas lo que pediste). */
function mostrarTarjeta(accion) {
  requestAnimationFrame(() => document.querySelector(`.tipo-${accion}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
}

async function pedirAccion(accion) {
  const frag = estado.fragmento;
  if (!frag || frag.resultados[accion]?.estado === "cargando") return;
  frag.resultados[accion] = { estado: "cargando" };
  pintarAsistente();
  mostrarTarjeta(accion);
  try {
    const r = await enviarJson("/api/asistente", { archivo: estado.archivo, pagina: frag.pagina, texto: frag.texto, accion });
    frag.resultados[accion] = { estado: "listo", md: r.resultado, modelo: r.modelo, cache: r.desde_cache };
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

  // Botones para pedir lo que falta + Guardar
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
    // Si ya estaba guardado, reemplazamos la nota (por si agregaste más tarjetas).
    if (frag.notaId) await api(`/api/notas/${frag.notaId}`, { method: "DELETE" }).catch(() => {});
    const r = await enviarJson("/api/notas", { archivo: estado.archivo, pagina: frag.pagina, original: frag.texto, contenido });
    frag.notaId = r.id;
    avisar("Guardado en tus notas ✔", "exito", 2200);
    pintarAsistente();
    cargarApuntes();
  } catch (e) {
    avisar(e.message, "error");
  }
}

async function cargarApuntes() {
  if (!estado.archivo) return;
  const notas = await api(`/api/notas?archivo=${enc(estado.archivo)}`).catch(() => []);
  $("contador-apuntes").textContent = notas.length || "";
  pintarNotas($("lista-apuntes"), notas, false);
}

async function pintarTodasLasNotas() {
  estado.notas = await api("/api/notas").catch(() => []);
  filtrarNotas();
}

function filtrarNotas() {
  const q = $("filtro-notas").value.trim().toLowerCase();
  const libro = $("filtro-libro").value;
  const notas = estado.notas.filter((n) =>
    (!libro || n.archivo === libro) && (!q || (n.original + n.contenido).toLowerCase().includes(q)));
  pintarNotas($("todas-notas"), notas, true);
}

function pintarNotas(contenedor, notas, mostrarLibro) {
  contenedor.innerHTML = "";
  if (!notas.length) {
    contenedor.innerHTML = `<div class="nota-vacia">Aún no hay notas. Selecciona texto en el libro y pulsa <b>Guardar</b>.</div>`;
    return;
  }
  for (const n of notas) {
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
    if (mostrarLibro) div.querySelector(".libro-nota").textContent = n.archivo.replace(/\.pdf$/i, "");
    div.querySelector("blockquote").textContent = n.original;
    pintarMarkdown(div.querySelector(".prosa"), n.contenido || "_(sin traducción guardada)_");
    div.querySelector(".ir").onclick = async () => {
      cambiarVista("lector");
      if (n.archivo !== estado.archivo) await abrirLibro(n.archivo);
      irA(n.pagina);
    };
    div.querySelector(".borrar").onclick = async () => {
      if (!confirm("¿Eliminar esta nota?")) return;
      await api(`/api/notas/${n.id}`, { method: "DELETE" }).catch((e) => avisar(e.message, "error"));
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

$("busqueda").addEventListener("input", () => {
  clearTimeout(temporizadorBusqueda);
  temporizadorBusqueda = setTimeout(buscar, 250); // esperar a que termines de escribir
});
$("busqueda").addEventListener("focus", () => { if ($("busqueda").value.trim().length >= 2) buscar(); });
$("busqueda").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && resultadosBusqueda[0]) { irA(resultadosBusqueda[0].pagina); $("resultados").hidden = true; }
  if (e.key === "Escape") { $("resultados").hidden = true; e.target.blur(); }
});

async function buscar() {
  const q = $("busqueda").value.trim();
  const caja = $("resultados");
  if (q.length < 2 || !estado.archivo) { caja.hidden = true; return; }
  caja.hidden = false;
  caja.innerHTML = '<div class="resultado-info">Buscando…</div>';
  let r = await api(`/api/libros/${enc(estado.archivo)}/buscar?q=${enc(q)}`).catch(() => null);
  for (let intento = 0; r?.preparando && intento < 12; intento++) {
    caja.innerHTML = '<div class="resultado-info">Preparando la búsqueda (solo la primera vez)…</div>';
    await esperar(1000);
    r = await api(`/api/libros/${enc(estado.archivo)}/buscar?q=${enc(q)}`).catch(() => null);
  }
  if ($("busqueda").value.trim() !== q) return; // escribiste otra cosa mientras tanto
  resultadosBusqueda = r?.resultados || [];
  if (!resultadosBusqueda.length) { caja.innerHTML = `<div class="resultado-info">Sin resultados para «${escapar(q)}».</div>`; return; }
  const marcar = (t) => escapar(t).replace(new RegExp(escapar(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `<mark>${m}</mark>`);
  caja.innerHTML = resultadosBusqueda
    .map((x) => `<button class="resultado" data-pagina="${x.pagina}"><b>Página ${x.pagina}</b>…${marcar(x.fragmento)}…</button>`)
    .join("");
  for (const b of caja.querySelectorAll(".resultado")) b.onclick = () => { irA(b.dataset.pagina); caja.hidden = true; };
}

// ───────────── 10. Controles ─────────────
function cambiarZoom(nuevo) {
  cambiarAjuste("zoom", Math.round(limitar(nuevo, 0.5, 3) * 10) / 10);
  if (estado.pdf) dibujarPagina(estado.pagina);
}
function cambiarLetra(delta) { cambiarAjuste("letra", limitar(ajustes.letra + delta, 14, 30)); }
function abrirAjustes(mostrar = true) { $("ajustes").hidden = !mostrar; }

// Navegación principal y pestañas
for (const b of document.querySelectorAll(".nav-item")) b.onclick = () => cambiarVista(b.dataset.vista);
for (const p of document.querySelectorAll(".pestana")) p.onclick = () => cambiarPestana(p.dataset.pestana);

// Libros
$("btn-libro").onclick = (e) => { e.stopPropagation(); alternarMenuLibros(); };
$("btn-agregar").onclick = () => { alternarMenuLibros(false); $("archivo-pdf").click(); };
$("btn-agregar-2").onclick = () => $("archivo-pdf").click();
$("archivo-pdf").onchange = (e) => { subirPdf(e.target.files[0]); e.target.value = ""; };

// Páginas
$("anterior").onclick = () => irA(estado.pagina - 1);
$("siguiente").onclick = () => irA(estado.pagina + 1);
$("numero").onchange = (e) => irA(e.target.value);
$("numero").onkeydown = (e) => { if (e.key === "Enter") e.target.blur(); };
$("deslizador").oninput = (e) => { $("pie-pagina").textContent = e.target.value; };
$("deslizador").onchange = (e) => irA(e.target.value);

// Barra del PDF
$("zoom-menos").onclick = () => cambiarZoom(ajustes.zoom - 0.1);
$("zoom-mas").onclick = () => cambiarZoom(ajustes.zoom + 0.1);
$("btn-ajustar").onclick = () => cambiarZoom(1);
$("btn-rotar").onclick = () => { estado.rotacion = (estado.rotacion + 90) % 360; dibujarPagina(estado.pagina); };
$("btn-imprimir").onclick = () => estado.archivo && window.open(`/api/libros/${enc(estado.archivo)}/pdf#page=${estado.pagina}`, "_blank");
$("btn-pantalla").onclick = () => document.fullscreenElement ? document.exitFullscreen() : $("tarjeta-pdf").requestFullscreen();
$("btn-indice").onclick = (e) => { e.stopPropagation(); const m = $("menu-indice"); m.hidden = !m.hidden; if (!m.hidden) pintarIndice(); };

// Traducción de página
$("btn-traducir").onclick = traducirPagina;
$("modo-texto").onclick = () => cambiarAjuste("conImagen", false);
$("modo-imagen").onclick = () => cambiarAjuste("conImagen", true);
$("letra-menos").onclick = () => cambiarLetra(-1);
$("letra-mas").onclick = () => cambiarLetra(+1);

// Barra de selección (mousedown con preventDefault = no perder la selección)
for (const b of $("barra-seleccion").querySelectorAll("button")) {
  b.onmousedown = (e) => e.preventDefault();
  b.onclick = () => accionDesdeSeleccion(b.dataset.accion);
}

// Notas
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

// Cerrar menús al hacer clic fuera
document.addEventListener("mousedown", (e) => {
  if (!e.target.closest("#selector-libro")) alternarMenuLibros(false);
  if (!e.target.closest(".buscador")) $("resultados").hidden = true;
  if (!e.target.closest(".ancla-menu")) $("menu-indice").hidden = true;
});

// Divisor arrastrable entre el PDF y el asistente
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

// Si cambia el ancho del panel del PDF, redibujamos (con una pausa corta).
let anchoAnterior = 0;
let temporizadorAncho = null;
new ResizeObserver(([entrada]) => {
  const ancho = Math.round(entrada.contentRect.width);
  if (Math.abs(ancho - anchoAnterior) < 4) return;
  anchoAnterior = ancho;
  clearTimeout(temporizadorAncho);
  temporizadorAncho = setTimeout(() => estado.pdf && dibujarPagina(estado.pagina), 150);
}).observe($("pdf-scroll"));

// Atajos de teclado
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
    case "+": case "=": cambiarLetra(+1); break;
    case "-": cambiarLetra(-1); break;
    default: return;
  }
  e.preventDefault();
});

// Arrastrar y soltar un PDF en cualquier parte de la ventana
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
  subirPdf(e.dataTransfer.files[0]);
});
document.addEventListener("fullscreenchange", () => estado.pdf && setTimeout(() => dibujarPagina(estado.pagina), 100));

// ───────────── 11. Arranque ─────────────
aplicarAjustes();
cargarLibros().catch((e) => avisar(`No pude conectar con el servidor: ${e.message}`, "error", 15000));
