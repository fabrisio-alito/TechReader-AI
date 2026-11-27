/* ==========================================================================
   almacen.js — La "base de datos" de la app, DENTRO del navegador (IndexedDB).

   Tablas (object stores):
     libros        -> cada PDF (el archivo + en qué página vas)
     traducciones  -> páginas completas traducidas
     asistente     -> resultados de Traducir/Explicar/Resumir/Ejemplo
     notas         -> lo que guardas con "Guardar"   (cada una con un "uid" único)
     glosario      -> términos técnicos + su estado de repaso (versión 2)
     eliminados    -> "lápidas": qué borraste, para que la sincronización
                      no lo vuelva a traer desde otro dispositivo (versión 2)
     textos        -> texto de todo el libro, para buscar rápido
     config        -> clave de Gemini, PIN, modelos, sincronización…

   VERSIÓN 2: agregamos glosario y eliminados, y un uid a cada nota.
   onupgradeneeded hace la MIGRACIÓN: si vienes de la versión 1, tus datos
   se conservan y solo se agregan las piezas nuevas (igual que el
   ALTER TABLE que hicimos en SQLite en la versión Python).
   ========================================================================== */

import { huella, nuevoId } from "./util.js";

const NOMBRE_DB = "techreader";
const VERSION_DB = 2;
let conexion = null;

/** Avisa cuando cambian datos que se sincronizan (lo escucha sincronizar.js). */
export const cambios = new EventTarget();
const SINCRONIZABLES = new Set(["libros", "traducciones", "asistente", "notas", "glosario", "eliminados"]);

function abrir() {
  if (conexion) return conexion;
  conexion = new Promise((resolver, rechazar) => {
    const pedido = indexedDB.open(NOMBRE_DB, VERSION_DB);
    pedido.onupgradeneeded = (evento) => {
      const db = pedido.result;
      const tx = pedido.transaction;
      if (evento.oldVersion < 1) {
        db.createObjectStore("libros", { keyPath: "id" });
        const trad = db.createObjectStore("traducciones", { keyPath: ["libroId", "pagina"] });
        trad.createIndex("libroId", "libroId");
        const asis = db.createObjectStore("asistente", { keyPath: "id", autoIncrement: true });
        asis.createIndex("busqueda", ["libroId", "accion", "original"]);
        asis.createIndex("libroId", "libroId");
        const notas = db.createObjectStore("notas", { keyPath: "id", autoIncrement: true });
        notas.createIndex("libroId", "libroId");
        db.createObjectStore("textos", { keyPath: "libroId" });
        db.createObjectStore("config", { keyPath: "clave" });
      }
      if (evento.oldVersion < 2) {
        const glosario = db.createObjectStore("glosario", { keyPath: "id" });
        glosario.createIndex("libroId", "libroId");
        db.createObjectStore("eliminados", { keyPath: "clave" });
        const notas = tx.objectStore("notas");
        notas.createIndex("uid", "uid");
        // Migración: a cada nota existente le damos un uid estable.
        notas.openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return;
          const n = cursor.value;
          if (!n.uid) { n.uid = uidLegado(n); cursor.update(n); }
          cursor.continue();
        };
      }
    };
    pedido.onsuccess = () => resolver(pedido.result);
    pedido.onerror = () => rechazar(pedido.error);
    pedido.onblocked = () => rechazar(new Error("Cierra las otras pestañas de TechReader y recarga."));
  });
  return conexion;
}

/** uid determinista para notas que vienen de versiones viejas o de un respaldo:
 *  la misma nota produce el mismo uid en todos tus dispositivos. */
const uidLegado = (n) => `n-${huella(`${n.libroId}|${n.pagina}|${n.original}`)}`;

const comoPromesa = (pedido) => new Promise((ok, mal) => {
  pedido.onsuccess = () => ok(pedido.result);
  pedido.onerror = () => mal(pedido.error);
});

async function operar(tabla, modo, accion) {
  const db = await abrir();
  const tx = db.transaction(tabla, modo);
  const resultado = await comoPromesa(accion(tx.objectStore(tabla)));
  if (modo === "readwrite") {
    await new Promise((ok, mal) => { tx.oncomplete = ok; tx.onerror = () => mal(tx.error); tx.onabort = () => mal(tx.error); });
    if (SINCRONIZABLES.has(tabla) && !silencio) cambios.dispatchEvent(new Event("cambio"));
  }
  return resultado;
}
let silencio = false; // durante una fusión no avisamos de "cambios" (si no, se sincronizaría en bucle)

export const ahora = () => new Date().toISOString();

// ───────────── Libros ─────────────
export const idLibro = (nombre, paginas) => `${nombre.replace(/\.pdf$/i, "").trim()}|${paginas}`;

export const libros = {
  todos: () => operar("libros", "readonly", (t) => t.getAll()),
  obtener: (id) => operar("libros", "readonly", (t) => t.get(id)),
  guardar: (libro) => operar("libros", "readwrite", (t) => t.put(libro)),
  borrar: (id) => operar("libros", "readwrite", (t) => t.delete(id)),
  async marcarPagina(id, pagina) {
    const libro = await this.obtener(id);
    if (!libro || libro.ultimaPagina === pagina) return;
    libro.ultimaPagina = pagina;
    libro.actualizado = ahora();
    await this.guardar(libro);
  },
};

// ───────────── Traducciones de página ─────────────
export const traducciones = {
  obtener: (libroId, pagina) => operar("traducciones", "readonly", (t) => t.get([libroId, pagina])),
  /** extra = { original, modo }: en el modo "Imagen" guardamos también lo que Gemini leyó en inglés. */
  guardar: (libroId, pagina, texto, modelo, extra = {}) =>
    operar("traducciones", "readwrite", (t) => t.put({ libroId, pagina, texto, modelo, ...extra, fecha: ahora() })),
  contar: (libroId) => operar("traducciones", "readonly", (t) => t.index("libroId").count(libroId)),
  deLibro: (libroId) => operar("traducciones", "readonly", (t) => t.index("libroId").getAll(libroId)),
  todas: () => operar("traducciones", "readonly", (t) => t.getAll()),
};

// ───────────── Asistente (caché) ─────────────
export const asistente = {
  async buscar(libroId, accion, original) {
    const filas = await operar("asistente", "readonly", (t) => t.index("busqueda").getAll([libroId, accion, original]));
    return filas.at(-1) || null;
  },
  guardar: (fila) => operar("asistente", "readwrite", (t) => t.add({ ...fila, fecha: ahora() })),
};

// ───────────── Notas ─────────────
export const notas = {
  async todas(libroId) {
    const filas = await operar("notas", "readonly", (t) => (libroId ? t.index("libroId").getAll(libroId) : t.getAll()));
    return filas.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "") || b.id - a.id);
  },
  guardar: (nota) => operar("notas", "readwrite", (t) => t.add({ uid: nuevoId(), ...nota, fecha: ahora() })),
  async borrar(id) {
    const nota = await operar("notas", "readonly", (t) => t.get(id));
    await operar("notas", "readwrite", (t) => t.delete(id));
    if (nota?.uid) await marcarEliminado(`nota:${nota.uid}`);
  },
};

// ───────────── Glosario (con estado de repaso) ─────────────
export const normalizarTermino = (t) => t.replace(/[`*_]/g, "").trim().toLowerCase();

export const glosario = {
  async todos(libroId) {
    const filas = await operar("glosario", "readonly", (t) => (libroId ? t.index("libroId").getAll(libroId) : t.getAll()));
    return filas.sort((a, b) => a.termino.localeCompare(b.termino, "es"));
  },
  obtener: (id) => operar("glosario", "readonly", (t) => t.get(id)),
  guardar: (entrada) => operar("glosario", "readwrite", (t) => t.put({ ...entrada, actualizado: ahora() })),
  /** Agrega un término nuevo. Si ya existe, no lo pisa (conserva tu progreso de repaso).
   *  Si lo habías ELIMINADO, la extracción automática no lo revive; solo
   *  vuelve si lo agregas tú a mano (manual = true). */
  async agregar({ termino, traduccion, explicacion = "", libroId = null, pagina = null }, { manual = false } = {}) {
    const id = normalizarTermino(termino);
    if (!id || id.length > 80) return false;
    if (await this.obtener(id)) return false;
    const lapida = await operar("eliminados", "readonly", (t) => t.get(`glosario:${id}`));
    if (lapida && !manual) return false;
    if (lapida) await operar("eliminados", "readwrite", (t) => t.delete(`glosario:${id}`));
    await this.guardar({ id, termino: termino.replace(/[`*_]/g, "").trim(), traduccion, explicacion, libroId, pagina, creado: ahora(), repaso: null });
    return true;
  },
  async borrar(id) {
    await operar("glosario", "readwrite", (t) => t.delete(id));
    await marcarEliminado(`glosario:${id}`);
  },
};

async function marcarEliminado(clave) {
  await operar("eliminados", "readwrite", (t) => t.put({ clave, fecha: ahora() }));
}

// ───────────── Texto para búsqueda y configuración ─────────────
export const textos = {
  obtener: (libroId) => operar("textos", "readonly", (t) => t.get(libroId)),
  guardar: (libroId, paginas) => operar("textos", "readwrite", (t) => t.put({ libroId, paginas })),
};

export const config = {
  async obtener(clave, porDefecto = null) {
    const fila = await operar("config", "readonly", (t) => t.get(clave));
    return fila ? fila.valor : porDefecto;
  },
  guardar: (clave, valor) => operar("config", "readwrite", (t) => t.put({ clave, valor })),
  borrar: (clave) => operar("config", "readwrite", (t) => t.delete(clave)),
};

// ───────────── Utilidades generales ─────────────
export async function pedirPersistencia() {
  try {
    if (navigator.storage?.persisted && await navigator.storage.persisted()) return true;
    return (await navigator.storage?.persist?.()) || false;
  } catch { return false; }
}

export async function espacio() {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usadoMB: Math.round(usage / 1048576), totalMB: Math.round(quota / 1048576) };
  } catch { return null; }
}

export async function borrarTodo() {
  if (conexion) (await conexion).close();
  conexion = null;
  await comoPromesa(indexedDB.deleteDatabase(NOMBRE_DB));
}

/** Todo lo exportable/sincronizable (sin los PDF ni la clave). */
export async function exportarDatos() {
  const db = await abrir();
  const leer = (tabla) => comoPromesa(db.transaction(tabla).objectStore(tabla).getAll());
  return {
    app: "TechReader AI",
    formato: 2,
    exportado: ahora(),
    libros: (await leer("libros")).map(({ archivo, ...resto }) => resto),
    traducciones: await leer("traducciones"),
    asistente: (await leer("asistente")).map(({ id, ...resto }) => resto),
    notas: (await leer("notas")).map(({ id, ...resto }) => resto),
    glosario: await leer("glosario"),
    eliminados: await leer("eliminados"),
  };
}

/* ───────────── FUSIÓN ─────────────
   Mezcla datos de otro lugar (respaldo o sincronización) con los locales
   SIN perder nada. Regla general: "gana el más reciente".
     libros        -> la versión con 'actualizado' más nuevo (tu última página)
     traducciones  -> la de 'fecha' más nueva
     asistente     -> se agregan los que falten
     notas         -> por uid; si una nota fue eliminada (lápida), se borra
     glosario      -> el de 'actualizado' más nuevo (incluye tu progreso de repaso)
   Devuelve cuántas cosas nuevas o actualizadas entraron. */
const masNuevo = (a, b) => (a || "") > (b || "");

export async function fusionar(datos) {
  if (datos?.app !== "TechReader AI") throw new Error("Ese archivo no es un respaldo de TechReader AI.");
  const r = { libros: 0, traducciones: 0, asistente: 0, notas: 0, glosario: 0, borrados: 0 };
  silencio = true;
  try {
    const lapidas = new Map((await operar("eliminados", "readonly", (t) => t.getAll())).map((e) => [e.clave, e.fecha]));
    for (const e of datos.eliminados || []) {
      if (!lapidas.has(e.clave)) { lapidas.set(e.clave, e.fecha); await operar("eliminados", "readwrite", (t) => t.put(e)); }
    }

    for (const l of datos.libros || []) {
      const local = await libros.obtener(l.id);
      if (!local) { await libros.guardar({ ...l, archivo: null }); r.libros++; }
      else if (masNuevo(l.actualizado, local.actualizado)) {
        await libros.guardar({ ...local, ultimaPagina: l.ultimaPagina, modo: l.modo ?? local.modo, actualizado: l.actualizado, titulo: local.titulo || l.titulo });
        r.libros++;
      }
    }

    for (const t of datos.traducciones || []) {
      const local = await traducciones.obtener(t.libroId, t.pagina);
      if (!local || masNuevo(t.fecha, local.fecha)) { await operar("traducciones", "readwrite", (s) => s.put(t)); r.traducciones++; }
    }

    for (const a of datos.asistente || []) {
      if (!(await asistente.buscar(a.libroId, a.accion, a.original))) {
        const { id, ...sinId } = a;
        await operar("asistente", "readwrite", (s) => s.add(sinId));
        r.asistente++;
      }
    }

    const notasLocales = await operar("notas", "readonly", (t) => t.getAll());
    const porUid = new Map(notasLocales.map((n) => [n.uid, n]));
    for (const n of datos.notas || []) {
      const uid = n.uid || uidLegado(n);
      if (lapidas.has(`nota:${uid}`) || porUid.has(uid)) continue;
      const { id, ...sinId } = n;
      await operar("notas", "readwrite", (s) => s.add({ ...sinId, uid }));
      porUid.set(uid, n);
      r.notas++;
    }
    for (const n of notasLocales) {
      if (lapidas.has(`nota:${n.uid}`)) { await operar("notas", "readwrite", (s) => s.delete(n.id)); r.borrados++; }
    }

    for (const g of datos.glosario || []) {
      const borrado = lapidas.get(`glosario:${g.id}`);
      if (borrado && !masNuevo(g.actualizado, borrado)) continue;
      const local = await glosario.obtener(g.id);
      if (!local || masNuevo(g.actualizado, local.actualizado)) { await operar("glosario", "readwrite", (s) => s.put(g)); r.glosario++; }
    }
    for (const [clave, fecha] of lapidas) {
      if (!clave.startsWith("glosario:")) continue;
      const local = await glosario.obtener(clave.slice(9));
      if (local && !masNuevo(local.actualizado, fecha)) { await operar("glosario", "readwrite", (s) => s.delete(local.id)); r.borrados++; }
    }
  } finally {
    silencio = false;
  }
  return r;
}
