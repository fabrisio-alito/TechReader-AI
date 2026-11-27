/* ==========================================================================
   lector.js — Extrae el texto de una página del PDF en Markdown.

   Es la traducción a JavaScript de lector.py (versión Python). Misma idea:
     - títulos (letra más grande)         -> "## Título"
     - prosa                              -> párrafos
     - código (fuente monoespaciada)      -> bloques ```
     - recuadros laterales (sidebars)     -> [RECUADRO] ... [/RECUADRO]
     - cabeceras y números de página      -> se ignoran

   Diferencia con PyMuPDF: PDF.js no agrupa el texto en "bloques"; nos da
   trocitos (items) con su posición y fuente. Así que primero armamos
   LÍNEAS, luego BLOQUES (líneas seguidas en la misma columna) y desde ahí
   aplicamos exactamente las mismas reglas que en Python.

   Coordenadas: en un PDF la y crece hacia ARRIBA (origen abajo-izquierda).
   Las convertimos a "y hacia abajo" (como en pantalla) para pensar igual
   que en lector.py.
   ========================================================================== */

const MARGEN = 0.07;                       // 7 % superior/inferior = cabecera/pie
const FIN_DE_FRASE = /[.:!?;)"”’]$/;
const VINETAS = /^[•●▪◦■–]\s*/;      // símbolos de listas

// ───────────── 1. Items -> líneas ─────────────
function armarLineas(contenido, altoPagina) {
  const esMono = (item) => contenido.styles[item.fontName]?.fontFamily === "monospace";
  const lineas = [];
  let actual = null;

  const cerrar = () => {
    if (!actual) return;
    const visibles = actual.items.filter((i) => i.str.trim());
    if (visibles.length) {
      const total = visibles.reduce((s, i) => s + i.str.trim().length, 0);
      const mono = visibles.filter(esMono).reduce((s, i) => s + i.str.trim().length, 0);
      const primero = actual.items.find((i) => i.str.length) || visibles[0];
      lineas.push({
        x0: primero.transform[4],
        x1: Math.max(...visibles.map((i) => i.transform[4] + i.width)),
        y: altoPagina - actual.y,                        // y hacia abajo (línea base)
        tam: Math.max(...visibles.filter((i) => /\w/.test(i.str)).map((i) => Math.abs(i.transform[3])), 0)
             || Math.abs(visibles[0].transform[3]),
        tamCodigo: Math.abs((visibles.find(esMono) || visibles[0]).transform[3]),
        textoCrudo: actual.items.map((i) => i.str).join(""),
        textoProsa: conCodigoEnLinea(actual.items, esMono),
        esCodigo: mono / (total || 1) > 0.6,
        caracteres: total,
      });
    }
    actual = null;
  };

  for (const item of contenido.items) {
    if (item.str === undefined) continue;               // marcas de contenido
    const y = item.transform[5];
    const tam = Math.abs(item.transform[3]) || 10;
    if (actual && item.str && Math.abs(y - actual.y) > tam * 0.6) cerrar();
    if (item.str) {
      if (!actual) actual = { y, items: [] };
      actual.items.push(item);
    }
    if (item.hasEOL) cerrar();
  }
  cerrar();
  return lineas;
}

/** Une los items de una línea marcando el código dentro de la frase: `print()`.
 *  Agrupa items seguidos con la misma fuente (los espacios se pegan al grupo actual). */
function conCodigoEnLinea(items, esMono) {
  const grupos = [];
  for (const item of items) {
    const soloEspacio = !item.str.trim();
    const mono = !soloEspacio && esMono(item);
    const ultimo = grupos.at(-1);
    if (ultimo && (soloEspacio || ultimo.mono === mono)) ultimo.texto += item.str;
    else grupos.push({ mono, texto: item.str });
  }
  return grupos.map((g) => {
    if (!g.mono) return g.texto;
    const antes = g.texto.match(/^\s*/)[0];
    const despues = g.texto.match(/\s*$/)[0];
    return `${antes}\`${g.texto.trim()}\`${despues}`;
  }).join("");
}

// ───────────── 2. Líneas -> bloques ─────────────
function armarBloques(lineas) {
  const bloques = [];
  let bloque = null;
  for (const l of lineas) {
    const anterior = bloque?.lineas.at(-1);
    const mismaColumna = anterior && l.x0 < bloque.x1 && l.x1 > bloque.x0;
    const salto = anterior ? l.y - anterior.y : 0;
    const continua = anterior && mismaColumna && salto > 0 && salto <= Math.max(anterior.tam, l.tam) * 1.7;
    if (!continua) {
      bloque = { lineas: [], x0: l.x0, x1: l.x1, yArriba: l.y - l.tam, yAbajo: l.y };
      bloques.push(bloque);
    }
    bloque.lineas.push(l);
    bloque.x0 = Math.min(bloque.x0, l.x0);
    bloque.x1 = Math.max(bloque.x1, l.x1);
    bloque.yAbajo = l.y;
  }
  for (const b of bloques) b.caracteres = b.lineas.reduce((s, l) => s + l.caracteres, 0);
  return bloques;
}

// ───────────── 3. Análisis de la página (igual que lector.py) ─────────────
function tamanoCuerpo(bloques) {
  const conteo = new Map();
  for (const b of bloques) for (const l of b.lineas) {
    if (l.esCodigo) continue;
    const t = Math.round(l.tam * 10) / 10;
    conteo.set(t, (conteo.get(t) || 0) + l.caracteres);
  }
  let mejor = 10, max = -1;
  for (const [t, c] of conteo) if (c > max) { mejor = t; max = c; }
  return mejor;
}

function columnaPrincipal(bloques) {
  const conteo = new Map();
  for (const b of bloques) {
    const clave = `${Math.round(b.x0 / 20)}|${Math.round(b.x1 / 20)}`;
    conteo.set(clave, (conteo.get(clave) || 0) + b.caracteres);
  }
  let mejor = "0|0", max = -1;
  for (const [k, c] of conteo) if (c > max) { mejor = k; max = c; }
  const [a, b] = mejor.split("|").map(Number);
  return [a * 20, b * 20];
}

function esLateral(bloque, [c0, c1]) {
  const ancho = Math.max(bloque.x1 - bloque.x0, 1);
  const superposicion = Math.max(0, Math.min(bloque.x1, c1) - Math.max(bloque.x0, c0));
  return superposicion / ancho < 0.3;
}

function unir(texto, linea) {
  linea = linea.trim();
  texto = texto.trimEnd();
  if (/[-­]$/.test(texto) && /^[a-záéíóúñ]/.test(linea)) return texto.slice(0, -1) + linea;
  return `${texto} ${linea}`.trim();
}

/** Bloque -> partes: ["titulo", str] | ["prosa", str] | ["codigo", [lineas]] */
function partesDeBloque(bloque, cuerpo) {
  const partes = [];
  for (const l of bloque.lineas) {
    if (l.esCodigo) {
      const ultima = partes.at(-1);
      if (ultima?.[0] === "codigo") ultima[1].push(l);
      else partes.push(["codigo", [l]]);
      continue;
    }
    const limpio = l.textoProsa.trim();
    if (VINETAS.test(limpio)) {
      partes.push(["prosa", "- " + limpio.replace(VINETAS, "")]);
      continue;
    }
    const tipo = l.tam > cuerpo * 1.15 ? "titulo" : "prosa";
    const ultima = partes.at(-1);
    if (ultima?.[0] === tipo) ultima[1] = unir(ultima[1], limpio);
    else partes.push([tipo, limpio]);
  }
  return partes;
}

/** Reconstruye un bloque de código: sangría por posición x y líneas en blanco. */
function dibujarCodigo(lineas) {
  const xMin = Math.min(...lineas.map((l) => l.x0));
  const salida = [];
  let yAnterior = null;
  for (const l of lineas) {
    const tam = l.tamCodigo || l.tam || 10;
    if (yAnterior !== null && l.y - yAnterior > tam * 1.9) salida.push("");
    yAnterior = l.y;
    const espacios = Math.max(0, Math.round((l.x0 - xMin) / (tam * 0.6)));
    salida.push(" ".repeat(espacios) + l.textoCrudo.trimEnd());
  }
  return "```\n" + salida.join("\n") + "\n```";
}

function aMarkdown(partes) {
  // Dos trozos de código seguidos = el mismo listado.
  const juntas = [];
  for (const [tipo, dato] of partes) {
    const ultima = juntas.at(-1);
    if (tipo === "codigo" && ultima?.[0] === "codigo") ultima[1] = ultima[1].concat(dato);
    else juntas.push([tipo, Array.isArray(dato) ? [...dato] : dato]);
  }
  const salida = [];
  let anterior = null;
  for (const [tipo, dato] of juntas) {
    if (tipo === "codigo") salida.push(dibujarCodigo(dato));
    else if (tipo === "titulo") salida.push("## " + dato);
    else if (tipo === "prosa") {
      const ultima = salida.at(-1) || "";
      if (dato.startsWith("- ") && ultima.split("\n").at(-1).startsWith("- ")) {
        salida[salida.length - 1] += "\n" + dato;            // lista: un elemento por línea
      } else if (anterior === "prosa" && ultima && !FIN_DE_FRASE.test(ultima) && /^[a-záéíóúñ]/.test(dato)) {
        salida[salida.length - 1] = unir(ultima, dato);        // párrafo partido en dos bloques
      } else {
        salida.push(dato);
      }
    } else salida.push(dato);
    anterior = tipo;
  }
  return salida.filter((s) => s.trim()).join("\n\n");
}

// ───────────── 4. Función principal ─────────────

/** Extrae la página (objeto de PDF.js) como Markdown.
 *  Devuelve { texto, tieneTexto, tieneImagenes }. */
export async function extraerPagina(pagina, pdfjsLib) {
  const [ , , , altoPagina] = pagina.view;
  const contenido = await pagina.getTextContent();
  const lineas = armarLineas(contenido, altoPagina);

  // Fuera cabeceras, pies y números de página.
  const bloques = armarBloques(lineas).filter((b) => {
    const enMargen = b.yAbajo < altoPagina * MARGEN || b.yArriba > altoPagina * (1 - MARGEN);
    return !(enMargen && b.caracteres < 80);
  });

  // Para detectar páginas "collage" (Head First): muchos bloques chiquitos sueltos.
  const totalCar = bloques.reduce((s, b) => s + b.caracteres, 0);
  const chicos = bloques.filter((b) => b.caracteres < 40);
  const sueltos = { cantidad: chicos.length, proporcion: totalCar ? chicos.reduce((s, b) => s + b.caracteres, 0) / totalCar : 0 };

  let texto = "";
  if (bloques.length) {
    const cuerpo = tamanoCuerpo(bloques);
    const columna = columnaPrincipal(bloques);
    const lateral = bloques.filter((b) => esLateral(b, columna)).reduce((s, b) => s + b.caracteres, 0);
    const total = bloques.reduce((s, b) => s + b.caracteres, 0);
    const separar = lateral < (total - lateral) * 0.6;   // si no, es un libro a dos columnas

    const principal = [];
    const recuadros = [];
    let ultimoLateral = false;
    for (const b of bloques) {
      if (separar && esLateral(b, columna)) {
        if (!ultimoLateral) recuadros.push([]);
        recuadros.at(-1).push(...partesDeBloque(b, cuerpo));
        ultimoLateral = true;
      } else {
        principal.push(...partesDeBloque(b, cuerpo));
        ultimoLateral = false;
      }
    }
    texto = aMarkdown(principal);
    for (const r of recuadros) texto += `\n\n[RECUADRO]\n\n${aMarkdown(r)}\n\n[/RECUADRO]`;
  }

  // ¿Hay figuras? Buscamos imágenes o muchos trazos (diagramas vectoriales).
  let tieneImagenes = false;
  try {
    const ops = await pagina.getOperatorList();
    const { OPS } = pdfjsLib;
    const imagenes = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat]);
    const trazos = ops.fnArray.filter((f) => f === OPS.constructPath).length;
    tieneImagenes = ops.fnArray.some((f) => imagenes.has(f)) || trazos > 30;
  } catch { /* no es grave */ }

  texto = texto.trim();
  return { texto, tieneTexto: texto.length > 20, tieneImagenes, sueltos, ...evaluarTexto(texto, tieneImagenes, sueltos) };
}

/** ¿El texto extraído sirve para traducir, o conviene que Gemini "vea" la página?
 *  Devuelve { calidad, motivo }:
 *   - "buena":  texto normal de libro → se traduce el texto (rápido y barato).
 *   - "vacia":  no hay texto (página escaneada o solo figura).
 *   - "pobre":  hay "texto" pero es basura (escaneo con OCR malo, fuentes raras).
 *   - "visual": texto real pero repartido en globos, flechas y notas (estilo Head First),
 *               o la página es casi toda una figura. Leído en orden interno sale desordenado.
 *  Son reglas simples (heurísticas): no aciertan siempre, por eso el usuario puede
 *  elegir el modo a mano. */
export function evaluarTexto(texto, tieneImagenes = false, sueltos = null) {
  // El código tiene líneas cortas y símbolos raros a propósito: no lo contamos.
  const prosa = texto.replace(/```[\s\S]*?```/g, " ").replace(/\[\/?(RECUADRO|FIGURA)\]/g, " ");
  const letras = texto.replace(/\s+/g, "").length;
  if (letras < 20) return { calidad: "vacia", motivo: "Esta página no tiene texto seleccionable" };

  // 1) ¿Son palabras de verdad? Un OCR malo produce cosas como "tlie", "rn", "lll|".
  const palabras = prosa.match(/[A-Za-zÀ-ÿ]+/g) || [];
  const reales = palabras.filter((p) => p.length >= 2 && p.length <= 20 && /[aeiouy]/i.test(p));
  const proporcionReales = palabras.length ? reales.length / palabras.length : 0;
  // 2) ¿Hay muchos caracteres extraños? (fuentes con codificación propia)
  const raros = (prosa.match(/[^\x20-\x7E\s\u00A0-\u00FF\u2010-\u203A]/g) || []).length;
  if (palabras.length < 8 || proporcionReales < 0.55 || raros / Math.max(1, prosa.length) > 0.1) {
    return { calidad: "pobre", motivo: "El texto de esta página sale ilegible" };
  }
  // 3) ¿Está todo en pedacitos? Globos y notas sueltas por toda la página.
  //    (Medido en "Learning Web Design": sus páginas nunca pasan de 0.42.)
  if (sueltos && sueltos.cantidad >= 8 && sueltos.proporcion >= 0.5) {
    return { calidad: "visual", motivo: "Esta página es muy visual (globos, flechas, notas sueltas)" };
  }
  //    Otra señal: muchas líneas de 1-3 palabras.
  const lineas = prosa.split("\n").map((l) => l.replace(/^[-*>#\s]+/, "").trim()).filter(Boolean);
  const cortas = lineas.filter((l) => l.split(/\s+/).length <= 3).length;
  if (lineas.length >= 12 && cortas / lineas.length > 0.55) {
    return { calidad: "visual", motivo: "Esta página es muy visual (globos, flechas, notas sueltas)" };
  }
  if (tieneImagenes && letras < 250) return { calidad: "visual", motivo: "Esta página es casi toda una figura" };
  return { calidad: "buena", motivo: "" };
}

/** Texto plano de todas las páginas, en minúsculas, para la búsqueda.
 *  avance(n, total) se llama para mostrar el progreso. */
export async function textosParaBuscar(pdf, avance) {
  const paginas = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const pagina = await pdf.getPage(n);
    const contenido = await pagina.getTextContent();
    paginas.push(contenido.items.map((i) => (i.str || "") + (i.hasEOL ? "\n" : "")).join("").replace(/­/g, "").toLowerCase());
    pagina.cleanup();
    if (n % 20 === 0) avance?.(n, pdf.numPages);
  }
  return paginas;
}

/** Busca en todas las páginas. Devuelve [{ pagina, fragmento }]. */
export function buscar(textos, consulta, limite = 40) {
  consulta = consulta.trim().toLowerCase();
  if (consulta.length < 2) return [];
  const resultados = [];
  textos.forEach((texto, i) => {
    if (resultados.length >= limite) return;
    const pos = texto.indexOf(consulta);
    if (pos === -1) return;
    const fragmento = texto.slice(Math.max(0, pos - 60), pos + consulta.length + 80).replace(/\s+/g, " ");
    resultados.push({ pagina: i + 1, fragmento });
  });
  return resultados;
}

/** Capítulo en el que cae una página, usando el índice (marcadores) del PDF. */
export async function leerIndice(pdf) {
  const contorno = (await pdf.getOutline()) || [];
  const entradas = [];
  async function recorrer(items, nivel) {
    for (const item of items) {
      let pagina = null;
      try {
        const destino = typeof item.dest === "string" ? await pdf.getDestination(item.dest) : item.dest;
        if (destino?.[0]) pagina = (await pdf.getPageIndex(destino[0])) + 1;
      } catch { /* marcador sin destino */ }
      if (pagina) entradas.push({ nivel, titulo: item.title.trim(), pagina });
      if (item.items?.length && nivel < 3) await recorrer(item.items, nivel + 1);
    }
  }
  await recorrer(contorno, 1);
  return entradas;
}

export function capitulo(entradas, pagina) {
  let actual = "";
  for (const e of entradas) {
    if (e.pagina > pagina) break;
    if (e.nivel <= 2) actual = e.titulo;
  }
  return actual === actual.toUpperCase() ? actual.toLowerCase().replace(/(^|\s|:)\S/g, (c) => c.toUpperCase()) : actual;
}
