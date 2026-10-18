# Pyx — ideas, repositorios y mejoras

Estudio de octubre de 2026. Se ha revisado el código completo de TeXstudio
(254 archivos C++, ~150 000 líneas, sus ~200 acciones de menú), las apps de
cálculo de referencia (Jupyter, Mathcad, MATLAB Live Editor, CalcTree,
Calcpad, marimo…) y el código de Pyx entero, en busca de lo que falta, lo que
sobra y lo que ya existe hecho mejor en otro sitio.

Leyenda: ✅ Pyx ya lo tiene · 🆕 añadido en esta revisión · ⏳ pendiente
(con prioridad **A** alta, **B** media, **C** baja y esfuerzo estimado).

---

## 1. Hecho en esta revisión

| | Qué | Por qué importa |
|---|---|---|
| 🆕 | **SyncTeX nativo** (`src-tauri/src/synctex.rs`): el índice `.synctex.gz` se lee directamente, sin lanzar el programa `synctex`. | Ctrl+clic y «el PDF sigue lo que escribes» sin arrancar un proceso cada vez, y **SyncTeX funciona con Tectonic** (que no trae `synctex`). Comparado con la herramienta oficial: 92/99 líneas idénticas en la búsqueda directa y 84/85 clics sobre palabras en la inversa. |
| 🆕 | **Capa de texto del PDF de PDF.js** en lugar de la propia. | Copiar del PDF conserva los saltos de línea (antes las líneas salían pegadas), sin recálculos de diseño por página, texto girado bien colocado. |
| 🆕 | **Vista previa de fórmulas al pasar el ratón**, con los `\py{}` ya sustituidos por su valor. | Lo que TeXstudio y LaTeX Workshop hacen, más lo propio de Pyx: ves la fórmula con los números reales. |
| 🆕 | **Ctrl+clic en `\ref{…}` salta a su `\label`**. | «Ir a la definición» de TeXstudio. |
| 🆕 | **Renombrar `\begin{x}` renombra su `\end{x}`**, en un solo paso de deshacer. | TeXstudio lo hace al escribir. |
| 🆕 | **Errores de la última compilación subrayados en su línea**; F8 / Mayús+F8 para recorrerlos, Ctrl+Mayús+M para la lista. | Los «log markers» de TeXstudio. |
| 🆕 | **Guías de sangría** con `@replit/codemirror-indentation-markers`. | −134 líneas propias; resalta el bloque activo. |
| 🆕 | **Dos funciones huérfanas conectadas**: cargar los mapas de líneas guardados junto al PDF al abrir, y resolver la fuente exacta de cada copia de compilación. | Ctrl+clic antes de la primera compilación de la sesión abría la copia interna `.build.tex`; dos capítulos con el mismo nombre en carpetas distintas podían confundirse. |
| 🆕 | **9 funciones muertas eliminadas.** | Código que nadie llamaba. |

---

## 2. TeXstudio → Pyx, función por función

TeXstudio es GPL-3 y Pyx es MIT: se toman **ideas y comportamiento**, nunca
código. Los archivos `.cwl` de autocompletado de TeXstudio también son GPL.

### Edición

| Función de TeXstudio | Pyx | Nota / cómo hacerlo |
|---|---|---|
| Resaltado, plegado, minimapa, multicursor, duplicar/mover línea | ✅ | CodeMirror 6. |
| Vista previa de fórmulas al pasar el ratón | 🆕 | Con valores `\py{}` en vivo. |
| Ir a la definición (`\ref` → `\label`) | 🆕 | Falta: `\cite` → entrada del `.bib` (**B**, 1 h). |
| Renombrar entorno (`\begin`/`\end` a la vez) | 🆕 | |
| Marcas de error del registro en el editor + siguiente/anterior error | 🆕 | |
| Ordenar líneas, minúsculas/mayúsculas/título | ⏳ **C** · 1 h | «Aa» existe para la selección; falta ordenar líneas. |
| Historial del cursor (Atrás / Adelante, Alt+← / Alt+→) | ⏳ **B** · 2 h | Una pila de posiciones en cada salto (Ctrl+clic, F8, TOC). |
| Buscar en todos los archivos del proyecto | ⏳ **A** · 1 día | Comando Rust que recorre el árbol `\input` (ya se conoce en `gatherTree`) y un panel de resultados. |
| Pegar como LaTeX (tabla de Excel/HTML → `tabular`) | ⏳ **A** · 1 día | Muy útil en ingeniería: el portapapeles de Excel trae TSV y HTML; convertir a `tabular`/`booktabs`. Pegar una imagen → guardar en `figuras/` + `\includegraphics`. |
| Insertar carácter Unicode | ⏳ **C** · 2 h | |
| Tesauro (sinónimos) | ⏳ **C** | LibreOffice/OpenOffice thesaurus (`th_es_ES_v2.dat`, LGPL). |
| Macros de usuario / scripts | ⏳ **B** · 2 días | En Pyx el lenguaje de scripting natural es **Python**: un «macro» = una celda guardada que recibe la selección y devuelve texto. |
| Autocompletado de ~1 700 paquetes (archivos `.cwl`) | ⏳ **A** · 2 días | Hoy la lista de comandos es corta y fija. Los `.cwl` son GPL; alternativas: generar la base desde la documentación de CTAN, o usar la base de comandos de **texlab** (GPL también) solo como servidor externo. Comprobar licencias antes de empaquetar datos. |

### Compilación

| Función | Pyx | Nota |
|---|---|---|
| pdflatex / xelatex / lualatex, comentarios mágicos `% !TeX program` | ✅ | |
| Pasadas automáticas (latexmk), BibTeX/Biber/makeindex | ✅ | Desde la 1.5.0. |
| Motor precalentado | ✅ | Desde la 1.5.0 (no existe en TeXstudio). |
| Glosarios (`makeglossaries`), `xindex`, `texindy` | ⏳ **B** · 2 h | Misma regla de huellas que BibTeX en `run_aux_tools`. |
| Asymptote / MetaPost | ⏳ **C** | Raro en informes de ingeniería; Python+matplotlib cubre el caso. |
| Limpiar archivos auxiliares | ⏳ **C** · 30 min | En Pyx viven en el directorio de trabajo: basta un botón «Vaciar el directorio de trabajo» (= «Recompilar desde cero» sin compilar). |
| Comprobar la instalación de LaTeX | ✅ parcial | `detect_env`; falta un informe legible con versión, paquetes que faltan y cómo instalarlos (**B**). |

### Visor PDF

| Función | Pyx | Nota |
|---|---|---|
| SyncTeX en ambos sentidos, con precisión de palabra | ✅ / 🆕 nativo | |
| Anotaciones, lupa, modo noche, búsqueda | ✅ | |
| Vista de miniaturas / esquema de marcadores del PDF | ⏳ **B** · 1 día | PDF.js da `getOutline()`; panel lateral con el índice del PDF. |
| Presentación (pantalla completa por páginas) | ⏳ **C** | |

### Herramientas

| Función | Pyx | Nota |
|---|---|---|
| Ortografía (Hunspell), palabras repetidas | ✅ | |
| Gramática (LanguageTool) | ⏳ **B** | Ver §4: **Harper** (local, rápido, solo inglés) y **LanguageTool** (español; servidor local o remoto). |
| Análisis de texto (frecuencia de palabras) | ⏳ **C** · 2 h | |
| Git / SVN integrados, diff entre versiones | ⏳ **B** · 3 días | Un `.pltx` es un zip: el diff útil es el del **fuente**; guardar historial de versiones dentro del `.pltx` (como CalcTree) sería aún más útil para ingeniería. |
| Plantillas de documento | ✅ parcial | Falta una **galería de plantillas de cálculo** (ver §3, CalcTree). |
| Sesiones | ✅ | |
| Colaboración en tiempo real | ⏳ **C** | Mucho esfuerzo; Yjs + CodeMirror (`y-codemirror.next`, MIT) si algún día se quiere. |
| Asistente de IA | ⏳ **B** | TeXstudio 4.9 ya trae «AI Chat»; en Pyx encaja como «explica este error de LaTeX / de Python» con el registro y la celda como contexto. |

---

## 3. Ideas de las apps de cálculo

### Jupyter / JupyterLab

| Idea | Pyx | Cómo |
|---|---|---|
| Plegado con la barra lateral, inspector de variables, contador de ejecución, `display` / `_repr_*_` | ✅ | |
| **Autocompletado real de Python** (atributos de objetos, firmas de funciones, documentación al pasar el ratón) | ⏳ **A** · 1 día | Hoy es una lista fija. IPython usa **jedi** (MIT): petición `complete` al kernel con `jedi.Interpreter(code, [NS])`, que conoce los objetos vivos (`df.` → columnas). Si jedi no está instalado, `rlcompleter` de la biblioteca estándar. |
| Widgets interactivos (deslizadores, desplegables) | ⏳ ver MATLAB | `ipywidgets` / **anywidget** necesitan el protocolo de comms de Jupyter; en Pyx es más simple con controles propios (abajo). |
| Diff de cuadernos (nbdime) | ⏳ C | Ver Git arriba. |
| Exportar el `.pltx` como `.ipynb` / `.py` (jupytext) | ⏳ **B** · 1 día | Abrirlo en Jupyter/VS Code o en CI. Las celdas ya están marcadas; el texto LaTeX va como celdas Markdown. |

### marimo — ejecución reactiva (la idea más valiosa para Pyx)

marimo analiza cada celda **sin ejecutarla** (qué nombres define y cuáles
lee) y forma un grafo: al cambiar una celda se re-ejecutan **solo las que
dependen de ella**, en orden del grafo.

Pyx hoy re-ejecuta a partir de la **primera celda cambiada** (el «ledger» de
prefijo). En un informe con una simulación al principio y un cambio en la
celda 2, todo lo de detrás se repite aunque no dependa de nada.

| Idea | Prioridad | Cómo |
|---|---|---|
| **Grafo de dependencias entre celdas** | **A** · 3–4 días | `ast` en el kernel para sacar definiciones/lecturas de cada celda (ya hay análisis de imports). Ejecutar solo los descendientes de lo que cambió. Mantener el ledger como red de seguridad: ante mutaciones no rastreables (`lst.append`) o dudas, ejecución completa. |
| Celdas desactualizadas marcadas en cascada | **A** | Si cambia `L`, todas las celdas que leen `L` pasan a «desactualizado» al instante, sin ejecutar nada. |
| Vista del grafo | C | |

Repositorio: <https://github.com/marimo-team/marimo> (Apache-2.0).

### MATLAB Live Editor

| Idea | Prioridad | Cómo |
|---|---|---|
| **Controles interactivos en el código**: deslizador, desplegable, casilla, campo numérico que sustituyen un valor literal | **A** · 2–3 días | Sintaxis en la celda, p. ej. `L = 6.5  # @slider(1, 12, 0.5)`. El editor dibuja un deslizador; al moverlo se reescribe el literal, se re-ejecutan las celdas dependientes (grafo de marimo) y se recompila el PDF en caliente (motor precalentado). Es el «estudio paramétrico» que los ingenieros hacen a mano. |
| Ocultar el código y dejar solo controles y resultados | B | «Modo informe» del documento. |
| «Tasks» (asistentes que generan código: ajustar curva, resolver ecuación…) | C | |

### Mathcad Prime / SMath

| Idea | Prioridad | Cómo |
|---|---|---|
| **Unidades de primera clase** | ✅ parcial | `\py{}` ya tipografía pint/sympy. Falta: conversión explícita en el texto (`\py[kN]{F}`) y aviso si una magnitud se imprime sin unidad. |
| **Bloques de resolución** (resolver sistemas, optimizar con restricciones) | B · 1 día | Plantilla de celda con `scipy.optimize` / `sympy.solve` y salida tipografiada con handcalcs. |
| **Áreas** que se pliegan y bloquean | ✅ plegado / ⏳ bloqueo **C** | Bloquear = celda de solo lectura con contraseña. |
| Distinción visual entre **datos de entrada** y **resultados** | **B** · 1 día | Marcar variables como `# @input`: color de entrada en el editor y tabla de entradas en el PDF (`\pyinputs`). |

### CalcTree

| Idea | Prioridad | Cómo |
|---|---|---|
| **Galería de plantillas de cálculo** (viga, pilar, zapata, cable, tubería…) | **A** · continuo | `.pltx` de ejemplo con celdas, `\py{}` y handcalcs; Nuevo → Desde plantilla. |
| **Panel de parámetros**: las entradas del cálculo en un formulario, fuera del código | **B** · 2 días | Depende de `# @input` (arriba). |
| Encabezados y portadas de informe configurables | B | Plantilla de cabecera con proyecto, autor, revisión, fecha. |
| **Historial de versiones dentro del documento** | **B** · 2 días | El `.pltx` ya es un zip: guardar las N últimas versiones del fuente con fecha. |
| Vínculo con Excel (leer/escribir celdas) | B | `openpyxl` en una celda ya funciona; falta que una celda que **lee** un Excel se marque desactualizada cuando el Excel cambia (ya se detecta para la compilación: `nsReads`). |

### Calcpad, efficalc, handcalcs

- **Calcpad** (MIT): calculadora de ingeniería con informes HTML, unidades y métodos numéricos. Útil como referencia de sintaxis legible para no programadores.
- **efficalc**: informes de cálculo desde funciones Python (`Input`, `Calculation`, `Comparison`) — buena inspiración para `# @input` y para un `\pycheck{M_Ed < M_Rd}` que imprima «CUMPLE / NO CUMPLE» con la comparación (hoy se hace a mano con `\pyif`).
- **handcalcs** + **forallpeople**: ya integrados; forallpeople da unidades con formato de ingeniería y está pensado para handcalcs.

---

## 4. Repositorios útiles

Licencias comprobadas salvo donde pone «comprobar».

| Repositorio | Licencia | Para qué en Pyx | Prio. |
|---|---|---|---|
| [marimo-team/marimo](https://github.com/marimo-team/marimo) | Apache-2.0 | Ejecución reactiva por grafo de dependencias (idea, §3). | A |
| [davidhalter/jedi](https://github.com/davidhalter/jedi) | MIT | Autocompletado real de Python en las celdas con objetos vivos. | A |
| [wgunderwood/tex-fmt](https://github.com/wgunderwood/tex-fmt) | MIT | «Formatear documento»: formateador LaTeX en Rust, muy rápido; se puede usar como crate o binario. | B |
| [Automattic/harper](https://github.com/Automattic/harper) | Apache-2.0 | Gramática local y rápida (inglés), compila a WebAssembly. | B |
| [languagetool-org/languagetool](https://github.com/languagetool-org/languagetool) | LGPL-2.1 | Gramática en español (servidor local Java o API). | B |
| [nteract/papermill](https://github.com/nteract/papermill) | BSD-3 | Idea: ejecutar el mismo informe con varios juegos de parámetros (un PDF por caso). | B |
| [mwouts/jupytext](https://github.com/mwouts/jupytext) | MIT | Exportar/importar `.pltx` ↔ `.ipynb` / `.py`. | B |
| [James-Yu/LaTeX-Workshop](https://github.com/James-Yu/LaTeX-Workshop) | MIT | Referencia de funciones de editor LaTeX: vista previa matemática, fragmentos, formateo, recetas de compilación. | B |
| [latex-lsp/texlab](https://github.com/latex-lsp/texlab) | GPL-3 | Servidor de lenguaje LaTeX como **programa externo** opcional (renombrar etiquetas en todo el proyecto, referencias, completado de paquetes). No se puede incluir su código. | B |
| [connorferster/handcalcs](https://github.com/connorferster/handcalcs) | Apache-2.0 | Ya integrado. | — |
| [connorferster/forallpeople](https://github.com/connorferster/forallpeople) | comprobar | Unidades de ingeniería pensadas para handcalcs. | B |
| [hgrecco/pint](https://github.com/hgrecco/pint) | BSD-3 | Unidades (ya soportado en `\py{}`). | — |
| [Proektsoftbg/Calcpad](https://github.com/Proektsoftbg/Calcpad) | MIT | Referencia de calculadora de ingeniería tipo Mathcad. | C |
| [youandvern/efficalc](https://github.com/youandvern/efficalc) | comprobar | Idea de `Input`/`Calculation`/`Comparison` para informes. | C |
| [astral-sh/uv](https://github.com/astral-sh/uv) | MIT/Apache-2.0 | **Entorno Python por documento**: instalar paquetes en segundos y guardar en el `.pltx` qué versiones usa el informe (reproducible años después). | A |
| [astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone) | MPL-2.0 / varias | **Incluir Python en el instalador**: que Pyx funcione sin instalar Python aparte. | A |
| [tectonic-typesetting/tectonic](https://github.com/tectonic-typesetting/tectonic) | MIT | Ya integrado como motor opcional; siguiente paso: ofrecer descargarlo desde Pyx si no hay LaTeX. | B |
| [let-def/texpresso](https://github.com/let-def/texpresso) | comprobar | Vista en vivo incremental; su idea de «instantáneas» del motor por página es el siguiente nivel del motor precalentado. | C |
| [typst/typst](https://github.com/typst/typst) | Apache-2.0 | Alternativa moderna a LaTeX con compilación incremental en milisegundos. Una opción «documento Typst + celdas Python» sería un producto aparte; como mínimo, idea para la vista en vivo. | C |
| [manzt/anywidget](https://github.com/manzt/anywidget) | MIT | Widgets interactivos portables (si algún día se adopta el protocolo de Jupyter). | C |
| [jupyter/nbdime](https://github.com/jupyter/nbdime) | BSD-3 | Diff/merge de cuadernos: referencia para el diff de `.pltx`. | C |
| [yjs/y-codemirror.next](https://github.com/yjs/y-codemirror.next) | MIT | Colaboración en tiempo real sobre CodeMirror 6. | C |
| [robbievanleeuwen/section-properties](https://github.com/robbievanleeuwen/section-properties), [JWock82/Pynite](https://github.com/JWock82/Pynite), [CoolProp/CoolProp](https://github.com/CoolProp/CoolProp) | MIT | Librerías de ingeniería (secciones, estructuras 3D, propiedades termodinámicas) para las **plantillas de cálculo**. | B |

---

## 5. Revisión del código: qué sobra y qué se puede hacer mejor

**Conclusión honesta:** no hay apartados de 500 líneas que se puedan resolver
en 20. El tamaño de los archivos grandes es sobre todo **explicación**: un
32 % de `compiler.js` son comentarios que documentan por qué cada decisión
(errores reales que se corrigieron). La lógica es densa y casi no hay
duplicación (solo 7 nombres repetidos entre archivos, todos justificados).

Lo que sí se ha encontrado y corregido:

- **Código muerto:** 9 funciones exportadas que nadie llamaba → eliminadas.
- **Funciones a medio conectar:** `ensureBuildMaps` y `sourceOfBuild` → conectadas (eran fallos visibles).
- **Piezas hechas a mano con un equivalente mejor:** capa de texto del PDF (→ PDF.js), guías de sangría (→ librería), programa `synctex` (→ lector propio, más rápido y sin dependencia).

Lo que **no** conviene sustituir, aunque exista una alternativa:

| Pieza | Alternativa | Por qué no (todavía) |
|---|---|---|
| Kernel Python propio (`kernel.py`, 3 900 líneas) | `ipykernel` + `jupyter_client` | Ahorraría ~2 000 líneas, pero añade ZeroMQ y ~50 MB de dependencias, y el kernel de Pyx resuelve cosas que ipykernel no (protocolo inmune a salidas de C, reinicio de librerías parcheadas, ledger incremental). |
| Visor PDF propio (`preview.js`) | `PDFViewer` de pdf.js (`web/pdf_viewer`) | Ahorraría ~700 líneas de virtualización, enlaces y búsqueda, pero se pierden la lupa, las anotaciones, el zoom anclado al cursor y el control fino del repintado sin parpadeo. Reconsiderar si el mantenimiento pesa. |
| Analizador del registro (puerto de TeXstudio) | `texlab` (sus diagnósticos de registro) | Funciona y está probado; texlab sería un proceso externo GPL. |
| Resaltado LaTeX / Python propios | `@codemirror/lang-*` + `parseMixed` | `stex` es un modo heredado (StreamLanguage) que no admite lenguajes anidados con lezer; reescribirlo es un proyecto en sí. |

Siguientes candidatos de optimización real:

1. **Grafo de dependencias de celdas** (marimo): la mayor ganancia de tiempo pendiente en documentos con cálculos pesados.
2. **Autocompletado Python con jedi**: elimina la lista fija de `autocomplete.js` (~100 líneas) y la sustituye por completado real.
3. **Autocompletado LaTeX desde datos** en lugar de listas en el código.

---

## 6. Hoja de ruta propuesta

1. **Velocidad en cálculo** (A): grafo de dependencias de celdas + celdas desactualizadas en cascada.
2. **Productividad en el editor** (A): autocompletado Python con jedi; buscar en todo el proyecto; pegar tablas de Excel como `tabular`.
3. **Sin instalaciones previas** (A): Python incluido en el instalador (python-build-standalone) + entorno por documento con uv; ofrecer Tectonic si no hay LaTeX.
4. **Cálculo interactivo** (A/B): controles `# @slider` estilo MATLAB, `# @input` y panel de parámetros estilo CalcTree.
5. **Plantillas de ingeniería** (A, continuo): galería con secciones, vigas, pilares, uniones, hidráulica…
6. **Pulido TeXstudio** (B/C): historial del cursor, glosarios, marcadores del PDF, gramática, macros en Python, Git/historial de versiones.
