# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
npm install                  # Install dev dependencies
npx http-server -p 8080 -c-1 # Serve locally at http://localhost:8080
```

No build step, no bundler, no transpilation — ES6 modules are served directly to the browser. There is no test suite and no linter configured.

Deployment is automatic via GitHub Actions (`.github/workflows/deploy.yml`) on push to `master`, targeting GitHub Pages.

## What This Is

A pure-frontend, browser-based CAM (Computer-Aided Manufacturing) tool. Users upload SVG or DXF design files, configure CNC machining parameters, and export G-Code for CNC controllers (GRBL or Mach3 dialect). All processing is client-side — no backend.

## Architecture

The data flows through four distinct stages:

**1. Parsing** — `js/svg-parser.js` and `js/dxf-parser.js` convert uploaded files into an internal "parts" representation (arrays of path segments with coordinate data). The SVG parser uses Strategy B: directly interpreting `d`-attribute path commands rather than DOM geometry APIs.

**2. CAM generation** — `js/cam/generator.js` is the orchestrator. It iterates parts and delegates to `js/cam/operations.js`, which builds the actual G-Code lines (G0 rapids, G1 cuts, G2/G3 arcs, M-codes). Operations include outside/inside/on-path profiles, drilling, tab support, and depth step-down layering. Tool radius compensation is applied in `operations.js`.

**3. Path optimization** — `js/cam/path-optimizer.js` runs a pipeline before code emission: Douglas-Peucker polyline simplification, arc fitting (converts polyline segments to native G2/G3 arcs using circumcircle detection), and collinear line merging. This reduces jitter and G-Code file size.

**4. Output & preview** — `js/app.js` is the main orchestrator for UI events, file I/O, theme switching, and download. `js/viewer3d.js` renders a live Three.js (r128) 3D toolpath preview with animation scrubbing and orbit controls.

**Module map:**
```
index.html          → shell + UI panels
js/app.js           → event wiring, file I/O, download, theme
js/svg-parser.js    → SVG → parts
js/dxf-parser.js    → DXF → parts
js/cam/
  generator.js      → part iteration, dialect formatting
  operations.js     → G-Code line builders, offset, tabs, layers
  path-optimizer.js → Douglas-Peucker, arc fitting, merge
js/viewer3d.js      → Three.js preview + animation
js/utils.js         → fmt() number formatter (single export)
css/style.css       → CSS variables for dark/light theme, layout grid
```

## Key Conventions

- **No framework.** Vanilla ES6 modules with `import`/`export`. Three.js is loaded from CDN; no npm runtime dependencies.
- **`utils.js` `fmt(n)`** — all numeric output in G-Code must go through this formatter to control decimal precision.
- **Parts representation** — parsers produce arrays of shape objects. Each shape carries path data and is later annotated with user-selected toolpath mode. Operations in `operations.js` consume this representation.
- **Dialect switching** — GRBL vs Mach3 output differences are handled in `generator.js` based on a `dialect` parameter; avoid scattering dialect checks into `operations.js`.
- **CSS theming** — dark/light mode is toggled by swapping a class on `<body>`; all colors are CSS variables in `style.css`, never hardcoded in JS.
