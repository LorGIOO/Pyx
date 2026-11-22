# Handcalcs and units

A single file showing the most striking side of Pyx for a technical calculation:

- **handcalcs**: `%%render` cells put in the PDF the development of each formula with the values
  substituted and the result; `%%render params` writes only the data, in columns. `handcalcs.render`
  must be imported in an earlier cell.
- **pint**: every quantity with its units (`850 * u.kN`); conversions with `.to(u.kPa)`;
  `\py{sigma_max}` writes the number with its unit.
- `\pyif` compares quantities in different units without errors.
- A plot (buckling curve) with the column's point.

Open `calculation-with-units.pltx` and press **Compile & view**. It needs `handcalcs` and `pint`
(the Python Pyx sets up already brings them).
