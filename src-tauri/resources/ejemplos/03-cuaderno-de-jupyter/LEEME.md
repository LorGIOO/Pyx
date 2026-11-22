# Informe que solo llama a un cuaderno de Jupyter

El documento `informe.pltx` **no tiene ninguna celda de Python**. Todo el cálculo está en:

- `calculos/lluvias.ipynb` — un cuaderno de Jupyter normal (pandas, numpy, matplotlib): lee
  `datos/maximos_anuales.csv`, ajusta una ley de Gumbel, define funciones y guarda una gráfica.
- `calculos/datos_estacion.py` — un archivo `.py` con bloques `# %%`.

El documento los vincula con `\pynotebook{…}` y `\pyfile{…}` y luego:

- escribe sus variables: `\py{media}`, `\py{estacion["nombre"]}`;
- **llama a sus funciones** con los argumentos que quiere: `\py{intensidad(100, t_c * 60)}`;
- construye una tabla entera con una función del cuaderno: `\py{filas_periodos([2, 5, 10])}`;
- consulta una tabla de pandas celda a celda: `\py{cuantiles.loc[100, 'P']}`;
- elige un texto u otro con `\pyif{tendencia > 0.2}{…}{…}`.

Si el cuaderno está abierto y ejecutado en Jupyter o VS Code, Pyx copia sus valores de allí
en décimas de segundo, sin ejecutar nada. Si no, lo ejecuta una vez y guarda los valores.
