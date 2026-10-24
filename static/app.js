import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = id => document.getElementById(id);

// ---------- state ----------
let scene, camera, renderer, controls;
let bedMesh = null, grid = null, originMarker = null;
let extrusionMesh = null;   // LineSegments
let travelMesh = null;
let nozzle = null;
let markerGroup = null;

let parsed = null; // {segments, toolChanges, pauses, layers, layerEnd, bedSize, colors, stats}
let currentLayer = 0;
let playing = false;
let lastTs = 0;
let accum = 0;

const DEFAULT_COLORS = ['#C3222A','#040103','#FDFCFB','#2951B6','#3fb950','#d29922','#a371f7','#58a6ff'];

// ---------- init ----------
function init() {
  const canvas = $('canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070a);
  camera = new THREE.PerspectiveCamera(45, canvas.clientWidth/canvas.clientHeight, 0.1, 10000);
  camera.position.set(200, 200, 200);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  const amb = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(amb);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(100,200,100);
  scene.add(dir);
  nozzle = new THREE.Mesh(new THREE.SphereGeometry(1.5,16,16), new THREE.MeshBasicMaterial({color:0xffffff}));
  nozzle.visible = false;
  scene.add(nozzle);
  markerGroup = new THREE.Group();
  scene.add(markerGroup);
  window.addEventListener('resize', onResize);
  onResize();
  animate();
}

function onResize() {
  const c = $('canvas');
  const w = c.clientWidth, h = c.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w/h;
  camera.updateProjectionMatrix();
}

// ---------- parsing ----------
function parseSettings(lines) {
  const bed = { x:256, y:256 };
  let colors = null;
  let layerHeight = 0.2;
  let nozzleDiam = 0.4;
  for (const raw of lines) {
    const m = raw.match(/^;\s*([a-zA-Z_]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'bed_size') {
      const mm = val.match(/([\d.]+)\s*x\s*([\d.]+)/i);
      if (mm) { bed.x = parseFloat(mm[1]); bed.y = parseFloat(mm[2]); }
    } else if (key === 'bed_shape' || key === 'bed_custom' ) {
      // try extract max extents
    } else if (key === 'filament_colour' || key === 'filament_color' || key === 'filament_colors') {
      colors = val.split(/[;,]/).map(s=>s.trim()).filter(Boolean);
    } else if (key === 'layer_height') {
      layerHeight = parseFloat(val) || layerHeight;
    } else if (key === 'nozzle_diameter') {
      nozzleDiam = parseFloat(val) || nozzleDiam;
    }
  }
  return { bed, colors, layerHeight, nozzleDiam };
}

function parseGcode(text) {
  const lines = text.split(/\r?\n/);
  const settings = parseSettings(lines);
  let absXYZ = true, absE = true;
  let x=0,y=0,z=0,e=0;
  let tool = 0;
  let currentLayer = 0;
  let sawMarker = false;
  let lastLayerKey = null;
  const layerZs = [];
  const segments = []; // extrusion segments in exec order
  const travelSegs = [];
  const toolChanges = [];
  const pauses = [];
  let layerMarkerPending = false;

  const layerMarkers = [';LAYER_CHANGE', ';LAYER:', '; layer num/total_layer_count:', ';Z_HEIGHT:', '; Z_HEIGHT:'];
  function isLayerMarker(line) {
    const l = line.toUpperCase();
    if (l.includes('LAYER_CHANGE')) return true;
    if (/;?\s*LAYER:\s*\d/i.test(line)) return true;
    if (/layer num\/total_layer_count:/i.test(line)) return true;
    if (/Z_HEIGHT:/i.test(line)) return true;
    return false;
  }
  function layerKey(line) {
    const m = line.match(/Z_HEIGHT:\s*([\d.]+)/i);
    if (m) return 'z'+m[1];
    const m2 = line.match(/LAYER:\s*(\d+)/i);
    if (m2) return 'l'+m2[1];
    const m3 = line.match(/layer num\/total_layer_count:\s*(\d+)/i);
    if (m3) return 'ln'+m3[1];
    return 'lc';
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // layer marker (comment)
    if (line.startsWith(';') && isLayerMarker(line)) {
      const mz = line.match(/Z_HEIGHT:\\s*([\\d.]+)/i);
      if (mz) {
        const zv = parseFloat(mz[1]);
        if (!layerZs.length || Math.abs(layerZs[layerZs.length-1]-zv) > 1e-6) layerZs.push(zv);
      }
      if (!layerMarkerPending) {
        layerMarkerPending = true;
        if (!sawMarker) { currentLayer = 0; sawMarker = true; }
        else { currentLayer++; }
      }
      continue;
    }
    // settings already parsed; skip other comments
    if (line.startsWith(';')) continue;

    const code = line.split(';')[0].trim();
    if (!code) continue;
    const tokens = code.split(/\s+/);
    const cmd = tokens[0].toUpperCase();

    // tool select
    if (/^T\d+$/.test(cmd)) {
      const nt = parseInt(cmd.slice(1));
      if (nt !== tool) {
        toolChanges.push({ pos:[x,y,z], from:tool, to:nt, layer:currentLayer });
        tool = nt;
      }
      continue;
    }

    const params = {};
    for (let i=1;i<tokens.length;i++){
      const t=tokens[i];
      const L=t[0];
      const num=t.slice(1);
      if ('XYZEFS'.includes(L)) params[L]=parseFloat(num);
      else if (L==='U') params.U=parseFloat(num);
    }

    switch (cmd) {
      case 'G90': absXYZ=true; break;
      case 'G91': absXYZ=false; break;
      case 'M82': absE=true; break;
      case 'M83': absE=false; break;
      case 'G92':
        if (params.X!==undefined) x=params.X;
        if (params.Y!==undefined) y=params.Y;
        if (params.Z!==undefined) z=params.Z;
        if (params.E!==undefined) e=params.E;
        break;
      case 'G0': case 'G1': {
        layerMarkerPending = false;
        const nx = params.X!==undefined ? (absXYZ?params.X:x+params.X) : x;
        const ny = params.Y!==undefined ? (absXYZ?params.Y:y+params.Y) : y;
        const nz = params.Z!==undefined ? (absXYZ?params.Z:z+params.Z) : z;
        const ne = params.E!==undefined ? (absE?params.E:e+params.E) : e;
        const de = ne - e;
        const isExtrude = de > 1e-9;
        const seg = { start:[x,y,z], end:[nx,ny,nz], tool, e0:e, e1:ne, de, speed: params.F||0, extrude: isExtrude, layer: currentLayer };
        if (isExtrude) segments.push(seg);
        else travelSegs.push(seg);
        x=nx;y=ny;z=nz;e=ne;
        break;
      }
      case 'G2': case 'G3': {
        layerMarkerPending = false;
        // approximate arc as a few segments
        const cx = params.I!==undefined ? x + params.I : x;
        const cy = params.J!==undefined ? y + params.J : y;
        const nx = params.X!==undefined ? (absXYZ?params.X:x+params.X) : x;
        const ny = params.Y!==undefined ? (absXYZ?params.Y:y+params.Y) : y;
        const nz = params.Z!==undefined ? (absXYZ?params.Z:z+params.Z) : z;
        const ne = params.E!==undefined ? (absE?params.E:e+params.E) : e;
        const steps = 12;
        let ax=x, ay=y, az=z, ae=e;
        const clockwise = cmd==='G2';
        for (let i=1;i<=steps;i++){
          const t = i/steps;
          // linear interp fallback (simple)
          const ix = x + (nx-x)*t;
          const iy = y + (ny-y)*t;
          const iz = z + (nz-z)*t;
          const ie = e + (ne-e)*t;
          const de = ie-ae;
          const seg = { start:[ax,ay,az], end:[ix,iy,iz], tool, e0:ae, e1:ie, de, speed: params.F||0, extrude: de>1e-9, layer: currentLayer };
          if (de>1e-9) segments.push(seg); else travelSegs.push(seg);
          ax=ix;ay=iy;az=iz;ae=ie;
        }
        x=nx;y=ny;z=nz;e=ne;
        break;
      }
      case 'M400':
        if (params.U === 1 || code.includes('U1')) {
          pauses.push({ pos:[x,y,z], layer: currentLayer });
        }
        break;
      default: break;
    }
  }

  // assign layer indices by Z if markers missing
  if (!sawMarker) {
    // fallback: use layerHeight
    const lh = settings.layerHeight || 0.2;
    for (const s of segments) s.layer = Math.max(0, Math.round(s.end[2]/lh));
    for (const t of toolChanges) t.layer = Math.max(0, Math.round(t.pos[2]/lh));
    for (const p of pauses) p.layer = Math.max(0, Math.round(p.pos[2]/lh));
  } else if (layerZs.length) {
    // remap currentLayer (sequential) already okay; but ensure monotonic by Z for segments? keep as is
  }

  // normalize layers: ensure layer indices contiguous from 0
  const maxL = [0, ...segments.map(s=>s.layer), ...toolChanges.map(t=>t.layer), ...pauses.map(p=>p.layer)].reduce((a,b)=>Math.max(a,b),0);
  // build layer list with Z
  const layers = [];
  for (let L=0; L<=maxL; L++) {
    const segs = segments.filter(s=>s.layer===L);
    const z = segs.length ? segs[segs.length-1].end[2] : (layerZs[L] ?? 0);
    layers.push({ index:L, z });
  }

  // layerEnd cumulative segment counts
  const layerEnd = new Array(layers.length+1).fill(0);
  // map segment index -> layer
  // segments are in exec order; compute cumulative per layer
  let counts = new Array(layers.length).fill(0);
  for (const s of segments) {
    if (s.layer >=0 && s.layer < counts.length) counts[s.layer]++;
  }
  let cum = 0;
  for (let L=0; L<layers.length; L++) { cum += counts[L]; layerEnd[L+1] = cum; }
  // layerEnd[L] = number of segments completed through end of layer L-1? Let's define layerEnd[i] = cumulative segments through layer i (inclusive). Adjust:
  // We'll use: segments up to layer L inclusive count = sum_{0..L} counts. Store in layerCum[L].
  const layerCum = new Array(layers.length).fill(0);
  cum = 0;
  for (let L=0; L<layers.length; L++) { cum += counts[L]; layerCum[L] = cum; }

  // colors
  const colors = (settings.colors && settings.colors.length)
    ? settings.colors : DEFAULT_COLORS;

  // stats
  const totalExtrude = segments.reduce((a,s)=>a+s.de,0);
  const toolsUsed = [...new Set(segments.map(s=>s.tool))];
  const stats = {
    segments: segments.length,
    travel: travelSegs.length,
    layers: layers.length,
    tools: toolsUsed.length,
    toolChanges: toolChanges.length,
    pauses: pauses.length,
    extrudeMm: totalExtrude.toFixed(1),
  };

  return { segments, travelSegs, toolChanges, pauses, layers, layerCum, bed: settings.bed, colors, stats, layerHeight: settings.layerHeight, nozzleDiam: settings.nozzleDiam };
}

// ---------- rendering helpers ----------
function colorForTool(tool) {
  const c = parsed.colors[tool % parsed.colors.length] || DEFAULT_COLORS[tool % DEFAULT_COLORS.length];
  return new THREE.Color(c);
}
function layerColor(layer, total) {
  const t = total>1 ? layer/(total-1) : 0;
  return new THREE.Color().setHSL(0.6 - 0.6*t, 0.7, 0.5);
}
function speedColor(speed, maxSpeed) {
  const t = maxSpeed>0 ? Math.min(1, speed/maxSpeed) : 0;
  return new THREE.Color().setHSL(0.33*(1-t), 0.8, 0.5);
}
function heightColor(z, minZ, maxZ) {
  const t = (maxZ-minZ)>0 ? (z-minZ)/(maxZ-minZ) : 0;
  return new THREE.Color().setHSL(0.7 - 0.7*t, 0.7, 0.5);
}

function buildPlate(bed) {
  // remove old
  if (bedMesh) { scene.remove(bedMesh); bedMesh.geometry.dispose(); bedMesh.material.dispose(); bedMesh=null; }
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); grid=null; }
  // bed plane: gcode X x Y -> three X x Z plane at Y=0
  const geo = new THREE.PlaneGeometry(bed.x, bed.y);
  const mat = new THREE.MeshBasicMaterial({ color:0x1a2230, side:THREE.DoubleSide, transparent:true, opacity:0.6 });
  bedMesh = new THREE.Mesh(geo, mat);
  bedMesh.rotation.x = -Math.PI/2;
  bedMesh.position.set(bed.x/2, 0, bed.y/2);
  scene.add(bedMesh);
  grid = new THREE.GridHelper(Math.max(bed.x,bed.y), Math.round(Math.max(bed.x,bed.y)/10), 0x30363d, 0x21262d);
  grid.position.set(bed.x/2, 0, bed.y/2);
  scene.add(grid);
  // origin marker
  if (originMarker) { scene.remove(originMarker); }
  const og = new THREE.Group();
  const ax = new THREE.AxesHelper(20);
  og.add(ax);
  originMarker = og;
  scene.add(originMarker);
}

function buildExtrusion() {
  if (extrusionMesh) { scene.remove(extrusionMesh); extrusionMesh.geometry.dispose(); extrusionMesh.material.dispose(); extrusionMesh=null; }
  if (travelMesh) { scene.remove(travelMesh); travelMesh.geometry.dispose(); travelMesh.material.dispose(); travelMesh=null; }

  const segs = parsed.segments;
  const positions = new Float32Array(segs.length*2*3);
  const colors = new Float32Array(segs.length*2*3);
  const maxSpeed = Math.max(1, ...segs.map(s=>s.speed));
  const minZ = Math.min(...segs.map(s=>s.start[2]), 0);
  const maxZ = Math.max(...segs.map(s=>s.end[2]), 1);
  const totalLayers = parsed.layers.length;
  for (let i=0;i<segs.length;i++){
    const s = segs[i];
    const a = i*6;
    // start
    positions[a+0]=s.start[0]; positions[a+1]=s.start[2]; positions[a+2]=s.start[1];
    // end
    positions[a+3]=s.end[0]; positions[a+4]=s.end[2]; positions[a+5]=s.end[1];
    let c;
    const mode = $('colorby').value;
    if (mode==='tool') c = colorForTool(s.tool);
    else if (mode==='layer') c = layerColor(s.layer, totalLayers);
    else if (mode==='speed') c = speedColor(s.speed, maxSpeed);
    else c = heightColor((s.start[2]+s.end[2])/2, minZ, maxZ);
    colors[a+0]=c.r; colors[a+1]=c.g; colors[a+2]=c.b;
    colors[a+3]=c.r; colors[a+4]=c.g; colors[a+5]=c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions,3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors,3));
  geo.setDrawRange(0,0);
  const mat = new THREE.LineBasicMaterial({ vertexColors:true, transparent:true, opacity: parseFloat($('opacity').value), linewidth:1 });
  extrusionMesh = new THREE.LineSegments(geo, mat);
  scene.add(extrusionMesh);

  // travel
  if ($('show-travel').checked && parsed.travelSegs.length) {
    const tpos = new Float32Array(parsed.travelSegs.length*2*3);
    for (let i=0;i<parsed.travelSegs.length;i++){
      const s=parsed.travelSegs[i]; const a=i*6;
      tpos[a+0]=s.start[0]; tpos[a+1]=s.start[2]; tpos[a+2]=s.start[1];
      tpos[a+3]=s.end[0]; tpos[a+4]=s.end[2]; tpos[a+5]=s.end[1];
    }
    const tgeo = new THREE.BufferGeometry();
    tgeo.setAttribute('position', new THREE.BufferAttribute(tpos,3));
    const tmat = new THREE.LineBasicMaterial({ color:0x444c56, transparent:true, opacity:0.25, linewidth:1 });
    travelMesh = new THREE.LineSegments(tgeo, tmat);
    scene.add(travelMesh);
  }

  buildMarkers();
  fitCamera();
}

function buildMarkers() {
  // clear
  while (markerGroup.children.length) {
    const o = markerGroup.children.pop();
    o.geometry?.dispose(); o.material?.dispose();
  }
  if (!$('show-markers').checked) return;
  // tool changes
  for (const tc of parsed.toolChanges) {
    const geo = new THREE.SphereGeometry(2,12,12);
    const mat = new THREE.MeshBasicMaterial({ color: colorForTool(tc.to) });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(tc.pos[0], tc.pos[2], tc.pos[1]);
    markerGroup.add(m);
  }
  // pauses
  for (const p of parsed.pauses) {
    const geo = new THREE.SphereGeometry(2.5,12,12);
    const mat = new THREE.MeshBasicMaterial({ color:0xd29922 });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(p.pos[0], p.pos[2], p.pos[1]);
    markerGroup.add(m);
  }
}

function fitCamera() {
  if (!parsed) return;
  const bed = parsed.bed;
  const dist = Math.max(bed.x, bed.y)*1.4;
  camera.position.set(dist*0.7, dist*0.9, dist*0.7);
  controls.target.set(bed.x/2, 0, bed.y/2);
  controls.update();
}

// ---------- animation ----------
function setDrawToSegment(idx) {
  if (!extrusionMesh) return;
  const total = parsed.segments.length;
  idx = Math.max(0, Math.min(total, idx));
  extrusionMesh.geometry.setDrawRange(0, idx*2);
  // nozzle position
  if (idx>0 && idx<=total) {
    const s = parsed.segments[idx-1];
    nozzle.position.set(s.end[0], s.end[2], s.end[1]);
    nozzle.visible = true;
  } else if (idx===0) {
    nozzle.visible = false;
  }
  // trail highlight? handled by draw range already
}

function setLayer(L) {
  if (!parsed) return;
  L = Math.max(0, Math.min(parsed.layers.length-1, L));
  currentLayer = L;
  const cum = parsed.layerCum[L] ?? 0;
  setDrawToSegment(cum);
  $('layer').value = L;
  $('badge-layer').textContent = `layer ${L+1}/${parsed.layers.length}`;
  $('timeline').textContent = `${L+1} / ${parsed.layers.length} layers  ·  ${cum} / ${parsed.segments.length} segs`;
  const pct = parsed.segments.length ? (cum/parsed.segments.length*100) : 0;
  $('progress-bar').style.width = pct + '%';
  // tool at this layer
  const segs = parsed.segments.filter(s=>s.layer===L);
  const tool = segs.length ? segs[segs.length-1].tool : 0;
  $('badge-tool').textContent = `T${tool}`;
}

function tickPlay(dt) {
  if (!playing || !parsed) return;
  const speed = parseFloat($('speed').value); // layers per second
  accum += dt * speed;
  while (accum >= 1) {
    accum -= 1;
    if (currentLayer < parsed.layers.length-1) {
      setLayer(currentLayer+1);
    } else {
      playing = false;
      $('btn-play').textContent = 'Play';
      break;
    }
  }
}

function animate(ts) {
  requestAnimationFrame(animate);
  const dt = lastTs ? (ts-lastTs)/1000 : 0;
  lastTs = ts;
  tickPlay(dt);
  controls.update();
  renderer.render(scene, camera);
}

// ---------- file loading ----------
async function loadFile(file) {
  $('status').textContent = 'Reading...';
  $('status').className = '';
  try {
    let text;
    if (file.name.toLowerCase().endsWith('.3mf')) {
      const zip = await JSZip.loadAsync(file);
      // find plate gcode
      let gcodePath = null;
      for (const p of Object.keys(zip.files)) {
        if (p.endsWith('plate_1.gcode') || p.endsWith('.gcode')) { gcodePath = p; break; }
      }
      if (!gcodePath) throw new Error('No gcode found in 3mf');
      text = await zip.files[gcodePath].async('string');
      $('status').textContent = `Extracted ${gcodePath}`;
    } else {
      text = await file.text();
    }
    parsed = parseGcode(text);
    // ui
    $('btn-play').disabled = false;
    $('btn-reset').disabled = false;
    $('btn-fit').disabled = false;
    $('layer').max = parsed.layers.length-1;
    $('layer').value = 0;
    $('badge-moves').textContent = `${parsed.stats.segments} segs`;
    // legend
    const legend = $('legend');
    legend.innerHTML = '';
    for (let t=0;t<parsed.stats.tools;t++) {
      // find if tool used
    }
    const usedTools = [...new Set(parsed.segments.map(s=>s.tool))];
    for (const t of usedTools) {
      const div = document.createElement('div');
      div.className='legend-item';
      div.innerHTML = `<div class="swatch" style="background:${parsed.colors[t % parsed.colors.length]}"></div><span>T${t} (tool ${t})</span>`;
      legend.appendChild(div);
    }
    // stats
    $('stats').innerHTML = `
      <div class="stat"><span>Segments</span><span>${parsed.stats.segments}</span></div>
      <div class="stat"><span>Travel</span><span>${parsed.stats.travel}</span></div>
      <div class="stat"><span>Layers</span><span>${parsed.stats.layers}</span></div>
      <div class="stat"><span>Tools</span><span>${parsed.stats.tools}</span></div>
      <div class="stat"><span>Tool changes</span><span>${parsed.stats.toolChanges}</span></div>
      <div class="stat"><span>Pauses</span><span>${parsed.stats.pauses}</span></div>
      <div class="stat"><span>Extruded</span><span>${parsed.stats.extrudeMm} mm</span></div>
      <div class="stat"><span>Bed</span><span>${parsed.bed.x}×${parsed.bed.y} mm</span></div>
    `;
    // markers list
    const mk = $('markers');
    mk.innerHTML = '';
    for (const tc of parsed.toolChanges) {
      const d = document.createElement('div');
      d.textContent = `T${tc.from}→T${tc.to} layer ${tc.layer+1} @ (${tc.pos[0].toFixed(1)},${tc.pos[1].toFixed(1)},${tc.pos[2].toFixed(1)})`;
      mk.appendChild(d);
    }
    for (const p of parsed.pauses) {
      const d = document.createElement('div');
      d.textContent = `Pause layer ${p.layer+1} @ z=${p.pos[2].toFixed(2)}`;
      mk.appendChild(d);
    }
    if (!parsed.toolChanges.length && !parsed.pauses.length) mk.textContent = 'none';

    // build scene
    if ($('show-plate').checked) buildPlate(parsed.bed);
    else { if(bedMesh){scene.remove(bedMesh);bedMesh=null;} if(grid){scene.remove(grid);grid=null;} }
    buildExtrusion();
    currentLayer = 0;
    accum = 0;
    setLayer(0);
    $('status').textContent = `Loaded ${file.name} — ${parsed.stats.segments} segments, ${parsed.stats.layers} layers`;
    $('status').className = '';
  } catch (err) {
    console.error(err);
    $('status').textContent = 'Error: ' + err.message;
    $('status').className = 'err';
  }
}

// ---------- wiring ----------
function wire() {
  const drop = $('dropzone');
  const fileInput = $('file');
  drop.addEventListener('click', ()=>fileInput.click());
  fileInput.addEventListener('change', e=>{ if(e.target.files[0]) loadFile(e.target.files[0]); });
  drop.addEventListener('dragover', e=>{ e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', ()=>drop.classList.remove('over'));
  drop.addEventListener('drop', e=>{ e.preventDefault(); drop.classList.remove('over'); if(e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });

  $('btn-play').addEventListener('click', ()=>{
    if (!parsed) return;
    if (playing) { playing=false; $('btn-play').textContent='Play'; }
    else {
      if (currentLayer >= parsed.layers.length-1) setLayer(0);
      playing=true; $('btn-play').textContent='Pause';
    }
  });
  $('btn-reset').addEventListener('click', ()=>{ if(parsed){ playing=false; $('btn-play').textContent='Play'; setLayer(0); accum=0; } });
  $('btn-fit').addEventListener('click', fitCamera);
  $('btn-sample').addEventListener('click', async ()=>{
    $('status').textContent='Loading sample...';
    try {
      const r = await fetch('/sample.gcode');
      if (!r.ok) throw new Error('HTTP '+r.status);
      const b = await r.blob();
      loadFile(new File([b], 'plate_holders_12.gcode'));
    } catch(e){ $('status').textContent='Error: '+e.message; $('status').className='err'; }
  });
  $('layer').addEventListener('input', e=>{ if(parsed){ playing=false; $('btn-play').textContent='Play'; setLayer(parseInt(e.target.value)); } });
  $('colorby').addEventListener('change', ()=>{ if(parsed) buildExtrusion(); });
  $('opacity').addEventListener('input', ()=>{ if(extrusionMesh) extrusionMesh.material.opacity = parseFloat($('opacity').value); });
  $('show-travel').addEventListener('change', ()=>{ if(parsed) buildExtrusion(); });
  $('show-markers').addEventListener('change', ()=>{ if(parsed) buildMarkers(); });
  $('show-plate').addEventListener('change', e=>{
    if (!parsed) return;
    if (e.target.checked) buildPlate(parsed.bed); else { if(bedMesh){scene.remove(bedMesh);bedMesh.geometry.dispose();bedMesh.material.dispose();bedMesh=null;} if(grid){scene.remove(grid);grid.geometry.dispose();grid.material.dispose();grid=null;} }
  });
  $('show-grid').addEventListener('change', e=>{ if(grid) grid.visible = e.target.checked; });
  $('trail').addEventListener('input', ()=>{ /* reserved */ });
  // URL param
  const params = new URLSearchParams(location.search);
  if (params.get('url')) {
    fetch(params.get('url')).then(r=>r.blob()).then(b=>loadFile(new File([b], params.get('url').split('/').pop())));
  }
}

init();
wire();
