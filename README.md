# Pyx

**Editor LaTeX con celdas Python tipo Jupyter — el cálculo y el documento en el mismo archivo.**

Escribe como en TeXstudio (con todo el motor XeLaTeX detrás) e inserta celdas de cálculo Python en
cualquier punto del documento. Los resultados se incorporan al PDF: cambias un dato de entrada y **toda la
memoria se actualiza sola**. Pensado para memorias de cálculo de ingeniería, donde el cálculo y el informe
son el mismo objeto vivo.

[![Licencia: MIT](https://img.shields.io/badge/Licencia-MIT-blue.svg)](LICENSE)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB)
![SolidJS](https://img.shields.io/badge/SolidJS-1.9-2C4F7C)

```
┌──────────────────────────────────────────────────┐
│ Pyx  [Archivo][Inicio][Matemáticas][Python][Ver]  │  ← cinta estilo Office
├───────────────────────────┬──────────────────────┤
│  Editor LaTeX             │   Vista previa PDF    │
│  (CodeMirror 6)           │   (PDF.js)            │
│                           │                       │
│  %#python                 │                       │
│    D = 0.50   # diámetro  │                       │
│    A = 3.1416*(D/2)**2    │                       │
│  %#end   [▶]              │                       │
│  El área es \py{A} m²     │                       │
├───────────────────────────┴──────────────────────┤
│ ● Kernel listo · Python 3.13 · xelatex     Ln,Col │  ← barra de estado
└──────────────────────────────────────────────────┘
```

## Características

- **Simbiosis LaTeX ↔ Python** — celdas `%#python … %#end` (comentarios LaTeX, el archivo sigue siendo un
  `.tex` válido) y el puente **`\py{expresión}`** que inserta valores calculados en el documento.
- **Texto que reacciona al cálculo** — `\pyif{condición}{…}{…}`: la redacción se adapta al resultado (p. ej.
  escribir «CUMPLE» / «NO CUMPLE» automáticamente).
- **Valores fantasma en vivo** — el resultado de cada `\py{}` aparece en gris junto a él mientras escribes,
  sin compilar (estilo Mathcad / MATLAB Live).
- **Kernel Python persistente** — numpy, pandas, sympy, matplotlib, handcalcs, pint… con errores estilo
  VSCode (traza limpia y coloreada, línea exacta y clic para saltar a ella) y subrayado de sintaxis en vivo.
- **Visor PDF profesional** — nítido a cualquier zoom, ajuste ancho/alto, búsqueda, enlaces clicables,
  **SyncTeX** (Ctrl+clic ↔ código) y una **capa de anotación/dibujo** (lápiz, resaltador, formas, notas).
- **Documentos multi-archivo** — documento raíz con `\input`; compilar un capítulo compila todo el proyecto.
- **Comodidades de IDE** — autocompletado y snippets de Python/LaTeX, corrector ortográfico, plegado de
  código, paneles divisibles, terminal integrada (`pip install …`), atajos configurables, temas claro/oscuro/azul.

## La simbiosis LaTeX ↔ Python

Una celda es cualquier bloque entre `%#python` y `%#end`. Como ambos son comentarios de LaTeX, **el archivo
sigue siendo un `.tex` 100 % válido** que compila igual en cualquier editor externo. Define variables:

```python
%#python
import math
r = 5
area = math.pi * r**2
%#end
```

Y tráelas al documento con **`\py{expresión}`**, donde la expresión es cualquier código Python evaluado con
esas variables:

```latex
El área es \py{round(area, 2)} cm², con formato \py{f"{area:.2f}"}.
\pyif{area > 75}{Supera el umbral.}{Dentro de lo previsto.}
```

Al **compilar**, Pyx ejecuta las celdas en orden → evalúa cada `\py{…}` en el kernel → escribe una copia de
build con los valores ya sustituidos → ejecuta `xelatex` → muestra el PDF. Tu `.tex` original conserva los
`\py{…}` intactos. Los documentos con celdas se guardan como **`.pltx`** (LaTeX + Python).

Helper para figuras: `figure("nombre")` guarda la figura matplotlib actual y **devuelve** su ruta; úsala con
`\includegraphics{\py{ruta}}`.

## Requisitos

- **Node.js 18+** y **Rust** (para compilar la app Tauri).
- **Python 3** en el PATH (para las celdas). Opcional: `pip install numpy matplotlib pandas sympy`.
- Una distribución **LaTeX** con `xelatex`/`pdflatex` — [MiKTeX](https://miktex.org/) o
  [TeX Live](https://tug.org/texlive/).

## Instalación

**Descargar el instalador** (Windows): consulta la sección [Releases](../../releases) — cada versión publica
un `.msi`/`.exe`. Necesitas Python y LaTeX instalados aparte.

**Compilar desde el código:**

```bash
npm install
npm run tauri:dev     # app de escritorio completa (editor + compilación + kernel)
npm run tauri:build   # genera el instalador
```

Solo la interfaz en el navegador (sin compilar ni ejecutar Python):

```bash
npm run dev
```

## Atajos

| Atajo | Acción |
|-------|--------|
| `Mayús+Enter` | Ejecutar la celda bajo el cursor |
| `Ctrl+Mayús+B` | Compilar el documento |
| `Ctrl+S` | Guardar |
| `Ctrl+N` / `Ctrl+O` | Nuevo / Abrir |
| `Ctrl+F` | Buscar (editor o PDF, según el foco) |
| `Ctrl+T` | Comentar / descomentar |
| `Ctrl+Alt+Z` | Modo zen |

Todos los atajos son reconfigurables en **Configuración → Atajos**.

## Stack

Tauri 2 · SolidJS · Vite · CodeMirror 6 · PDF.js · kernel Python embebido gestionado desde Rust.

## Licencia

[MIT](LICENSE) — libre para usar, modificar y distribuir. ¿Ideas o problemas? Abre un *issue*; las
contribuciones son bienvenidas (ver [CONTRIBUTING.md](CONTRIBUTING.md)).
