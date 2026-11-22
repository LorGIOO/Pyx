# Handcalcs y unidades

Un solo archivo que enseña lo más vistoso de Pyx para un cálculo técnico:

- **handcalcs**: las celdas `%%render` ponen en el PDF el desarrollo de cada fórmula con los
  valores sustituidos y el resultado; `%%render params` escribe solo los datos, en columnas.
  Hay que importar `handcalcs.render` en una celda anterior.
- **pint**: cada magnitud con sus unidades (`850 * u.kN`); las conversiones con `.to(u.kPa)`;
  `\py{sigma_max}` escribe el número con su unidad.
- `\pyif` compara magnitudes con unidades distintas sin errores.
- Una gráfica (curva de pandeo) con el punto del pilar.

Abre `calculo-con-unidades.pltx` y pulsa **Compilar y ver**. Necesita `handcalcs` y `pint`
(el Python que prepara Pyx ya los trae).
