"""
probar_gemini.py — Comprueba que tu clave funciona y muestra los modelos disponibles.

Ejecutar:  python probar_gemini.py

Úsalo si la app dice que ningún modelo responde: copia nombres de esta lista
en GEMINI_MODELOS dentro de tu archivo .env (separados por comas).
"""

import os

from dotenv import load_dotenv
from google import genai

load_dotenv()
cliente = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

print("Modelos de texto disponibles para tu clave:\n")
for m in cliente.models.list():
    if "generateContent" in (m.supported_actions or []) and "gemini" in m.name:
        print("  ", m.name.removeprefix("models/"))

modelo = os.getenv("GEMINI_MODELOS", "gemini-3.5-flash-lite").split(",")[0].strip()
print(f"\nProbando {modelo}...")
r = cliente.models.generate_content(model=modelo, contents="Traduce al español: A closure captures variables.")
print("Respuesta:", r.text)
