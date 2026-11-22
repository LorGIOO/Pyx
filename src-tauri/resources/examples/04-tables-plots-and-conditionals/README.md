# Tables, plots and conditionals

A single file, `study.pltx`, with Python cells and fictitious energy data.

- **Table 1, cell by cell**: the table is written in LaTeX and the document asks a normal pandas
  DataFrame for each number: `\py{df.at["Jan", "total"]}`, `\py{df.loc["Jan":"Mar", "net"].sum()}`.
  Python has nothing prepared for LaTeX: only the data.
- **Table 2, in one line**: `\py{tabletex(df, caption=…, label=…)}`.
- **Table 3, with a loop**: a cell builds the rows and `\py{month_table}` places them.
- **Plots**: in the same cell that draws, `figure = figtex(…)` saves the image and returns the whole
  LaTeX figure (the document places it with `\py{figure}`); `path = figure(…)` saves only the image
  for `\includegraphics{\py{path}}`.
- **Conditionals**: `\pyif{coverage >= target}{is met}{is not met}`; a condition inside another
  sentence, with colours, and even the plural: «1 month» or «4 months».

Change a datum of the DataFrame and compile again: tables, plots and sentences change by themselves.
