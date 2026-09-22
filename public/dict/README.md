# Diccionarios de corrección ortográfica

Diccionarios Hunspell (el mismo formato que usan Word, LibreOffice y Firefox).
El corrector carga `<código>.aff` + `<código>.dic` según el idioma de revisión
elegido en Configuración → Comprobación del lenguaje, y encima de ellos el
suplemento `<código>.extra.txt` si existe. Un idioma sin diccionario aquí
simplemente no subraya nada: para añadir uno, copia sus dos archivos con el
código correspondiente (por ejemplo `fr.aff` y `fr.dic`) y añádelo al selector
de `ConfigDialog.jsx`.

| Código | Idioma  | Origen                                  | Licencia                        |
|--------|---------|-----------------------------------------|---------------------------------|
| `es`   | Español | RLA (`es_ANY`) — el mismo de LibreOffice | GPL-3.0 OR LGPL-3.0 OR MPL-1.1 |
| `en`   | English | SCOWL — **unión de en_US y en_GB**       | MIT AND BSD                     |

Las licencias completas están en `es.LICENSE.txt` y `en.LICENSE.txt`.

## Por qué el inglés va fusionado

`dictionary-en` solo trae ortografía estadounidense, así que un documento
escrito en inglés británico salía con `behaviour`, `modelling`, `optimisation`,
`centre` y `analysed` subrayadas, todas ellas correctas. Las dos variantes
comparten exactamente la misma tabla de afijos, así que sus listas de palabras
se pueden unir sin tocar las reglas: el resultado acepta las dos ortografías y
sigue rechazando las erratas de verdad.

Quien quiera regenerar los archivos:

```bash
node tools/build-dicts.mjs
```

El script comprueba antes de fusionar que las tablas de afijos siguen siendo
idénticas, y se niega a hacerlo si algún día dejan de serlo.

## Los suplementos `*.extra.txt`

Listas de palabras mantenidas a mano, una por línea, con `#` para comentarios.
Ningún diccionario general —tampoco el RLA, que es el mejor libre que existe
para español— recoge el vocabulario de ingeniería civil: medido sobre una
muestra de 128 palabras españolas y 74 inglesas reales, el diccionario pelado
rechazaba 19 y 16 respectivamente (`flector`, `axil`, `hiperestático`,
`geotecnia`, `hidrograma`, `rebar`, `formwork`, `subgrade`…). Con el suplemento
no rechaza ninguna, y las 34 erratas parecidas que se le pasaron por delante
las sigue marcando.

No hay afijos aquí, así que al añadir un término hay que escribir también su
plural y su femenino. `test/dictionaries.test.js` vigila las dos direcciones:
que lo correcto se acepte y que lo incorrecto se siga rechazando.
