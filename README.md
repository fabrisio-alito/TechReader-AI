# 📘 TechReader AI

Lector de libros técnicos en PDF con traducción y explicaciones en español con Gemini.

El proyecto tiene **dos versiones** que hacen lo mismo:

| | **Versión web** (`docs/`) ⭐ | **Versión Python** (`servidor.py` + `static/`) |
|---|---|---|
| Dónde corre | 100 % en el navegador | En tu laptop (FastAPI) |
| Se usa desde | PC, celular, PC del trabajo | Solo tu laptop |
| Publicación | Gratis en GitHub Pages | No se publica |
| Tus datos | En cada navegador (IndexedDB) | En `datos/techreader.db` (SQLite) |

---

## A. Versión web (para leer en cualquier lado)

### A.1 Publicarla en GitHub Pages (una sola vez)

1. Crea una cuenta en **github.com** si no tienes.
2. Arriba a la derecha, **+ → New repository**:
   - Nombre: `TechReader-AI`
   - Visibilidad: **Public** (GitHub Pages es gratis solo en repositorios públicos; no hay problema, porque tu clave y tus libros **no** se suben)
   - No marques "Add a README"
   - **Create repository**
3. En la terminal de VS Code, dentro de la carpeta del proyecto:
   ```powershell
   git init
   git add .
   git status
   ```
   Revisa la lista de `git status`: **no deben aparecer** `.env`, `libros/*.pdf`, `datos/`, `venv/` ni `.venv/` (el archivo `.gitignore` los excluye). Si aparece alguno, detente y pregúntale a Claude.
   ```powershell
   git commit -m "TechReader AI: versión web y versión Python"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/TechReader-AI.git
   git push -u origin main
   ```
   La primera vez, Windows te pedirá iniciar sesión en GitHub (se abre una ventana del navegador).
4. En GitHub, dentro del repositorio: **Settings → Pages**
   - *Source*: **Deploy from a branch**
   - *Branch*: **main** y carpeta **/docs** → **Save**
5. Espera 1-2 minutos. Tu app queda en:
   **`https://TU-USUARIO.github.io/TechReader-AI/`**

Cada vez que cambies algo: `git add .` → `git commit -m "qué cambié"` → `git push`. La página se actualiza sola en un par de minutos.

### A.2 Usarla en cada dispositivo

1. Abre tu enlace `https://TU-USUARIO.github.io/TechReader-AI/`.
2. **Primera vez:** pega tu clave de Gemini y agrega el PDF (se guarda en ese dispositivo).
   O mejor: **Importar respaldo** (ver A.3) y luego agrega el PDF.
3. **Instálala como app:**
   - Android (Chrome): menú ⋮ → **Instalar app** / *Agregar a pantalla principal*.
   - iPhone (Safari): botón **Compartir** → **Agregar a inicio**.
   - PC (Chrome/Edge): ícono de instalar en la barra de direcciones, o el botón 📱 de la app.
4. **En la PC del trabajo:** activa un **PIN** en ⚙️ Ajustes → Seguridad. Al terminar tu uso ahí, usa **Salir de este dispositivo** si no quieres dejar nada guardado.

### A.3 Lectura en voz alta 🔊

- En **Traducir página**: **Escuchar traducción** (atajo `L`) u **Original en inglés** para practicar pronunciación.
- En cada tarjeta del Asistente IA, el botón 🔊 lee esa tarjeta.
- El reproductor permite pausar, ir al párrafo anterior o siguiente y cambiar la velocidad (0.75× a 2×). El párrafo que se está leyendo se resalta.
- **Seguir** (modo audiolibro): al terminar una página pasa a la siguiente, la traduce si hace falta y sigue leyendo. Ojo: cada página nueva gasta una petición de Gemini.
- Usa las voces de tu dispositivo, es gratis y no gasta cuota. En ⚙️ Ajustes → *Lectura en voz alta* eliges la voz. En Edge y en Android suele haber voces "naturales" que suenan mejor.
- Código: `docs/js/voz.js` (Web Speech API, `speechSynthesis`).

### A.4 Respaldo: pasar tu avance de un dispositivo a otro

- ⚙️ **Ajustes → Tus datos → Descargar respaldo** genera un archivo `.json` con tu progreso, traducciones y notas (sin los PDF).
- Marca **"Incluir mi clave de Gemini"** para que el respaldo la lleve **cifrada** con una contraseña tuya.
- En el otro dispositivo: **Importar respaldo**. Luego agrega el mismo PDF y continúas donde ibas.
- **Desde la versión Python (tu laptop):** con `python servidor.py` corriendo, abre `http://localhost:8000/api/respaldo`. Se descarga un respaldo con todo lo que ya hiciste, que puedes importar en la versión web.

⚠️ Tus datos viven en el navegador. **No borres "Cookies y datos de sitios"** del navegador o los perderás. Descarga un respaldo de vez en cuando.

### A.5 Cómo está hecha (para aprender)

```
docs/
├── index.html            estructura de la página
├── estilos.css           diseño (escritorio + celular)
├── app.js                interfaz y comportamiento
├── js/
│   ├── lector.js         extracción de texto del PDF (traducción de lector.py a JavaScript)
│   ├── gemini.js         llamadas a Gemini con fetch() (reemplaza a traductor.py)
│   ├── almacen.js        base de datos del navegador, IndexedDB (reemplaza a db.py + SQLite)
│   └── voz.js            lectura en voz alta con las voces del dispositivo
├── prompts/*.md          las mismas instrucciones para la IA
├── manifest.webmanifest  permite "instalarla" como app
├── sw.js                 service worker: abre sin internet (estrategia "red primero")
└── vendor/               PDF.js, marked, DOMPurify, highlight.js
```

Compara `lector.py` con `docs/js/lector.js`: es el mismo algoritmo en dos lenguajes. La diferencia es que PDF.js entrega trocitos de texto con posición, y primero hay que armar las líneas y los bloques que PyMuPDF ya trae hechos.

---

# B. Versión Python (en tu laptop)

Lector de libros técnicos en PDF. A la izquierda ves la página original; a la derecha, su traducción al español.

- **Traducir página**: traduce la página completa cuando la necesitas (atajo `T`).
- **Traducir selección**: selecciona con el mouse cualquier parte del PDF y aparece la burbuja **Traducir selección**. La traducción sale en una ventana flotante que puedes mover.
- Todo lo traducido se guarda: volver a una página o a un fragmento no gasta cuota de Gemini.

---

## 1. Cómo arrancar (cada día)

```powershell
.venv\Scripts\activate
python servidor.py
```

Se abre el navegador en **http://localhost:8000**. Para detener el servidor, pulsa `Ctrl + C` en la terminal.

### Primera vez / después de actualizar

```powershell
.venv\Scripts\activate
pip install -r requirements.txt
python probar_gemini.py
```

> La clave de Gemini va en `.env` (copia `.env.example`). Se saca gratis en https://aistudio.google.com/apikey. Tu cuenta *AI Pro* de estudiante es para la app de Gemini y **no** incluye la API.

---

## 2. Cómo se usa

| Quiero… | Cómo |
|---|---|
| Agregar un libro | Clic en el nombre del libro (arriba a la izquierda) → **Agregar PDF…**, o arrastra el PDF a la ventana |
| Cambiar de libro | El mismo menú: muestra cada libro con su avance |
| Entender una parte | **Selecciónala en el PDF** → barra con **Traducir · Explicar · Resumir · Ejemplo · Guardar** |
| Traducir la página completa | Pestaña **Traducir página** (o `T` sin selección) |
| Buscar en el libro | Cuadro **Buscar en el libro…** (o `Ctrl + F`) |
| Ir a un capítulo | Botón de índice (☰) en la barra del PDF |
| Repasar lo guardado | Pestaña **Apuntes** (este libro) o **Mis Notas** arriba (todos los libros) |
| Letra más grande / temas | `A−` `A+`, o ⚙️ Ajustes: tema Oscuro/Sepia/Claro, interlineado, serif/sans, PDF oscuro |
| Repartir el espacio | Arrastra el espacio entre las dos tarjetas |

**Glosario** y **Cuestionarios** aparecen en el menú, pero son los próximos sprints.

## 3. Cómo funciona

El proyecto ahora tiene dos mitades que se comunican por HTTP:

```
 NAVEGADOR (frontend: static/)                 PYTHON (backend: servidor.py)
 ─────────────────────────────                 ─────────────────────────────
 index.html   estructura                       servidor.py  rutas /api/...
 estilos.css  apariencia y temas       fetch    lector.py    lee el PDF
 app.js       comportamiento         ───────►  traductor.py habla con Gemini
 vendor/      PDF.js, marked,        ◄───────  db.py        guarda en SQLite
              DOMPurify                JSON     prompts/     instrucciones para la IA
```

Con el servidor encendido, abre **http://localhost:8000/docs**: FastAPI genera una página donde puedes ver y probar cada ruta de la API. Úsala para entender qué responde el backend.

### Qué hace cada archivo

| Archivo | Qué hace | Concepto que aprendes |
|---|---|---|
| `servidor.py` | Define la API (`/api/libros`, `/api/asistente`, `/api/notas`, `/buscar`…) y sirve la página web | API REST, rutas, JSON, validación con Pydantic, seguridad (*path traversal*), hilos y candados |
| `lector.py` | Extrae el texto de la página: títulos, párrafos, código, recuadros, figuras | El PDF guarda texto con posición y fuente, no párrafos. Hay que reconstruir la estructura |
| `traductor.py` | Envía la página o la selección a Gemini, con un prompt distinto para cada acción (traducir, explicar, resumir, ejemplo) | Consumir APIs externas, manejo de errores, aislar un proveedor en un solo archivo |
| `db.py` | Tablas `libros`, `traducciones`, `selecciones`, `notas` | SQL, caché, *upsert*, **migraciones** (`ALTER TABLE` sin perder datos) |
| `prompts/*.md` | Instrucciones para la IA: una por acción | *Prompt engineering*: se editan sin tocar código |
| `static/app.js` | Dibuja el PDF con PDF.js, detecta tu selección, llama a la API | DOM, eventos, `async/await`, `fetch`, `localStorage` |
| `static/estilos.css` | Temas y tipografía | Variables CSS, grid, diseño adaptable |

### El error de la versión anterior (y la lección)

En tu PC la página quedó vacía porque **Windows le dijo a Python que los archivos `.js` eran texto plano**. El navegador, por seguridad, no ejecuta JavaScript que llega con un tipo incorrecto. Las primeras líneas de `servidor.py` (`mimetypes.add_type`) dejan fijo el tipo correcto. Además, si `app.js` no logra cargar, ahora aparece un aviso que explica qué revisar, en vez de una página vacía.

### El truco de la selección

PDF.js dibuja la página en un `<canvas>`, que es una imagen. Encima pone una **capa de texto invisible** (`.textLayer`) con cada palabra en su posición exacta. Cuando seleccionas, en realidad seleccionas esa capa transparente. `app.js` lee la selección con `window.getSelection()`, muestra la burbuja junto a ella y envía el texto a `/api/seleccion`.

### Lo que arreglamos en la versión 2 del lector

En la v1 un recuadro lateral (como "I Just Want My Own Site") se metía en medio de un párrafo y la IA lo resumía como "Figura". La causa era que ordenábamos los bloques por su altura en la página. Ahora `lector.py` hace esto:
1. Respeta el orden de lectura que trae el PDF.
2. Detecta la columna principal y manda los bloques que quedan fuera a un `[RECUADRO]`, que el prompt obliga a traducir completo.
3. Quita cabeceras y números de página, une párrafos que el diseño partió en dos y arregla los guiones suaves (`organiza­tion` → `organization`).

> Las páginas que tradujiste con la versión anterior siguen guardadas. Si alguna quedó incompleta, pulsa **Volver a traducir**.

---

## 4. Retos para aprender

1. **API:** abre `http://localhost:8000/docs`, prueba `GET /api/libros` y explica cada campo de la respuesta.
2. **CSS:** crea un cuarto tema (por ejemplo "noche azul") copiando el bloque `[data-tema="sepia"]` de `estilos.css` y agregando su botón en `index.html`.
3. **Prompts:** agrega una acción "Pronunciar" al asistente: escribe `prompts/pronunciar.md`, añádela a `ACCIONES` en `traductor.py` y agrega su botón en `index.html`.
4. **SQL:** abre `datos/techreader.db` y cuenta cuántas veces usaste cada acción (`SELECT accion, COUNT(*) FROM selecciones GROUP BY accion`).
5. **Lector:** busca una página donde la extracción falle (mira "🔍 Ver el texto que extrajo el lector") e investiga por qué.

---

## 5. Próximos sprints

- [x] Sprint 1: traducción por página, caché, última página
- [x] Sprint 1.5: interfaz web, traducción de selección, temas y tamaño de letra
- [x] Sprint 2: Asistente IA (explicar, resumir, ejemplo), notas, búsqueda, índice
- [ ] Sprint 3: glosario personal a partir de tus selecciones y del 📌 Vocabulario
- [ ] Sprint 4: tarjetas de repaso
- [ ] Sprint 5: pre-traducir la siguiente página mientras lees

> `app.py` y la carpeta `.streamlit/` son de la versión anterior (Streamlit). Ya no se usan y puedes borrarlos.
