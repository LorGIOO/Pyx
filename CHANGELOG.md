# Registro de cambios

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

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
- Mientras una herramienta está en la mano, las páginas no se mueven solas.

### Escribir

- Imagen a LaTeX: pega una captura de una fórmula y se escribe su código. El
  reconocedor se queda cargado: ~1 s por fórmula tras la primera.
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
- Pestañas de documentos más pequeñas, con ancho configurable.
- Instaladores comprobados con antivirus antes de publicarse.
