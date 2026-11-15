# Trabajar a la vez en un proyecto (sesión compartida)

Varias personas editan el mismo proyecto de Pyx al mismo tiempo, como en Google Docs u Overleaf:
cada una ve lo que escriben las demás al instante, su cursor, su selección y **su ratón**, en el
editor y en el PDF. No hace falta pasarse archivos.

## Cómo funciona, en una frase

Quien comparte (el **anfitrión**) tiene los archivos en su ordenador: su Pyx los guarda, ejecuta
el Python y compila. Los demás (los **invitados**) editan esos mismos archivos desde su Pyx y ven
el PDF del anfitrión, que les llega solo después de cada compilación.

```
 Pyx del anfitrión ──┐                          ┌── Pyx de un invitado
 (archivos, Python,  │   conexión cifrada (wss) │
  compilación)       └──►  servidor relé  ◄─────┼── Pyx de otro invitado
                           (solo reenvía datos   │
                            cifrados; no puede   └── …
                            leerlos)
```

## Compartir un proyecto (anfitrión)

1. Abre el documento principal del proyecto.
2. Pulsa **Compartir** (arriba a la derecha). Pyx propone la **carpeta compartida**: la carpeta madre
   del proyecto, la que contiene el preámbulo y todo lo que incluye (capítulos en `../capitulos`,
   figuras en `../figuras`, bibliografía…). Puedes elegir otra con **Cambiar…**. Todo lo que hay
   dentro se puede abrir, editar y compilar en la sesión; lo de fuera, no. Pyx nunca propone por sí
   solo tu carpeta personal.
3. Escribe tu nombre y la dirección del servidor de sesiones (`wss://…`, ver más abajo).
4. Elige qué podrán modificar quienes entren:
   - **Python y LaTeX**: todo.
   - **Solo LaTeX**: el texto del documento. No pueden tocar las celdas `%#python … %#end`,
     ni `\py{}`, ni la condición de `\pyif{}`, ni `\pyfile{}` / `\pynotebook{}`.
   - **Solo Python**: las celdas y las expresiones de Python, no el texto.
   - **Solo lectura**: ven todo en directo, no cambian nada.
5. Pulsa **Empezar a compartir** y envía el **código de invitación** por un canal de confianza.

Cada vez que alguien pide entrar aparece una tarjeta con su nombre y un **código de verificación**
de 6 cifras. El invitado ve el mismo código: si queréis estar seguros de que nadie se ha colado,
comparadlo de viva voz. Puedes aceptar con un permiso distinto del general, cambiarlo después o
sacar a alguien de la sesión en cualquier momento (**Compartir → En la sesión**).

> ⚠ **Dar permiso de Python significa que el código de esa persona se ejecuta en tu ordenador**
> al compilar. Dáselo solo a gente de total confianza. Con «Solo LaTeX» o «Solo lectura» el
> invitado no puede ejecutar nada en tu ordenador.

Mientras compartes:
- Lo que escriben los invitados se guarda solo en tus archivos (unos segundos después).
- Tu Pyx compila para todos al dejar de escribir, como siempre; si varias personas escriben sin
  parar, compila igualmente cada pocos segundos.
- Los archivos que abre un invitado se abren también en tu Pyx, en segundo plano.

Para terminar: **Compartir → Terminar la sesión**. Lo pendiente se guarda antes de cerrar.

## Unirse (invitado)

1. Pulsa **Compartir → Unirme con un código**.
2. Escribe tu nombre, pega el código y pulsa **Unirme**.
3. Espera a que el anfitrión te acepte (verás el código de verificación).

Dentro de la sesión:
- El documento principal se abre solo. El resto de archivos está en el panel lateral
  **Sesión compartida** (icono de dos personas).
- **Guardar** (Ctrl+S) pide al anfitrión que compile: los archivos se guardan en su equipo.
- Ctrl+clic en el PDF y la búsqueda directa funcionan igual que siempre.
- **Ctrl+Z deshace solo lo que has escrito tú**, nunca lo de los demás.
- Nada del documento se ejecuta en tu ordenador: ni las celdas, ni `\py{}`, ni LaTeX.
- Si te quedas sin conexión puedes seguir escribiendo: al volver, todo se une solo.
- Si la sesión termina, tus pestañas se quedan como documentos sin guardar, para que no pierdas
  nada («Guardar como»).

## Ver a los demás

- **Ratón**: la flecha de cada persona, con su color y su nombre, se mueve en tiempo real sobre el
  editor y sobre el PDF. Se coloca sobre el mismo carácter o el mismo punto de la página aunque
  vuestras ventanas tengan distinto tamaño o zoom.
- Si alguien está en una parte que no ves, aparece una píldora en el borde («Ana ↓»): púlsala
  para ir allí.
- **Cursor y selección**: se ven en el texto con su color; el nombre aparece mientras escribe.
- **Seguir a alguien**: pulsa su círculo en la barra de título (o el ojo en el panel). Tu editor y
  tu PDF siguen lo que ve esa persona hasta que tocas el teclado, el ratón o la rueda.

## El servidor de sesiones (relé)

Las sesiones necesitan un pequeño servidor que reenvía los datos entre los participantes. **No
puede leer nada**: todo va cifrado de extremo a extremo y la clave viaja en el código de
invitación, que el servidor nunca ve. Ningún ordenador de la sesión abre puertos.

Para montarlo (cualquier servidor con Docker o Node 20+):

```bash
cd server
docker build -t pyx-relay .
docker run -d --restart=always -p 127.0.0.1:8787:8787 -e TRUST_PROXY=1 pyx-relay
```

y delante un proxy con certificado TLS, por ejemplo Caddy con `server/Caddyfile.example`
(Caddy obtiene el certificado solo). La dirección para Pyx será `wss://tu-dominio`.

Sin Docker: `npm install --omit=dev` en `server/` y `node relay.mjs` (variables `PORT`, `HOST`,
`TLS_CERT`/`TLS_KEY` para servir TLS directamente, `TRUST_PROXY=1` detrás de un proxy).

Para probar en un solo ordenador: `npm run relay` y la dirección `ws://localhost:8787`
(sin cifrado TLS, solo se admite para `localhost`).

## Seguridad: qué protege y qué no

| Riesgo | Protección |
|---|---|
| Alguien de Internet entra en tu ordenador | Ningún equipo abre puertos: todos se conectan hacia fuera al relé. |
| Alguien sin el código se une | El código lleva una clave de 256 bits; sin ella no se puede ni pedir paso. |
| Alguien con el código se une | El anfitrión acepta a cada persona; código de verificación de 6 cifras. |
| El servidor lee o altera los documentos | Cifrado de extremo a extremo (AES-256-GCM, ECDH P-256, claves por persona y de grupo); mensajes repetidos o reordenados se rechazan. |
| Un invitado «Solo LaTeX» cambia el Python | Su Pyx lo impide al teclear y el del anfitrión **lo comprueba otra vez** contra el texto real: si llega igualmente, lo deshace para todos antes de que nadie lo vea. |
| Un invitado falsifica cambios en nombre de otro | Cada cambio lleva el identificador de su autor; el anfitrión rechaza los firmados con el de otra persona. |
| Un LaTeX malicioso ejecuta programas o lee tus archivos | Durante la sesión el motor se lanza siempre sin `shell-escape`. Antes de compilar, Pyx comprueba que cada `\input`, `\includegraphics`, `\bibliography`, `\verbatiminput`… apunte dentro de la carpeta compartida (con `../` incluido) y rechaza los nombres de archivo hechos con macros. Si el proyecto no sale de la carpeta del documento raíz, TeX Live además se lanza en modo paranoico (sin rutas absolutas ni `..`). |
| Se expulsa a alguien | Se desconecta y la clave de grupo cambia: no puede leer nada de lo que sigue. |
| Un PDF manipulado ataca al invitado | El visor nunca ejecuta código del PDF. |

Lo que **no** se puede evitar: si das permiso de Python a alguien, su código se ejecuta en tu
ordenador (igual que si abrieras un cuaderno de Jupyter suyo). Y quien tenga el código de
invitación puede pedir entrar: por eso hay que aceptar a cada persona.

El modo paranoico de TeX Live rechaza cualquier `..`, así que no se puede usar en proyectos con
capítulos en carpetas vecinas; en ellos (y siempre en MiKTeX y Tectonic, que no lo tienen) la
protección contra leer archivos de fuera de la carpeta compartida la da la comprobación de Pyx antes
de compilar. Esa comprobación no interpreta TeX: alguien con permiso de LaTeX y mucha intención podría
construir un nombre de archivo que la esquive. Por eso conviene aceptar solo a gente conocida.
`shell-escape` sigue desactivado en todos los casos: nadie puede ejecutar programas en tu equipo
desde LaTeX.

## Límites

- Hasta unas 30 personas por sesión.
- Solo viajan los archivos de texto editables del proyecto (`.pltx`, `.tex`, `.bib`, `.sty`,
  `.cls`, `.md`, `.txt`, `.py`) y solo los que alguien abre. Las imágenes y datos se quedan en el
  equipo del anfitrión, que es quien compila.
- Por ahora los invitados no crean, renombran ni borran archivos, ni pegan imágenes: lo hace el
  anfitrión y los demás lo ven en la lista de archivos.
- En una sesión, las rutas de LaTeX deben quedarse dentro de la carpeta compartida, y los nombres
  de archivo se escriben tal cual (no con macros como `\input{\carpeta/intro}`).
- Lo que se compila es el documento raíz del último archivo editado (o el que tiene delante quien
  pide compilar); el PDF que ven todos es el de esa última compilación.
