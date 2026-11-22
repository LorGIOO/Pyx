# A report that only calls a Jupyter notebook

The document `report.pltx` **has no Python cell at all**. All the calculation is in:

- `calcs/rainfall.ipynb` — a normal Jupyter notebook (pandas, numpy, matplotlib): it reads
  `data/annual_maxima.csv`, fits a Gumbel law, defines functions and saves a plot.
- `calcs/station_data.py` — a `.py` file with `# %%` blocks.

The document links them with `\pynotebook{…}` and `\pyfile{…}` and then:

- writes their variables: `\py{mean}`, `\py{station["name"]}`;
- **calls their functions** with the arguments it wants: `\py{intensity(100, t_c * 60)}`;
- builds a whole table with a function of the notebook: `\py{period_rows([2, 5, 10])}`;
- queries a pandas table cell by cell: `\py{quantiles.loc[100, 'P']}`;
- chooses one text or another with `\pyif{trend > 0.2}{…}{…}`.

If the notebook is open and run in Jupyter or VS Code, Pyx copies its values from there in tenths
of a second, without running anything. If not, it runs it once and saves the values.
