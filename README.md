<div align="center">

<img src="src-tauri/icons/icon.png" alt="Pyx" width="104" height="104">

# Pyx

**El cálculo y el documento, en un mismo archivo.**

Un editor de LaTeX con celdas de Python dentro. Escribes el informe, calculas en él<br>
y el PDF sale con los números ya puestos. Cambias un dato y todo se actualiza.

[![Descargar para Windows](https://img.shields.io/badge/Descargar_para_Windows-2.0.0-007ACC?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/LorGIOO/Pyx/releases/latest)
&nbsp;
[![Manual de usuario](https://img.shields.io/badge/Manual_de_usuario-PDF-1F2937?style=for-the-badge)](Manual%20de%20usuario/Manual%20de%20usuario%20de%20Pyx.pdf)

<br>

<img src="Manual de usuario/capturas/interfaz.png" alt="Pyx: el código con sus celdas a la izquierda y el PDF a la derecha" width="92%">

</div>

<br>

## Cómo funciona

Un documento de Pyx es LaTeX normal con bloques de Python. Los bloques calculan; el texto usa sus resultados.

```latex
%#python
P, L = 15.0, 3.0                       # carga (kN) y vuelo (m)
flecha = P*1e3*(L*1e3)**3 / (3*210e3*8356e4)
%#end

La flecha en el extremo es de \py{round(flecha, 2)} mm,
\pyif{flecha <= L*1e3/300}{dentro}{fuera} del límite L/300.
```

Al compilar, Pyx ejecuta solo las celdas que han cambiado, pone cada valor en su sitio y genera el PDF. El documento sigue siendo LaTeX válido: las celdas son comentarios.

<br>

## Qué puedes hacer

<table>
<tr><td width="33%" valign="top">

**Escribir**

Editor de LaTeX con autocompletado de más de 300 comandos, errores marcados antes de compilar, corrector de español e inglés (rojo ortografía, azul puntuación, verde redacción), buscar y reemplazar en todo el proyecto y proyectos de varios archivos.

</td><td width="33%" valign="top">

**Calcular**

Celdas de Python como en Jupyter, con su salida debajo: tablas de pandas, gráficas, fórmulas. Autocompletado con jedi. Solo se repite lo que depende de un cambio. Tus cuadernos `.ipynb` y scripts `.py` se vinculan con `\pynotebook{}` y `\pyfile{}`.

</td><td width="33%" valign="top">

**Llevar al PDF**

`\py{}` escribe un valor, `\pyif{}` elige un texto. `tabletex()` y `figtex()` convierten una tabla o una gráfica en LaTeX. Las celdas `%%render` de handcalcs muestran el desarrollo del cálculo.

</td></tr>
<tr><td valign="top">

**Tablas e imágenes**

Pega celdas de Excel y salen como tabla. Asistentes con vista previa del código y tu propio estilo guardado. Pega una captura de una fórmula y Pyx escribe su LaTeX.

</td><td valign="top">

**Ver y revisar**

Visor de PDF integrado y rápido con documentos largos, Ctrl+clic exacto entre código y PDF en los dos sentidos, marcadores, búsqueda y anotaciones editables que se exportan con el PDF.

</td><td valign="top">

**Sin preparar nada**

Si no tienes Python o LaTeX, Pyx los prepara en su carpeta con un clic, sin tocar el sistema. Se actualiza solo desde Configuración.

</td></tr>
</table>

<br>

## Instalación

| Sistema | Archivo |
|---|---|
| **Windows** 10/11 (64 bits) | [`Pyx_2.0.0_x64-setup.exe`](https://github.com/LorGIOO/Pyx/releases/latest) — no pide permisos de administrador |
| **macOS** 11+ (Intel y Apple Silicon) | [`Pyx_2.0.0_universal.dmg`](https://github.com/LorGIOO/Pyx/releases/latest) |
| **Linux** | [`.deb`, `.rpm` o `.AppImage`](https://github.com/LorGIOO/Pyx/releases/latest) |

Si ya tienes Python (Anaconda, python.org…) o LaTeX (MiKTeX, TeX Live, MacTeX), Pyx los usa. Si no, al arrancar ofrece prepararlos. Las versiones nuevas se instalan desde **Configuración → General → Buscar actualizaciones**.

El [manual de usuario](Manual%20de%20usuario/Manual%20de%20usuario%20de%20Pyx.pdf) explica cada función con capturas. Está escrito y compilado con Pyx.

<br>

## Con qué está hecho

| Pieza | Para qué |
|---|---|
| [Tauri 2](https://tauri.app) (Rust) | La aplicación de escritorio: ventanas, archivos y los procesos de LaTeX y Python |
| [SolidJS](https://www.solidjs.com) | La interfaz |
| [CodeMirror 6](https://codemirror.net) | El editor de código |
| [PDF.js](https://mozilla.github.io/pdf.js/) · [pdf-lib](https://pdf-lib.js.org) | Mostrar el PDF · guardarlo con las anotaciones |
| Kernel de Python propio | Ejecutar las celdas y conservar sus variables entre compilaciones |
| [jedi](https://github.com/davidhalter/jedi) | Autocompletado y ayuda de Python |
| [XeLaTeX / pdfLaTeX / LuaLaTeX](https://www.latex-project.org) · [Tectonic](https://tectonic-typesetting.github.io) | Componer el PDF |
| [uv](https://github.com/astral-sh/uv) | Preparar un Python propio cuando no hay ninguno |
| [Hunspell](https://hunspell.github.io) ([nspell](https://github.com/wooorm/nspell)) · diccionario RLA | El corrector ortográfico |
| [RapidLaTeXOCR](https://github.com/RapidAI/RapidLaTeXOCR) | Reconocer fórmulas en imágenes |
| [KaTeX](https://katex.org) | La vista previa de fórmulas en el editor |
| [handcalcs](https://github.com/connorferster/handcalcs) | El desarrollo de los cálculos en el PDF |

Ideas tomadas de TeXstudio, Jupyter, marimo (ejecución reactiva), latexmk y tex-fast-recompile (el motor de LaTeX con el preámbulo precargado).

<br>

## Desarrollo

```bash
npm install
npm run tauri:dev     # la aplicación, con recarga en caliente
npm test              # pruebas
npm run tauri:build   # el instalador
```

Requiere Node.js 18+ y Rust. Los instaladores de las tres plataformas los genera GitHub Actions al publicar una etiqueta `v*`.

## Licencia

[MIT](LICENSE).
