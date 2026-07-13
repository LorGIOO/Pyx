<div align="center">

<img src="src-tauri/icons/icon.png" alt="Pyx" width="112" height="112">

# Pyx

**El cálculo y el documento, en un mismo archivo.**

Editor LaTeX con **celdas Python tipo Jupyter** integradas: escribe la memoria y calcula sin salir del documento. Cambias un dato de entrada y **todo el informe se actualiza solo**.

![versión](https://img.shields.io/badge/versión-1.1.0-007ACC?style=flat-square)
![licencia](https://img.shields.io/badge/licencia-MIT-3fb950?style=flat-square)
![Windows](https://img.shields.io/badge/Windows-x64-0078D7?style=flat-square)
![macOS](https://img.shields.io/badge/macOS-universal-000000?style=flat-square)
![Linux](https://img.shields.io/badge/Linux-deb%20·%20rpm%20·%20AppImage-FCC624?style=flat-square)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square)
![SolidJS](https://img.shields.io/badge/SolidJS-2C4F7C?style=flat-square)

<br>

<a href="https://github.com/LorGIOO/Pyx/releases/latest"><img src="https://img.shields.io/badge/⬇%20Descargar%20para%20Windows-007ACC?style=for-the-badge&logo=windows&logoColor=white" alt="Descargar para Windows"></a>

<br><br>

<img src="docs/screenshots/tabla-python.png" alt="Pyx: editor LaTeX con celdas Python y visor PDF en paralelo" width="92%">

</div>

---

## ✨ ¿Por qué Pyx?

En ingeniería el **cálculo** vive en un sitio (Excel, Mathcad…) y el **informe** en otro (Word, LaTeX), y copiar valores a mano es lento y da errores. Pyx los une: el cálculo y la memoria son **el mismo objeto vivo**. Escribes Python donde lo necesitas, insertas el resultado en el texto con `\py{…}`, y al compilar obtienes un PDF con tipografía LaTeX y los números ya calculados. Cambia una carga, recompila, y **toda la memoria se recalcula sola**.

```latex
%#python
import math
D = 0.50               # diámetro (m)
A = math.pi * (D/2)**2 # área
%#end

El área de la sección es \py{round(A, 4)} m².
\pyif{A > 0.15}{\textcolor{red}{Sección sobredimensionada.}}{Dentro de lo previsto.}
```

## 🚀 Características

- **Simbiosis LaTeX ↔ Python** — celdas `%#python … %#end` (el archivo sigue siendo un `.tex` válido) y el puente **`\py{expresión}`** que mete valores calculados en el documento.
- **Texto que reacciona al cálculo** — `\pyif{condición}{…}{…}`: el informe se redacta solo según el resultado (p. ej. «CUMPLE / NO CUMPLE»).
- **Valores en vivo** — el resultado de cada `\py{}` aparece en gris junto a él mientras escribes, sin compilar (estilo Mathcad / MATLAB Live).
- **Kernel Python completo** — numpy, pandas, sympy, matplotlib, handcalcs, pint… con **errores estilo VSCode** (traza limpia y coloreada, línea exacta y clic para saltar) y subrayado de sintaxis en vivo.
- **Visor PDF profesional** — nítido a cualquier zoom, búsqueda, enlaces clicables, **SyncTeX** (Ctrl+clic ↔ código) y **capa de anotación/dibujo** (lápiz, resaltador, formas, notas).
- **Proyectos multi-archivo** — documento raíz con `\input`; compilar un capítulo compila todo el proyecto.
- **Comodidades de IDE** — autocompletado y snippets, corrector ortográfico, plegado de código, paneles divisibles, terminal integrada (`pip install …`), atajos configurables y temas claro/oscuro/azul.

## 📸 Capturas

**Tablas generadas con Python.** Una celda construye el `tabular` en LaTeX y lo insertas en el documento con `\py{}`; cambia los datos y la tabla se regenera al recompilar.

<div align="center">
<img src="docs/screenshots/tabla-python.png" alt="Tabla calculada en una celda Python y renderizada en el PDF" width="92%">
</div>

**Gráficos de matplotlib.** El resultado de la figura aparece **dentro de la propia celda** y, con `\includegraphics`, también en el PDF final — sin exportar nada a mano.

<div align="center">
<img src="docs/screenshots/figura-matplotlib.png" alt="Figura de matplotlib mostrada en la celda y embebida en el PDF" width="92%">
</div>

## 📦 Instalación

Descarga el instalador de tu sistema desde la [**última release**](https://github.com/LorGIOO/Pyx/releases/latest):

| Sistema | Archivo |
|---|---|
| **Windows** (x64) | `Pyx_1.1.0_x64-setup.exe` |
| **macOS** (Intel y Apple Silicon) | `Pyx_1.1.0_universal.dmg` |
| **Linux** | `.deb` (Debian/Ubuntu) · `.rpm` (Fedora) · `.AppImage` (cualquier distro) |

Como la app aún **no está firmada**: en Windows, SmartScreen mostrará un aviso — pulsa **«Más información» → «Ejecutar de todas formas»**; en macOS, la primera vez ábrela con **clic derecho → Abrir**.

Para que las celdas y la compilación funcionen, ten instalados aparte:

- **Python 3** en el PATH — opcional: `pip install numpy matplotlib pandas sympy handcalcs`.
- Una distribución **LaTeX** con `xelatex` — [MiKTeX](https://miktex.org/) (Windows), [MacTeX](https://tug.org/mactex/) (macOS) o [TeX Live](https://tug.org/texlive/) (Linux).

## ⚙️ Compilar desde el código

```bash
npm install
npm run tauri:dev      # app de escritorio con recarga en caliente
npm run tauri:build    # genera el instalador
```

Requiere **Node.js 18+**, **Rust**, **Python 3** y **LaTeX**. Solo la interfaz en el navegador: `npm run dev`.

## ⌨️ Atajos

| Atajo | Acción |
|-------|--------|
| `Mayús+Enter` | Ejecutar la celda bajo el cursor |
| `Ctrl+Mayús+B` | Compilar el documento |
| `Ctrl+S` · `Ctrl+N` · `Ctrl+O` | Guardar · Nuevo · Abrir |
| `Ctrl+F` | Buscar (editor o PDF, según el foco) |
| `Ctrl+T` | Comentar / descomentar |
| `Ctrl+Alt+Z` | Modo zen |

Todos reconfigurables en **Configuración → Atajos**.

## 🛠️ Stack

Tauri 2 · SolidJS · Vite · CodeMirror 6 · PDF.js · kernel Python embebido gestionado desde Rust.

## 📄 Licencia

[MIT](LICENSE) — libre para usar, modificar y distribuir. Las contribuciones son bienvenidas (ver [CONTRIBUTING.md](CONTRIBUTING.md)); abre un *issue* con ideas o problemas.
