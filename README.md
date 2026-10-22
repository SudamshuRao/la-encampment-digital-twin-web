# LA Encampment Vulnerability Digital Twin (static / Netlify version)

Same digital twin as the Streamlit app, rebuilt to run entirely in the browser:
SNN-2 scoring on every slider move, the greedy optimizer (all three modes), and
population scenarios. No server, no cold start.

## Run locally
    python3 -m http.server 8000      # then open http://localhost:8000

## Deploy (Netlify, from Git)
1. Push this folder to a GitHub repo.
2. Netlify > Add new project > Import an existing project > GitHub > pick the repo.
3. Leave the build command empty; publish directory is "." (set in netlify.toml). Deploy.

## What is here
- `index.html`, `css/style.css`, `js/app.js` : the interface
- `js/snn.js` : JavaScript port of the Python SNN-2 inference, optimizer and scenarios
- `js/charts.js` : small SVG charts
- `data/*.json` : model weights, per-hex features, slider bounds and hex polygons (exported by `scripts/export_static.py` in the main project)
- `vendor/leaflet` : Leaflet 1.9.4 (BSD-2), bundled so the page does not depend on a CDN

## Fidelity
`js/snn.js` was checked against the Python implementation on all three resolutions:
risk scores, per-feature and per-interaction contributions, optimizer steps in all
three modes, and population scenarios agree to about 1e-16. Basemap tiles come from
Esri's public Canvas service (same as the Streamlit app) and need an internet connection.
