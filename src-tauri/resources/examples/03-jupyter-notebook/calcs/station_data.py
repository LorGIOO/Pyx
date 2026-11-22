# Data of the (fictitious) station. A normal .py file, with «# %%» blocks
# as in VS Code or Spyder: Pyx runs again only the block that changes.

# %% Station
station = {
    "name": "Lorem Valley rain gauge",
    "code": "LV-042",
    "altitude": 412,         # m
    "catchment": 18.6,       # km²
}

# %% Time of concentration (made-up formula based on Témez's)
stream_length = 7.9          # km
slope = 0.031                # m/m
t_c = 0.3 * (stream_length / slope ** 0.25) ** 0.76   # hours
