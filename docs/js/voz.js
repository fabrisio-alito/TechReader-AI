/* ==========================================================================
   voz.js — Lectura en voz alta con las voces que YA trae tu navegador.

   Usa la "Web Speech API" (speechSynthesis): es gratis, no gasta cuota de
   Gemini y funciona en Chrome, Edge, Safari y Android.

   Idea clave: no le damos al navegador toda la página de golpe, sino
   PÁRRAFO POR PÁRRAFO. Así podemos:
     - resaltar el párrafo que se está leyendo,
     - saltar al anterior o al siguiente,
     - y evitamos un error de Chrome que corta los textos muy largos.
   ========================================================================== */

const sintesis = window.speechSynthesis;
export const disponible = Boolean(sintesis && window.SpeechSynthesisUtterance);

/** Lista de voces del idioma pedido ("es" o "en"). Puede tardar en cargar. */
export function voces(idioma = "es") {
  if (!disponible) return Promise.resolve([]);
  const filtrar = () => sintesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(idioma));
  const ya = filtrar();
  if (ya.length) return Promise.resolve(ya);
  return new Promise((resolver) => {
    const listo = () => resolver(filtrar());
    sintesis.addEventListener("voiceschanged", listo, { once: true });
    setTimeout(listo, 1500); // algunos navegadores nunca avisan
  });
}

/** Elige la mejor voz: primero las "naturales" o de Google, y en español,
 *  primero las de Latinoamérica (es-MX, es-US, es-419). */
export function mejorVoz(lista, preferida) {
  if (preferida) {
    const exacta = lista.find((v) => v.voiceURI === preferida);
    if (exacta) return exacta;
  }
  const puntos = (v) =>
    (/natural|neural|online/i.test(v.name) ? 4 : 0) +
    (/google/i.test(v.name) ? 3 : 0) +
    (/-(mx|us|419|co|ar|pe|cl)$/i.test(v.lang) ? 2 : 0) +
    (v.localService ? 0 : 1);
  return [...lista].sort((a, b) => puntos(b) - puntos(a))[0] || null;
}

/** Convierte un elemento HTML (párrafo, título, ítem de lista…) en texto para leer. */
export function textoParaLeer(elemento) {
  if (elemento.matches("pre")) return "Bloque de código.";
  const copia = elemento.cloneNode(true);
  copia.querySelectorAll("pre").forEach((p) => p.replaceWith(" (código) "));
  return copia.textContent
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")   // emojis
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parte un contenedor ya dibujado en "bloques" leíbles (en orden). */
export function bloquesDe(contenedor) {
  const elementos = contenedor.querySelectorAll("h1, h2, h3, h4, p, li, pre, td, th");
  const bloques = [];
  for (const el of elementos) {
    if (el.closest("li") && el.tagName === "P") continue;   // un <p> dentro de <li>: ya lo lee el <li>
    if (el.closest("pre") && el.tagName !== "PRE") continue;
    const texto = textoParaLeer(el);
    if (texto) bloques.push({ elemento: el, texto });
  }
  return bloques;
}

/* ───────────── El reproductor ─────────────
   Guarda la lista de bloques y el número del bloque actual.
   Avisa con callbacks: alCambiar(indice, total) y alTerminar(completo). */
export class Lector {
  constructor({ alCambiar, alTerminar, alEstado } = {}) {
    this.bloques = [];
    this.indice = 0;
    this.velocidad = 1;
    this.voz = null;
    this.idioma = "es-ES";
    this.estado = "detenido"; // detenido | leyendo | pausado
    this.alCambiar = alCambiar || (() => {});
    this.alTerminar = alTerminar || (() => {});
    this.alEstado = alEstado || (() => {});
    this.turno = 0; // para ignorar eventos de lecturas viejas
  }

  leer(bloques, { voz, velocidad, idioma, desde = 0 } = {}) {
    this.detener(false);
    this.bloques = bloques;
    this.voz = voz || null;
    this.velocidad = velocidad || this.velocidad;
    this.idioma = voz?.lang || idioma || this.idioma;
    this.indice = Math.max(0, Math.min(desde, bloques.length - 1));
    this.#cambiarEstado("leyendo");
    this.#decir();
  }

  #decir() {
    const turno = ++this.turno;
    const bloque = this.bloques[this.indice];
    if (!bloque) { this.#terminar(true); return; }
    this.alCambiar(this.indice, this.bloques.length);
    const frase = new SpeechSynthesisUtterance(bloque.texto);
    if (this.voz) frase.voice = this.voz;
    frase.lang = this.idioma;
    frase.rate = this.velocidad;
    frase.onend = () => {
      if (turno !== this.turno || this.estado !== "leyendo") return;
      this.indice++;
      if (this.indice >= this.bloques.length) this.#terminar(true);
      else this.#decir();
    };
    frase.onerror = (e) => {
      if (turno !== this.turno || e.error === "interrupted" || e.error === "canceled") return;
      this.#terminar(false);
    };
    sintesis.speak(frase);
  }

  pausar() {
    if (this.estado !== "leyendo") return;
    // Pausar/reanudar a mitad de frase falla en algunos Android: es más
    // confiable cancelar y, al reanudar, repetir el párrafo actual.
    this.turno++;
    sintesis.cancel();
    this.#cambiarEstado("pausado");
  }

  reanudar() {
    if (this.estado !== "pausado") return;
    this.#cambiarEstado("leyendo");
    this.#decir();
  }

  alternar() { this.estado === "leyendo" ? this.pausar() : this.reanudar(); }

  saltar(delta) {
    if (!this.bloques.length) return;
    this.indice = Math.max(0, Math.min(this.indice + delta, this.bloques.length - 1));
    this.turno++;
    sintesis.cancel();
    if (this.estado === "pausado") { this.alCambiar(this.indice, this.bloques.length); return; }
    this.#cambiarEstado("leyendo");
    this.#decir();
  }

  cambiarVelocidad(v) {
    this.velocidad = v;
    if (this.estado === "leyendo") { this.turno++; sintesis.cancel(); this.#decir(); }
  }

  detener(avisar = true) {
    this.turno++;
    if (disponible) sintesis.cancel();
    const estaba = this.estado !== "detenido";
    this.#cambiarEstado("detenido");
    if (avisar && estaba) this.alTerminar(false);
  }

  #terminar(completo) {
    this.#cambiarEstado("detenido");
    this.alTerminar(completo);
  }

  #cambiarEstado(nuevo) {
    this.estado = nuevo;
    this.alEstado(nuevo);
  }
}
