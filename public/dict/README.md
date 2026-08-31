# Diccionarios de corrección ortográfica

Diccionarios Hunspell (el mismo formato que usan Word, LibreOffice y Firefox).
El corrector carga `<código>.aff` + `<código>.dic` según el idioma de revisión
elegido en Configuración → Idioma. Un idioma sin diccionario aquí simplemente
no subraya nada: para añadir uno, copia sus dos archivos con el código
correspondiente (por ejemplo `fr.aff` y `fr.dic`) y añádelo al selector de
`ConfigDialog.jsx`.

| Código | Idioma   | Origen           | Licencia                          |
|--------|----------|------------------|-----------------------------------|
| `es`   | Español  | RLA / LibreOffice | GPL-3.0 OR LGPL-3.0 OR MPL-1.1   |
| `en`   | English  | SCOWL / Hunspell  | MIT AND BSD                       |

Las licencias completas están en `es.LICENSE.txt` y `en.LICENSE.txt`.
