/* ==========================================================================
   python-worker.js — Ejecuta Python DENTRO del navegador con Pyodide.

   Pyodide es el intérprete de Python (CPython) compilado a WebAssembly.
   Corre en un "Web Worker": un hilo aparte. Así, si tu código tiene un
   bucle infinito, la app no se congela: el laboratorio simplemente
   detiene este worker.

   La primera vez descarga ~10 MB desde un CDN; luego el navegador lo guarda.
   ========================================================================== */

let pyodide = null;

async function cargar(indexURL) {
  if (pyodide) return pyodide;
  postMessage({ tipo: "estado", texto: "Descargando Python (≈10 MB, solo la primera vez)…" });
  const { loadPyodide } = await import(`${indexURL}pyodide.mjs`);
  pyodide = await loadPyodide({ indexURL });
  pyodide.setStdout({ batched: (texto) => postMessage({ tipo: "salida", texto }) });
  pyodide.setStderr({ batched: (texto) => postMessage({ tipo: "salida", texto, error: true }) });
  // input() no existe en el navegador: avisamos en vez de quedarnos esperando.
  pyodide.setStdin({ stdin: () => { throw new Error("input() no está disponible en el laboratorio: usa valores fijos en el código."); } });
  return pyodide;
}

onmessage = async (evento) => {
  const { codigo, indexURL } = evento.data;
  try {
    const py = await cargar(indexURL);
    postMessage({ tipo: "inicio" });
    const t0 = performance.now();
    await py.runPythonAsync(codigo);
    postMessage({ tipo: "fin", ms: Math.round(performance.now() - t0) });
  } catch (error) {
    // De un "Traceback" largo mostramos solo lo útil: desde tu código en adelante.
    const texto = String(error?.message || error);
    const util = texto.includes('File "<exec>"') ? texto.slice(texto.indexOf('File "<exec>"')) : texto;
    postMessage({ tipo: "error", texto: util.trim() });
  }
};
