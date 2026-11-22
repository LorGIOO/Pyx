# Memoria de cálculo (ejemplo)

Una memoria completa de una **pasarela peatonal ficticia**: todos los datos son inventados.
Enseña cómo se organiza un trabajo grande en Pyx.

- **Abre** `1. Main/_Preámbulo.pltx` y pulsa **Compilar y ver**.
- `2. Capítulos/` — cada capítulo es un `.pltx` con sus propias celdas de Python.
  Las variables de un capítulo se usan en los siguientes.
- `2. Datos de partida` — lee un **CSV** y un **Excel** con pandas; una tabla con un
  `\py{}` en cada celda y otra entera con `tabletex`.
- `3. Cálculo de la viga` — **handcalcs** (`%%render`) con el desarrollo de las fórmulas,
  **pint** para las unidades, una **gráfica** de matplotlib, `\pyif` para «CUMPLE / NO
  CUMPLE» y una tabla cuyas filas escribe un bucle.
- `3. Anejos/Anejo A. Viento` — sin celdas: usa las variables y **funciones** del cuaderno
  `999. Recursos/2. Cálculos/viento.ipynb` con `\pynotebook{}`.
- `1. Main/memoria.sty` — el estilo: portada, colores, `\cumple`, `\nocumple`, `\resultado{}`.

Prueba a cambiar `perfil = "IPE 330"` por `"IPE 300"` en el capítulo 3, o la sobrecarga en
`cargas.xlsx`, y vuelve a compilar.
