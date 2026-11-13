# Registro de cambios

Todas las versiones publicadas de Pyx. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

## [1.8.1] — 2026-11-13

### Corregido

- **El instalador de Windows de la 1.8.0 no se abría** («Windows no tiene
  acceso al dispositivo, ruta de acceso o archivo especificado»). No era un
  fallo del instalador ni del programa: Kaspersky marcó por reputación esos
  archivos concretos (sin firma digital y recién publicados) y bloqueaba su
  ejecución; el mismo código compilado de nuevo se analiza limpio y se
  ejecuta. Esta versión publica los instaladores otra vez, comprobados con
  Kaspersky antes de anunciarlos. El contenido es el de la 1.8.0.

## [1.8.0] — 2026-11-13

### Más rápido

- **Compilar tarda bastante menos en documentos con preámbulo pesado.**
  Medido en un informe real de 18 páginas (122 paquetes, ocho figuras en
  PDF), que tardaba 17,3 s por pasada:
  - «Compilar y ver» usa ahora también el motor precalentado. Hasta ahora
    solo lo aprovechaban las compilaciones al guardar y al escribir, y el
    botón que más se pulsa era justo el que pagaba el preámbulo entero cada
    vez (7 s en ese documento). «Recompilar desde cero» sigue partiendo de
    nada.
  - XeLaTeX ya no vuelve a comprimir al máximo todo el PDF en cada
    compilación: con compresión ligera la pasada baja de 17,3 s a 13,5 s y
    el PDF solo crece un 3 %. Configuración → Compilación → «Escritura del
    PDF» permite pedir el archivo más pequeño.
- **Visor de PDF: las páginas ya están cuando llegas a ellas.** Cuando la
  vista lleva un momento quieta, el resto del documento se dibuja en segundo
  plano, las páginas más cercanas primero, y se conserva. En ese mismo
  informe, llegar a una página pasaba de esperar a que se dibujara (4,5 s en
  un A3 con cincuenta imágenes) a 4–13 ms. Se detiene en cuanto te mueves y
  nunca desaloja una página ya dibujada para adelantar otra.

### Corregido

- **Ctrl+clic llevaba a unas líneas más arriba o más abajo** en cuanto había
  por encima una tabla o una figura insertada con `\py{…}` de varias líneas
  (`tabletex`, `figtex`) o un `\pyif{…}` escrito en varias líneas: el mapa
  entre el PDF y el código solo descontaba las celdas. Ahora sigue también
  esas líneas, en los dos sentidos, y los errores del registro apuntan a su
  línea real.
- Ctrl+clic en una página sin texto —una figura a página completa, un plano
  traído con `\includepdf`— ya no se queda sin hacer nada: lleva a la orden
  que puso esa página.
- **Marcadores del PDF.** Tras recompilar seguían apuntando al PDF anterior,
  y un clic llevaba a otra página o a ninguna. Ahora se releen en cada carga,
  muestran su número de página, resaltan el apartado que se está leyendo y
  sus ramas se pueden plegar.
- El botón «Borrar anotaciones» parecía no funcionar: borraba la página del
  centro del visor, que a menudo no era la anotada. Ahora hay dos botones
  (esta página / todo el documento), y si la página a la vista no tiene
  anotaciones dice en cuáles las hay.
- Un enlace dentro de un PDF solo se abre si es web o de correo.

### Mejorado

- **Modo de anotación del PDF, rehecho.**
  - Las marcas se editan: con «Seleccionar», cada una muestra sus tiradores
    para cambiarle el tamaño y la forma, se mueve arrastrándola o con las
    flechas del teclado, y su color, grosor y estilo se cambian desde la barra.
  - Líneas y flechas rectas, curvas (tirando de su centro) o en codo, con
    punta al final, al inicio, en los dos extremos o sin punta, y trazo
    continuo o discontinuo. Mayús las bloquea a 0°, 45° y 90°, también al
    mover un extremo.
  - El puntero del lápiz, el rotulador y el borrador es un círculo —solo el
    contorno— del tamaño exacto de la punta. El grosor se escribe como
    número, o se cambia con la rueda.
  - El borrador borra la marca entera o solo la parte que toca.
  - Cuadros de texto editables escritos sobre la página, con su tamaño de
    letra.
  - Herramienta **láser**: un trazo para señalar que se desvanece solo y no
    se guarda.
  - Los comentarios se pliegan a su icono con un clic (y hay un botón para
    plegarlos o abrirlos todos).
  - «Guardar una copia del PDF» puede llevar las anotaciones dibujadas en
    sus páginas.
- **Ctrl+R: reemplazar.** Con una palabra seleccionada, se buscan todas sus
  apariciones y el cursor queda en «Reemplazar».
- **Pegar desde Excel.** Además de lo que ya hacía, reconoce una sola
  columna, las celdas combinadas en vertical y las negritas, y elige
  booktabs mirando el preámbulo del documento raíz (antes solo el del archivo
  abierto). Se puede fijar el estilo de líneas y pedir que la tabla venga en
  un entorno `table` con su título.
- **Asistente de tabla**, rehecho: una rejilla donde se escribe o se pegan
  las celdas de Excel, alineación por columna, cuatro estilos de líneas,
  colocación, título y etiqueta, tamaño de letra y vista del código que se
  va a insertar.
- **Asistente de figura**, rehecho: varias imágenes como subfiguras,
  miniatura de cada una, ancho en porcentaje o en centímetros, alto máximo,
  y la ruta relativa a la carpeta del documento raíz (subiendo con `..`
  cuando hace falta) en vez de una ruta absoluta.
- **Las pestañas de los documentos** ocupan el 60 % de lo que ocupaban, y su
  ancho se puede elegir.
- **Configuración**: secciones que estaban partidas en dos vuelven a ser
  una, y hay opciones nuevas: motor LaTeX por defecto, compilar o no al
  guardar, botón del ratón que arrastra la página del PDF (central o
  derecho), ancho de las pestañas, y las de pegado de tablas e imágenes.

### Añadido

- **Imagen a LaTeX.** Pega una captura de una fórmula (Ctrl+V) o usa
  Matemáticas → «Imagen a LaTeX»: Pyx escribe su LaTeX donde está el cursor,
  como fórmula independiente, en línea o tal cual si ya estás dentro de una.
  El reconocedor se descarga la primera vez (unos 450 MB) en la carpeta de
  Pyx, sin tocar tu Python, y después funciona sin conexión.
- Pegar una imagen también puede guardarla en una carpeta del proyecto e
  insertar su figura.
- **Las figuras y tablas no pasan de su apartado** (Configuración →
  Compilación, activado). LaTeX puede dejar una figura que no cabe después
  del título del apartado siguiente; ahora se colocan todas las pendientes
  antes de cada `\section`, `\subsection` y `\subsubsection`. Comprobado que
  el orden que da Pyx sin esta opción es exactamente el de LaTeX.

## [1.7.0] — 2026-11-10

### Corregido

- **«Compilo y el PDF no cambia».** Desde la 1.6.6, a partir de la segunda
  compilación de la sesión el visor seguía mostrando las páginas anteriores
  (el registro decía `doc.destroy is not a function`) y el PDF viejo no se
  liberaba nunca. Ahora cada compilación termina en un PDF nuevo en pantalla
  o en un motivo escrito: «LaTeX terminó sin producir ninguna página…», «El
  PDF está abierto en otro programa», etc.
- Una copia `.build.tex` que una versión antigua dejó en la carpeta del
  proyecto ya no es la que se compila (se compilaba esa, y no lo que había en
  el editor).
- La compilación al escribir ya no se queda suspendida ni se rearma sin fin
  con un motor lento: espera lo configurado (como mucho lo que tardó la última
  compilación, tope 10 s) y, si llega durante otra, queda en cola.
- «Detener» actúa también entre pasadas y sobre bibtex/makeindex; después se
  puede volver a compilar al momento.
- Un intérprete de Python que muere o no responde ya no deja la compilación
  esperando para siempre («Tiempo máximo por celda» en Configuración; 0 = sin
  límite).
- **Cerrar Pyx con cambios sin guardar pregunta** Guardar / No guardar /
  Cancelar (X, Alt+F4 y barra de tareas); cerrar una pestaña, igual.
- Lo que se escribe mientras un guardado está en curso ya no queda marcado
  como guardado.
- La actualización se descarga y se comprueba antes de preguntar por los
  documentos abiertos, y sin SHA-256 publicado no se instala nada.
- Abrir dos veces el mismo archivo (doble clic, o la misma ruta escrita de
  otra forma) ya no crea dos pestañas.
- Renombrar no sobrescribe un archivo que ya existe; las pestañas siguen al
  archivo renombrado.
- Cada archivo se guarda con la codificación, el BOM y los finales de línea
  con que se abrió. Un carácter que no cabe en su codificación ya no se
  escribe como «?»: se pregunta.
- «Buscar en el proyecto» no se queda en «Buscando…», y reemplazar respeta la
  codificación de los archivos cerrados y lo que hay en los abiertos.
- El terminal integrado ya no congela la ventana, usa el Python elegido y se
  puede detener.
- El autoguardado guarda todos los documentos con archivo, sin diálogos, sin
  compilar y sin recortar el espacio recién escrito.
- Al cambiar de pestaña, nada del documento anterior se queda en la
  estructura, las macros ni la cinta.
- El árbol de archivos abre en el editor solo texto; lo demás, con su
  programa. Borrar desde el árbol envía a la papelera de reciclaje.
- Archivos vinculados (`\pynotebook`, `\pyfile`):
  - `\pyfile{datos}` busca `datos.py` (antes `datos.ipynb`, y decía que no
    existía); la ruta se resuelve igual al compilar, con Mayús+Intro, con
    Ctrl+clic y en el autocompletado: primero la carpeta del documento
    principal y después la del capítulo que contiene el comando.
  - Una misma ruta escrita de dos formas (`./calc/a`, `calc\a`) ya no cuenta
    como dos cuadernos (se ejecutaba dos veces o «faltaban» sus valores).
  - En un script `.py` con celdas `# %%`, insertar una celda al principio ya
    no hace que se ejecuten otra vez todas las siguientes.
  - Una celda a medio escribir (error de sintaxis) ya no obliga a ejecutar el
    cuaderno entero en la compilación al escribir.
  - Leer un `.ipynb` justo mientras Jupyter lo guarda ya no da «no es un
    cuaderno».
  - Dos documentos vinculados al mismo cuaderno ya no se tiran los valores el
    uno al otro; un kernel de Jupyter ocupado en una celda larga no cuesta
    1,5 s en cada compilación; un kernel recién arrancado que aún no dice qué
    cuaderno sirve se vuelve a consultar.
  - Lo que no se pudo traer de Jupyter (un valor que no se puede copiar, una
    variable que una función solo usa) se dice en el registro en vez de
    acabar en un `NameError` sin explicación.
  - Si una celda del cuaderno falla, lo recuperado de la copia guardada no se
    vuelve a cargar en cada compilación.
  - Después de editar un script vinculado, de borrar una celda o de cerrar
    Jupyter, lo que dependía de lo desaparecido se ejecuta una vez y no en
    cada compilación (se quedaba ejecutándolo siempre, sin decir por qué).
  - Los valores traídos de Jupyter se conservan cuando Jupyter se cierra: la
    siguiente compilación ya no los cambia por los del código del cuaderno.
  - Un archivo de datos (Excel, CSV…) leído por un script vinculado se vigila
    también cuando el script se ejecutó en Pyx, no solo cuando sus valores
    venían de una copia guardada.
  - Una función de un cuaderno o script que está en otra carpeta y abre un
    archivo con ruta relativa (`open("datos.csv")`, `pd.read_csv("datos.csv")`)
    lo encuentra en SU carpeta aunque la llame una celda del documento o un
    `\py{}`, sin evaluar nada dos veces. Un archivo con ese nombre en la
    carpeta de trabajo sigue teniendo preferencia.

### Más rápido

- **Visor de PDF con desplazamiento nativo.** El desplazamiento lo hace el
  navegador y no un manejador de rueda; las páginas que salen de la vista
  dejan de dibujarse y las capas de texto solo se crean para lo visible. En
  un informe de 20 páginas con gráficas, recorriendo 24 000 px en 3,8 s: de
  53 fotogramas con una página en blanco (de 534) a 4 (de 669), sin ninguna
  tarea larga; la primera página aparece 195 ms después de terminar LaTeX.
- **Archivos vinculados sin esperas.** Cuando ni el cuaderno, ni sus valores
  guardados, ni Jupyter han cambiado, la compilación ya no pregunta nada al
  kernel de Python (0,1 ms en lugar de una consulta por cuaderno y
  compilación).
- Escribir en un documento grande: el corrector, el contador de la búsqueda,
  el autocompletado y el panel de estructura ya no recorren el documento
  entero en cada pulsación.
- Las carpetas del proyecto ya no se recorren en cada compilación.

### Añadido

- **Cinta adaptable.** La cinta ya no se desplaza de lado: los grupos pasan
  de grandes a medianos, a solo iconos y, al final, a un botón que abre el
  grupo entero. «Compilar» está siempre a un clic. La barra de estado, la de
  título, las pestañas y la barra del visor caben a media pantalla; el ancho
  mínimo de la ventana baja de 860 a 640 px.
- **Indicador de compilación en modo zen.** Un punto de color junto a las
  pestañas: gris sin compilar, anillo con una compilación programada, azul
  con LaTeX, amarillo con Python, verde correcto, ámbar con avisos y rojo con
  error. Clic: va al primer error (o abre el registro); clic derecho: Abrir
  registro, Detener, Salir de zen. Se puede mostrar siempre desde
  Configuración → Compilación. Atajo Ctrl+Alt+L para el registro.
- **Los archivos vinculados se vigilan.** Con «compilar al escribir»
  activado, Pyx comprueba cada 1,5 s los cuadernos y scripts del último PDF:
  si se guardan desde otro editor, cambian los datos que leen o se ejecutan
  celdas en Jupyter, el PDF se actualiza solo, sin tener que escribir nada en
  Pyx.
- Una línea por compilación en `logs/compile.jsonl` (resultado, motivo y
  tiempos por fase) y los tiempos del motor y del visor en «Tiempos de Pyx».

### Seguridad

- Se retiran los permisos del plugin de archivos (no se usaban) y el
  inspector web en las versiones publicadas.
- Escritura de archivos más segura: temporal único por escritura, un solo
  escritor por archivo y sincronización antes de renombrar.

## [1.6.6] — 2026-11-04

### Corregido

- **Pulsar Compilar muchas veces seguidas ya no bloquea Pyx.** Si un PDF se
  sustituía por otro mientras el visor aún le pedía una página, su texto o
  sus enlaces, esa petición no terminaba nunca (PDF.js no la cancela): el
  visor dejaba de dibujar y la compilación que cargaba el PDF se quedaba «En
  cola…» hasta cerrar la aplicación. Ahora toda espera sobre un PDF se
  abandona en cuanto ese PDF se sustituye, y la compilación nunca espera más
  de 20 s a que el visor termine de cargar.
- Si Python no puede arrancar, la celda muestra el motivo en vez de quedarse
  «ejecutándose» para siempre.
- Los botones «Nuevo documento» y «Abrir» de la pantalla de inicio siguen el
  tema de la aplicación.
- Las anotaciones de una página de otro tamaño (una apaisada en un informe
  vertical) quedan donde se dibujaron.

### Más rápido

- **Visor de PDF:** las páginas se dibujan en un hilo aparte (PDF.js 6 con
  OffscreenCanvas) y varias a la vez, y las ya vistas se guardan. Una página
  con una gráfica de 700 000 operaciones de dibujo (decenas de miles de
  puntos) tardaba 4–5 s en volver a dibujarse con la interfaz congelada;
  ahora ~1,3 s sin que el editor ni el desplazamiento se detengan, y volver a
  ella tras desplazarse es instantáneo (de 1,4 s a 59 ms).
- **Kernel de Python:** cada petición durante una compilación responde en
  ~3,8 ms en lugar de 8–12 ms (en Windows la lectura de peticiones esperaba
  hasta 20 ms entre comprobaciones).
- **LaTeX:** el final de cada pasada se detecta antes (sondeo de 5 ms).

### Añadido

- **Actualizaciones desde la propia aplicación.** Al arrancar, Pyx consulta
  su repositorio de GitHub; si hay una versión nueva, la barra de estado
  ofrece «Actualizar a…». En Windows descarga el instalador, comprueba su
  SHA-256 con el publicado, lo instala y se vuelve a abrir (antes pide
  guardar los documentos con cambios). En macOS y Linux abre la página de la
  versión.
- **Herramientas de revisión del PDF:** resaltar, subrayar y tachar el texto
  seleccionado (el resaltado se funde con la página como un rotulador),
  lápiz con trazo suavizado, rotulador, línea y flecha con punta rellena
  (Mayús: 0°/45°/90°), recuadro y elipse (Mayús: cuadrado/círculo),
  comentarios escritos en la propia página, herramienta de selección para
  mover y borrar (Supr) marcas, deshacer y rehacer (Ctrl+Z / Ctrl+Y) y
  «Copiar la lista de correcciones» (página, tipo, texto marcado y
  comentario de cada marca).

### Manual

- Revisado frente a la aplicación: se quitan las funciones que no tiene
  (abrir un archivo arrastrándolo a la ventana, avisar de que un documento
  abierto cambió en el disco) y se corrigen las que no eran exactas (los
  tipos que abre «Abrir», que guardar también compila, la alineación del
  asistente de tablas, el desplegable «Intérprete»). Capturas con la cinta
  actual. Nuevas secciones: revisión del PDF, actualizar Pyx y visor rápido.

## [1.6.5] — 2026-11-02

### Más rápido

- **Cambiar un cuaderno ya no obliga a ejecutarlo entero.** Con Jupyter
  cerrado, al modificar una celda de un `.ipynb` o un `.py` vinculado, Pyx
  recupera todo lo que dejó su última ejecución (aunque sea de otra sesión)
  y ejecuta solo las celdas cambiadas y las que dependen de ellas. Un
  cuaderno que tardaba minutos tarda, tras un cambio pequeño, lo que tarde
  esa celda. Al guardar, solo se vuelven a serializar las variables que han
  cambiado.
- **Buscar el Jupyter abierto pasa de ~10 s a unas decenas de ms** con muchos
  archivos de kernels antiguos: se comprueban todos a la vez y se recuerdan
  los que ya no responden.

### Cambiado

- **Cinta de compilación con cuatro botones, como TeXstudio**: Compilar y
  ver, Detener, Ver PDF y Registro. «Recompilar desde cero» sigue en
  `Ctrl+Alt+Mayús+B` y «Compilar al escribir» en Configuración → Compilación.

### Corregido

- **Un `%` dentro de `\py{…}` ya no se toma por un comentario.** Es Python: un
  formato (`float_format="%.6f"`, `"%d" % n`, `f"{x:.1%}"`) o el operador
  módulo. El editor lo coloreaba como comentario hasta el final de la línea;
  ahora el contenido de `\py{…}` (y la condición de `\pyif{…}`) se colorea
  como Python. La misma regla vale para el corrector ortográfico y el panel
  de estructura, y un `\py{}` comentado (`% \py{x}`) ya no se evalúa.
- **Cualquier función de un cuaderno o `.py` vinculado se puede usar desde
  `\py{}`**: también las creadas dentro de otra función (*closures*), las
  `lambda` guardadas en diccionarios o listas, los alias (`g = f`) y las que
  no tienen código fuente recuperable. Viajan como código compilado (mismo
  Python que el cuaderno; si no lo es, el aviso lo dice).
- Las clases con decoradores (`@dataclass`) y sus objetos se cargan en el
  orden que necesitan; antes, `@dataclass` podía llegar tarde.
- Una función del cuaderno que abre un archivo por ruta relativa
  (`pd.read_csv("Datos.csv")`) funciona al llamarla desde `\py{}`, como en
  Jupyter (se busca en la carpeta del cuaderno).
- Las funciones propias de Pyx o de IPython que sustituyen a un *builtin*
  (`open`) ya no se copian como si fueran del cuaderno.
- Si un valor de Jupyter no se puede cargar porque Jupyter y Pyx usan
  intérpretes de Python distintos, el aviso lo dice y propone el arreglo.

### Añadido

- `tex`, `texesc`, `tabletex` y `figtex` se pueden usar directamente en
  `\py{}` sin `from pyx import …`: un documento que toma sus valores de un
  cuaderno no tiene celdas donde importarlos.
- Un `\py{}` que produce miles de líneas (un `to_csv()` de 99 054 filas) da un
  aviso claro en ese `\py{}` en lugar de agotar la memoria de LaTeX y perder el
  resto del documento.

## [1.6.4] — 2026-10-25

Los cuadernos de Jupyter vinculados funcionan como las celdas: una función
del cuaderno se puede llamar desde `\py{}` (con todo lo que usa por dentro),
una tabla de pandas sale como tabla, y también se pueden vincular archivos
`.py`.

### Añadido

- **Archivos `.py` vinculados: `\pyfile{calculos/datos.py}`** (o
  `\pynotebook{…}`, que acepta los dos tipos). Un `.py` se ejecuta entero o por
  bloques `# %%` (VS Code, Spyder, PyCharm, Jupytext); con bloques, solo se
  repiten los que cambian. Igual que un cuaderno, no se vuelve a ejecutar si
  hay valores que tomar.
- **El valor del archivo más próximo.** Si dos archivos vinculados (o dos
  celdas) dan valor a la misma variable, cada `\py{}` y `\pyif{}` muestra el
  del que tiene encima, como al leer un cuaderno de arriba abajo; las celdas
  que hay entre ellos, también. Un `\py{}` anterior a todos sigue mostrando el
  valor final. El valor gris del editor coincide con el del PDF.
- **`\py{df}` con una tabla de pandas** (`DataFrame` o `Series`) escribe un
  `tabular` completo: números alineados a la derecha, celdas vacías para los
  valores que faltan, el índice cuando dice algo. Más de 500 filas dan un
  aviso en lugar de una tabla interminable.
- **Autocompletado dentro de `\py{…}`**: al escribir `\py{` se abre la lista de
  todas las variables disponibles, las de las celdas y las de los cuadernos y
  archivos vinculados (lo que definen en su código y lo que tiene su kernel de
  Jupyter), con el archivo de cada una. Funciona en cualquier punto de la
  expresión y, tras un punto, ofrece los atributos del valor.
- El manual de usuario en PDF se publica junto a los instaladores de cada
  versión.

### Corregido

- **Una función de un cuaderno vinculado fallaba al llamarla desde `\py{}`**
  (`\py{filas_ln(rumbo_estudio, len(dict_lognormal[rumbo_estudio]))}`): Pyx
  copiaba la función pero no lo que usa por dentro (otras funciones,
  diccionarios, `np`). Ahora se lleva todo lo que necesita, a un espacio de
  nombres propio del cuaderno (no se mezcla con el del documento). También
  viajan las clases definidas en el cuaderno y los objetos de esas clases, y
  una función cuyo código Jupyter no sabe dar se toma del propio cuaderno. Los
  valores guardados con la 1.6.3, que no traían esas dependencias, se
  descartan una vez.
- Si se edita en Jupyter una función auxiliar, lo que depende de ella en el
  documento se vuelve a calcular (antes se daba por igual).
- **Pegar.** El código con sangría de tabuladores (LaTeX o Python copiado de
  otro editor) y el código copiado de GitHub o de una web de documentación ya
  no se convierten en un `tabular` de texto escapado. Se quitan los caracteres
  invisibles (espacios de anchura cero, guiones blandos, BOM, marcas de
  dirección) y las ligaduras de los PDF; en una celda de Python, los espacios
  de no separación, que Python rechaza. Una celda pegada junto a la original
  recibe otro identificador: antes compartían la salida. Lo mismo al pegar con
  el botón de la cinta.
- Dos celdas con el mismo identificador (por duplicar una línea, por ejemplo)
  se separan solas: la copia recibe uno nuevo.
- Los valores de un archivo ejecutado en Pyx se guardaban con lo que quedaba al
  final de la compilación, que podía ser lo que otro archivo posterior había
  puesto en la misma variable.
- El registro decía «5 ejecutadas de 2» cuando la compilación se reparaba sola.
- Un documento sin celdas propias, solo con archivos vinculados, no mostraba
  los valores grises de `\py{}`.
- El terminal integrado perdía en Windows las líneas con acentos que algunos
  programas escriben en la codificación de la consola.

## [1.6.3] — 2026-10-22

Un cuaderno de Jupyter vinculado ya no se vuelve a ejecutar: el documento
toma los valores que ya tiene, en milisegundos en lugar de minutos.

### Cambiado

- **Un cuaderno vinculado ya no se ejecuta: Pyx toma sus valores.** Con
  `\pynotebook{…}`, el documento recibe las variables que usa directamente
  del kernel de Jupyter donde el cuaderno ya se ejecutó (VS Code, JupyterLab
  o Jupyter Notebook): se copian en una fracción de segundo y en el cuaderno
  no se ejecuta nada (ni queda rastro en su historial ni en sus variables).
  Con Jupyter cerrado, se usan los últimos valores guardados mientras el
  código del cuaderno no cambie; también sirven para un `\py{}` nuevo que lea
  otra variable pequeña del cuaderno. Solo si no hay ni Jupyter abierto ni
  valores guardados (o el código del cuaderno ha cambiado) se ejecuta en Pyx,
  una vez: sus valores se guardan y la siguiente compilación los carga. El
  registro de la compilación dice de dónde salió cada cuaderno y en cuánto
  tiempo, y los avisos señalan las variables que Jupyter aún no tiene.
  "Recompilar desde cero" y "Ejecutar todo" tampoco vuelven a ejecutar el
  cuaderno. La conexión con Jupyter no necesita `jupyter_client` ni `pyzmq`
  en el Python de Pyx.

### Corregido

- La barra de botones de las celdas desaparecía con el visor de PDF abierto
  cuando una línea no cabía en el editor (sin ajuste de línea o con una salida
  ancha): quedaba pegada al final del contenido, fuera de la vista. Ahora se
  mantiene en el borde visible de la celda.

## [1.6.2] — 2026-10-22

Pyx deja de repetir trabajo. En un cuaderno corriente —cada celda importa lo
que usa, `%matplotlib inline` arriba— cambiar una celda re-ejecutaba el
documento entero; ahora ejecuta esa celda. Un documento puede usar las
variables de un cuaderno de Jupyter (`\pynotebook{…}`), y las tablas de pandas
se ven como en JupyterLab y VS Code.

### Añadido

- **Cuadernos de Jupyter vinculados: `\pynotebook{ruta/cuaderno.ipynb}`.**
  Las celdas de código del cuaderno se ejecutan en el kernel de Pyx en ese
  punto del documento, y `\py{}`, `\pyif{}` y las celdas `%#python` usan sus
  variables con la sintaxis de siempre. Se ejecutan desde la carpeta del
  cuaderno, como en Jupyter (`pd.read_csv("datos.csv")` junto al cuaderno
  funciona). El cuaderno se sigue editando en Jupyter o VS Code a la vez: Pyx
  lo relee cuando cambia y el grafo de dependencias vuelve a ejecutar solo las
  celdas modificadas y lo que depende de ellas. La ruta es relativa a la
  carpeta del documento raíz (`.ipynb` se puede omitir); se pueden vincular
  varios. Mayús+Intro en una celda que lee una variable del cuaderno lo
  ejecuta primero si hace falta, y un fallo del cuaderno se explica en la
  celda y en los avisos de la compilación. Ctrl+clic en la ruta abre el
  cuaderno en su programa. Solo se lee su código: sus salidas guardadas
  (figuras incluidas) no se cargan.

### Rendimiento

- **Un import repetido ya no re-ejecuta el documento.** Con `import numpy as
  np` en varias celdas, el grafo de dependencias creía que cada una
  «redefinía» `np` y arrastraba todas las demás: un Mayús+Intro en un
  cuaderno de 300 celdas ejecutaba las 300. Un nombre que solo enlaza siempre
  el mismo import es el mismo objeto en todas las celdas: ahora se ejecuta
  una.
- **Las magias de IPython ya no obligan a ejecutarlo todo.** `%matplotlib`,
  `%config`, `%pip`, `!orden`, `%time …`, `%timeit …`, `x = !orden`,
  `%%time`, `%%capture` y las celdas `%%html`, `%%latex`, `%%writefile`,
  `%%bash`… se analizan por lo que hacen. Antes, una sola de esas líneas
  hacía que cualquier cambio reiniciara el kernel y volviera a ejecutar todas
  las celdas (leer otra vez el CSV de 500 000 filas por cambiar un título).
  Las que pueden cambiar cualquier cosa (`%run`, `%cd`…) siguen siendo
  prudentes.
- **`from math import *` (o `numpy`, `scipy`…)** también se sigue: el kernel
  dice qué nombres enlaza. Los módulos del propio proyecto se tratan como
  antes.
- **Las respuestas del kernel llegan a la ventana tal como salen de Python**,
  sin convertirlas en Rust a un árbol JSON y otra vez a texto: la mitad de
  trabajo por cada resultado, que con figuras y salidas largas son megabytes.
- **Encontrar el documento raíz ya no relee la carpeta.** Un documento sin
  `\documentclass` (un cuaderno solo de Python, sobre todo) leía todos los
  `.tex` y `.pltx` de su carpeta y de la superior —contenedores enteros, con
  sus resultados guardados— en cada Mayús+Intro pasados 20 s. Ahora decide el
  listado de las carpetas, y solo se relee lo que cambió.
- **De un `.pltx` se lee solo su fuente** al compilar un capítulo, buscar el
  raíz o buscar en el proyecto: sus resultados guardados (figuras incluidas)
  y su carpeta de trabajo ya no se descomprimen para eso.
- **El editor redibuja las celdas una vez por fotograma.** Cada celda
  ejecutada pedía dos redibujados de todas las celdas: ejecutar entero un
  documento de 300 celdas gastaba ~2,4 s solo en eso, entre celda y celda.
- **La revisión de sintaxis manda al kernel solo las celdas que cambiaron.**
  Antes compilaba todas en cada pausa al escribir, y un Mayús+Intro pulsado
  justo después esperaba detrás.
- **Salidas de texto enormes:** pasadas las 2000 líneas se muestran el
  principio y el final, con un botón para ver el resto (como VS Code).
  Cincuenta mil líneas tardaban ~0,4 s en dibujarse y convertían el editor en
  un desplazamiento de 700 000 px.

### Cambiado

- **Tablas como en JupyterLab y VS Code**: sin rejilla, filas alternas
  suaves, cabecera e índice en negrita, números alineados a la derecha y una
  línea bajo la cabecera, en el tema claro y en el oscuro. Los DataFrames se
  mostraban con la rejilla blanca por defecto del navegador: el bloque
  `<style>` que pandas añade los mandaba a un marco aislado donde no llegaban
  los estilos de Pyx. Ese bloque solo alinea celdas y ahora se descarta.

### Eliminado

- **Panel Parámetros y controles interactivos** (`# @slider`, `# @input`,
  `# @select`, `# @check`). Esos comentarios siguen siendo comentarios de
  Python: las celdas que los tengan se ejecutan igual, solo que ya no
  muestran un control.
- **Panel Variables** de la barra lateral. Las variables siguen a mano donde
  se usan: el valor de cada `\py{}` aparece en gris junto a él, y el
  autocompletado de Python conoce las del kernel.
- **Panel Historial** (versiones guardadas y Git). Guardar ya no conserva una
  copia aparte del documento. Las versiones que ya se guardaron no se borran:
  siguen en la carpeta de datos de Pyx (`%LOCALAPPDATA%\Pyx\history` en
  Windows) por si alguna hiciera falta.

### Corregido

- **Un resultado podía quedarse sin actualizar** al ejecutar solo lo
  necesario, cuando un mismo nombre se definía en varias celdas: el «no ha
  cambiado» comparaba con el valor que quedaba en memoria, que podía venir de
  otra celda, no con el que había visto la celda que lo lee. Ahora ese
  atajo solo se aplica a nombres con una única celda que los define.
  Comprobado contra Python real con 1500 documentos aleatorios.
- **`\begin{…}` ya no duplica lo que escribes.** La opción «\begin{ }» del
  autocompletado ponía dos cursores (uno en el `\begin` y otro en el `\end`)
  que seguían activos después del nombre: Intro partía las dos líneas y todo
  lo que se escribía salía dos veces. Ahora hay un solo cursor; el `\end`
  copia el nombre mientras lo escribes e Intro (o Tab) entra en el cuerpo del
  entorno.
- **Intro tras un `\begin{x}` solo añade `\end{x}` si el entorno no está
  cerrado.** Antes añadía otro `\end` cada vez. Elegir un entorno de la lista
  sobre un `\begin` que ya tiene cierre cambia solo el nombre (y, sobre la
  plantilla vacía, pone la del entorno elegido: la figura trae su
  `\includegraphics` y su `\caption`).
- **Renombrar el `\end` renombra también su `\begin`**, no solo al revés.
- **Ajuste del PDF al ancho y al alto.** Una página que esperaba a
  redibujarse tras un cambio de zoom ocupaba 1,7 veces su ancho: aparecía una
  barra de desplazamiento horizontal y «Ajustar» centraba sobre ese ancho
  falso, con la página desplazada a un lado. Además, «Ajustar al alto» no se
  rehacía al cambiar la altura del visor (salir del modo zen, abrir la
  terminal, una ventana más baja), y cambiar de ajuste o de tamaño hacía
  perder la página que estabas leyendo. «Ajustar al alto» muestra ahora la
  página entera y centrada.
- **Salir del modo zen con Esc ya no deja el visor en gris ni lo devuelve a
  la página 1**, y el editor conserva su posición. El modo zen quitaba la
  barra de título, la cinta y la barra de estado; al volver a ponerlas, el
  área de trabajo se recolocaba y perdía su desplazamiento. Ahora solo se
  ocultan.

## [1.6.0] — 2026-10-18

Pyx recalcula solo lo que un cambio alcanza, completa Python de verdad, se
prepara solo en un equipo vacío y trae su manual de usuario, escrito y
compilado con el propio Pyx.

### Cálculo

- **Ejecución reactiva (grafo de dependencias, como marimo).** Pyx sabe qué
  variables define y usa cada celda. Al compilar o al pulsar Mayús+Intro se
  ejecutan solo las celdas cambiadas y las que dependen de ellas; si una
  celda vuelve a dar el mismo valor, lo que la lee no se ejecuta (corte
  temprano). Las mutaciones (`lst.append`) cuentan como definiciones; lo que
  no se puede analizar (`exec`, `global`, magias) vuelve a la regla exacta.
  Comprobado contra Python real con cientos de documentos aleatorios.
- **Celdas desactualizadas en cascada**: al editar una celda, las que
  dependen de ella lo indican. Nuevo ajuste: Ejecución reactiva.
- **Controles interactivos** en las celdas (`# @slider`, `# @input`,
  `# @select`, `# @check`, como en MATLAB) y panel **Parámetros**.
- **Autocompletado de Python con jedi** sobre el espacio de nombres vivo,
  firma de la función al escribir y ayuda al pasar el ratón.
- Los valores en gris de `\py{}` se actualizan también al ejecutar celdas.

### Sin instalaciones previas

- Si falta Python o LaTeX, **Pyx los prepara con un clic**: uv descarga un
  CPython autónomo con numpy, scipy, sympy, pandas, matplotlib, handcalcs,
  pint, IPython y jedi; Tectonic hace de motor LaTeX. Todo en la carpeta de
  datos de Pyx.
- Un `ModuleNotFoundError` trae el botón **Instalar**, y la barra de estado
  avisa de las librerías que importa el documento y faltan.

### Editor

- **Vista previa de fórmulas al pasar el ratón** sobre `$…$`, `\[…\]` o
  entornos como `equation`/`align`: se dibuja con KaTeX y cada `\py{}`
  muestra su valor actual.
- **Ctrl+clic en `\ref`, `\eqref`, `\cref`…** salta a su `\label`, también
  en otros documentos abiertos.
- **Renombrar un entorno** cambia `\begin{x}` y su `\end{x}` a la vez; se
  deshace en un solo paso.
- **Marcas del registro de compilación** en el propio código; F8 y
  Mayús+F8 recorren los problemas.
- Guías de sangría más precisas (resaltan el bloque activo).
- Las tres primeras se pueden desactivar en Configuración → Editor.

### Visor PDF

- **SyncTeX leído directamente** del índice (`.synctex.gz`) en Rust, sin
  arrancar el programa `synctex`: el salto código↔PDF es inmediato y ahora
  también funciona con Tectonic.
- La capa de texto usa la de PDF.js: al copiar del PDF se conservan los
  saltos de línea y la selección se ajusta a las letras.
- El salto desde el PDF elige el archivo exacto aunque dos capítulos se
  llamen igual en carpetas distintas.
- Abrir un proyecto con un PDF ya compilado deja SyncTeX listo sin compilar.

### Más funciones de TeXstudio

- **Autocompletado de LaTeX desde datos**: 336 comandos y 51 entornos con su
  paquete y descripción; si el paquete no está cargado, se añade el
  `\usepackage`. También los comandos definidos en el documento.
- **Buscar en todo el proyecto** (Ctrl+Mayús+F), con reemplazo.
- **Pegar tablas de Excel**, LibreOffice, Word o web como `tabular`.
- **Historial del cursor** (Alt+← / Alt+→), Ctrl+B / Ctrl+I.
- **Gramática**: más reglas sin conexión y LanguageTool opcional.
- **Macros en Python** (Alt+Mayús+1…9) con su editor.
- **Historial de versiones** de cada documento (comparar y restaurar) y Git
  básico.
- **Glosarios** (glossaries) ordenados entre pasadas y autocompletado de
  `\gls{}`; **marcadores del PDF**.

### Manual de usuario

- Nueva carpeta **Manual de usuario**: un manual de 49 páginas con capturas
  de todas las funciones, escrito como documento `.pltx` y compilado con Pyx
  (sus figuras y números los calculan celdas de Python al compilar).

### Interno

- Eliminadas nueve funciones sin uso, las carpetas `examples/`, `docs/` y
  `tools/`, los iconos de Android, iOS y Microsoft Store y tres paquetes de
  diccionarios que solo usaba un script de generación.
- El `.pltx` ya no guarda el `.xdv` intermedio de xelatex.

## [1.5.0] — 2026-10-16

Compilar casi al instante: el preámbulo ya está cargado cuando compilas,
«Compilar» vuelve a ser incremental, los errores de LaTeX se ven mientras
escribes y el kernel de Python se ha revisado a fondo.

El kernel de Python, revisado a fondo: probado con cientos de celdas por
cuatro frentes (librerías científicas y salidas, handcalcs frente a Jupyter
real, semántica de Python e IPython, entrada/salida y procesos) y con 18 000
peticiones aleatorias con interrupciones sin un solo cuelgue.

### Más rápido — motor precalentado

- **El preámbulo ya está cargado cuando compilas.** Al terminar cada
  compilación, Pyx deja un motor LaTeX con el preámbulo (paquetes y fuentes)
  procesado, esperando. Si la siguiente compilación tiene el mismo preámbulo
  y ningún archivo que este lee ha cambiado, solo se compone el cuerpo. En
  un informe con fontspec, TikZ y hyperref, xelatex pasa de **0,71 s a
  0,10 s** por compilación. Idea de tex-fast-recompile; funciona con xelatex,
  lualatex y pdflatex (mylatexformat no sirve con las fuentes de fontspec).
  SyncTeX y el panel de problemas no notan la diferencia. Se descarta ante
  cualquier duda, y se puede desactivar en Configuración → Compilación.
- **BibTeX, Biber y makeindex se ejecutan solos**, entre pasadas y solo
  cuando cambia lo que leen (las reglas de latexmk). Antes un `\cite` se
  quedaba en «[?]» para siempre.

### Nuevo — antes de compilar

- **Errores de LaTeX subrayados mientras escribes** (como texlab): llaves
  sin cerrar o de más, `\begin`/`\end` desparejados (también un
  `\end{document}` que falta), etiquetas repetidas, `\ref` a etiquetas que
  no existen y `$` sin cerrar. Ignora celdas Python, comentarios, verbatim y
  el Python de `\py{}`.
- **ChkTeX opcional** para avisos de estilo (desactivado por defecto).
- **Tectonic** aparece como motor si está instalado: compilar sin MiKTeX ni
  TeX Live.

### Nuevo — celdas y visor

- **Plegar con la barra lateral, como en JupyterLab**: un clic en la barra
  de la celda pliega el código; en la de la salida, la salida.
- **Panel Variables** (el inspector de variables de Jupyter): tipo, tamaño
  y valor de cada variable del kernel; doble clic inserta `\py{nombre}`.
- **El PDF sigue lo que escribes** (idea de TeXpresso): tras una compilación
  en vivo, el visor muestra la parte que estás editando si no estaba a la
  vista.
- Corregido: la vista previa de una celda plegada no se veía (0 px de alto).
- Las salidas HTML se sanean con **DOMPurify**.

### Más rápido — «Compilar» vuelve a ser incremental

- **«Compilar» (Ctrl+Mayús+B) ya no reconstruye todo desde cero.** Cada pulsación
  reiniciaba Python y re-ejecutaba **todas** las celdas, borraba los `.aux` y
  `.toc` y forzaba 2 (a menudo 3) pasadas de xelatex. Ahora solo se ejecutan las
  celdas que cambiaron (el registro del kernel ya garantiza el mismo resultado
  y vuelve a empezar ante cualquier duda, incluido un CSV o Excel modificado) y
  LaTeX hace una pasada, añadiendo otra solo cuando TeX la pide. En un documento
  de prueba la parte de LaTeX pasa de ~1,0 s a ~0,5 s; la de Python, de «todas
  las celdas» a «las que cambiaron».
- **Nuevo «Recompilar desde cero»** (botón *Desde cero*, Ctrl+Alt+Mayús+B):
  kernel nuevo y sin datos auxiliares, para cuando quieras la certeza absoluta.
- **El motor se localiza una vez por sesión**: antes cada compilación (y cada
  Ctrl+clic de SyncTeX) arrancaba `xelatex --version`, 100–500 ms con MiKTeX.
- El PDF aparece unos milisegundos antes al terminar el motor (sondeo de 20 ms
  en lugar de 50 ms).
- Compilar ya no reescribe en disco el `.tex` si no ha cambiado.

### Corregido

- **«Detener compilación» existía pero no había forma de pulsarlo.** Ahora hay
  un botón *Detener* en la cinta y otro junto al estado de la barra inferior,
  más una acción configurable en Atajos. Detener durante las celdas ya no
  provoca que se re-ejecuten todas («autocuración») justo después.
- **En Linux y macOS, detener el motor dejaba vivo a `xdvipdfmx`**, que seguía
  escribiendo el PDF. El motor corre ahora en su propio grupo de procesos (el
  equivalente del Job Object de Windows).
- **Compilar cambiaba la codificación del archivo.** Con la codificación
  Latin-1/Windows-1252 configurada, guardar respetaba la codificación pero
  compilar reescribía el `.tex` (y los capítulos abiertos) en UTF-8.
- **Guardar ya no puede dejar un archivo a medias.** Se escribe en un temporal
  junto al documento y se sustituye de una vez; un corte de luz o un disco
  lleno dejan la versión anterior intacta.
- La barra de estado dice en qué fase está la compilación (Python, LaTeX,
  cargando PDF) y cuánto tardó la última.
- Prueba del vigilante de bucles que fallaba de forma intermitente con TeX Live.

### Seguridad

- **Salidas HTML: cerrado un bypass del saneado.** `href="java&#x09;script:…"`
  llega al DOM con un tabulador que el navegador ignora en una URL, y el filtro
  no lo detectaba. Como los `.pltx` llevan sus salidas, abrir un informe ajeno y
  pulsar un enlace podía ejecutar código con acceso a los comandos de la app.
  Se eliminan también las animaciones SVG (`<animate>`, `<set>`), capaces de
  reescribir un enlace después del saneado.
- **Ningún enlace navega la ventana de la app**: uno relativo (`informe.html`)
  o `file:///…` en una salida sustituía el editor —y el texto sin guardar— por
  esa página. Los enlaces web y de correo se abren en el navegador del sistema.
- La ruta del PDF en la ventana del visor separada se pasa serializada, no
  pegada dentro de un literal de JavaScript.

### Corregido — el kernel ya no puede colgar la aplicación

- **Nada escrito por debajo de Python llega al canal del protocolo.** Un
  `os.system(...)`, un `subprocess` sin capturar, un solver que imprime desde
  C (HiGHS), o un texto sin salto de línea o con acentos de la consola de
  Windows podían partir un mensaje del kernel y dejar la app esperando para
  siempre, o matar el kernel. Ahora el protocolo va por descriptores privados
  y todo eso aparece en la salida de la celda, en su orden.
- **Un proceso hijo que lee la entrada ya no se come las peticiones de la
  app** (incluida la de interrumpir): recibe fin de archivo, como en Jupyter.
- **Pulsar Detener justo cuando la celda termina o empieza ya no deja la app
  colgada.** La interrupción solo puede alcanzar el código del documento;
  si llega mientras el kernel prepara la ejecución, se aplica al empezar esa
  celda. Toda petición recibe siempre respuesta.
- Un carácter suelto no válido (`'\ud800'`), `getpass()` o `msvcrt.getch()`
  tampoco cuelgan ya nada.
- Reiniciar el kernel ya no se queda esperando a un hilo que dejó en marcha
  una celda.

### Corregido — resultados exactos, compilación tras compilación

- **Lo que borras del documento deja de influir de verdad.** El reinicio de
  cada compilación restaura también `np.seterr`, los filtros de `warnings`,
  la configuración regional, el `logging`, las opciones de pandas y sympy,
  `mpmath.mp.dps`, la precisión de `decimal`, `os.environ`, `sys.path`, el
  backend de matplotlib…
- **Si el documento modifica una librería** (`scipy.constants.g = 10`,
  `math.pi = 3.14`, `Fraction.__str__ = …`), ningún reinicio dentro del mismo
  proceso puede deshacerlo: la siguiente compilación arranca un **Python
  nuevo** y el registro dice por qué.
- **Un `helper.py` junto al documento se vuelve a leer en cada compilación.**
  Antes se seguía ejecutando la versión que había en disco la primera vez
  (incluso con dos cambios en el mismo segundo). Además ya no aparece
  `__pycache__` en la carpeta del proyecto.
- `\py{}`: un `%` (p. ej. `f"{x:.1%}"`) ya no convierte en comentario el resto
  de la línea; los números grandes no llevan ceros falsos
  (`12345678901234.5`); `float32` da `0.1`, no `0.10000000149`; los valores
  extremos se escriben como `m×10ⁿ`; pint y sympy salen tipografiados; un
  objeto cualquiera se escapa para que no rompa la compilación; y una
  expresión que falla ya no se lleva por delante las demás.
- La vista previa en vivo de `\py{}` ya no ejecuta expresiones que modifican
  datos (`lst.pop()`, `next(it)`, `rng.random()`), que desplazaban los valores
  de la siguiente compilación.

### Corregido — cualquier librería, como en Jupyter

- Las celdas se ejecutan en `__main__`: `if __name__ == "__main__":`, `pickle`,
  `joblib.dump`, `enum` y las anotaciones de tipos funcionan.
- Sintaxis de IPython: `%matplotlib inline`, `%time`, `%timeit`, `%pip`,
  `%load_ext autoreload`, `!cmd`, `x = !cmd`, `%%writefile`, `%%html`…
- `from IPython.display import display` funciona con `HTML`, `Math`, `Latex`,
  `Markdown`, imágenes JPEG/GIF/SVG, `display_id`/`update`, `clear_output`.
- Importar seaborn, handcalcs o IPython ya no rompe todas las gráficas de la
  sesión; `plt.show()` muestra cada figura en su sitio (un bucle con
  `plt.show()` da una figura por vuelta).
- sympy y cualquier objeto con `_repr_latex_` se ven tipografiados; plotly ya
  no sale en blanco ni puede colgar la celda (`renderer="browser"`); bokeh y
  altair se muestran dentro de la app.
- `logging`, tqdm o `rich` configurados en una celda siguen escribiendo en las
  siguientes; `os.chdir` persiste entre celdas; `await` funciona en una celda.
- La salida respeta el orden real (texto, tablas y figuras intercaladas), los
  colores de terminal y las barras de progreso con `\r`.
- El análisis de sintaxis ya no marca como error las celdas `%%render` ni las
  líneas mágicas, y un error dentro de `%%render` se señala en su línea real.
- handcalcs: `@handcalc` sigue funcionando tras cientos de ejecuciones,
  `%%render` exige el `import handcalcs.render` igual que Jupyter (también tras
  reiniciar), `%decimal_separator` funciona y un error de tipografiado señala
  su línea. Comparado con Jupyter real: 856 de 873 celdas idénticas; el resto
  son casos en los que Jupyter falla y Pyx no.

### Más rápido

- Al abrir un documento, el kernel importa ya sus librerías (numpy, scipy,
  matplotlib, handcalcs…): la primera compilación deja de esperarlas.
- Índices creados por la plantilla (`\newlistof`) incluidos: una compilación
  basta, ya no hay que darle varias veces.
- Un documento compilado con errores recuperables se marca en ámbar
  («Compilado con errores»), no en rojo.

### Corregido — anterior

- **handcalcs ya no arrastra ajustes de antes.** Una celda `%%render` con
  `a = 2` salía partida en dos líneas —`a` en una y `= 2` en la siguiente—
  aunque el código fuese correcto. handcalcs guarda cada
  `handcalcs.set_option(...)` dentro de su propio módulo, y el reinicio que hace
  la compilación solo vaciaba las variables: un
  `set_option("math_environment_start", "gathered")` ejecutado alguna vez en la
  sesión —en una línea ya borrada, o en otro documento abierto, porque todos
  comparten el mismo kernel— seguía en vigor. `gathered` tiene una sola columna
  centrada y TeX convierte cada `&` en una fila nueva. Ahora el reinicio
  devuelve la configuración de handcalcs a la de un intérprete recién
  arrancado (respetando lo guardado con `handcalcs.save_config()`), y lo mismo
  los ajustes de matplotlib (`rcParams`, `plt.style.use`).
- Los argumentos de `%%render` (`params`, `long`, `short`, la precisión…) se
  interpretan con el analizador de la propia handcalcs, así que una versión
  nueva de la librería se comporta igual que en Jupyter. Comprobado contra
  handcalcs 1.10: la salida de Pyx es idéntica, carácter a carácter, en todos
  los modos.

## [1.4.0] — 2026-09-22

Lo que escribes es lo que ves, siempre.

### Corregido

- **Las celdas ya no muestran la misma figura dos veces.** La forma más normal
  que hay de terminar una celda que dibuja —`fig, ax = plt.subplots()` … `fig`—
  pintaba la gráfica dos veces: una como resultado de la celda y otra porque la
  figura seguía abierta cuando el kernel barría las figuras al terminar. Lo
  mismo con `display(fig)`. Ahora una figura que ya se ha mostrado no se vuelve
  a recoger, y una celda que dibuja sin escribir nada al final se sigue
  capturando igual que antes.
- **«Reiniciar el kernel» ya puede parar la celda que no termina.** Se ponía en
  la cola detrás de la secuencia en curso, así que con un `while True:` delante
  el botón no hacía absolutamente nada: esperaba a que acabase justo aquello
  que se le pedía terminar. Ahora, si hay algo ejecutándose, mata el proceso
  primero y reinicia después.
- **El botón de parada dice lo que va a hacer.** La interrupción suave no
  siempre llega a la celda (una extensión en C que nunca comprueba las
  señales), y pulsar otra vez escalaba a matar el proceso sin que nada lo
  contara. A los dos segundos sin efecto, el botón pasa a decir **«Forzar
  parada»** y avisa de que se pierden las variables.
- **El visor avisa cuando el PDF no es del documento abierto.** Al cambiar a
  otro proyecto que todavía no se ha compilado, se quedaba en pantalla el PDF
  del anterior sin nada que lo indicara: se leía el texto de un informe junto a
  los números de otro. Ahora aparece una franja que lo dice y nombra el PDF.
  Un capítulo y su raíz comparten PDF, y ese caso sigue sin avisar de nada.
- **Una ruta de proyecto demasiado larga ya no falla con «os error 267».**
  Windows no deja arrancar un programa en una carpeta de más de 260 caracteres
  —y el prefijo `\\?\` no lo arregla, solo vale para rutas de archivo—, así
  que ahora el mensaje dice exactamente eso, cuánto mide la carpeta y que hay
  que mover el proyecto.
- **El corrector dejó de subrayar «graphics» en cada figura.** La lista de
  órdenes cuyo argumento no es texto probaba `\include` antes que
  `\includegraphics`, así que de `\includegraphics{figuras/viga.png}` solo se
  ocultaba la primera mitad. Además, una orden que no está en la lista ya no
  puede confundirse con otra más corta: `\reflectbox{Texto}` ya no se lee como
  `\ref` + «lectbox».
- **Los iconos ya no salían aplastados.** Un `<button>` trae el relleno del
  propio navegador (`1px 6px`) y ningún estilo lo quitaba, así que la equis de
  cerrar pestaña se dibujaba a 14×6 y los iconos de la barra del visor a 12×18.
  No parecían «de web» por casualidad: estaban estrujados.
- **El icono de la sección «Estructura» ocupaba el panel entero.** No tenía
  ninguna regla de tamaño, así que se dibujaba al tamaño por defecto de un SVG
  sin medidas.
- **El icono de estado de la barra inferior se dibujaba a 54×54** en una barra
  de 24 px, por el mismo motivo.
- **Las barras de desplazamiento volvieron a ser redondeadas.** Un
  `* { scrollbar-width: thin }` anulaba en silencio todo el bloque
  `::-webkit-scrollbar` —en Chromium la propiedad estándar gana— y devolvía la
  barra cuadrada de 10 px del motor.
- **La barra del visor PDF ya no esconde botones.** Con el panel lateral
  abierto en una ventana de 1000 px, los cinco últimos botones quedaban fuera
  del borde derecho y no había manera de llegar a ellos. Ahora los controles se
  desplazan como una tira y el botón de cerrar se queda fijo.
- **Las flechas de página se apagan al principio y al final del documento**, en
  vez de parecer activas y no hacer nada.
- **Una salida muy larga ya no empuja el documento varias pantallas abajo**:
  pasadas unas 30 líneas se desplaza dentro de su propio recuadro, como en los
  cuadernos de VS Code. Las figuras y las tablas se siguen mostrando enteras.
- **El menú del clic derecho se cierra con Escape** y se coloca midiendo su
  altura real, no una estimada: cerca del borde inferior de la pantalla se le
  quedaban filas fuera.
- **«Restablecer» vuelve también al tema claro.** El tema no vive en los
  ajustes generales, así que era lo único que se quedaba como estaba.
- **El deslizador del intervalo de autoguardado se apaga cuando el
  autoguardado está desactivado.**
- **«Sin fondo» se distingue de «fondo negro»** en la tabla de colores: el
  selector no tiene forma de representar la ausencia de color y enseñaba un
  cuadro negro en los dos casos.
- **El nombre del tema «Claro» se lee.** Era texto blanco sobre un degradado
  que empieza en blanco.


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
- **Un guardado que falla ya no parece que haya funcionado.** Si el archivo
  está en solo lectura, la unidad de red se cae o el disco está lleno, el
  documento sigue marcado como modificado, el motivo sale en «Problemas» y se
  avisa con un diálogo. Antes no se decía nada: el error se perdía y la barra
  de estado hasta se ponía en verde por la compilación en vivo, con el trabajo
  solo en memoria.
- **Dos guardados a la vez ya no se pisan.** Pulsar Ctrl+S varias veces
  seguidas lanzaba varios empaquetados sobre el mismo archivo temporal; uno
  fallaba («os error 2») y dos escrituras simultáneas podían dejar un `.pltx`
  dañado. Ahora se guardan de uno en uno.
- **`\py{}` con una llave sin cerrar ya no tumba la compilación entera.** Antes
  dejaba sin resolver todos los `\py{}` siguientes del archivo y el motor se
  paraba en seco («Emergency stop», ningún PDF). Ahora se ignora ese comando,
  el resto del documento se compone y «Problemas» dice en qué línea están las
  llaves mal puestas.
- **Un `\py{}` que falla ya no hace que se ejecuten todas las celdas otra
  vez.** La reejecución de seguridad solo tiene sentido cuando la compilación
  se saltó celdas; si acababan de ejecutarse todas, repetirlas no cambia nada y
  duplicaba el tiempo (una celda interrumpida de 30 s costaba 60). El registro
  también decía «2 ejecutadas de 1».
- **El visor sigue al documento que estás mirando**: al cambiar de pestaña
  muestra el PDF de ese proyecto, y una compilación de otro proyecto que
  termina ya no se adueña de la vista.
- **La carpeta del proyecto ya no queda bloqueada** mientras Pyx está abierto:
  el kernel de Python se salía de ella al terminar cada ejecución, y hasta
  ahora Windows impedía renombrarla o moverla.
- La cinta se **solapaba consigo misma** por debajo de unos 1100 px (a 860x560,
  el tamaño mínimo de la ventana, 17 solapes: «Cortar» encima de «Compilar y
  ver», los desplegables de «Estructura» fuera de la ventana). Ahora los grupos
  conservan su tamaño y la cinta se desplaza en horizontal.
- **Escape cierra los diálogos** (Configuración, Nuevo documento, asistentes) y
  abrir uno cierra el anterior: un atajo podía dejar dos superpuestos.
- «Tabla» e «Imagen» estaban activos sin ningún documento abierto, y el
  asistente se quedaba ahí sin sitio donde insertar nada.
- **Un `.pltx` dañado abierto directamente ya no se abre en silencio.** Un
  contenedor que no se puede leer mostraba sus bytes en el editor como si
  fueran el documento, sin avisar, y un Ctrl+S habría empaquetado esa basura
  encima del original. Ahora se explica por qué no se puede abrir y no se abre
  ninguna pestaña. (Un `.pltx` antiguo en texto plano se sigue abriendo como
  texto, como siempre.)
- Al reabrir un documento, sus celdas volvían a aparecer como si nunca se
  hubieran ejecutado, aunque sus resultados estaban guardados y el PDF ya
  mostraba esos números. Ahora se repintan con su número de ejecución.
- **Una celda que importaba numpy, matplotlib o pandas dejaba la compilación
  colgada para siempre**, sin mensaje y sin poder interrumpirla: había que
  cerrar la app. En Windows, mientras el kernel esperaba órdenes bloqueado en
  su tubería, ningún otro hilo del proceso podía cargar una biblioteca nativa
  —y cargarla es justo lo que hace `import numpy`—, así que la celda no
  terminaba nunca y la orden de interrumpir tampoco podía leerse, porque
  leerla era precisamente lo que estaba bloqueado. Ahora el kernel consulta la
  tubería en vez de quedarse esperando en ella: `import numpy` tarda 0,2 s,
  matplotlib 0,8 s, y una celda que se atasca sí se puede interrumpir.
- Un `\py{}` con las llaves sin cerrar en un `.tex` **sin celdas** seguía
  tumbando la compilación entera: la limpieza solo se aplicaba a los archivos
  que Pyx procesa como documentos con Python.
- Una celda `%%render` (handcalcs) rompía el documento si el preámbulo no
  cargaba `amsmath`: lo que escribe handcalcs es un entorno `aligned`, que es
  de ese paquete, y el motor encadenaba errores por toda la página. Ahora se
  garantiza igual que los demás paquetes que Pyx ya asegura.
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

### Añadido

- **El menú del clic derecho distingue las correcciones de las órdenes.** Al
  pulsar sobre una palabra mal escrita, las sugerencias salían en la lista con
  exactamente el mismo aspecto que «Cortar» o «Copiar», así que no había forma
  de ver de un vistazo qué filas sustituían la palabra y cuáles actuaban sobre
  ella. Ahora las encabeza un rótulo —«Sugerencias para «coheficiente»»— y se
  escriben en la tipografía del editor, en negrita: son palabras, no
  comandos. Además **cada entrada lleva su icono** en una columna fija, de
  modo que todas las etiquetas arrancan a la misma altura, como en VS Code.
  Vale para el menú del editor, el del árbol de archivos y los de la celda.

- **Las etiquetas al pasar el ratón ya no son las de Windows.** El tooltip del
  sistema tarda cerca de un segundo, usa la fuente del sistema, ignora el tema
  y desentona con todo lo demás. Pyx dibuja el suyo, con los números del de VS
  Code (500 ms de retardo, 13 px, borde de un píxel, radio de 5) y con el
  atajo de teclado en teclas aparte. Se conserva la accesibilidad: donde se
  quita el `title` queda un `aria-label`.

- **La celda trae la barra de herramientas de VS Code**, con las mismas
  acciones y en el mismo orden: ejecutar las celdas anteriores, ejecutar esta
  y las siguientes, dividir la celda por el cursor, un menú «…» y eliminar.
  El menú «…» añade cortar y copiar la celda, insertar una celda arriba o
  abajo, contraerla, y borrar o copiar su salida. La salida tiene además su
  propio «…» junto al número de ejecución, con **copiar la salida** y
  **borrar la salida** —lo que se pide cuando lo que quieres es el resultado,
  no el código—. Todo aparece solo en la celda en la que estás, como en VS
  Code: una celda en reposo enseña su código y nada más.

- **El corrector ortográfico deja de subrayar el vocabulario del documento.**
  Medido sobre una muestra de 128 palabras españolas y 74 inglesas reales de
  una memoria de cálculo, el corrector rechazaba 19 y 16: `flector`, `axil`,
  `hiperestático`, `geotecnia`, `hidrograma`, `mayoración`, `rebar`,
  `formwork`, `subgrade`… Ahora no rechaza ninguna, y las 34 erratas parecidas
  que se le pusieron delante (`flecktor`, `hiperstatico`, `arriostramento`,
  `formwok`) las sigue marcando, con su sugerencia correcta. Dos cambios lo
  consiguen: `public/dict/en.dic` pasa a ser la **unión de las listas
  estadounidense y británica** —antes un texto en inglés británico salía con
  `behaviour`, `modelling`, `optimisation`, `centre` y `analysed` subrayadas,
  todas correctas—, y cada idioma gana un suplemento técnico
  (`public/dict/*.extra.txt`) con el vocabulario de ingeniería civil, cálculo
  estructural, geotecnia, hidrología, topografía y materiales que ningún
  diccionario general recoge. El español sigue siendo el RLA, que es el mejor
  diccionario libre que existe para este idioma y el mismo que usa
  LibreOffice. `tools/build-dicts.mjs` regenera los archivos y se niega a
  fusionar el inglés si las dos variantes dejan de compartir tabla de afijos.

### Cambiado

- **La barra de acciones de la celda es ahora el panel flotante de VS Code.**
  Estaba dentro de la celda, lo que convertía la parte de arriba en una franja
  de 24 px vacía; ahora es un recuadro pequeño centrado sobre la línea del
  borde superior, a la derecha, y la celda empieza directamente con el código.
- **El borde de la celda es una línea de 1 px por los cuatro lados.** El
  sombreado interior que llevaba la cabecera se veía como un trazo grueso
  arriba y fino en el resto.

- **Los controles y los iconos siguen ahora el patrón de VS Code.** Los
  desplegables, las casillas, los deslizadores, los campos y los botones se
  han rehecho con las medidas de la propia hoja de estilos de VS Code, y los
  iconos con el trazo de sus codicons: caja de 16×16, trazo de 1,2 px, sin
  rellenos salvo cuando la forma ES un sólido. Dos detalles que se notaban:
  la marca de la casilla se dibujaba a 16 px dentro de un área de 20 y se
  salía por la esquina, con lo que parecía un carácter suelto en vez de una
  casilla; y el estado de la celda usaba los caracteres `✓` y `✗`, que cada
  fuente dibuja a su manera, en vez de un icono.

- **Los colores del editor ya no son una aproximación: son los de TeXstudio y
  los de VS Code.** El LaTeX reproduce el esquema de fábrica de TeXstudio,
  tomado de los dos ficheros que el propio TeXstudio carga al arrancar
  (`defaultFormats.qxf` y `defaultFormatsDark.qxf`) y contrastado con el
  esquema que una instalación real escribe en su `texstudio.ini`. Eso incluye
  tres cosas que casi nadie acierta de memoria: el formato llamado `numbers`
  es el color del **contenido matemático**, no el de los dígitos —los números
  en texto corriente no llevan color—; las llaves, los corchetes y los escapes
  tipo `\%` tampoco tienen color propio (el escape usa el del comando); y
  `\begin`/`\end` comparten formato con `\section`, mientras el nombre del
  entorno y el título de la sección llevan cada uno el suyo. Se añaden
  construcciones que antes no se distinguían: contenido y comandos
  matemáticos, `verbatim` y `\verb`, cuerpos de `tikzpicture`, comentarios
  `%TODO` y mágicos `% !TeX`, y el argumento de `\ref`, `\cite` y
  `\usepackage`.
- **El Python de las celdas se colorea como un `.py` en VS Code.** El
  resaltador dejó de ser un tokenizador por caracteres y pasa a analizar la
  celda con la gramática real de Python, que es lo único que permite
  distinguir lo que VS Code distingue: `foo(x)` como función y `x` como
  variable, `obj.attr` como propiedad y `obj.metodo()` como función, la clase
  como tipo, `MAX_ITER` como constante, los escapes dentro de una cadena, el
  prefijo `r`/`b`/`f` y el `0x` de un número con su propio color, el
  especificador `:.2f` de un f-string, y el `in` de un `for` en el color del
  `for` mientras el `in` de una comprobación de pertenencia va en el de los
  operadores. Los valores salen de los ficheros de tema que VS Code instala,
  no de la memoria de nadie.
- **Las celdas Python se ven como las de VS Code.** Canalón de 44 píxeles a la
  izquierda con el botón de ejecutar y el plegado fuera de la caja, una sola
  barra continua marcando la celda activa, caja plana con borde de un píxel y
  esquinas de 6 píxeles, barra de estado inferior con el resultado, el tiempo
  y el lenguaje, y la salida sobre el lienzo sin marco, alineada con el código
  para que se lean como una columna. Lo que sobra —limpiar salida, eliminar,
  plegar— solo aparece en la celda en la que estás. La celda activa se marca
  con **dos barras alineadas**, una por el código y otra por la salida,
  separadas por los 3 píxeles que deja VS Code. Estaban desplazadas un píxel
  entre sí por un motivo que cuesta ver: un hijo posicionado en absoluto se
  coloca contra la *caja de relleno* de su ancestro, así que los tramos que
  cuelgan de la caja con borde empezaban un píxel más a la derecha que el de
  la salida, que no lo tiene.
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

[1.6.4]: https://github.com/LorGIOO/Pyx/releases/tag/v1.6.4
[1.6.3]: https://github.com/LorGIOO/Pyx/releases/tag/v1.6.3
[1.6.2]: https://github.com/LorGIOO/Pyx/releases/tag/v1.6.2
[1.6.0]: https://github.com/LorGIOO/Pyx/releases/tag/v1.6.0
[1.5.0]: https://github.com/LorGIOO/Pyx/releases/tag/v1.5.0
[1.4.0]: https://github.com/LorGIOO/Pyx/releases/tag/v1.4.0
[1.3.1]: https://github.com/LorGIOO/Pyx/releases/tag/v1.3.1
[1.3.0]: https://github.com/LorGIOO/Pyx/releases/tag/v1.3.0
[1.2.1]: https://github.com/LorGIOO/Pyx/releases/tag/v1.2.1
[1.2.0]: https://github.com/LorGIOO/Pyx/releases/tag/v1.2.0
[1.1.0]: https://github.com/LorGIOO/Pyx/releases/tag/v1.1.0
