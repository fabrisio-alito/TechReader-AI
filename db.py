"""
db.py — La memoria de la app (SQLite).

Tablas:
  libros        -> en qué página te quedaste en cada libro
  traducciones  -> páginas completas ya traducidas (caché)
  selecciones   -> resultados del Asistente IA sobre fragmentos (caché)
                   accion = traducir | explicar | resumir | ejemplo
  notas         -> lo que guardas con el botón "Guardar" (tus apuntes)

SQLite es una base de datos en UN solo archivo (datos/techreader.db).
Viene incluida con Python. Puedes abrirla con "DB Browser for SQLite".
"""

import sqlite3
from datetime import datetime
from pathlib import Path

RUTA_DB = Path(__file__).parent / "datos" / "techreader.db"


def _conectar() -> sqlite3.Connection:
    RUTA_DB.parent.mkdir(exist_ok=True)
    con = sqlite3.connect(RUTA_DB)
    con.row_factory = sqlite3.Row   # filas que se leen como diccionarios: fila["pagina"]
    return con


def _ahora() -> str:
    return datetime.now().isoformat(timespec="seconds")


def iniciar() -> None:
    """Crea las tablas si no existen y actualiza las viejas (migración)."""
    with _conectar() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS libros (
                archivo        TEXT PRIMARY KEY,
                ultima_pagina  INTEGER NOT NULL DEFAULT 0,
                actualizado    TEXT
            );

            CREATE TABLE IF NOT EXISTS traducciones (
                archivo    TEXT    NOT NULL,
                pagina     INTEGER NOT NULL,
                texto      TEXT    NOT NULL,
                modelo     TEXT,
                fecha      TEXT,
                PRIMARY KEY (archivo, pagina)
            );

            CREATE TABLE IF NOT EXISTS selecciones (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                archivo    TEXT    NOT NULL,
                pagina     INTEGER NOT NULL,
                original   TEXT    NOT NULL,
                traduccion TEXT    NOT NULL,
                modelo     TEXT,
                fecha      TEXT
            );

            CREATE TABLE IF NOT EXISTS notas (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                archivo    TEXT    NOT NULL,
                pagina     INTEGER NOT NULL,
                original   TEXT    NOT NULL,
                contenido  TEXT    NOT NULL DEFAULT '',
                fecha      TEXT
            );
            """
        )
        # MIGRACIÓN: la versión anterior no tenía la columna "accion".
        # Si tu base de datos es vieja, se la agregamos sin borrar nada.
        columnas = [fila["name"] for fila in con.execute("PRAGMA table_info(selecciones)")]
        if "accion" not in columnas:
            con.execute("ALTER TABLE selecciones ADD COLUMN accion TEXT NOT NULL DEFAULT 'traducir'")
        con.execute(
            "CREATE INDEX IF NOT EXISTS idx_sel ON selecciones (archivo, accion, original)"
        )


# ───────────────────────── libros y páginas ─────────────────────────

def ultima_pagina(archivo: str) -> int:
    with _conectar() as con:
        fila = con.execute("SELECT ultima_pagina FROM libros WHERE archivo = ?", (archivo,)).fetchone()
    return fila["ultima_pagina"] if fila else 0


def guardar_pagina(archivo: str, pagina: int) -> None:
    # "UPSERT": inserta la fila, y si ya existe, la actualiza.
    with _conectar() as con:
        con.execute(
            """
            INSERT INTO libros (archivo, ultima_pagina, actualizado) VALUES (?, ?, ?)
            ON CONFLICT(archivo) DO UPDATE SET
                ultima_pagina = excluded.ultima_pagina,
                actualizado   = excluded.actualizado
            """,
            (archivo, pagina, _ahora()),
        )


def obtener_traduccion(archivo: str, pagina: int) -> tuple[str, str] | None:
    with _conectar() as con:
        fila = con.execute(
            "SELECT texto, modelo FROM traducciones WHERE archivo = ? AND pagina = ?",
            (archivo, pagina),
        ).fetchone()
    return (fila["texto"], fila["modelo"]) if fila else None


def guardar_traduccion(archivo: str, pagina: int, texto: str, modelo: str) -> None:
    with _conectar() as con:
        con.execute(
            "INSERT OR REPLACE INTO traducciones (archivo, pagina, texto, modelo, fecha) "
            "VALUES (?, ?, ?, ?, ?)",
            (archivo, pagina, texto, modelo, _ahora()),
        )


def todas_las_traducciones(archivo: str) -> list[tuple[int, str]]:
    with _conectar() as con:
        filas = con.execute(
            "SELECT pagina, texto FROM traducciones WHERE archivo = ? ORDER BY pagina", (archivo,)
        ).fetchall()
    return [(f["pagina"], f["texto"]) for f in filas]


def total_traducidas(archivo: str) -> int:
    with _conectar() as con:
        return con.execute(
            "SELECT COUNT(*) FROM traducciones WHERE archivo = ?", (archivo,)
        ).fetchone()[0]


# ───────────────────────── asistente (caché de selecciones) ─────────────────────────

def buscar_resultado(archivo: str, accion: str, original: str) -> tuple[str, str] | None:
    """¿Ya aplicamos esta acción a exactamente este fragmento?"""
    with _conectar() as con:
        fila = con.execute(
            "SELECT traduccion, modelo FROM selecciones "
            "WHERE archivo = ? AND accion = ? AND original = ? ORDER BY id DESC LIMIT 1",
            (archivo, accion, original),
        ).fetchone()
    return (fila["traduccion"], fila["modelo"]) if fila else None


def guardar_resultado(archivo: str, pagina: int, accion: str, original: str,
                      resultado: str, modelo: str) -> None:
    with _conectar() as con:
        con.execute(
            "INSERT INTO selecciones (archivo, pagina, accion, original, traduccion, modelo, fecha) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (archivo, pagina, accion, original, resultado, modelo, _ahora()),
        )


# ───────────────────────── notas ─────────────────────────

def guardar_nota(archivo: str, pagina: int, original: str, contenido: str) -> int:
    with _conectar() as con:
        cursor = con.execute(
            "INSERT INTO notas (archivo, pagina, original, contenido, fecha) VALUES (?, ?, ?, ?, ?)",
            (archivo, pagina, original, contenido, _ahora()),
        )
        return cursor.lastrowid


def listar_notas(archivo: str | None = None) -> list[dict]:
    """Todas las notas, o solo las de un libro. Las más recientes primero."""
    consulta = "SELECT id, archivo, pagina, original, contenido, fecha FROM notas"
    parametros: tuple = ()
    if archivo:
        consulta += " WHERE archivo = ?"
        parametros = (archivo,)
    with _conectar() as con:
        return [dict(f) for f in con.execute(consulta + " ORDER BY id DESC", parametros)]


def borrar_nota(id_nota: int) -> bool:
    with _conectar() as con:
        return con.execute("DELETE FROM notas WHERE id = ?", (id_nota,)).rowcount > 0


# ───────────────────────── respaldo para la versión web ─────────────────────────

def volcar_tablas() -> dict:
    """Todas las filas de cada tabla (para el respaldo que importa la versión web)."""
    with _conectar() as con:
        return {
            tabla: [dict(f) for f in con.execute(f"SELECT * FROM {tabla}")]
            for tabla in ("libros", "traducciones", "selecciones", "notas")
        }
