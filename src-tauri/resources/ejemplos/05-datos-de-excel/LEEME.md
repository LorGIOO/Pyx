# Datos de Excel y CSV, sin Python

Un presupuesto de obra ficticio cuyos datos están en `datos/obra.xlsx` (hojas «Resumen» y
«Mediciones») y en `datos/ensayos.csv`. El documento no tiene ninguna celda de Python.

- `\hoja[Mediciones]{datos/obra.xlsx}` vincula el libro y la hoja desde ese punto.
- `\celda{B3}` coloca una celda; `\celda{A2:E7}` un rango (fila, columna o tabla, listo para un
  `tabular`); `\celda[T]{B2:B6}` lo transpone: la columna sale como fila.
- `capitulos/ensayos.pltx` vincula un CSV con `;` y coma decimal, como lo guarda Excel en español.

Abre `informe.pltx` y pulsa **Compilar y ver**. Cambia un número en Excel, guarda (Ctrl+S) y vuelve
a compilar: el documento cambia solo.
