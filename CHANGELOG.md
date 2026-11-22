# Registro de cambios

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

## [2.2.1] — 2026-11-23

### Añadido

- **El valor de cada `\celda` se ve en el editor**, junto al comando (como el
  de un `\py{}`), leído del libro sin compilar; si no se puede leer, dice por
  qué en el mismo sitio.
- **Ctrl+clic en `\celda{D18}`** abre el libro en Excel en esa hoja y celda (si
  ya está abierto, va a la celda); en `\hoja{…}`, abre el libro.
- El acceso directo del escritorio se llama **«Pyx 2.2.1»**: la versión, a
  simple vista.

### Corregido

- `\celda` en una **celda combinada** lee el valor de la combinación; las
  **fórmulas sin resultado guardado** (libros escritos por otros programas) se
  calculan (sumas, promedios, redondeos, operaciones…); se leen las celdas sin
  dirección en el XML. Una celda vacía avisa en Problemas.
- **Modo noche del PDF**: las letras negras salen blancas y limpias. El halo
  violeta eran los bordes de colores del suavizado de texto de Windows
  (ClearType); ahora el texto se dibuja sin él en modo noche.
- Los cuadros de diálogo (nombre de un entorno, avisos, preguntas) tienen el
  estilo de Pyx, no el del navegador o el del sistema.
- Autocompletado en inglés: la descripción de cada comando y entorno
  (`\section`…) y los textos de las plantillas (`title`, `caption`…).

## [2.2.0] — 2026-11-22

### Añadido

- **Datos de Excel y CSV sin Python.** `\hoja[Hoja]{libro.xlsx}` vincula un
  libro y su hoja; `\celda{E4}` coloca una celda y `\celda{E4:E8}` un rango,
  listo para un `tabular`; `\celda[T]{…}` lo transpone; `\celda{Hoja2!B2}`
  lee otra hoja. Pyx lee el archivo al compilar (los valores que guardó Excel,
  también los de las fórmulas) y CSV con «;» y coma decimal.
- **Abrir carpeta**: la carpeta del proyecto queda fija en el explorador,
  aunque no haya documentos abiertos, y se recuerda al reiniciar.
- La configuración se guarda sola en `config.json` en la carpeta `config` de
  la instalación (con copia en la carpeta del usuario), al cambiar cualquier
  ajuste y al cerrar, y se puede exportar e importar. En esa misma carpeta
  están `theme.css`, las plantillas, `macros.json` y `symbols.json`.
- La instalación trae el manual (en español y en inglés), los proyectos de
  ejemplo y la licencia. El manual tiene versión en inglés.
- Ejemplo nuevo, `05-datos-de-excel`, y todos los ejemplos en inglés.
- **Formato en `\celda`**, con la mini-lengua de formato de Python:
  `\celda[.3f]{E4}`, `\celda[,.2f]{…}`, `\celda[.1%]{…}`, `\celda[abs,.2f]{…}`,
  plantillas como `\celda[{:.2f}\,kN]{E4}`, coma decimal (`coma`),
  `cmd=\textbf`, `color=red` y `math`. Cualquier LaTeX alrededor funciona como
  con un texto (`\textbf{\celda{E4}}`, `$\celda{E4}$`); alrededor de un
  rango se aplica a cada celda. También lee los **nombres definidos** en
  Excel (`\celda{Caudal}`).
- **Insertar archivo** (el clip de Inicio → Insertar): Excel (pregunta la
  hoja), CSV, Jupyter, Python (ejecutar o mostrar el código), PDF (páginas o
  una página como figura), imagen, LaTeX y bibliografía. **Arrastrar** uno
  de esos archivos al editor escribe su llamada donde se suelta (con Mayús,
  abre el diálogo).
- **Biblioteca de plantillas** de tablas, figuras y llamadas a archivos: el
  código de los asistentes se puede editar a mano y guardar como plantilla,
  marcar una como predeterminada (también para lo que se arrastra) y
  borrarla. Son archivos `.tex` con marcadores `{{…}}`.
- **Tema personalizado**: un único `theme.css`, que empieza con todos los
  colores del tema claro u oscuro y admite cualquier regla CSS, como en VS Code.
- **Mis símbolos** en el panel de símbolos (`symbols.json`), con buscador.
- Explorador: **Copiar ruta** y **Copiar ruta relativa** (Mayús+Alt+C y
  Ctrl+Mayús+Alt+C).
- Las **pestañas** se reordenan arrastrándolas y se cierran con la rueda del
  ratón.

### Cambiado

- **Modo noche del PDF**: solo el papel y el texto negro cambian; los
  colores, las gráficas y las imágenes se conservan.
- **Ctrl+T sobre una selección** comenta solo lo seleccionado.
- Negrita, cursiva y demás formatos con el cursor en un `\py{}` se aplican
  al comando entero.
- Explorador, autocompletado y panel de problemas con el aspecto de VS Code.
- Un documento nuevo empieza vacío.
- Los temas son claro, oscuro y personalizado (el azul desaparece).
- Los desplegables abren una lista con el estilo de la app, no la del sistema.
- Panel de símbolos con la tipografía de las fórmulas (KaTeX), sin textos
  solapados.
- Panel lateral en este orden: Explorador, Estructura, Índice, Buscar.
- Toda la interfaz en inglés cuando se elige inglés (visor PDF, celdas,
  asistentes, avisos de compilación, menús y textos de ayuda).
- Los archivos de trabajo de LaTeX se borran al cerrar Pyx (y, si una sesión
  terminó mal, al arrancar): no se quedan en el ordenador.

### Corregido

- El instalador de Windows ya no lleva archivos comprimidos dentro (los
  proyectos de ejemplo van como carpetas) y Pyx ya no prueba a escribir junto
  a su ejecutable: son las dos cosas nuevas de la 2.2.0 que las heurísticas
  de algunos antivirus (Kaspersky) toman por un troyano, con el aviso «Windows
  no tiene acceso al dispositivo, ruta de acceso o archivo especificado».
  Cada publicación pasa ahora por Microsoft Defender y, si está configurado,
  por VirusTotal y la firma de SignPath antes de salir.
- Al hacer zoom en el editor (Ctrl+rueda) o cambiar la letra, los números de
  línea se quedaban desalineados y cortados hasta desplazarse.

## [2.1.0] — 2026-11-17

### Cambiado

- **Compartir queda en pausa.** La sesión compartida ya no aparece en la
  interfaz (ni el botón de la barra de título ni su pestaña del panel lateral)
  mientras se mejora. El código sigue en Pyx, sin activar; volverá en una
  versión posterior.
- El visor de PDF se mueve arrastrando con **el botón derecho, la rueda
  (botón central) o los dos**, a elegir en *Configuración → Atajos de teclado*
  (también en *Configuración → Visor PDF*). Por defecto, los dos, como antes.
- En `tabletex()` y `tex()`, `prec` son siempre **decimales**, también en una
  tabla de pandas o un array: `prec=1` escribe `41.2`, no `4e+01`.

### Corregido

- Al compilar, o tras un cambio grande, **el PDF ya no salta hacia la
  derecha**: si la página más ancha cambia, la vista se mantiene centrada donde
  estaba.
- Las **funciones de un cuaderno** vinculado con `\pynotebook{}` funcionan
  también en la compilación siguiente, al reutilizar los valores guardados
  (antes: «Can't get attribute … on `__main__`»). Los valores guardados por
  versiones anteriores se recalculan una vez.
- Un `\py{}` escrito dentro del código de una celda (en un comentario de
  Python, por ejemplo) ya no se evalúa como si fuera texto del documento.
- Un `\py{}` en un comentario de LaTeX (`% … \py{} …`) ya no produce el aviso
  «sin resolver».

### Para desarrollar

- `test/e2e/real-compile.test.js`: compila un proyecto completo con el
  compilador de Pyx, Python y LaTeX de verdad. Con él se construyen y se
  comprueban los [proyectos de ejemplo](https://lorgioo.github.io/Pyx-web/ejemplos/)
  de la web.

## [2.0.0] — 2026-11-17

Primera versión de la nueva etapa de Pyx. Recoge todo lo anterior y añade:

### Trabajar a la vez (sesión compartida)

- **Compartir** (arriba a la derecha): varias personas editan el mismo proyecto
  a la vez, como en Overleaf o Google Docs, sin pasarse archivos. Funciona sin
  configurar nada: Pyx trae puesto su servidor de sesiones.
- Se ve en tiempo real el **ratón** de cada persona (en el editor y en el PDF,
  en el mismo punto del texto o de la página aunque las ventanas sean
  distintas), su cursor y su selección; «Seguir a» alguien muestra lo que ve.
- El anfitrión elige por persona: **Python y LaTeX**, **solo LaTeX**, **solo
  Python** o **solo lectura**, y lo puede cambiar en directo. Su Pyx comprueba
  cada cambio contra el texto real y deshace lo que no está permitido, en
  cualquier archivo del proyecto (`.pltx`, `.tex`, `.sty`…).
- El anfitrión ejecuta el Python y compila para todos; el PDF llega a los
  invitados enviando solo las partes que cambian.
- Se comparte la **carpeta madre** del proyecto: capítulos, figuras y
  bibliografía en carpetas vecinas se abren, editan y compilan.
- Cifrado de extremo a extremo; ningún equipo abre puertos; el servidor no
  puede leer nada. Durante la sesión LaTeX se compila sin `shell-escape`, sin
  Lua y sin leer archivos de fuera del proyecto.
- Quien pierde la conexión sigue escribiendo y, al volver, todo se une solo,
  sin pedir paso otra vez. Probado con una docena de personas a la vez.
- Guía: `Manual de usuario/colaboracion.md`. El servidor (`server/`) se puede
  montar en cualquier sitio (`server/README.md`).

### Actualizaciones automáticas

- Pyx busca versiones nuevas al arrancar y cada dos horas; las descarga y
  comprueba (SHA-256) en segundo plano y las instala al cerrarse, o al momento
  con «Reiniciar para actualizar». En Windows, macOS y Linux (AppImage).
- Funciona aunque muchos equipos compartan la misma conexión (un aula, una
  oficina): no depende del límite de consultas de la API de GitHub.

### Compilar y ver

- «Compilar y ver» aprovecha el motor de LaTeX con el preámbulo ya cargado,
  y XeLaTeX escribe el PDF con compresión ligera: en un informe real de 18
  páginas, cada pasada baja de 17,3 s a 13,5 s.
- El visor dibuja en segundo plano el resto del documento mientras la vista
  está quieta: desplazarse es instantáneo.
- La página del PDF se mueve arrastrando con el botón derecho.
- Ctrl+clic exacto entre el código y el PDF, también debajo de tablas y
  figuras escritas con `\py{}` y en páginas sin texto.
- Marcadores del PDF fiables tras cada compilación, con número de página.
- Las figuras y tablas no pasan de su apartado (opcional, activado).

### Anotar el PDF

- Marcas editables con tiradores; flechas rectas, curvas o en codo, con una
  o dos puntas; trazo discontinuo; grosor a medida; puntero circular del
  tamaño de la punta; borrador entero o por partes; cuadros de texto; láser;
  comentarios plegables a su icono; exportar el PDF con las anotaciones.
- Mientras una herramienta está en la mano, las páginas no se mueven: ni
  solas ni al dibujar con un lápiz digital o con el dedo.

### Escribir

- Pegar una imagen la guarda en la carpeta del proyecto y escribe su figura.
- Asistentes de tabla y figura nuevos, con vista previa del código, pegar
  desde Excel en una rejilla y un estilo propio que se guarda.
- Corrector más completo en español: vocabulario técnico, verbos con
  pronombres, prefijos y adverbios; rojo para la ortografía, azul para la
  puntuación y los espacios, verde para la redacción.
- Ctrl+R reemplaza la palabra seleccionada en todo el documento.

### Aplicación

- El kernel de Python arranca siempre a la primera, aunque se abran dos a la
  vez.
- `\py{}` rechaza los datos ausentes de pandas (`pd.NA`, `pd.NaT`) como ya
  rechazaba NaN.
- La versión se ve en el título de la ventana.
- Configuración → General → «Buscar actualizaciones»: descarga, comprueba,
  instala y reabre Pyx sin más pasos.
- La carpeta del programa contiene solo el programa: compilaciones,
  registros y entornos de Python van a `%LOCALAPPDATA%\com.pyx.studio`. Lo
  que guardaban versiones anteriores se traslada solo al arrancar.
- Un `.pltx` guarda solo el documento y los resultados de sus celdas, no el
  PDF ni los archivos de compilación: pesa lo que el texto.
- La carpeta de trabajo no acumula basura: el visor no duplica el PDF, y al
  arrancar se borran los proyectos sin compilar desde hace un mes, las copias
  de la sesión anterior y los archivos intermedios.
- Pestañas de documentos más pequeñas, con ancho configurable.
- Instaladores comprobados con antivirus antes de publicarse.
