# Registro de cambios

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

## [Sin publicar] (rama `remote`)

### Seguridad de la sesión compartida

- **Con permiso «Solo LaTeX» se podía ejecutar Python en el equipo del
  anfitrión.** Bastaba escribir una celda `%#python` (o `\py{}`, `\pyif`,
  `\pynotebook`) en un `.tex`, `.sty` o `.txt` compartido: se daba por hecho
  que en esos archivos nada se ejecuta, pero el compilador sí ejecuta las
  celdas de cualquier archivo que las tenga. Ahora todo archivo de texto se
  comprueba por lo que ejecutaría.
- **Un solo mensaje podía tumbar el servidor de sesiones** y cortar las de
  todo el mundo (una orden de control que no fuera un objeto, p. ej. `null`).
  Ya no; ningún error al tratar un mensaje detiene el relé.
- En una sesión se rechaza el código Lua (`\directlua`, `luacode`), que
  puede leer cualquier archivo por su cuenta, y las órdenes de lectura
  escritas de forma encubierta (`\csname input\endcsname`, `\catcode`).
- El tope de 32 MB por documento vale también para quien tiene todos los
  permisos, y un invitado no puede hacer que el anfitrión acumule en memoria
  un mensaje sin fin.
- La dirección del servidor tiene que ser `wss://` (solo `ws://localhost`
  para pruebas).

### Sesión compartida

- Quien vuelve tras un corte de red antes de que el servidor note la
  desconexión ya no tiene que ser aprobado otra vez ni aparece duplicado.
- Montar el servidor de sesiones: `render.yaml` (Render) y `server/fly.toml`
  (Fly.io) listos para usar, y `js/collab/default-relay.js` para que todos
  los usuarios lo tengan ya puesto (`server/README.md`).

### Actualizaciones con muchos usuarios

- **«Buscar actualizaciones» fallaba para todos en un aula u oficina** con un
  falso «sin conexión»: la API de GitHub solo admite 60 consultas por hora y
  por dirección pública, que un grupo detrás del mismo router agota enseguida.
  Una instalación estable lee ahora `pyx-update.json`, que cada versión
  publica: una descarga corriente, sin ese límite. Si aun así GitHub rechaza
  la consulta, el mensaje lo dice.
- Comprobación cada dos horas (antes cada 30 minutos) y escalonada al
  arrancar; una descarga que falla no se reintenta sin fin en segundo plano.
- Un paquete ya descargado y comprobado no se vuelve a bajar. Un segundo clic
  en «Buscar actualizaciones» no lanza dos instalaciones.
- En Linux, el segundo usuario del mismo equipo no podía actualizar (la
  descarga iba a `/tmp`, compartido): va a la caché de cada usuario.

### Python

- **El kernel de Python fallaba a veces al arrancar** («SyntaxError» en una
  línea cualquiera, o «terminó al arrancar») cuando dos arranques coincidían:
  uno leía el archivo del kernel a medio escribir por el otro. Ahora se
  escribe aparte y se renombra, y si ya está intacto no se toca. En Linux
  vive en la carpeta del usuario, no en `/tmp`.
- `\py{}` rechaza los datos ausentes de pandas (`pd.NA`, `pd.NaT`) como ya
  rechazaba NaN: no llegan al PDF como «<NA>».

## [2.0.3] — 2026-11-16 (pre-lanzamiento, rama `remote`)

- **El instalador de Windows de la 2.0.2 lo bloqueaba el antivirus.** El
  ejecutable de Windows llevaba dentro, sin usarlo nunca, el código con el
  que se actualizan macOS y Linux: un pequeño script que espera a que el
  programa termine, borra (`rm -rf`) y sustituye la aplicación. Es justo lo
  que los antivirus heurísticos consideran un troyano. Ahora cada sistema
  lleva solo su propia forma de actualizarse; el de Windows, la misma que la
  2.0.0.

## [2.0.2] — 2026-11-15 (pre-lanzamiento, rama `remote`)

### Actualizaciones automáticas

- Pyx busca versiones nuevas al arrancar, cada 30 minutos y al volver a la
  ventana; las descarga y comprueba (SHA-256) en segundo plano y las instala
  al cerrarse, o al momento con «Reiniciar para actualizar».
- Ahora también en **macOS** (sustituye Pyx.app) y **Linux** (sustituye el
  AppImage), no solo en Windows.
- «Buscar actualizaciones» no veía las versiones de prueba: quien tiene una
  versión de prueba recibe la más reciente (de prueba o estable); quien tiene
  una estable, solo estables. Se puede elegir en Configuración → General.

### Sesión compartida

- La sesión comparte la **carpeta madre** del proyecto (detectada a partir de
  lo que incluye el documento raíz, o la que elija el anfitrión), no solo la
  del preámbulo: capítulos, figuras y bibliografía en carpetas vecinas se
  abren, editan y compilan. Las rutas con `../` dentro de esa carpeta ya no
  bloquean la compilación; lo de fuera sigue bloqueado.
- Se compila el documento raíz del último archivo editado, o el que tiene
  delante quien pide compilar.

## [2.0.1] — 2026-11-15 (pre-lanzamiento, rama `remote`)

### Trabajar a la vez (sesión compartida)

- **Compartir** (arriba a la derecha): varias personas editan el mismo proyecto
  a la vez, como en Overleaf o Google Docs, sin pasarse archivos.
- Se ve en tiempo real el **ratón** de cada persona (en el editor y en el PDF,
  en el mismo punto del texto o de la página aunque las ventanas sean
  distintas), su cursor y su selección; «Seguir a» alguien muestra lo que ve.
- El anfitrión elige por persona: **Python y LaTeX**, **solo LaTeX**, **solo
  Python** o **solo lectura**, y lo puede cambiar en directo. Su Pyx comprueba
  cada cambio contra el texto real y deshace lo que no está permitido.
- El anfitrión ejecuta el Python y compila para todos; el PDF llega a los
  invitados enviando solo las partes que cambian.
- Cifrado de extremo a extremo; ningún equipo abre puertos; el servidor relé
  (`server/`) no puede leer nada. Durante la sesión LaTeX se compila sin
  `shell-escape` y sin leer archivos de fuera del proyecto.
- Sin tirones en documentos grandes: con 40 000 líneas, teclear cuesta lo
  mismo que sin sesión y los cambios de los demás llegan en unas decenas de ms.
- Guía: `Manual de usuario/colaboracion.md`.

## [2.0.0] — 2026-11-13

Primera versión de la nueva etapa de Pyx. Recoge todo lo anterior y añade:

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
