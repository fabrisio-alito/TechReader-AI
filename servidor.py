"""
servidor.py — El "backend": una API web hecha con FastAPI.

El proyecto tiene dos mitades que se hablan por HTTP:

    FRONTEND (static/)          BACKEND (este archivo)
    HTML + CSS + JavaScript     Python
    Lo que ves y tocas   ──►   Lee el PDF, habla con Gemini, guarda en SQLite
                         ◄──   Responde en JSON

Cada función con @app.get / @app.post / @app.delete es una "ruta" (endpoint)
que el JavaScript llama con fetch(). Para verlas y probarlas todas, abre
http://localhost:8000/docs con el servidor encendido.

Ejecutar:  python servidor.py
"""

import mimetypes
import threading
import webbrowser
from pathlib import Path
from urllib.parse import quote

# ⚠️ ARREGLO PARA WINDOWS
# Python adivina el tipo de cada archivo (.js, .css...) leyendo el registro de
# Windows, y a veces se equivoca (por ejemplo, .js como "text/plain") o no
# conoce .mjs. El navegador se niega a ejecutar JavaScript con un tipo
# incorrecto, así que la página queda vacía. Aquí lo dejamos fijo.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("text/html", ".html")

from dotenv import load_dotenv  # noqa: E402

load_dotenv()  # lee .env ANTES de importar traductor

import uvicorn  # noqa: E402
from fastapi import FastAPI, HTTPException, UploadFile  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

import db  # noqa: E402
import lector  # noqa: E402
import traductor  # noqa: E402

RAIZ = Path(__file__).parent
CARPETA_LIBROS = RAIZ / "libros"
CARPETA_LIBROS.mkdir(exist_ok=True)

app = FastAPI(title="TechReader AI")
db.iniciar()


@app.middleware("http")
async def sin_copias_viejas(request, call_next):
    """Un "middleware" se ejecuta en TODAS las peticiones. Este le dice al
    navegador que siempre pregunte si hay una versión nueva de la página,
    el CSS y el JS (si no cambió, el servidor responde rápido con un 304).
    Así, cuando actualizas el código, no se queda usando archivos viejos."""
    respuesta = await call_next(request)
    if not request.url.path.endswith("/pdf"):
        respuesta.headers["Cache-Control"] = "no-cache"
    return respuesta

# PyMuPDF no es seguro si dos hilos leen el MISMO documento a la vez.
# FastAPI atiende varias peticiones en paralelo, así que usamos un candado.
_candado = threading.Lock()
_documentos: dict[str, object] = {}
_indices: dict[str, list] = {}
_textos_busqueda: dict[str, list[str]] = {}


def _ruta_libro(archivo: str) -> Path:
    """Valida el nombre del archivo. Evita trucos como '../../windows/...'
    (eso se llama 'path traversal' y es un error de seguridad clásico)."""
    ruta = CARPETA_LIBROS / archivo
    if Path(archivo).name != archivo or ruta.suffix.lower() != ".pdf" or not ruta.exists():
        raise HTTPException(404, "Libro no encontrado")
    return ruta


def _documento(archivo: str):
    """Abre cada PDF una sola vez y lo guarda en memoria (caché)."""
    if archivo not in _documentos:
        _documentos[archivo] = lector.abrir(str(_ruta_libro(archivo)))
        _indices[archivo] = lector.indice(_documentos[archivo])
    return _documentos[archivo]


def _indice(archivo: str, pagina: int) -> int:
    """En la API las páginas empiezan en 1 (como en pantalla);
    en PyMuPDF y en la base de datos empiezan en 0."""
    total = len(_documento(archivo))
    if not 1 <= pagina <= total:
        raise HTTPException(400, f"La página debe estar entre 1 y {total}")
    return pagina - 1


def _preparar_busqueda(archivo: str) -> None:
    """Lee el texto de todo el libro en segundo plano (tarda unos segundos)
    para que la búsqueda sea instantánea. Usa su PROPIA copia del PDF, así
    no bloquea al resto de la app."""
    if archivo in _textos_busqueda:
        return
    _textos_busqueda[archivo] = []  # marca "en preparación"

    def trabajo():
        doc = lector.abrir(str(_ruta_libro(archivo)))
        _textos_busqueda[archivo] = lector.textos_para_buscar(doc)
        doc.close()

    threading.Thread(target=trabajo, daemon=True).start()


# ───────────────────────── Datos que llegan en JSON ─────────────────────────

class PedidoPagina(BaseModel):
    con_imagen: bool = False   # True = enviar también la foto de la página


class PedidoAsistente(BaseModel):
    archivo: str
    pagina: int
    texto: str
    accion: str = "traducir"   # traducir | explicar | resumir | ejemplo


class PedidoNota(BaseModel):
    archivo: str
    pagina: int
    original: str
    contenido: str = ""


# ───────────────────────── Libros ─────────────────────────

@app.get("/api/libros")
def listar_libros():
    libros = []
    with _candado:
        for ruta in sorted(CARPETA_LIBROS.glob("*.pdf")):
            try:
                paginas = len(_documento(ruta.name))
            except Exception:   # PDF dañado: lo saltamos en vez de romper todo
                continue
            libros.append({
                "archivo": ruta.name,
                "titulo": ruta.stem,
                "paginas": paginas,
                "ultima_pagina": db.ultima_pagina(ruta.name) + 1,
                "traducidas": db.total_traducidas(ruta.name),
            })
    return libros


@app.post("/api/libros")
def subir_libro(pdf: UploadFile):
    nombre = Path(pdf.filename or "").name
    if not nombre.lower().endswith(".pdf"):
        raise HTTPException(400, "Solo se aceptan archivos PDF")
    destino = CARPETA_LIBROS / nombre
    with destino.open("wb") as f:
        while bloque := pdf.file.read(1024 * 1024):   # copiamos de 1 MB en 1 MB
            f.write(bloque)
    try:
        with _candado:
            _documento(nombre)
    except Exception:
        destino.unlink(missing_ok=True)
        raise HTTPException(400, "El archivo no es un PDF válido")
    return {"archivo": nombre}


@app.get("/api/libros/{archivo}/pdf")
def descargar_pdf(archivo: str):
    # FileResponse permite que PDF.js pida el archivo "por partes" (HTTP Range),
    # así no espera a cargar los 80 MB para mostrar la primera página.
    return FileResponse(_ruta_libro(archivo), media_type="application/pdf")


@app.get("/api/libros/{archivo}/indice")
def ver_indice(archivo: str):
    with _candado:
        _documento(archivo)
    return _indices[archivo]


@app.get("/api/libros/{archivo}/buscar")
def buscar(archivo: str, q: str):
    _ruta_libro(archivo)
    _preparar_busqueda(archivo)
    textos = _textos_busqueda[archivo]
    if not textos:
        return {"preparando": True, "resultados": []}
    return {"preparando": False, "resultados": lector.buscar(textos, q)}


# ───────────────────────── Páginas ─────────────────────────

@app.get("/api/libros/{archivo}/paginas/{pagina}")
def ver_pagina(archivo: str, pagina: int):
    """Info de la página + su traducción si ya existe. También guarda
    que estás leyendo esta página (para retomarla la próxima vez)."""
    with _candado:
        n = _indice(archivo, pagina)
        datos = lector.extraer_pagina(_documento(archivo), n)
    _preparar_busqueda(archivo)
    db.guardar_pagina(archivo, n)
    guardada = db.obtener_traduccion(archivo, n)
    return {
        "pagina": pagina,
        "capitulo": lector.capitulo(_indices[archivo], pagina),
        "traducidas": db.total_traducidas(archivo),
        "traduccion": guardada[0] if guardada else None,
        "modelo": guardada[1] if guardada else None,
        "tiene_texto": datos["tiene_texto"],
        "tiene_imagenes": datos["tiene_imagenes"],
        "texto_extraido": datos["texto"],
    }


# Nota: usamos "def" y no "async def". Gemini tarda varios segundos y su
# librería es síncrona; con "def", FastAPI la ejecuta en otro hilo y el
# servidor sigue atendiendo otras peticiones (por ejemplo, cambiar de página).
@app.post("/api/libros/{archivo}/paginas/{pagina}/traducir")
def traducir_pagina(archivo: str, pagina: int, pedido: PedidoPagina):
    with _candado:
        n = _indice(archivo, pagina)
        doc = _documento(archivo)
        datos = lector.extraer_pagina(doc, n)
        enviar_imagen = pedido.con_imagen or not datos["tiene_texto"]
        png = lector.imagen_pagina(doc, n) if enviar_imagen else None
    texto = datos["texto"] if datos["tiene_texto"] else None
    try:
        traduccion, modelo = traductor.traducir_pagina(texto, png)
    except traductor.ErrorTraduccion as e:
        raise HTTPException(502, str(e))
    db.guardar_traduccion(archivo, n, traduccion, modelo)
    return {"pagina": pagina, "traduccion": traduccion, "modelo": modelo,
            "traducidas": db.total_traducidas(archivo)}


# ───────────────────────── Asistente IA (sobre la selección) ─────────────────────────

@app.post("/api/asistente")
def usar_asistente(pedido: PedidoAsistente):
    original = pedido.texto.strip()
    guardado = db.buscar_resultado(pedido.archivo, pedido.accion, original)
    if guardado:
        return {"accion": pedido.accion, "resultado": guardado[0], "modelo": guardado[1], "desde_cache": True}
    try:
        resultado, modelo = traductor.asistente(original, pedido.accion, Path(pedido.archivo).stem)
    except traductor.ErrorTraduccion as e:
        raise HTTPException(502, str(e))
    db.guardar_resultado(pedido.archivo, pedido.pagina - 1, pedido.accion, original, resultado, modelo)
    return {"accion": pedido.accion, "resultado": resultado, "modelo": modelo, "desde_cache": False}


# ───────────────────────── Notas ─────────────────────────

@app.get("/api/notas")
def ver_notas(archivo: str | None = None):
    notas = db.listar_notas(archivo)
    for n in notas:
        n["pagina"] += 1
    return notas


@app.post("/api/notas")
def crear_nota(pedido: PedidoNota):
    _ruta_libro(pedido.archivo)
    id_nota = db.guardar_nota(pedido.archivo, pedido.pagina - 1, pedido.original.strip(), pedido.contenido)
    return {"id": id_nota}


@app.delete("/api/notas/{id_nota}")
def eliminar_nota(id_nota: int):
    if not db.borrar_nota(id_nota):
        raise HTTPException(404, "Nota no encontrada")
    return {"ok": True}


@app.get("/api/libros/{archivo}/exportar", response_class=PlainTextResponse)
def exportar(archivo: str):
    """Tus páginas traducidas y tus notas del libro en un archivo Markdown."""
    _ruta_libro(archivo)
    partes = [f"# {Path(archivo).stem}"]
    notas = db.listar_notas(archivo)
    if notas:
        partes.append("## 🔖 Mis notas")
        for n in reversed(notas):
            cita = "\n".join("> " + linea for linea in n["original"].splitlines())
            partes.append(f"**Página {n['pagina'] + 1}**\n\n{cita}\n\n{n['contenido']}")
    for p, texto in db.todas_las_traducciones(archivo):
        partes.append(f"## Página {p + 1}\n\n{texto}")
    nombre = Path(archivo).stem + "_apuntes.md"
    return PlainTextResponse(
        "\n\n---\n\n".join(partes),
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(nombre)}"},
    )


@app.get("/api/respaldo")
def respaldo_para_web():
    """Exporta tus datos en el formato que importa la VERSIÓN WEB (carpeta docs/).
    Abre http://localhost:8000/api/respaldo, guarda el archivo y en la versión
    web usa ⚙️ Ajustes → Importar respaldo.
    Ojo: en la versión web las páginas empiezan en 1 (aquí en la base, en 0)."""
    with _candado:
        paginas = {r.name: len(_documento(r.name)) for r in CARPETA_LIBROS.glob("*.pdf")}
    tablas = db.volcar_tablas()

    def id_libro(archivo: str) -> str:
        return f"{Path(archivo).stem.strip()}|{paginas.get(archivo, 0)}"

    datos = {
        "app": "TechReader AI",
        "formato": 1,
        "origen": "version-python",
        "libros": [
            {"id": id_libro(l["archivo"]), "nombre": l["archivo"], "titulo": Path(l["archivo"]).stem,
             "paginas": paginas[l["archivo"]], "ultimaPagina": l["ultima_pagina"] + 1, "actualizado": l["actualizado"]}
            for l in tablas["libros"] if l["archivo"] in paginas
        ],
        "traducciones": [
            {"libroId": id_libro(t["archivo"]), "pagina": t["pagina"] + 1, "texto": t["texto"],
             "modelo": t["modelo"], "fecha": t["fecha"]}
            for t in tablas["traducciones"] if t["archivo"] in paginas
        ],
        "asistente": [
            {"libroId": id_libro(a["archivo"]), "pagina": a["pagina"] + 1, "accion": a.get("accion") or "traducir",
             "original": a["original"], "resultado": a["traduccion"], "modelo": a["modelo"], "fecha": a["fecha"]}
            for a in tablas["selecciones"] if a["archivo"] in paginas
        ],
        "notas": [
            {"libroId": id_libro(n["archivo"]), "libroNombre": Path(n["archivo"]).stem, "pagina": n["pagina"] + 1,
             "original": n["original"], "contenido": n["contenido"], "fecha": n["fecha"]}
            for n in tablas["notas"] if n["archivo"] in paginas
        ],
    }
    return JSONResponse(datos, headers={"Content-Disposition": 'attachment; filename="techreader-respaldo-desde-laptop.json"'})


# El frontend (HTML, CSS, JS) se sirve desde la carpeta static/.
# Va al final para que no "tape" las rutas /api de arriba.
app.mount("/", StaticFiles(directory=RAIZ / "static", html=True), name="static")


if __name__ == "__main__":
    puerto = 8000
    print(f"\n📘 TechReader AI en http://localhost:{puerto}  (Ctrl + C para detener)\n")
    threading.Timer(1.5, lambda: webbrowser.open(f"http://localhost:{puerto}")).start()
    uvicorn.run(app, host="127.0.0.1", port=puerto, log_level="warning")
