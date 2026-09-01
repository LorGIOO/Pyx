# Registro de cambios

Todas las versiones publicadas de Pyx. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

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

[1.2.1]: https://github.com/LorGIOO/Pyx/releases/tag/v1.2.1
[1.2.0]: https://github.com/LorGIOO/Pyx/releases/tag/v1.2.0
[1.1.0]: https://github.com/LorGIOO/Pyx/releases/tag/v1.1.0
