# Calculation report (example)

A complete report on a **fictitious footbridge**: every datum is made up. It shows how a large
piece of work is organised in Pyx.

- **Open** `1. Main/_Preamble.pltx` and press **Compile & view**.
- `2. Chapters/` — each chapter is a `.pltx` with its own Python cells. The variables of one
  chapter are used in the following ones.
- `2. Input data` — reads a **CSV** and an **Excel** file with pandas; one table with a `\py{}`
  in each cell and another written whole with `tabletex`.
- `3. Beam design` — **handcalcs** (`%%render`) with the development of the formulas, **pint**
  for units, a matplotlib **plot**, `\pyif` for «PASSES / FAILS» and a table whose rows a loop
  writes.
- `3. Annexes/Annex A. Wind` — no cells: it uses the variables and **functions** of the notebook
  `999. Resources/2. Calculations/wind.ipynb` with `\pynotebook{}`.
- `1. Main/pyxstyle.sty` — the style: cover, colours, `\pass`, `\fail`, `\result{}`.

Try changing `section = "IPE 330"` to `"IPE 300"` in chapter 3, or the imposed load in
`loads.xlsx`, and compile again.
