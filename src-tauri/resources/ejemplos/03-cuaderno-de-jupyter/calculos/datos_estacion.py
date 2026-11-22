# Datos de la estación (ficticia). Un archivo .py normal, con bloques «# %%»
# como en VS Code o Spyder: Pyx solo vuelve a ejecutar el bloque que cambia.

# %% Estación
estacion = {
    "nombre": "Estación pluviométrica de Valle Lorem",
    "codigo": "VL-042",
    "altitud": 412,          # m
    "cuenca": 18.6,          # km²
}

# %% Tiempo de concentración (fórmula inventada a partir de la de Témez)
longitud_cauce = 7.9         # km
pendiente = 0.031            # m/m
t_c = 0.3 * (longitud_cauce / pendiente ** 0.25) ** 0.76   # horas
