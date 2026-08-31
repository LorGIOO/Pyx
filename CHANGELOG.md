# Registro de cambios

Todas las versiones publicadas de Pyx. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

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

[1.2.0]: https://github.com/LorGIOO/Pyx/releases/tag/v1.2.0
[1.1.0]: https://github.com/LorGIOO/Pyx/releases/tag/v1.1.0
