/* ==========================================================================
   laboratorio.js — "▶ Probar": ejecuta el código de los ejemplos.

   - HTML / CSS / JavaScript: se arma una página y se muestra en un <iframe>
     con sandbox. El sandbox SIN "allow-same-origin" aísla ese código: no
     puede leer tu clave, tus notas ni nada de la app.
   - Python: se ejecuta con Pyodide en un Web Worker (python-worker.js).
   - "✨ Hacer ejecutable": si el fragmento del libro está incompleto
     (por ejemplo solo CSS), Gemini arma un ejemplo mínimo que sí funciona.

   Cada bloque de código que dibuja la app recibe una barrita con
   "Copiar" y "▶ Probar" (ver alPintarMarkdown al final).
   ========================================================================== */

import { $, alPintarMarkdown, avisar, copiarTexto, esMovil, icono } from "./util.js";
import * as gemini from "./gemini.js";

const PYODIDE = "https://cdn.jsdelivr.net/npm/pyodide@314.0.8/";
const LIMITE_PYTHON_MS = 20000;
const NOMBRES = { html: "HTML", css: "CSS", js: "JavaScript", python: "Python" };

const lab = {
  pestana: "html",
  codigo: { html: "", css: "", js: "", python: "" },
  original: null,       // para "Restablecer"
  worker: null,
  temporizador: null,
  vivo: null,           // actualización en vivo (HTML/CSS/JS)
};

/** Adivina el lenguaje de un fragmento. */
export function detectarLenguaje(codigo, clase = "") {
  const c = codigo.trim();
  const porClase = (clase.match(/language-(\w+)/) || [])[1];
  if (/^(html|xml|svg)$/.test(porClase)) return "html";
  if (porClase === "css") return "css";
  if (/^(js|javascript|jsx|mjs)$/.test(porClase)) return "js";
  if (/^(py|python)$/.test(porClase)) return "python";
  if (/^\s*(<!doctype|<\w+[\s>]|<!--)/i.test(c) && /<\/?\w+[^>]*>/.test(c)) return "html";
  if (/^\s*(def |class \w+.*:|import \w+|from \w+ import|print\()/m.test(c) && !/[{};]\s*$/m.test(c)) return "python";
  if (/\b(function|const|let|var|console\.|document\.|=>|addEventListener)\b/.test(c)) return "js";
  if (/[\w\-.#:*\]\s>,]+\s*\{[^}]*:[^}]*\}/.test(c)) return "css";
  return null; // texto plano: no lo ofrecemos para ejecutar
}

// ───────────── Abrir / cerrar ─────────────
export function abrirLaboratorio(codigo = "", lenguaje = "html") {
  lab.codigo = { html: "", css: "", js: "", python: "" };
  if (lenguaje === "python") lab.codigo.python = codigo;
  else if (lenguaje === "css") {
    lab.codigo.css = codigo;
    lab.codigo.html = "<!-- Escribe aquí el HTML para ver el CSS, o usa ✨ Hacer ejecutable -->\n";
  } else lab.codigo[lenguaje] = codigo;
  lab.original = { ...lab.codigo };
  $("lab-consola").textContent = "";
  $("laboratorio").hidden = false;
  cambiarPestana(lenguaje, { guardar: false });
  mostrarMovil("codigo");
  ejecutar();
  setTimeout(() => $("lab-codigo").focus(), 50);
}

function cerrar() {
  $("laboratorio").hidden = true;
  $("lab-iframe").srcdoc = "";
  detenerPython();
}

/** Cambia de pestaña. "guardar" = primero guarda lo que hay en el editor
 *  (false cuando acabamos de poner código nuevo y el editor tiene lo viejo). */
function cambiarPestana(pestana, { guardar = true } = {}) {
  if (guardar) guardarEditor();
  lab.pestana = pestana;
  for (const b of $("lab-pestanas").children) b.classList.toggle("activo", b.dataset.pestana === pestana);
  $("lab-codigo").value = lab.codigo[pestana];
  $("lab-codigo").placeholder = pestana === "python" ? "# Escribe tu código Python…" : `Escribe tu ${NOMBRES[pestana]}…`;
  $("laboratorio").dataset.modo = pestana === "python" ? "python" : "web";
}

const guardarEditor = () => { lab.codigo[lab.pestana] = $("lab-codigo").value; };

function mostrarMovil(vista) {
  $("laboratorio").dataset.vistaMovil = vista;
  for (const b of $("lab-vista-movil").children) b.classList.toggle("activo", b.dataset.vista === vista);
}

// ───────────── Consola ─────────────
function consola(texto, nivel = "log") {
  const linea = document.createElement("div");
  linea.className = `lab-linea ${nivel}`;
  linea.textContent = texto;
  $("lab-consola").append(linea);
  $("lab-consola").scrollTop = $("lab-consola").scrollHeight;
}

// El iframe nos manda sus console.log con postMessage.
addEventListener("message", (e) => {
  if (e.source !== $("lab-iframe").contentWindow || !e.data?.__lab) return;
  consola(e.data.texto, e.data.nivel);
});

const CAPTURADOR = `<script>(function(){
  function texto(a){ try { return typeof a === "object" ? JSON.stringify(a, null, 1) : String(a); } catch (e) { return String(a); } }
  function enviar(nivel, args){ parent.postMessage({ __lab: 1, nivel: nivel, texto: Array.prototype.map.call(args, texto).join(" ") }, "*"); }
  ["log","info","warn","error"].forEach(function(n){ var o = console[n]; console[n] = function(){ enviar(n, arguments); o.apply(console, arguments); }; });
  addEventListener("error", function(e){ enviar("error", [e.message + (e.lineno ? " (línea " + e.lineno + ")" : "")]); });
  addEventListener("unhandledrejection", function(e){ enviar("error", [String(e.reason)]); });
})();<\/script>`;

/** Arma la página completa con el HTML, el CSS y el JS de las pestañas. */
function armarPagina({ html, css, js }) {
  let doc = html.trim();
  if (!/<!doctype|<html[\s>]|<body[\s>]/i.test(doc)) {
    doc = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${doc}</body></html>`;
  }
  const cabeza = `${CAPTURADOR}<style>body{font-family:system-ui,sans-serif;margin:12px}</style>${css ? `<style>${css}</style>` : ""}`;
  doc = /<head[^>]*>/i.test(doc) ? doc.replace(/<head[^>]*>/i, (m) => m + cabeza) : cabeza + doc;
  if (js) {
    const guion = `<script>${js.replace(/<\/script/gi, "<\\/script")}<\/script>`;
    doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, `${guion}</body>`) : doc + guion;
  }
  return doc;
}

// ───────────── Ejecutar ─────────────
function ejecutar() {
  guardarEditor();
  if (lab.pestana === "python") { ejecutarPython(); return; }
  $("lab-consola").textContent = "";
  $("lab-iframe").srcdoc = armarPagina(lab.codigo);
  if (esMovil()) mostrarMovil("resultado");
}

function detenerPython() {
  clearTimeout(lab.temporizador);
  if (lab.worker) { lab.worker.terminate(); lab.worker = null; }
}

function ejecutarPython() {
  $("lab-consola").textContent = "";
  if (esMovil()) mostrarMovil("resultado");
  if (!lab.worker) {
    lab.worker = new Worker(new URL("./python-worker.js", import.meta.url), { type: "module" });
    lab.worker.onmessage = ({ data }) => {
      if (data.tipo === "estado") consola(data.texto, "info");
      else if (data.tipo === "inicio") {
        clearTimeout(lab.temporizador);
        lab.temporizador = setTimeout(() => {
          detenerPython();
          consola(`⏹ Detenido: tardó más de ${LIMITE_PYTHON_MS / 1000} s (¿un bucle infinito?).`, "error");
        }, LIMITE_PYTHON_MS);
      } else if (data.tipo === "salida") consola(data.texto, data.error ? "error" : "log");
      else if (data.tipo === "fin") { clearTimeout(lab.temporizador); consola(`✔ Terminó en ${data.ms} ms`, "info"); }
      else if (data.tipo === "error") { clearTimeout(lab.temporizador); consola(data.texto, "error"); }
    };
    lab.worker.onerror = (e) => consola(`No pude iniciar Python: ${e.message || "¿sin internet?"}`, "error");
  }
  lab.worker.postMessage({ codigo: lab.codigo.python, indexURL: PYODIDE });
}

async function hacerEjecutable() {
  guardarEditor();
  const lenguaje = lab.pestana === "python" ? "python" : [lab.codigo.html && "HTML", lab.codigo.css && "CSS", lab.codigo.js && "JavaScript"].filter(Boolean).join(" + ") || "HTML";
  const codigo = lab.pestana === "python" ? lab.codigo.python
    : [lab.codigo.html && !lab.codigo.html.startsWith("<!-- Escribe") ? lab.codigo.html : "", lab.codigo.css && `/* CSS */\n${lab.codigo.css}`, lab.codigo.js && `// JavaScript\n${lab.codigo.js}`].filter(Boolean).join("\n\n");
  if (!codigo.trim()) { avisar("Primero escribe o trae un fragmento de código.", "info"); return; }
  const boton = $("lab-ia");
  boton.disabled = true;
  consola("✨ Pidiendo a Gemini un ejemplo completo…", "info");
  try {
    const r = await gemini.hacerEjecutable(codigo, lenguaje);
    if (/^py/.test(r.lenguaje) || lab.pestana === "python") {
      lab.codigo.python = r.codigo;
      cambiarPestana("python", { guardar: false });
    } else {
      lab.codigo = { html: r.codigo, css: "", js: "", python: lab.codigo.python };
      cambiarPestana("html", { guardar: false });
    }
    ejecutar();
    if (r.explicacion) consola(`💡 ${r.explicacion}`, "info");
  } catch (e) {
    consola(e.message, "error");
  } finally {
    boton.disabled = false;
  }
}

// ───────────── Eventos ─────────────
$("lab-cerrar").onclick = cerrar;
$("lab-ejecutar").onclick = ejecutar;
$("lab-ia").onclick = hacerEjecutable;
$("lab-limpiar").onclick = () => { $("lab-consola").textContent = ""; };
$("lab-restablecer").onclick = () => {
  if (!lab.original) return;
  lab.codigo = { ...lab.original };
  cambiarPestana(lab.pestana, { guardar: false });
  ejecutar();
};
$("lab-copiar").onclick = () => { guardarEditor(); copiarTexto(lab.codigo[lab.pestana]); };
for (const b of $("lab-pestanas").children) b.onclick = () => cambiarPestana(b.dataset.pestana);
for (const b of $("lab-vista-movil").children) b.onclick = () => mostrarMovil(b.dataset.vista);
$("laboratorio").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.stopPropagation(); cerrar(); }
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); ejecutar(); }
});
// En el editor, Tab inserta 2 espacios (en vez de saltar al siguiente botón).
$("lab-codigo").addEventListener("keydown", (e) => {
  if (e.key !== "Tab" || e.shiftKey) return;
  e.preventDefault();
  const t = e.target;
  const [a, b] = [t.selectionStart, t.selectionEnd];
  t.value = t.value.slice(0, a) + "  " + t.value.slice(b);
  t.selectionStart = t.selectionEnd = a + 2;
});
// HTML/CSS/JS se actualizan solos mientras escribes (con una pausa corta).
$("lab-codigo").addEventListener("input", () => {
  if (lab.pestana === "python") return;
  clearTimeout(lab.vivo);
  lab.vivo = setTimeout(() => { guardarEditor(); $("lab-iframe").srcdoc = armarPagina(lab.codigo); $("lab-consola").textContent = ""; }, 700);
});

// ───────────── Botón ▶ Probar en cada bloque de código ─────────────
alPintarMarkdown((contenedor) => {
  for (const pre of contenedor.querySelectorAll("pre")) {
    if (pre.parentElement?.classList.contains("bloque-codigo")) continue;
    const code = pre.querySelector("code");
    if (!code) continue;
    const texto = code.textContent;
    const lenguaje = detectarLenguaje(texto, code.className);
    const caja = document.createElement("div");
    caja.className = "bloque-codigo";
    const barra = document.createElement("div");
    barra.className = "barra-codigo";
    barra.innerHTML = `<span class="lenguaje">${lenguaje ? NOMBRES[lenguaje] : "Código"}</span>`;
    const copiar = document.createElement("button");
    copiar.innerHTML = `${icono("copiar")}Copiar`;
    copiar.onclick = () => copiarTexto(texto);
    barra.append(copiar);
    if (lenguaje) {
      const probar = document.createElement("button");
      probar.className = "probar";
      probar.innerHTML = `${icono("play")}Probar`;
      probar.onclick = () => abrirLaboratorio(texto.replace(/\n$/, ""), lenguaje);
      barra.append(probar);
    }
    pre.replaceWith(caja);
    caja.append(barra, pre);
  }
});
