# HYDROTHERM Postprocessor

Interactive browser-based visualization tool for **HYDROTHERM hydrothermal simulation outputs**.

🌐 **Live application**  
https://tectonic-hydrology.github.io/HYDROTHERM/

This tool allows users to explore **Plot_scalar and Plot_vector outputs directly in a web browser**, without requiring MATLAB, Python, or specialized visualization software.

---

# Features

## Scalar Field Visualization

Supports HYDROTHERM **Plot_scalar** files.

Available scalar fields:

- Temperature
- Pressure
- Saturation
- Phase index

Interactive features:

- dynamic colorbar scaling
- adjustable colormap
- zoom and pan
- time slider navigation
- automatic grid reconstruction

---

# Vector Field Visualization

Supports HYDROTHERM **Plot_vector** files.

Vector arrows can display:

- **Water mass flux**
- **Steam mass flux**
- **Total mass flux (water + steam)**

Arrows are plotted as vector overlays on scalar fields.

Vector display controls include:

- adjustable arrow scaling
- arrow color selection
- optional vector file loading
- independent scalar/vector visualization

---

# Derived Fields

The application can compute additional fields from vector data.

Derived quantities include:

### Water Mass Flux Magnitude

Magnitude of the water phase mass-flux vector.

### Steam Mass Flux Magnitude

Magnitude of the steam phase mass-flux vector.

### Total Mass Flux Magnitude

\[
|F_{total}| = |F_{water}| + |F_{steam}|
\]

This approximates the total fluid transport magnitude.

---

# Advective Heat Transport Proxy

The viewer can compute a **heat transport proxy** based on phase fluxes and temperature.

\[
Q = (\dot{m}_w c_{p,w} + \dot{m}_s c_{p,s}) T
\]

where

- $\dot{m}_w$ = water mass flux  
- $\dot{m}_s$ = steam mass flux  
- $c_{p,w}$ = water heat capacity  
- $c_{p,s}$ = steam heat capacity  
- $T$ = temperature  

Heat capacities are automatically obtained from **built-in lookup tables for pure water and steam** based on temperature from the scalar file.

This provides a rapid visualization of **regions of strong advective heat transport** in geothermal systems.

---

# Time Series Extraction

Users can extract time series at specific spatial locations.

Features include:

- up to **4 spatial points simultaneously**
- plots variable evolution through time
- works with scalar or derived vector fields

Points can be selected by:

- entering coordinates manually
- **clicking directly on the main plot**

---

# Data Export

Time series can be exported as **CSV files** for further analysis.

Exported files include:

- time
- variable values
- coordinates of sampled points

---

# Animation Export

The application can export **GIF animations** of time evolution.

Options include:

- frame downsampling
- resolution selection
- animated scalar field evolution

This allows rapid creation of figures for presentations or papers.

---

# Data Format

The viewer expects HYDROTHERM output formats.

## Scalar File Format (Plot_scalar)

Columns:
x,y,z km
time yr
temperature °C
pressure bar
saturation fraction
phase integer


---

# How to Use

1. Open the application  
2. Load a **Plot_scalar file**
3. Click **Load & Plot**
4. Use the **time slider** to explore simulation evolution
5. Optionally load a **Plot_vector file** to display flux arrows
6. Choose scalar or derived fields from the dropdown
7. Click the plot to select points for time-series analysis
8. Export time series or GIF animations as needed

---

# Technical Details

Frontend stack:

- HTML5
- CSS3
- JavaScript (ES6)
- Plotly.js
- Bootstrap 5
- jQuery UI sliders

Processing is performed **entirely in the browser**, so no server is required.

---

# Performance

The viewer is optimized for large HYDROTHERM outputs.

Typical capabilities:

- 400k+ line files
- fast time slicing
- efficient memory usage
- responsive interactive plotting

---

# Browser Compatibility

Supported browsers:

- Chrome 80+
- Firefox 75+
- Safari 13+
- Edge 80+

Modern WebGL-capable browsers are recommended.

---

# Branch Information

The enhanced visualization features are implemented in the branch:HYRROTHERM_MW


Major additions in this branch include:

- vector visualization
- derived fields
- heat transport proxy
- Cp lookup tables
- time-series extraction
- CSV export
- GIF animation export
- interactive point selection

---

# License

This tool is provided for **research and educational use**.

Developed for visualization of HYDROTHERM geothermal simulation outputs.
