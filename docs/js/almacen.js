/* ==========================================================================
   almacen.js — La "base de datos" de la app, DENTRO del navegador.

   En la versión Python usábamos SQLite (datos/techreader.db).
   En el navegador usamos IndexedDB: una base de datos que cada navegador
   guarda por sitio web. Sobrevive a cerrar la pestaña o apagar el equipo,
   pero se borra si limpias los "datos de sitios" del navegador.

   "Tablas" (en IndexedDB se llaman object stores):
     libros        -> cada PDF (el archivo en sí + en qué página vas)
     traducciones  -> páginas completas traducidas
     asistente     -> resultados de Traducir/Explicar/Resumir/Ejemplo
     notas         -> lo que guardas con "Guardar"
     textos        -> texto de todo el libro, para buscar rápido
     config        -> clave de Gemini, PIN, modelos, etc.

   IndexedDB trabaja con "eventos" (onsuccess/onerror). Aquí lo envolvemos
   en Promesas para poder usar async/await, igual que fetch().
   ========================================================================== */

const NOMBRE_DB = "techreader";
const VERSION_DB = 1;
let conexion = null;

function abrir() {
  if (conexion) return conexion;
  conexion = new Promise((resolver, rechazar) => {
    const pedido = indexedDB.open(NOMBRE_DB, VERSION_DB);
    // Se ejecuta solo la primera vez (o al subir VERSION_DB): crea las tablas.
    pedido.onupgradeneeded = () => {
      const db = pedido.result;
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
    };
    pedido.onsuccess = () => resolver(pedido.result);
    pedido.onerror = () => rechazar(pedido.error);
  });
  return conexion;
}

/** Convierte un pedido de IndexedDB en una Promesa. */
const comoPromesa = (pedido) => new Promise((ok, mal) => {
  pedido.onsuccess = () => ok(pedido.result);
  pedido.onerror = () => mal(pedido.error);
});

/** Ejecuta una operación sobre una tabla. modo: "readonly" | "readwrite" */
async function operar(tabla, modo, accion) {
  const db = await abrir();
  const tx = db.transaction(tabla, modo);
  const resultado = await comoPromesa(accion(tx.objectStore(tabla)));
  if (modo === "readwrite") {
    await new Promise((ok, mal) => { tx.oncomplete = ok; tx.onerror = () => mal(tx.error); tx.onabort = () => mal(tx.error); });
  }
  return resultado;
}

const ahora = () => new Date().toISOString();

// ───────────── Libros ─────────────
/** Identificador de un libro: nombre del archivo + nº de páginas.
 *  Es el mismo en todos tus dispositivos si el PDF tiene el mismo nombre,
 *  así un respaldo importado encuentra "su" libro. */
export const idLibro = (nombre, paginas) => `${nombre.replace(/\.pdf$/i, "").trim()}|${paginas}`;

export const libros = {
  todos: () => operar("libros", "readonly", (t) => t.getAll()),
  obtener: (id) => operar("libros", "readonly", (t) => t.get(id)),
  guardar: (libro) => operar("libros", "readwrite", (t) => t.put(libro)),
  borrar: (id) => operar("libros", "readwrite", (t) => t.delete(id)),
  async marcarPagina(id, pagina) {
    const libro = await this.obtener(id);
    if (!libro) return;
    libro.ultimaPagina = pagina;
    libro.actualizado = ahora();
    await this.guardar(libro);
  },
};

// ───────────── Traducciones de página ─────────────
export const traducciones = {
  obtener: (libroId, pagina) => operar("traducciones", "readonly", (t) => t.get([libroId, pagina])),
  guardar: (libroId, pagina, texto, modelo) =>
    operar("traducciones", "readwrite", (t) => t.put({ libroId, pagina, texto, modelo, fecha: ahora() })),
  contar: (libroId) => operar("traducciones", "readonly", (t) => t.index("libroId").count(libroId)),
  deLibro: (libroId) => operar("traducciones", "readonly", (t) => t.index("libroId").getAll(libroId)),
};

// ───────────── Asistente (caché de resultados) ─────────────
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
    return filas.sort((a, b) => b.id - a.id); // más recientes primero
  },
  guardar: (nota) => operar("notas", "readwrite", (t) => t.add({ ...nota, fecha: ahora() })),
  borrar: (id) => operar("notas", "readwrite", (t) => t.delete(id)),
};

// ───────────── Texto para búsqueda ─────────────
export const textos = {
  obtener: (libroId) => operar("textos", "readonly", (t) => t.get(libroId)),
  guardar: (libroId, paginas) => operar("textos", "readwrite", (t) => t.put({ libroId, paginas })),
};

// ───────────── Configuración ─────────────
export const config = {
  async obtener(clave, porDefecto = null) {
    const fila = await operar("config", "readonly", (t) => t.get(clave));
    return fila ? fila.valor : porDefecto;
  },
  guardar: (clave, valor) => operar("config", "readwrite", (t) => t.put({ clave, valor })),
  borrar: (clave) => operar("config", "readwrite", (t) => t.delete(clave)),
};

// ───────────── Utilidades generales ─────────────

/** Pide al navegador que NO borre nuestros datos aunque falte espacio. */
export async function pedirPersistencia() {
  try {
    if (navigator.storage?.persisted && await navigator.storage.persisted()) return true;
    return (await navigator.storage?.persist?.()) || false;
  } catch { return false; }
}

/** Cuánto espacio usamos (en MB) y cuánto hay disponible. */
export async function espacio() {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usadoMB: Math.round(usage / 1048576), totalMB: Math.round(quota / 1048576) };
  } catch { return null; }
}

/** Borra TODO lo guardado en este dispositivo. */
export async function borrarTodo() {
  if (conexion) (await conexion).close();
  conexion = null;
  await comoPromesa(indexedDB.deleteDatabase(NOMBRE_DB));
}

/** Todo lo exportable (sin los PDF, que pesan mucho y tienen derechos de autor). */
export async function exportarDatos() {
  const db = await abrir();
  const leer = (tabla) => comoPromesa(db.transaction(tabla).objectStore(tabla).getAll());
  const listaLibros = (await leer("libros")).map(({ archivo, ...resto }) => resto);
  return {
    app: "TechReader AI",
    formato: 1,
    exportado: ahora(),
    libros: listaLibros,
    traducciones: await leer("traducciones"),
    asistente: (await leer("asistente")).map(({ id, ...resto }) => resto),
    notas: (await leer("notas")).map(({ id, ...resto }) => resto),
  };
}

/** Mezcla un respaldo con lo que ya hay (no borra nada existente). */
export async function importarDatos(datos) {
  if (datos?.app !== "TechReader AI") throw new Error("Ese archivo no es un respaldo de TechReader AI.");
  const resumen = { libros: 0, traducciones: 0, asistente: 0, notas: 0 };

  for (const l of datos.libros || []) {
    const existente = await libros.obtener(l.id);
    if (existente) {
      // Nos quedamos con la página más avanzada.
      if ((l.ultimaPagina || 0) > (existente.ultimaPagina || 0)) await libros.marcarPagina(l.id, l.ultimaPagina);
    } else {
      await libros.guardar({ ...l, archivo: null }); // el PDF se agrega después en este dispositivo
    }
    resumen.libros++;
  }
  for (const t of datos.traducciones || []) {
    if (!(await traducciones.obtener(t.libroId, t.pagina))) {
      await operar("traducciones", "readwrite", (s) => s.put(t));
      resumen.traducciones++;
    }
  }
  for (const a of datos.asistente || []) {
    if (!(await asistente.buscar(a.libroId, a.accion, a.original))) {
      await operar("asistente", "readwrite", (s) => s.add(a));
      resumen.asistente++;
    }
  }
  const existentes = new Set((await notas.todas()).map((n) => `${n.libroId}|${n.pagina}|${n.original}`));
  for (const n of datos.notas || []) {
    if (existentes.has(`${n.libroId}|${n.pagina}|${n.original}`)) continue;
    await operar("notas", "readwrite", (s) => s.add(n));
    resumen.notas++;
  }
  return resumen;
}
