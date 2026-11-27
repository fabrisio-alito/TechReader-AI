"""
traductor.py — Habla con Gemini.

Dos usos:
  - traducir_pagina(): una página completa (texto y/o imagen).
  - asistente(): trabaja sobre un fragmento que seleccionaste con el mouse.
    Puede traducirlo, explicarlo, resumirlo o dar un ejemplo de código.

Ambos usan la misma función interna _generar(), que:
  1. Lee la clave y la lista de modelos desde .env
  2. Envía las instrucciones (prompt) y el contenido.
  3. Si un modelo falla por límite de uso (429) o no existe (404),
     prueba con el siguiente modelo de la lista.

Este es el ÚNICO archivo que sabe que existe Gemini. Si mañana quieres
usar otra IA, solo cambias este archivo y el resto de la app ni se entera.
"""

import os
from pathlib import Path

from google import genai
from google.genai import errors, types

CARPETA_PROMPTS = Path(__file__).parent / "prompts"
MODELOS_POR_DEFECTO = "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash"

# Errores "recuperables": vale la pena intentar con otro modelo.
#   404 = el modelo no existe o cambió de nombre
#   429 = superaste el límite gratuito de ese modelo (por minuto o por día)
#   500/503 = el servidor de Google está saturado
CODIGOS_REINTENTAR = {404, 429, 500, 503}


class ErrorTraduccion(Exception):
    """Error con un mensaje en español que podemos mostrar en pantalla."""


def modelos() -> list[str]:
    texto = os.getenv("GEMINI_MODELOS", MODELOS_POR_DEFECTO)
    return [m.strip() for m in texto.split(",") if m.strip()]


_cliente_cache: genai.Client | None = None


def _cliente() -> genai.Client:
    """Crea el cliente una sola vez y lo reutiliza (patrón 'singleton')."""
    global _cliente_cache
    if _cliente_cache is None:
        clave = os.getenv("GEMINI_API_KEY", "").strip()
        if not clave:
            raise ErrorTraduccion(
                "No encontré GEMINI_API_KEY. Copia .env.example como .env y pega tu clave "
                "de Google AI Studio."
            )
        _cliente_cache = genai.Client(api_key=clave)
    return _cliente_cache


def _generar(nombre_prompt: str, contenido: list) -> tuple[str, str]:
    """Envía 'contenido' a Gemini con el prompt indicado.
    Devuelve (texto_respuesta, modelo_usado)."""
    configuracion = types.GenerateContentConfig(
        system_instruction=(CARPETA_PROMPTS / nombre_prompt).read_text(encoding="utf-8"),
        temperature=0.2,  # bajo = respuestas más fieles y menos "creativas"
    )
    ultimo_error = None
    for modelo in modelos():
        try:
            respuesta = _cliente().models.generate_content(
                model=modelo, contents=contenido, config=configuracion
            )
            if respuesta.text:
                return respuesta.text, modelo
            ultimo_error = "respuesta vacía"
        except errors.APIError as e:
            ultimo_error = f"{e.code}: {e.message}"
            if e.code in CODIGOS_REINTENTAR:
                continue  # probamos el siguiente modelo
            raise ErrorTraduccion(f"Gemini rechazó la petición ({ultimo_error})") from e

    raise ErrorTraduccion(
        f"Ningún modelo pudo traducir. Último error: {ultimo_error}. "
        "Si es 429, alcanzaste el límite gratuito: espera un minuto o hasta mañana."
    )


def traducir_pagina(texto: str | None = None, imagen_png: bytes | None = None) -> tuple[str, str]:
    """Traduce una página completa.

    - Solo texto: más rápido y gasta menos cuota.
    - Texto + imagen: Gemini "ve" también los diagramas.
    - Solo imagen: para páginas escaneadas (sin texto seleccionable).
    """
    if not texto and not imagen_png:
        raise ErrorTraduccion("La página está vacía: no hay nada que traducir.")

    # "contenido" es una lista: puede mezclar imágenes y texto.
    contenido: list = []
    if imagen_png:
        contenido.append(types.Part.from_bytes(data=imagen_png, mime_type="image/png"))
    if texto:
        contenido.append("Texto extraído de la página:\n\n" + texto)
    else:
        contenido.append("Traduce el contenido de esta página (es una imagen).")
    return _generar("traducir_pagina.md", contenido)


# Cada acción del asistente usa su propio prompt (carpeta prompts/).
# Agregar una acción nueva = escribir un .md y añadir una línea aquí.
ACCIONES = {
    "traducir": "traducir_seleccion.md",
    "explicar": "explicar.md",
    "resumir": "resumir.md",
    "ejemplo": "ejemplo.md",
}


def asistente(texto: str, accion: str, libro: str = "") -> tuple[str, str]:
    """Aplica una acción (traducir, explicar, resumir, ejemplo) a un fragmento."""
    if accion not in ACCIONES:
        raise ErrorTraduccion(f"Acción desconocida: {accion}")
    texto = texto.strip()
    if not texto:
        raise ErrorTraduccion("No hay texto seleccionado.")
    if len(texto) > 6000:
        raise ErrorTraduccion("La selección es muy larga. Para eso usa 'Traducir página'.")
    contexto = f"Libro: {libro}\n\n" if libro else ""
    return _generar(ACCIONES[accion], [contexto + "Fragmento seleccionado:\n\n" + texto])
