"""
lector.py — Todo lo relacionado con LEER el PDF.

Responsabilidades:
  1. Abrir un PDF.
  2. Convertir una página en imagen (para el modo "texto + imagen").
  3. Extraer el texto de una página en Markdown, separando:
       - títulos (letra más grande que el cuerpo)  -> "## Título"
       - prosa normal                              -> párrafos
       - código (fuente monoespaciada)             -> bloques ```
       - recuadros laterales (sidebars)            -> [RECUADRO] ... [/RECUADRO]
       - figuras                                   -> [FIGURA]
     e ignorando cabeceras y números de página.

Lección aprendida (versión 2):
  La v1 ordenaba los bloques por posición vertical (sort=True). En páginas con
  un recuadro al costado, eso mezclaba el recuadro EN MEDIO de un párrafo.
  Las editoriales guardan el texto en orden de lectura, así que ahora
  respetamos el orden original del PDF y separamos los recuadros por su
  posición horizontal (están fuera de la columna principal).
"""

from collections import Counter

import pymupdf  # PyMuPDF (antes se importaba como "fitz")

# Palabras que suelen aparecer en el nombre de fuentes monoespaciadas.
# Ej.: tu libro usa "TheSansMonoCd-W4SemiLigh" -> contiene "mono".
FUENTES_MONO = (
    "mono", "courier", "consola", "code", "menlo",
    "inconsolata", "monaco", "lucidaconsole", "fixed",
)
FLAG_MONOESPACIADA = 8   # bit 3 de span["flags"]
MARGEN = 0.07            # 7 % superior e inferior = zona de cabecera/pie
FIN_DE_FRASE = tuple('.:!?;)"”’')
VINETAS = ("•", "●", "▪", "◦", "■", "–", "\uf0b7")   # símbolos de listas


def abrir(ruta: str) -> pymupdf.Document:
    """Abre el PDF. No carga las 800 páginas en memoria: las lee bajo demanda."""
    return pymupdf.open(ruta)


def imagen_pagina(doc: pymupdf.Document, n: int, zoom: float = 1.6) -> bytes:
    """Devuelve la página n (empezando en 0) como imagen PNG."""
    pix = doc[n].get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
    return pix.tobytes("png")


# ───────────────────────── utilidades pequeñas ─────────────────────────

def _es_mono(span: dict) -> bool:
    """¿Este trozo de texto está escrito con fuente de código?"""
    if span["flags"] & FLAG_MONOESPACIADA:
        return True
    nombre = span["font"].lower().replace(" ", "")
    return any(palabra in nombre for palabra in FUENTES_MONO)


def _texto_bloque(bloque: dict) -> str:
    return "".join(s["text"] for l in bloque["lines"] for s in l["spans"])


def _unir(texto: str, linea: str) -> str:
    """Pega una línea al párrafo, arreglando palabras cortadas con guion
    al final de línea ("spe-" + "cific" -> "specific")."""
    linea = linea.strip()
    texto = texto.rstrip()
    # "-" = guion normal; "\xad" = guion suave (invisible) que usan las editoriales
    if texto.endswith(("-", "\xad")) and linea[:1].islower():
        return texto[:-1] + linea
    return (texto + " " + linea).strip()


def _render_codigo(lineas: list[tuple[float, float, str, float]]) -> str:
    """Reconstruye un bloque de código respetando sangría y líneas en blanco.

    En un PDF la sangría no son espacios: es la POSICIÓN x de cada línea.
    En fuentes monoespaciadas cada carácter mide ~0.6 × tamaño de fuente,
    así que (x - x_mínima) / ancho_carácter = número de espacios.
    Si el salto vertical entre dos líneas es mucho mayor que el normal,
    había una línea en blanco.
    """
    x_min = min(x for x, _, _, _ in lineas)
    salida, y_anterior = [], None
    for x, y, texto, tam in lineas:
        if y_anterior is not None and y - y_anterior > tam * 1.9:
            salida.append("")
        y_anterior = y
        # Algunos PDF guardan la sangría como posición x, otros como espacios
        # reales dentro del texto: sumamos ambas cosas.
        espacios = round((x - x_min) / (tam * 0.6 or 1))
        salida.append(" " * max(espacios, 0) + texto.rstrip())
    return "```\n" + "\n".join(salida) + "\n```"


# ───────────────────────── análisis de la página ─────────────────────────

def _tamano_cuerpo(bloques: list[dict]) -> float:
    """El tamaño de letra más usado en la página = texto normal."""
    conteo = Counter()
    for b in bloques:
        for l in b["lines"]:
            for s in l["spans"]:
                if not _es_mono(s):
                    conteo[round(s["size"], 1)] += len(s["text"])
    return conteo.most_common(1)[0][0] if conteo else 10


def _columna_principal(bloques: list[dict]) -> tuple[float, float]:
    """Rango horizontal (x0, x1) donde está la mayor parte del texto."""
    por_columna = Counter()
    for b in bloques:
        x0, _, x1, _ = b["bbox"]
        por_columna[(round(x0 / 20), round(x1 / 20))] += len(_texto_bloque(b))
    (c0, c1), _ = por_columna.most_common(1)[0]
    return c0 * 20, c1 * 20


def _es_lateral(bloque: dict, col: tuple[float, float]) -> bool:
    """Un bloque es 'lateral' si casi no se superpone con la columna principal."""
    x0, _, x1, _ = bloque["bbox"]
    ancho = max(x1 - x0, 1)
    superposicion = max(0, min(x1, col[1]) - max(x0, col[0]))
    return superposicion / ancho < 0.3


def _partes_de_bloque(bloque: dict, cuerpo: float) -> list[tuple[str, object]]:
    """Convierte un bloque en partes: ("titulo", str), ("prosa", str)
    o ("codigo", [lineas]). Un mismo bloque puede mezclar prosa y código."""
    partes: list[tuple[str, object]] = []
    for linea in bloque["lines"]:
        spans = linea["spans"]
        texto_linea = "".join(s["text"] for s in spans)
        if not texto_linea.strip():
            continue

        letras_mono = sum(len(s["text"].strip()) for s in spans if _es_mono(s))
        if letras_mono / (len(texto_linea.strip()) or 1) > 0.6:
            x0, y0 = linea["bbox"][0], linea["bbox"][1]
            dato = (x0, y0, texto_linea, spans[0]["size"])
            if partes and partes[-1][0] == "codigo":
                partes[-1][1].append(dato)
            else:
                partes.append(("codigo", [dato]))
            continue

        # Prosa: marcamos el código dentro de la frase con `comillas invertidas`.
        trozos = []
        for s in spans:
            t = s["text"]
            if _es_mono(s) and t.strip():
                antes, despues = t[: len(t) - len(t.lstrip())], t[len(t.rstrip()):]
                trozos.append(f"{antes}`{t.strip()}`{despues}")
            else:
                trozos.append(t)
        texto = "".join(trozos)

        # Viñeta de lista: empieza un elemento nuevo "- ...".
        limpio = texto.strip()
        if limpio.startswith(VINETAS):
            partes.append(("prosa", "- " + limpio.lstrip("".join(VINETAS) + " \t")))
            continue

        # Título = letra claramente más grande (ignorando símbolos sueltos).
        tamanos = [s["size"] for s in spans if any(c.isalnum() for c in s["text"])]
        tamano = max(tamanos) if tamanos else cuerpo
        tipo = "titulo" if tamano > cuerpo * 1.15 else "prosa"
        if partes and partes[-1][0] == tipo:
            partes[-1] = (tipo, _unir(partes[-1][1], texto))
        else:
            partes.append((tipo, texto.strip()))
    return partes


def _a_markdown(partes: list[tuple[str, object]]) -> str:
    """Une las partes en Markdown, juntando párrafos que el diseño del libro
    partió en dos bloques (el primero no termina en punto y el segundo
    empieza en minúscula)."""
    # Dos trozos de código seguidos son el mismo listado: juntamos sus líneas
    # ANTES de dibujarlo, para calcular bien la sangría de todo el bloque.
    juntas: list[tuple[str, object]] = []
    for tipo, dato in partes:
        if tipo == "codigo" and juntas and juntas[-1][0] == "codigo":
            juntas[-1] = ("codigo", juntas[-1][1] + dato)
        else:
            juntas.append((tipo, dato))

    salida: list[str] = []
    anterior = None
    for tipo, dato in juntas:
        if tipo == "codigo":
            salida.append(_render_codigo(dato))
        elif tipo == "titulo":
            salida.append("## " + dato)
        elif tipo == "prosa":
            if dato.startswith("- ") and salida and salida[-1].split("\n")[-1].startswith("- "):
                salida[-1] += "\n" + dato           # lista: un elemento por línea
            elif (anterior == "prosa" and salida
                    and not salida[-1].endswith(FIN_DE_FRASE)
                    and dato[:1].islower()):
                salida[-1] = _unir(salida[-1], dato)
            else:
                salida.append(dato)
        else:  # marcadores como [FIGURA]
            salida.append(dato)
        anterior = tipo
    return "\n\n".join(s for s in salida if s.strip())


def extraer_pagina(doc: pymupdf.Document, n: int) -> dict:
    """Extrae la página n (desde 0) como Markdown.

    Devuelve:
      texto          -> Markdown listo para enviar a la IA
      tiene_texto    -> False si la página es escaneada (solo imagen)
      tiene_imagenes -> True si hay figuras o diagramas
    """
    pagina = doc[n]
    alto = pagina.rect.height
    # SIN sort=True: respetamos el orden de lectura que trae el PDF.
    bloques = pagina.get_text("dict")["blocks"]

    # 1) Filtramos: fuera cabeceras/pies; las figuras quedan en su lugar.
    ordenados: list[tuple[str, dict]] = []
    for b in bloques:
        if b["type"] == 1:                         # tipo 1 = imagen
            if b["bbox"][3] - b["bbox"][1] > 25:  # ignorar adornos pequeños
                ordenados.append(("figura", b))
            continue
        texto = _texto_bloque(b).strip()
        if not texto:
            continue
        y0, y1 = b["bbox"][1], b["bbox"][3]
        en_margen = y1 < alto * MARGEN or y0 > alto * (1 - MARGEN)
        if en_margen and len(texto) < 80:          # cabecera, pie o nº de página
            continue
        ordenados.append(("texto", b))

    texto_bloques = [b for tipo, b in ordenados if tipo == "texto"]
    tiene_imagenes = any(tipo == "figura" for tipo, _ in ordenados)

    # 2) Analizamos la página: tamaño de letra normal y columna principal.
    cuerpo = _tamano_cuerpo(texto_bloques) if texto_bloques else 10
    col = _columna_principal(texto_bloques) if texto_bloques else (0, alto)
    lateral = sum(len(_texto_bloque(b)) for b in texto_bloques if _es_lateral(b, col))
    total = sum(len(_texto_bloque(b)) for b in texto_bloques)
    # Si "lo lateral" es casi tan grande como lo principal, es un libro a
    # dos columnas, no un recuadro: entonces no separamos nada.
    separar = lateral < (total - lateral) * 0.6

    # 3) Recorremos en orden, mandando los recuadros a su propia lista.
    principal: list[tuple[str, object]] = []
    recuadros: list[list] = []
    ultimo_fue_lateral = False
    for tipo, b in ordenados:
        if tipo == "figura":
            principal.append(("marca", "[FIGURA]"))
            ultimo_fue_lateral = False
        elif separar and _es_lateral(b, col):
            if not ultimo_fue_lateral:
                recuadros.append([])
            recuadros[-1].extend(_partes_de_bloque(b, cuerpo))
            ultimo_fue_lateral = True
        else:
            principal.extend(_partes_de_bloque(b, cuerpo))
            ultimo_fue_lateral = False

    texto = _a_markdown(principal)
    for r in recuadros:
        texto += "\n\n[RECUADRO]\n\n" + _a_markdown(r) + "\n\n[/RECUADRO]"

    tiene_texto = len(texto.replace("[FIGURA]", "").strip()) > 20
    # Diagramas dibujados con líneas (no son "imágenes" pero son figuras).
    if not tiene_imagenes and len(pagina.get_drawings()) > 30:
        tiene_imagenes = True

    return {"texto": texto.strip(), "tiene_texto": tiene_texto, "tiene_imagenes": tiene_imagenes}


# ───────────────────────── índice, capítulos y búsqueda ─────────────────────────

def indice(doc: pymupdf.Document) -> list[dict]:
    """La tabla de contenidos que trae el PDF (marcadores).
    Cada entrada: {nivel, titulo, pagina}. Las páginas empiezan en 1."""
    return [
        {"nivel": nivel, "titulo": titulo.strip(), "pagina": pagina}
        for nivel, titulo, pagina in doc.get_toc()
        if pagina > 0
    ]


def capitulo(entradas: list[dict], pagina: int) -> str:
    """Nombre del capítulo en el que cae la página (pagina empieza en 1).
    Usamos los niveles 1 y 2 del índice: "Parte" y "Capítulo"."""
    actual = ""
    for e in entradas:
        if e["pagina"] > pagina:
            break
        if e["nivel"] <= 2:
            actual = e["titulo"]
    return actual.title() if actual.isupper() else actual


def textos_para_buscar(doc: pymupdf.Document) -> list[str]:
    """Texto plano de cada página, en minúsculas. Se calcula una vez por libro
    (unos segundos en un libro de 800 páginas) y el servidor lo guarda."""
    return [p.get_text("text").replace("\xad", "").lower() for p in doc]


def buscar(textos: list[str], consulta: str, limite: int = 40) -> list[dict]:
    """Busca la consulta en todas las páginas. Devuelve [{pagina, fragmento}]."""
    consulta = consulta.strip().lower()
    if len(consulta) < 2:
        return []
    resultados = []
    for i, texto in enumerate(textos):
        pos = texto.find(consulta)
        if pos == -1:
            continue
        inicio = max(0, pos - 60)
        fragmento = " ".join(texto[inicio: pos + len(consulta) + 80].split())
        resultados.append({"pagina": i + 1, "fragmento": fragmento})
        if len(resultados) >= limite:
            break
    return resultados
