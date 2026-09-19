# Registro de cambios

Todas las versiones publicadas de Pyx. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

## [Sin publicar]

Lo que escribes es lo que ves, siempre.

### Corregido

- **Proyectos fuera de la carpeta de usuario no compilaban.** Un proyecto en
  otra unidad (`E:\…`), un USB o una carpeta de red: la interfaz solo podía
  leer, escribir y comprobar archivos dentro de `C:\Users\<usuario>`, y fuera de
  ahí «¿existe `capitulo.pltx`?» respondía que no, en silencio. El
  `\input{capitulo.pltx}` no se traducía y el motor recibía el `.pltx`
  comprimido. Tampoco se podían guardar `.tex` allí. Ahora todo pasa por los
  comandos propios de Pyx, sin esa restricción, y un `\input` a un `.pltx` que
  no se encuentra aparece en «Problemas».
- **Un archivo enlazado que no existe ya no impide compilar ni da errores.**
  Imágenes (`\includegraphics`, con o sin extensión), PDF (`\includepdf`),
  documentos (`\input`, `\include`) y listados (`\lstinputlisting`,
  `\verbatiminput`): en su lugar aparece un recuadro «No encontrado: <ruta>»,
  el resto del documento se compone con lo último que escribiste y «Problemas»
  lo lista como **aviso**, con su archivo y su línea. Antes, con xelatex una
  sola imagen que faltaba detenía a xdvipdfmx a mitad del PDF —el visor seguía
  enseñando el anterior y nada de lo escrito después aparecía—, y un `\input`
  o un `\lstinputlisting` a un archivo inexistente abortaba la compilación
  entera. Un `.pltx` dañado se muestra como «No se pudo leer» y se explica el
  motivo, en vez de romper la compilación.
- Si aun así el motor deja un PDF a medias, se descarta, se conserva el
  anterior y se explica por qué (antes el único mensaje era «Invalid PDF
  structure», que además sustituía todo el registro).
- **Guardar durante una compilación ya no empaqueta archivos a medio escribir**
  dentro del `.pltx` (un `synctex(busy)`, un registro cortado): ese guardado
  conserva el directorio de trabajo del guardado anterior; la fuente y los
  resultados sí son siempre los actuales.
- Los problemas del documento principal aparecían bajo un nombre cortado
  («_Raiz.build.te») y con números de línea de la copia interna: TeX parte el
  registro a 79 columnas. Ahora llevan el archivo y la línea reales.
- **Al abrir un proyecto se veía el PDF de una versión antigua** si sus
  capítulos habían cambiado después del último guardado de la raíz: el PDF
  restaurado del `.pltx` llevaba la hora de apertura y solo se comparaba con la
  raíz. Ahora conserva la hora del guardado y se compara también con los
  documentos que la raíz incluye con `\input`; si alguno es más nuevo, no se
  enseña un PDF que ya no corresponde.
- Un `\input` **comentado** (`% \input{capitulo}`) ya no se procesa: antes se
  leía el capítulo desactivado y se ejecutaban sus celdas.
- Un error del visor al abrir el PDF se **añade** al registro de la
  compilación en vez de reemplazarlo, y un fallo interno de la compilación
  aparece en «Problemas» (antes decía «Sin errores ni avisos detectados» bajo
  una barra de estado que marcaba error).
- Los capítulos `\input` en `latin-1`/`windows-1252` se leen igual que al
  abrirlos en el editor, sin convertir los acentos en «�».
- **Cambios que no llegaban al PDF.** Leer un `.pltx` restauraba su directorio
  de compilación desde el último guardado, y el compilador lee `.pltx` todo el
  rato: la raíz del capítulo que editas, cada capítulo, cada candidato al
  buscar la raíz. Cada una de esas lecturas ponía los `.build.tex` guardados
  encima de los recién escritos, y el motor componía el texto viejo. Ahora solo
  se restaura al **abrir** un documento.
- **Pulsar «Compilar» durante otra compilación no hacía nada** —y el botón se
  desactivaba, justo cuando la compilación de fondo de la pausa al escribir
  estaba en marcha—. Ahora ninguna petición se pierde: las que llegan mientras
  se compila se funden en una sola compilación que empieza en cuanto termina la
  actual, con el texto tal como esté entonces.
- **El visor podía quedarse con el PDF anterior** cuando dos compilaciones
  terminaban seguidas: el que acababa de analizarse el último ganaba, aunque
  fuera el más viejo.
- **Ctrl+S guardaba dos veces** con el cursor en el editor: el editor atendía
  la tecla y la dejaba seguir hasta el atajo global, que volvía a guardar. Cada
  guardado de un `.pltx` empaqueta su directorio de compilación entero.
- **Reabrir un documento mostraba el PDF de una edición antes.** Guardar
  empaqueta el directorio de compilación antes de la compilación que dispara,
  y al abrir, la restauración pisaba el PDF nuevo con el empaquetado. Ahora se
  conserva todo archivo de compilación más reciente que el propio documento, y
  al abrir solo se muestra un PDF que no sea más antiguo que el documento: uno
  de otra versión del archivo (editada fuera de Pyx, copiada de otro equipo) no
  se enseña como si fuera suyo.
- El compilador ya no se fía de su memoria para saltarse escribir un
  `.build.tex`: comprueba que el archivo en disco sigue siendo el que escribió.
- El mismo documento podía tener dos directorios de trabajo según existiera o
  no en ese instante, y un guardado empaquetaba uno mientras la apertura
  restauraba el otro.

### Cambiado

- **Ctrl+S guarda, compila y muestra el PDF**, igual que «Compilar y ver»:
  ejecuta las celdas que lo necesiten y LaTeX, y abre el visor si estaba
  cerrado. Antes lanzaba una compilación de fondo que no abría el visor.
- **Los botones de compilar dicen lo que están haciendo.** Mientras compila,
  «Compilar y ver» pasa a «Compilando…», resaltado y con una barra en marcha;
  si se pulsa otra vez, «En cola…». Antes se veía igual en reposo que
  trabajando —y en la 1.3.1 se desactivaba—, así que pulsar durante una
  compilación larga parecía no hacer nada.
- **Los `.pltx` funcionan como capítulos igual que un `.tex`**, lleven celdas o
  no. Antes un `.pltx` de LaTeX puro no recibía copia de compilación y TeX
  intentaba leer el zip. Las imágenes y paquetes junto a un capítulo en una
  subcarpeta se encuentran también, sin tapar nunca un archivo del mismo nombre
  junto al documento principal (comprobado con pdflatex y xelatex).
- **Una pasada de LaTeX en vez de dos.** Se forzaban dos en cualquier documento
  que tuviera `\ref`, `\cite` o `\tableofcontents`, es decir, casi todos, aunque
  el `.aux` ya se conserva. Ahora el motor relanza solo cuando hace falta: si
  cambian las referencias o si cambia el contenido del índice, que LaTeX no
  avisa.
- **Al abrir un documento se ve su PDF al instante**, el que venía guardado
  dentro del `.pltx`, sin esperar a compilar.
- **Repintar el PDF tras compilar es ~4× más rápido** (de ~135 ms a ~34 ms en
  un informe de 494 páginas): el visor reutiliza un único proceso de PDF.js en
  vez de arrancar uno nuevo en cada compilación.
- El visor pinta primero las páginas que estás viendo y deja la capa de texto
  seleccionable para después de tener todos los lienzos.

## [1.3.1] — 2026-09-04

Compilar deja de repetir trabajo que ya estaba hecho.

### Corregido

- **«Compilar y ver» ya no reinicia el kernel.** Cada pulsación vaciaba el
  espacio de nombres y volvía a ejecutar **todas** las celdas del documento:
  reimportar numpy, matplotlib, handcalcs y pandas, y repetir cada cálculo,
  aunque solo hubieras cambiado una coma. De ahí venían los 10–50 s.

  El registro del espacio de nombres ya garantizaba lo mismo sin ese coste:
  solo se salta un prefijo de celdas cuando es **exactamente** un prefijo, y
  ante cualquier divergencia —otra celda, otro directorio de trabajo, un
  kernel reiniciado, una celda interrumpida— vuelve a ejecutarlo todo. El
  reinicio forzado era una precaución encima de una garantía que ya existía, y
  se cobraba en cada compilación.

  La red de seguridad que antes solo cubría las compilaciones en segundo plano
  ahora cubre las dos: si un `\py{}` no evalúa —la señal de que el espacio de
  nombres ha derivado— se relanza el documento entero antes de que nada llegue
  al PDF. Para forzar una ejecución completa a mano sigue estando **«Reiniciar
  el kernel»**.

  La primera compilación tras abrir un documento sigue costando lo mismo: ahí
  hay que construir el espacio de nombres de verdad, y eso es trabajo real.

- **Los `\input` de un proyecto se resuelven en paralelo.** Localizar en disco
  el archivo al que apunta cada `\input` costaba una consulta al backend por
  capítulo, **en serie**, en cada compilación —incluidas las que dispara una
  pausa al escribir—. Un proyecto de cien capítulos pagaba cien viajes de ida
  y vuelta encadenados. Ahora salen todos a la vez y el resultado se recuerda
  durante la sesión, porque la ruta a la que resuelve `cap/uno` no cambia entre
  compilaciones. Un archivo incluido dos veces se lee una sola.

- **Guardar un `.pltx` ya no recomprime el PDF.** El contenedor volvía a
  aplicar Deflate a todo el directorio de compilación en cada guardado, PDF y
  figuras incluidos. Eso es CPU quemada para nada: ya venían comprimidos. El
  texto (`.aux`, `.log`, `.toc`) se sigue comprimiendo, que ahí sí compensa.

### Añadido

- **Desglose de tiempos al final del log**, con lo que costó Python, lo que
  costó el motor LaTeX y cuántas celdas se ejecutaron de cuántas. Cuando
  compilar se hace lento, la única pregunta útil es «lento haciendo qué», y
  adivinar la respuesta ya salió mal una vez.

### Cambiado

- **La aplicación arranca en su página de inicio**, no en un documento en
  blanco. Antes cada arranque ofrecía un «sin-título» que nadie había pedido y
  que había que cerrar antes de abrir el proyecto de verdad. Ahora aparecen el
  logo y los dos botones que hacen falta: **Nuevo documento** y **Abrir**.
  Abrir un `.pltx` con doble clic sigue llevando directamente al documento.
- Nuevo logo de Pyx en la página de inicio.

## [1.3.0] — 2026-09-01

La carpeta del proyecto vuelve a ser tuya: solo contiene lo que tú pusiste.

### Cambiado

- **Ni un solo archivo de compilación en tu carpeta.** El motor LaTeX ya no
  escribe junto al documento: cada proyecto tiene un directorio de trabajo
  **fuera** de la carpeta (en la caché del sistema), y ahí van los `.build.tex`,
  el `.aux`, `.log`, `.toc`, `.out`, `.fls`, `.maf`, los `.mtc*` de minitoc, el
  índice SyncTeX y el PDF. La carpeta `.pyxbuild` que introdujo la 1.2.1
  desaparece: tampoco era asunto del usuario.

  El motor sigue **ejecutándose** desde la carpeta del proyecto, así que las
  rutas relativas del documento (`\includegraphics{xref/…}`, un `.sty` al lado)
  se resuelven exactamente como las escribiste.

- **Todo eso se guarda dentro del `.pltx`.** Al guardar, el directorio de
  trabajo entero se empaqueta en el contenedor comprimido, y al abrir se
  restaura. Estructuras anidadas (`_Proyecto.pltx` con sus `documento1.pltx`)
  siguen funcionando igual: cada documento tiene su propio directorio de
  trabajo y ninguno ensucia nada.

- **El PDF también vive ahí**, invisible. El visor lo abre desde el directorio
  de trabajo; para sacar una copia hay un botón nuevo en la barra del visor,
  **«Guardar una copia del PDF…»**.

- **Al abrir un documento se limpia lo que dejaron las versiones anteriores**:
  su `.build.tex`, sus `.aux`/`.log`/`.toc`/`.out`/`.mtc*`… y la carpeta
  `.pyxbuild`. Solo se borran los archivos que llevan el nombre de ese
  documento; nada más se toca.

### Añadido

- **Se pueden abrir y editar archivos `.sty`** (y `.cls` y `.bib`). Son fuentes
  del proyecto y son lo único que se queda, a propósito, junto al documento.

### Corregido

- **La lupa aumenta de verdad, con zoom regulable y sin perder resolución.**
  Antes escalaba 3× el lienzo ya dibujado en pantalla (un mapa de bits pequeño),
  de ahí el pixelado. Ahora le pide a PDF.js que rasterice la zona bajo el
  cursor **a la resolución de la lupa** (`escala × zoom × densidad de
  pantalla`) y la copia píxel a píxel, sin reescalar nada: el texto se ve como
  si la página estuviera de verdad a ese aumento.

  El **zoom se ajusta con la rueda** mientras la lupa está activa, de 1,5× a
  16×, con el factor indicado bajo el cristal. El coste no depende del aumento:
  el recuadro que se rasteriza encoge en unidades de página al mismo ritmo que
  crece su densidad, así que 16× cuesta lo mismo que 2×.

  La aritmética vive en `js/pdf/loupe-geometry.js` y está cubierta por pruebas,
  porque equivocarse ahí es silencioso: la primera versión dimensionaba el
  lienzo con el factor de zoom **y** leía una región del mismo tamaño, lo que da
  exactamente 1:1 — la lupa no aumentaba nada.

- **No se recompila cuando nada puede cambiar el PDF.** El texto de compilación
  ya lleva los valores de `\py{}` resueltos y los bloques de handcalcs, así que
  si es idéntico al de la vez anterior, una pasada nueva produciría el mismo
  PDF. Escribir prosa, editar un comentario o ejecutar una celda que solo
  imprime en el editor pasan de costar entre 2 y 3 segundos de motor (más la
  recarga del PDF) a costar **cero**. Una compilación manual siempre se
  ejecuta: es el usuario pidiendo la verdad.

- Al conservarse el `.aux` entre sesiones dentro del `.pltx`, las referencias
  cruzadas y el índice se asientan en una pasada en lugar de dos.

## [1.2.1] — 2026-09-01

Un IDE no decide por ti qué librerías son importantes. Esta versión quita todos
los privilegios que el kernel se había reservado.

### Cambiado — INCOMPATIBLE con documentos anteriores

- **El espacio de nombres arranca vacío.** El kernel definía `figure`, `figtex`,
  `tabletex`, `tex`, `texesc`, `hc`, `handcalc`, `HTML`, `Markdown`, `Image`,
  `Audio`, `Video` y hasta un `pint.UnitRegistry()` ya instanciado, sin que
  nadie los pidiera. Ahora una celda empieza tan vacía como la primera celda de
  Jupyter y **cada documento importa lo que usa**.

  Los ayudantes de Pyx siguen existiendo, en un módulo de verdad:

  ```python
  from pyx import figure, figtex, tabletex, tex, texesc
  from pyx import display, HTML, Markdown, Image, Audio, Video
  ```

  Un documento antiguo dará `NameError` la primera vez; el mensaje dice
  exactamente qué import añadir. `hc()` y `ureg` no vuelven: eran atajos sobre
  handcalcs y pint, y ahora se escriben con la API de esas librerías.

- **`%%render` y `%%tex` solo funcionan si el documento importa handcalcs.**
  Antes el kernel implementaba las magias por su cuenta **y sustituía
  `handcalcs.render` por un sucedáneo**, de modo que funcionaban en sesiones
  que nunca habían importado handcalcs y la librería real no se podía usar,
  inspeccionar ni actualizar. Ahora `import handcalcs.render` carga la librería
  auténtica y es ese import el que habilita las magias, como en Jupyter.

- **«Reiniciar el kernel» reinicia el proceso de verdad.** Antes solo vaciaba el
  espacio de nombres, así que una librería recién actualizada con
  `pip install -U` seguía sirviendo el código viejo hasta cerrar la aplicación.

### Añadido

- `get_ipython()`, que es lo que permite que las librerías que registran magias
  al importarse se importen sin trucos.
- El icono de documento de Pyx también para los archivos `.tex`, y `.tex`
  registrado como tipo de archivo de la aplicación.

### Corregido

- **Toda la basura del motor LaTeX en un solo sitio.** `.aux`, `.log`, `.fls`,
  `.toc`, `.out`, `.maf`, `.mtc*`… ya no se esparcen por la carpeta del
  documento: van a `.pyxbuild`, y al guardar un `.pltx` se empaquetan dentro
  del documento y la carpeta desaparece. Junto al proyecto quedan solo
  `documento.pltx` y `documento.pdf`.
- El kernel ya no importa numpy, pandas, sympy, pint ni PIL por su cuenta para
  comprobar tipos: los lee de `sys.modules` solo si el documento ya los cargó.
  Una sesión que no usa numpy deja de pagar su arranque.
- Eliminada la entrada muerta `.pyx-word` de `.gitignore` (no la generaba nada).

## [1.2.0] — 2026-08-31

Versión centrada en que un documento de cálculo sea **fiable**: que nunca
enseñe un número que ya no corresponde a su fórmula, que no recalcule lo que no
ha cambiado, y que abrir un informe no dependa de tener Python instalado.

### Añadido

- **Los resultados se guardan dentro del `.pltx`.** Al abrir un informe se ven
  sus números, tablas y figuras sin ejecutar nada. El contenedor sigue siendo
  ligero: hay un presupuesto de tamaño para las figuras, y lo que no cabe se
  guarda sin imagen indicándolo. Conmutable en *Configuración → Editor*.
- **Detección de resultados desactualizados.** Cada celda lleva un
  identificador estable (`%#python id=…`, escrito solo la primera vez que se
  ejecuta) y su resultado guarda la huella del código que lo produjo. Si el
  código cambia después, la celda se marca en ámbar en vez de dar el resultado
  viejo por bueno.
- **Ejecución incremental.** El kernel lleva el registro exacto de qué celdas
  construyeron su espacio de nombres; al recompilar solo se ejecuta lo que
  cambió. Cualquier divergencia fuerza un reinicio completo, así que un salto
  nunca puede dar un valor distinto del que daría la ejecución entera.
- **Interrupción al estilo Jupyter.** Parar una celda lanza
  `KeyboardInterrupt` dentro de ella y **las variables sobreviven**. Pulsar
  parar dos veces seguidas escala a matar el proceso.
- **Ayudas de documentación en el kernel**: `figtex(...)` devuelve la figura
  LaTeX completa (con `\caption` y `\label`) y `tabletex(df, ...)` hace lo
  propio con una tabla, para insertarlas con un solo `\py{}`.
- **Corrector en español e inglés**, seleccionable en *Configuración → Idioma*.
- **Doble clic en un `.pltx`** abre ese documento (la asociación de archivo
  estaba registrada pero nadie la atendía), y una segunda apertura reutiliza la
  ventana en marcha en vez de arrancar otra copia con su propio kernel.
- Pruebas automatizadas (`npm test`) de la lógica donde un fallo es silencioso:
  localización de celdas, `\py{}` / `\pyif{}`, mapas de línea y ejecución
  incremental.

### Cambiado

- Las fórmulas de handcalcs se componen con **KaTeX empaquetado**: la función
  ya no necesita conexión a internet.
- Los instaladores de las tres plataformas se publican desde GitHub Actions,
  cada sistema en su runner nativo.

### Corregido

- **Seguridad: ejecución de código arbitrario desde una salida de celda.** El
  HTML de una celda se montaba en un `iframe` sin `sandbox`, que al ser
  `srcdoc` es del mismo origen que la aplicación: podía alcanzar
  `parent.__TAURI__` e invocar los comandos del backend. Ahora va en un marco
  aislado (`sandbox="allow-scripts"`, sin `allow-same-origin`), el HTML
  estático se sanea antes de entrar en el DOM y `withGlobalTauri` está
  desactivado.
- **Resultados que se perdían o se mezclaban.** Se archivaban bajo un hash del
  código: editar una celda mientras corría hacía desaparecer su salida, y dos
  celdas con el mismo código compartían una sola.
- **Fuga de memoria en las salidas.** Cada edición creaba una entrada nueva y
  ninguna se liberaba, acumulando las figuras de toda la sesión.
- **Búsqueda inversa de SyncTeX y Ctrl+clic sobre `\input` en macOS y Linux**:
  las rutas se reescribían con barras invertidas.
- El PDF cruzaba el puente como un array JSON de números (un PDF de 20 MB se
  convertía en ~70 MB de texto que generar y analizar **en cada compilación**);
  ahora viaja como bytes.
- La capa de texto del visor provocaba un reflujo síncrono por cada fragmento
  de texto de la página.
- Las órdenes de archivo (`read_dir`, renombrar, borrar, crear) corrían en el
  hilo principal y congelaban la interfaz en carpetas lentas o en red.
- Borrar un archivo o cerrar sin guardar usan diálogos nativos, no los del
  navegador.
- Fugas menores: `linecache` del kernel, caché de palabras del corrector.

## [1.1.0]

- Instaladores para Windows, macOS y Linux.
- Soporte de interfaz en inglés.

[1.3.1]: https://github.com/LorGIOO/Pyx/releases/tag/v1.3.1
[1.3.0]: https://github.com/LorGIOO/Pyx/releases/tag/v1.3.0
[1.2.1]: https://github.com/LorGIOO/Pyx/releases/tag/v1.2.1
[1.2.0]: https://github.com/LorGIOO/Pyx/releases/tag/v1.2.0
[1.1.0]: https://github.com/LorGIOO/Pyx/releases/tag/v1.1.0
