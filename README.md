<div align="center">

<img src="src-tauri/icons/icon.png" alt="Pyx" width="112" height="112">

# Pyx

**El cálculo y el documento, en un mismo archivo.**

Editor LaTeX con **celdas Python tipo Jupyter** integradas: escribe la memoria y calcula sin salir del documento. Cambias un dato de entrada y **todo el informe se actualiza solo**.

![versión](https://img.shields.io/badge/versión-1.6.0-007ACC?style=flat-square)
![licencia](https://img.shields.io/badge/licencia-MIT-3fb950?style=flat-square)
![Windows](https://img.shields.io/badge/Windows-x64-0078D7?style=flat-square)
![macOS](https://img.shields.io/badge/macOS-universal-000000?style=flat-square)
![Linux](https://img.shields.io/badge/Linux-deb%20·%20rpm%20·%20AppImage-FCC624?style=flat-square)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square)
![SolidJS](https://img.shields.io/badge/SolidJS-2C4F7C?style=flat-square)

<br>

<a href="https://github.com/LorGIOO/Pyx/releases/latest"><img src="https://img.shields.io/badge/⬇%20Descargar%20para%20Windows-007ACC?style=for-the-badge&logo=windows&logoColor=white" alt="Descargar para Windows"></a>

<br><br>

<img src="Manual de usuario/capturas/interfaz.png" alt="Pyx: editor LaTeX con celdas Python y visor PDF en paralelo" width="92%">

📘 **[Manual de usuario (PDF)](Manual%20de%20usuario/Manual%20de%20usuario%20de%20Pyx.pdf)** — todas las funciones, paso a paso, con capturas. Escrito y compilado con Pyx.

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

La celda es Python normal y corriente: **importas lo que uses**, igual que en Jupyter. Los ayudantes propios de Pyx (guardar una figura, convertir un objeto a LaTeX) viven en un módulo que también se importa:

```python
from pyx import figure, figtex, tabletex, tex, texesc
```

## 🚀 Características

- **Simbiosis LaTeX ↔ Python** — celdas `%#python … %#end` (el archivo sigue siendo un `.tex` válido) y el puente **`\py{expresión}`** que mete valores calculados en el documento.
- **Texto que reacciona al cálculo** — `\pyif{condición}{…}{…}`: el informe se redacta solo según el resultado (p. ej. «CUMPLE / NO CUMPLE»).
- **Valores en vivo** — el resultado de cada `\py{}` aparece en gris junto a él mientras escribes, sin compilar (estilo Mathcad / MATLAB Live).
- **Kernel Python plano, como Jupyter** — el espacio de nombres arranca **vacío**: ninguna librería viene precargada ni tiene trato de favor, así que las actualizas, las cambias o las parcheas como en cualquier IDE. Lo que sí trae el kernel es el protocolo del cuaderno: `display()`, `get_ipython()`, las figuras de matplotlib capturadas solas y **errores estilo VSCode** (traza limpia y coloreada, línea exacta y clic para saltar).
- **handcalcs igual que en Jupyter** — `import handcalcs.render` y las magias `%%render` / `%%tex` quedan disponibles; sin ese import no existen. Se usa la librería **real** (antes se sustituía por un sucedáneo interno, y no se podía ni actualizar).
- **Los resultados viajan con el documento** — al abrir un informe ves sus números, tablas y figuras **sin ejecutar nada** (ni hace falta Python instalado). Si una celda cambió desde que se calculó, su resultado se marca **«desactualizado»** en vez de pasar por vigente: en una memoria de cálculo, un número que ya no corresponde a su fórmula es el error más caro que existe.
- **Ejecución reactiva (grafo de dependencias)** — Pyx sabe qué variables define y usa cada celda, como marimo: al cambiar una, solo se ejecutan esa y las que dependen de ella, y si una celda vuelve a dar el mismo valor, la cadena se corta ahí. Editar la gráfica final no repite la simulación de arriba. Las celdas afectadas por un cambio se marcan **desactualizadas en cascada**. Para empezar de cero sin dudas, **Recompilar desde cero** (`Ctrl+Alt+Mayús+B`).
- **Controles interactivos** — `L = 6.0  # @slider(2, 12, 0.5)`, `# @input`, `# @select(…)`, `# @check`: un deslizador o una lista en la propia celda (como los *live scripts* de MATLAB), y el panel **Parámetros** con todos los del documento (como CalcTree).
- **Autocompletado de Python real (jedi)** — sobre las variables vivas del kernel, con la firma de cada función al escribir y su ayuda al pasar el ratón.
- **Nada que instalar antes** — si el equipo no tiene Python o LaTeX, Pyx los prepara con un clic dentro de su propia carpeta: Python con **uv** (numpy, scipy, sympy, pandas, matplotlib, handcalcs, pint…) y LaTeX con **Tectonic**. Un `ModuleNotFoundError` trae el botón **Instalar**.
- **Compilación casi instantánea (motor precalentado)** — tras cada compilación Pyx deja un motor LaTeX con el preámbulo (paquetes y fuentes) ya cargado, esperando. La siguiente solo compone el cuerpo: en un informe con fontspec, TikZ y hyperref, **0,7 s → 0,1 s**. Funciona con xelatex, lualatex y pdflatex.
- **Bibliografías e índices sin pensar en ellos** — BibTeX, Biber y makeindex se ejecutan solos entre pasadas, y solo cuando cambia lo que leen (las reglas de latexmk).
- **Errores de LaTeX subrayados mientras escribes** — llaves sin cerrar, `\begin`/`\end` que no cuadran, etiquetas repetidas, `\ref` a etiquetas inexistentes y `$` sin cerrar, antes de compilar. Opcional: avisos de estilo de ChkTeX.
- **El PDF sigue lo que escribes** — tras cada compilación en vivo, el visor muestra la parte que estás editando si no estaba a la vista.
- **Celdas como en JupyterLab** — pulsa la barra lateral de una celda para plegar su código, o la de su salida para plegar la salida. Panel **Variables** con el tipo, tamaño y valor de cada variable del kernel (doble clic: inserta `\py{nombre}`).
- **Interrupción sin perder la sesión** — parar una celda lanza `KeyboardInterrupt` como en Jupyter: **las variables ya calculadas siguen en memoria**.
- **Visor PDF profesional** — nítido a cualquier zoom, búsqueda, enlaces clicables, **SyncTeX** (Ctrl+clic ↔ código) y **capa de anotación/dibujo** (lápiz, resaltador, formas, notas).
- **Proyectos multi-archivo** — documento raíz con `\input`; compilar un capítulo compila todo el proyecto.
- **Tu carpeta solo tiene lo tuyo** — el motor LaTeX no escribe nada junto al documento: los `.build.tex`, el `.aux`, `.log`, `.toc`, `.out`, `.mtc*`, el índice SyncTeX y el PDF viven en un directorio de trabajo fuera del proyecto, y al guardar se empaquetan **dentro del `.pltx`** como hace un `.docx`. Lo único que se queda fuera, a propósito, son tus fuentes: `.tex`, imágenes y `.sty`.
- **Lo mejor de TeXstudio** — autocompletado de 336 comandos y 51 entornos (añade el `\usepackage` que falte), vista previa de fórmulas al pasar el ratón, Ctrl+clic de `\ref` a `\label`, renombrar `\begin`/`\end` a la vez, historial del cursor (`Alt+←`), **buscar en todo el proyecto** (`Ctrl+Mayús+F`), **pegar tablas de Excel** como `tabular`, glosarios, marcadores del PDF, gramática (local y **LanguageTool**) y **macros en Python**.
- **Historial de versiones** — cada guardado conserva una versión, con comparación y restauración; y Git básico si la carpeta es un repositorio.
- **Comodidades de IDE** — snippets, corrector ortográfico (español e inglés), plegado de código, paneles divisibles, terminal integrada (`pip install …`), atajos configurables y temas claro/oscuro/azul.
- **Funciona sin conexión** — las fórmulas de handcalcs se componen con KaTeX empaquetado en la app; nada depende de una CDN.

## 📸 Capturas

**Celdas, tablas y figuras.** Una celda calcula; su salida (un DataFrame, una gráfica) aparece debajo, y con `\py{}` o `pyx.tabletex()` llega al PDF.

<div align="center">
<img src="Manual de usuario/capturas/celda-tabla.png" alt="Tabla de pandas en la salida de una celda" width="45%">
<img src="Manual de usuario/capturas/celda-figura.png" alt="Gráfica de matplotlib en la salida de una celda" width="45%">
</div>

**Ejecución reactiva y parámetros.** Al cambiar la luz de la viga, las celdas que dependen de ella se marcan desactualizadas; los controles se ven en la celda y en el panel Parámetros.

<div align="center">
<img src="Manual de usuario/capturas/desactualizadas.png" alt="Celdas desactualizadas en cascada" width="45%">
<img src="Manual de usuario/capturas/parametros.png" alt="Panel de parámetros y controles" width="52%">
</div>

Más capturas, con la explicación de cada función, en el [manual de usuario](Manual%20de%20usuario/Manual%20de%20usuario%20de%20Pyx.pdf).

## 📦 Instalación

Descarga el instalador de tu sistema desde la [**última release**](https://github.com/LorGIOO/Pyx/releases/latest):

| Sistema | Archivo |
|---|---|
| **Windows** (x64) | `Pyx_1.6.0_x64-setup.exe` |
| **macOS** (Intel y Apple Silicon) | `Pyx_1.6.0_universal.dmg` |
| **Linux** | `.deb` (Debian/Ubuntu) · `.rpm` (Fedora) · `.AppImage` (cualquier distro) |

Como la app aún **no está firmada**: en Windows, SmartScreen mostrará un aviso — pulsa **«Más información» → «Ejecutar de todas formas»**; en macOS, la primera vez ábrela con **clic derecho → Abrir**.

**No hace falta instalar nada más.** Si ya tienes Python (Anaconda, python.org…) o una distribución LaTeX ([MiKTeX](https://miktex.org/), [MacTeX](https://tug.org/mactex/), [TeX Live](https://tug.org/texlive/)), Pyx los encuentra y los usa. Si falta alguno, al arrancar te ofrece prepararlo con un clic: Python con [uv](https://github.com/astral-sh/uv) y las librerías científicas, y LaTeX con [Tectonic](https://tectonic-typesetting.github.io/). Todo queda en la carpeta de datos de Pyx, sin tocar el sistema.

## ⚙️ Compilar desde el código

```bash
npm install
npm run tauri:dev      # app de escritorio con recarga en caliente
npm run tauri:build    # genera el instalador
npm test               # pruebas de la lógica de celdas, \py{} y mapas de línea
```

Requiere **Node.js 18+** y **Rust** (Python y LaTeX, los del sistema o los que prepara la propia app). Solo la interfaz en el navegador: `npm run dev`.

Los instaladores de las tres plataformas los produce GitHub Actions al empujar una etiqueta `v*`: Tauri **no compila de forma cruzada**, así que cada sistema se construye en su propio runner (ver [`.github/workflows/release.yml`](.github/workflows/release.yml)).

## ⌨️ Atajos

| Atajo | Acción |
|-------|--------|
| `Mayús+Enter` | Ejecutar la celda bajo el cursor |
| `Ctrl+Alt+Enter` | Ejecutar todas las celdas |
| `Ctrl+Alt+R` | Reiniciar el kernel |
| `Ctrl+Mayús+B` | Compilar el documento |
| `Ctrl+Alt+Mayús+B` | Recompilar desde cero (kernel nuevo, sin datos auxiliares) |
| `Ctrl+S` · `Ctrl+N` · `Ctrl+O` | Guardar · Nuevo · Abrir |
| `Ctrl+F` | Buscar (editor o PDF, según el foco) |
| `Ctrl+Mayús+F` | Buscar en todo el proyecto |
| `Alt+←` · `Alt+→` | Posición anterior / siguiente del cursor |
| `Alt+Mayús+1…9` | Ejecutar una macro de Python |
| `Ctrl+T` | Comentar / descomentar |
| `Ctrl+Alt+Z` | Modo zen |

Todos reconfigurables en **Configuración → Atajos**. La lista completa está en el manual.

## 🛠️ Stack

Tauri 2 · SolidJS · Vite · CodeMirror 6 · PDF.js · DOMPurify · KaTeX · kernel Python embebido gestionado desde Rust.

## 🙏 Código abierto en el que se apoya Pyx

Pyx adapta ideas y código de estos proyectos. Gracias a sus autores.

| Proyecto | Qué usa Pyx | Cómo |
|---|---|---|
| [tex-fast-recompile](https://github.com/user202729/tex-fast-recompile) | La idea del **motor precalentado**: un TeX que ya ha procesado el preámbulo y espera el cuerpo del documento. | Reimplementado en Rust (`src-tauri/src/latex.rs`, «Warm engine»), integrado con SyncTeX, el registro y el vigilante de bucles. |
| [mylatexformat](https://ctan.org/pkg/mylatexformat) + [latexmk](https://ctan.org/pkg/latexmk) | La separación preámbulo/cuerpo de los preámbulos precompilados, y las reglas de latexmk: repetir pasadas solo cuando hace falta y ejecutar BibTeX/Biber/makeindex cuando cambian sus entradas. | Reimplementado en `latex.rs`. El formato precompilado de mylatexformat no sirve con xelatex/fontspec; por eso se usa el motor precalentado, que sí. |
| [TeXpresso](https://github.com/let-def/texpresso) | La vista en vivo: el PDF acompaña a lo que escribes. | Tras cada compilación en vivo, el visor se desplaza vía SyncTeX a lo que estás editando (`followCursorInPdf`). |
| [Tectonic](https://github.com/tectonic-typesetting/tectonic) | Motor LaTeX autocontenido. | Opcional: si está instalado aparece como motor, y si no hay LaTeX Pyx ofrece descargarlo; Pyx adapta sus salidas y rutas de búsqueda. |
| [texlab](https://github.com/latex-lsp/texlab) + [ChkTeX](https://www.nongnu.org/chktex/) | Los diagnósticos de estructura del servidor de lenguaje de LaTeX y su integración con ChkTeX. | Comprobaciones reescritas desde cero en `js/editor/latex-lint.js` (texlab es GPL-3; no se copia su código). ChkTeX se ejecuta tal cual, si está instalado. |
| [marimo](https://github.com/marimo-team/marimo) | La ejecución reactiva: un grafo de qué variables define y usa cada celda. | Reimplementado (`js/editor/py-deps.js`, `dep-plan.js`) sobre el árbol de lezer-python, con mutaciones, corte temprano y vuelta a la regla exacta ante lo que no se puede analizar; comprobado contra Python real. |
| [jedi](https://github.com/davidhalter/jedi) | Autocompletado, firmas y ayuda de Python. | Dependencia opcional del kernel (`jedi.Interpreter` sobre el espacio de nombres vivo). |
| [uv](https://github.com/astral-sh/uv) + [python-build-standalone](https://github.com/astral-sh/python-build-standalone) | El Python que Pyx prepara si no hay ninguno. | Se descarga al pulsar «Preparar» (`src-tauri/src/runtime.rs`). |
| [LanguageTool](https://github.com/languagetool-org/languagetool) | Revisión gramatical completa. | Opcional: servidor propio o público, configurado por el usuario. |
| [MATLAB Live Editor](https://www.mathworks.com/help/matlab/matlab_prog/add-interactive-controls-to-a-live-script.html) / [CalcTree](https://www.calctree.com) | Los controles interactivos y el panel de parámetros. | Reimplementados (`js/editor/controls.js`). |
| [DOMPurify](https://github.com/cure53/DOMPurify) | Saneado del HTML de las salidas de las celdas. | Dependencia directa, con las reglas propias de Pyx como *hooks*. |
| [SyncTeX](https://github.com/jlaurens/synctex) | El formato del índice que une el PDF con el código. | Lector propio en Rust (`src-tauri/src/synctex.rs`) que reproduce las reglas de selección del programa oficial; el programa `synctex` queda como respaldo. También funciona con Tectonic. |
| [TeXstudio](https://github.com/texstudio-org/texstudio) | Funciones de editor: vista previa de fórmulas al pasar el ratón, saltar de `\ref` a `\label` con Ctrl+clic, renombrar `\begin`/`\end` a la vez y marcas del registro en el código (F8). | Reimplementado sobre CodeMirror; en la vista previa, los `\py{}` muestran su valor actual. |
| [@replit/codemirror-indentation-markers](https://github.com/replit/codemirror-indentation-markers) | Guías de sangría. | Dependencia directa. |
| [Jupyter](https://github.com/jupyter) / [JupyterLab](https://github.com/jupyterlab/jupyterlab) | El plegado de celdas y salidas con la barra lateral («collapser»), el inspector de variables, el protocolo de visualización (`display`, `_repr_*_`) y el contador de ejecución. | Reimplementado sobre CodeMirror y el kernel propio de Pyx. |

Y la base de todo: [Tauri](https://tauri.app), [SolidJS](https://www.solidjs.com), [CodeMirror](https://codemirror.net), [PDF.js](https://mozilla.github.io/pdf.js/), [KaTeX](https://katex.org), [handcalcs](https://github.com/connorferster/handcalcs) y [nspell](https://github.com/wooorm/nspell).

## 📄 Licencia

[MIT](LICENSE) — libre para usar, modificar y distribuir. Las contribuciones son bienvenidas (ver [CONTRIBUTING.md](CONTRIBUTING.md)); abre un *issue* con ideas o problemas.
