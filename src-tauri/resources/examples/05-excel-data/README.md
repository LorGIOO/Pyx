# Excel and CSV data, without Python

A fictitious construction budget whose data is in `data/works.xlsx` (sheets «Summary» and
«Quantities») and in `data/tests.csv`. The document has no Python cell.

- `\hoja[Quantities]{data/works.xlsx}` links the workbook and the sheet from that point on.
- `\celda{B3}` places one cell; `\celda{A2:E7}` a range (row, column or table, ready for a
  `tabular`); `\celda[T]{B2:B6}` transposes it: the column comes out as a row.
- `chapters/tests.pltx` links a CSV with `;` and the decimal comma, as Excel saves it in many
  European languages.

Open `report.pltx` and press **Compile & view**. Change a number in Excel, save (Ctrl+S) and compile
again: the document changes by itself.
