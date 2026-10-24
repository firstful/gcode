# gcode

Interactive 3D gcode previewer for Bambu P1S prints — served at <http://gcode.ffilt.us>.

## What it does

- **3D toolpath viewer** (Three.js): orbit, pan, zoom; extrusion colored by tool/layer/speed/height.
- **Playback**: play/pause/reset, layer slider, speed control; nozzle position marker; cumulative draw.
- **Tool changes**: spheres at every T-change, colored by new tool; legend + marker list.
- **Pauses**: M400 U1 (magnet swaps) marked.
- **Build plate**: sized from gcode `; bed_size`, with grid + axes at origin.
- **Travel moves** toggle, opacity control, show/hide plate/grid/markers.
- **Stats**: segments, travel, layers, tools, tool changes, pauses, extruded mm, bed size.
- **Input**: drag-and-drop or browse `.gcode` / `.3mf` (extracts `plate_1.gcode` via JSZip in-browser). Also `?url=` query param.

## Deploy

k3s manifests live in `reeds/sutliff-cluster` `apps/gcode/`. Image: `192.168.1.2:3000/reeds/gcode:<sha8>`.

## Env

| Var | Default | Meaning |
|---|---|---|
| `HTTP_PORT` | `8080` | listen port |
