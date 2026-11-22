# Tablas, gráficas y condicionales

Un solo archivo, `estudio.pltx`, con celdas de Python y datos ficticios de consumo energético.

- **Tabla 1, celda a celda**: la tabla se escribe en LaTeX y cada número lo pide el documento a un
  DataFrame de pandas normal: `\py{df.at["Ene", "total"]}`, `\py{df.loc["Ene":"Mar", "neto"].sum()}`.
  En Python no hay nada preparado para LaTeX: solo los datos.
- **Tabla 2, en una línea**: `\py{tabletex(df, caption=…, label=…)}`.
- **Tabla 3, con un bucle**: una celda construye las filas y `\py{tabla_meses}` las coloca.
- **Gráficas**: en la misma celda que dibuja, `figura = figtex(…)` guarda la imagen y devuelve la
  figura entera de LaTeX (el documento la coloca con `\py{figura}`); `ruta = figure(…)` guarda solo
  la imagen para `\includegraphics{\py{ruta}}`.
- **Condicionales**: `\pyif{cobertura >= objetivo}{se alcanza}{no se alcanza}`; una condición
  dentro de otra frase, con colores.

Cambia un dato del DataFrame y vuelve a compilar: tablas, gráficas y frases cambian solas.
