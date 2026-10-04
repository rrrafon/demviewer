import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { OBJLoader } from 'three/addons/OBJLoader.js';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';

const el = (id) => document.getElementById(id);
const infoEl = el('info');
const loadEl = el('loading');
const loadLabel = el('loadLabel');
const loadBar = el('loadBar');

function showError(msg) {
  el('errMsg').textContent = msg;
  el('errbox').style.display = 'block';
  loadEl.style.display = 'none';
  console.error(msg);
}

const SETTINGS_KEY = 'demviewer-settings';
const loadSettings = () => {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
  catch { return {}; }
};
const saveSettings = (s) => {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* private mode */ }
};

async function main() {
  const params = new URLSearchParams(location.search);
  const manifestPath = './data/' + (params.get('m') || 'manifest.json');
  const res = await fetch(manifestPath);
  const manifest = await res.json();

  if (manifest.earth_model !== 'flat') {
    showError(`earth_model=${manifest.earth_model}: viewer supports flat only.`);
    return;
  }
  if (manifest.z_exaggeration !== 1.0) {
    showError(`z_exaggeration=${manifest.z_exaggeration}: export at 1.0 for the web viewer.`);
    return;
  }

  // Render-verified per dataset: manifest.texture_flip_y selects the
  // upload flip (false for all datasets so far; true mirrors N/S).
  const flipY = manifest.texture_flip_y === true;

  const container = document.getElementById('app');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Part 2: shadow-mapped sun. PCFSoft + per-mesh cast/receive flags below.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e13);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 1e7);
  camera.up.set(0, 0, 1); // Z-up: mesh Z is absolute elevation

  // Untextured + textured materials. Each tile gets its own textured
  // material (map differs per tile); the mode switch swaps mesh.material.
  const untexturedMat = new THREE.MeshLambertMaterial({ color: 0x9aa37a });
  const texLoader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // Hillshade = white Lambert + single directional sun, no ambient.
  // Normal-view lights (sun + hemisphere) and hillshade sun are mutually
  // exclusive so hillshade stays pure N·L.
  const hillshadeMat = new THREE.MeshLambertMaterial({ color: 0xffffff });

  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(-0.5, -1.0, 1.2);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x3a352c, 0.7);
  scene.add(hemi);

  // Hillshade sun: positioned from geographic azimuth (deg clockwise from
  // north) / altitude (deg above horizon). Scene axes: X=east, Y=north, Z=up.
  // Shadow camera is fitted to the dataset in fitShadows() once extent is
  // known; normalBias is in world units (tune if acne stripes appear).
  const hillSun = new THREE.DirectionalLight(0xffffff, 1.6);
  hillSun.visible = false;
  hillSun.castShadow = true;
  hillSun.shadow.bias = -0.0002;
  hillSun.shadow.normalBias = 10;
  scene.add(hillSun);
  scene.add(hillSun.target);
  const placeHillSun = (azDeg, altDeg) => {
    const az = THREE.MathUtils.degToRad(azDeg);
    const alt = THREE.MathUtils.degToRad(altDeg);
    const r = extentHillSunDist();
    hillSun.position.set(
      Math.cos(alt) * Math.sin(az) * r,
      Math.cos(alt) * Math.cos(az) * r,
      Math.sin(alt) * r,
    );
  };
  // Sun distance scales with scene size; defined after extent is known.
  let extentHillSunDist = () => 10000;

  // Exaggeration scales a parent group about Z=0 (sea level stays fixed
  // because Z is absolute elevation and the group is XY-centred only).
  // Independent per-layer factors were tried and reverted: with different
  // factors building bases detach from the slopes, since no single
  // transform can follow varying base elevations.
  const scaleGroup = new THREE.Group();
  scene.add(scaleGroup);
  const terrainGroup = new THREE.Group();
  scaleGroup.add(terrainGroup);
  // Buildings live under the same scaled parent so bases stay registered
  // with the terrain at any exaggeration.
  const buildingsGroup = new THREE.Group();
  scaleGroup.add(buildingsGroup);
  const buildingsMat = new THREE.MeshLambertMaterial({
    color: 0xd8d3c8, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });

  const objLoader = new OBJLoader();
  const gltfLoader = new GLTFLoader();
  // .glb (binary glTF) or .obj by file extension. A GLB tile may carry
  // its texture embedded; its map is reused with the same flipY as the
  // PNG path (same bytes + same UVs + same flip).
  const loadModel = (path) => path.endsWith('.glb')
    ? gltfLoader.loadAsync(path).then((g) => g.scene)
    : objLoader.loadAsync(path);
  // Map embedded in a GLB tile (used as the textured variant). Returns
  // null when no mesh carries a map (then the tile falls back to flat).
  const embeddedMap = (obj) => {
    let found = null;
    obj.traverse((child) => {
      if (found || !child.isMesh) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      const withMap = mats.find((m) => m && m.map);
      if (withMap) {
        withMap.map.flipY = flipY;
        withMap.map.needsUpdate = true;
        found = new THREE.MeshLambertMaterial({ map: withMap.map, alphaTest: 0.5 });
      }
    });
    return found;
  };

  const unionBox = new THREE.Box3();
  // Progress across every fetched file (geometry + textures + buildings).
  const expectedFiles = manifest.tiles.reduce((n, t) => n + 1 + (t.texture ? 1 : 0), 0)
    + (manifest.buildings ? 1 : 0) + (manifest.elevation_grid ? 1 : 0);
  let loadedFiles = 0;
  const tick = (label) => {
    loadedFiles++;
    loadLabel.textContent = `${label} (${loadedFiles}/${expectedFiles})`;
    loadBar.style.width = `${Math.round(100 * loadedFiles / Math.max(expectedFiles, 1))}%`;
  };

  await Promise.all(manifest.tiles.map(async (t) => {
    const [obj, tex] = await Promise.all([
      loadModel('./data/' + t.file).then((o) => { tick(`terrain ${t.file}`); return o; }),
      t.texture
        ? texLoader.loadAsync('./data/' + t.texture).then((x) => { tick(`texture`); return x; })
        : Promise.resolve(null),
    ]);
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = flipY;
      tex.anisotropy = maxAniso;
    }
    const texturedMat = tex
      ? new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5 })
      : embeddedMap(obj);
    obj.traverse((child) => {
      if (child.isMesh) {
        const g = child.geometry;
        if (!g.getAttribute('normal')) g.computeVertexNormals();
        const mesh = new THREE.Mesh(g, untexturedMat);
        mesh.userData.texturedMat = texturedMat;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        terrainGroup.add(mesh);
        g.computeBoundingBox();
        unionBox.union(g.boundingBox);
      }
    });
  }));

  // Optional buildings layer (second group, same frame).
  let buildingCount = 0;
  if (manifest.buildings) {
    const bObj = await loadModel('./data/' + manifest.buildings);
    tick('buildings');
    bObj.traverse((child) => {
      if (child.isMesh) {
        const g = child.geometry;
        if (!g.getAttribute('normal')) g.computeVertexNormals(); // keep file normals (crisp faces)
        const mesh = new THREE.Mesh(g, buildingsMat);
        mesh.userData.isBuilding = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        buildingsGroup.add(mesh);
        buildingCount++;
        g.computeBoundingBox();
      }
    });
  }

  // Centre XY only — never Z (Z stays absolute so scale.z pivots at sea
  // level). Offset lives on the shared parent so EVERY layer (terrain +
  // buildings) recentres identically; per-layer offsets desync layers.
  const cx = (unionBox.min.x + unionBox.max.x) / 2;
  const cy = (unionBox.min.y + unionBox.max.y) / 2;
  scaleGroup.position.set(-cx, -cy, 0);

  const size = new THREE.Vector3();
  unionBox.getSize(size);
  const extent = Math.max(size.x, size.y);
  const zRange = [unionBox.min.z, unionBox.max.z];

  // Frame camera; near/far derived from extent
  const dist = extent * 1.1;
  camera.position.set(cx + dist * 0.7, cy - dist * 0.9, zRange[1] + dist * 0.55);
  camera.near = Math.max(1, extent / 10000);
  camera.far = extent * 20 + Math.abs(zRange[1]) + Math.abs(zRange[0]) + dist * 4;
  camera.updateProjectionMatrix();

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, (zRange[0] + zRange[1]) / 2);
  controls.update();
  hillSun.target.position.set(0, 0, (zRange[0] + zRange[1]) / 2);

  loadEl.style.display = 'none';
  el('dsTitle').textContent = manifest.name;
  infoEl.innerHTML =
    `${manifest.tiles.length} tiles · extent ${Math.round(size.x)} × ${Math.round(size.y)} m<br>` +
    `elevation ${zRange[0].toFixed(1)} … ${zRange[1].toFixed(1)} m<br>` +
    `CRS ${manifest.crs} · flat · exaggeration 1.0 <span style="color:#888">(v18)</span><br>` +
    `${manifest.attribution}`;

  const settings = loadSettings();
  const persist = () => saveSettings({
    mode, exagg: exagg.value, az: sunAz.value, alt: sunAlt.value,
    bld: chkBld ? chkBld.checked : true,
    shadow: chkShadow.checked,
  });

  // Dataset switcher (URL ?m= stays the source of truth). Populated from
  // data/datasets.json, which export_web maintains on every export.
  const currentM = params.get('m') || 'manifest.json';
  let datasetList = [{ label: manifest.name, file: currentM }];
  try {
    const reg = await (await fetch('./data/datasets.json')).json();
    if (Array.isArray(reg) && reg.length) datasetList = reg;
  } catch { /* single dataset */ }
  const dsBtns = el('dsBtns');
  datasetList.forEach((d) => {
    const b = document.createElement('button');
    b.textContent = d.label;
    b.className = 'dsbtn' + (d.file === currentM ? ' active' : '');
    b.onclick = () => { location.search = '?m=' + d.file; };
    dsBtns.appendChild(b);
  });

  // Collapsible panel; start collapsed on small screens.
  const panel = el('panel');
  const collapseBtn = el('collapseBtn');
  const setCollapsed = (c) => {
    panel.classList.toggle('collapsed', c);
    collapseBtn.textContent = c ? '+' : '–';
  };
  el('panelHead').onclick = (e) => {
    if (e.target === collapseBtn) return;
    setCollapsed(!panel.classList.contains('collapsed'));
  };
  collapseBtn.onclick = () => setCollapsed(!panel.classList.contains('collapsed'));
  if (window.innerWidth <= 700) setCollapsed(true);

  extentHillSunDist = () => extent * 3;
  // Fit the shadow camera to the dataset once; far plane covers 5x relief.
  const fitShadows = () => {
    const r = extent * 3;
    const c = hillSun.shadow.camera;
    const d = extent * 0.75;
    c.left = -d; c.right = d; c.top = d; c.bottom = -d;
    c.near = Math.max(1, r - extent * 1.5);
    c.far = r + extent * 1.5 + Math.abs(zRange[1]) * 5;
    const smallScreen = window.innerWidth <= 700;
    hillSun.shadow.mapSize.set(smallScreen ? 1024 : 2048, smallScreen ? 1024 : 2048);
    if (hillSun.shadow.map) { hillSun.shadow.map.dispose(); hillSun.shadow.map = null; }
    c.updateProjectionMatrix();
  };
  fitShadows();
  const sunAz = el('sunAz');
  const sunAlt = el('sunAlt');
  const sunAzVal = el('sunAzVal');
  const sunAltVal = el('sunAltVal');
  const updateHillSun = () => {
    sunAzVal.textContent = `${sunAz.value}°`;
    sunAltVal.textContent = `${sunAlt.value}°`;
    placeHillSun(Number(sunAz.value), Number(sunAlt.value));
    persist();
  };
  sunAz.oninput = updateHillSun;
  sunAlt.oninput = updateHillSun;

  let mode = 'textured';
  const setMode = (next) => {
    mode = next;
    const hill = mode === 'hillshade';
    sun.visible = !hill;
    hemi.visible = !hill;
    hillSun.visible = hill;
    el('sunSection').style.display = hill ? '' : 'none';
    terrainGroup.traverse((child) => {
      if (child.isMesh) {
        child.material = hill
          ? hillshadeMat
          : (mode === 'textured' && child.userData.texturedMat)
            ? child.userData.texturedMat
            : untexturedMat;
      }
    });
    buildingsGroup.traverse((child) => {
      if (child.isMesh) child.material = hill ? hillshadeMat : buildingsMat;
    });
    document.querySelectorAll('#modeSeg button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    persist();
  };
  document.querySelectorAll('#modeSeg button').forEach((b) => {
    b.onclick = () => setMode(b.dataset.mode);
  });

  const exagg = el('exagg');
  const exaggVal = el('exaggVal');
  const zMid = (zRange[0] + zRange[1]) / 2;
  exagg.oninput = () => {
    const k = Number(exagg.value);
    exaggVal.textContent = `${k.toFixed(1)}×`;
    scaleGroup.scale.z = k;
    controls.target.z = zMid * k;
    camera.far = extent * 20 + Math.abs(zRange[1] * k) + Math.abs(zRange[0] * k) + dist * 4;
    camera.updateProjectionMatrix();
    persist();
  };

  const chkBld = manifest.buildings ? el('chkBld') : null;
  if (manifest.buildings) {
    el('layerSection').style.display = '';
    chkBld.onchange = () => {
      buildingsGroup.visible = chkBld.checked;
      persist();
    };
  }

  // Click-to-read elevation (+ lat/lon). Heights come from the source-DEM
  // grid, NOT the decimated mesh (plan §7: never measure the mesh).
  // UTM inverse (Snyder series, mm-accurate) avoids a proj library.
  const utmZone = (() => {
    const m = /EPSG:32([67])(\d\d)/.exec(manifest.crs || '');
    return m ? { south: m[1] === '7', zone: Number(m[2]) } : null;
  })();
  const utmToLonLat = (x, y) => {
    if (!utmZone) return null;
    const a = 6378137.0, f = 1 / 298.257223563;
    const k0 = 0.9996, e2 = 2 * f - f * f, ep2 = e2 / (1 - e2);
    const lon0 = ((utmZone.zone - 1) * 6 - 180 + 3) * Math.PI / 180;
    const X = x - 500000.0;
    let Y = y;
    if (utmZone.south) Y -= 10000000.0;
    const M = Y / k0;
    const mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256));
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    const J1 = 3 * e1 / 2 - 27 * e1 * e1 * e1 / 32;
    const J2 = 21 * e1 * e1 / 16 - 55 * e1 * e1 * e1 * e1 / 16;
    const J3 = 151 * e1 * e1 * e1 / 96;
    const fp = mu + J1 * Math.sin(2 * mu) + J2 * Math.sin(4 * mu) + J3 * Math.sin(6 * mu);
    const C1 = ep2 * Math.cos(fp) * Math.cos(fp);
    const T1 = Math.tan(fp) * Math.tan(fp);
    const N1 = a / Math.sqrt(1 - e2 * Math.sin(fp) * Math.sin(fp));
    const R1 = a * (1 - e2) / Math.pow(1 - e2 * Math.sin(fp) * Math.sin(fp), 1.5);
    const D = X / (N1 * k0);
    const lat = fp - N1 * Math.tan(fp) / R1 * (D * D / 2
      - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1) * D * D * D * D / 24
      + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D * D * D * D * D * D / 720);
    const lon = lon0 + (D - (1 + 2 * T1 + C1) * D * D * D / 6
      + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D * D * D * D * D / 120) / Math.cos(fp);
    return [lon * 180 / Math.PI, lat * 180 / Math.PI];
  };
  let elevGrid = null;
  if (manifest.elevation_grid) {
    try {
      const eg = await (await fetch('./data/' + manifest.elevation_grid)).json();
      const n = eg.n;
      const raw = Uint8Array.from(atob(eg.data), (c) => c.charCodeAt(0));
      elevGrid = { n, bounds: eg.bounds, z: new Float32Array(raw.buffer) };
      tick('elevation grid');
    } catch (e) { console.warn('elevation grid skipped:', e); }
  }
  const sampleElev = (wx, wy) => { // world coords (absolute, pre-centre)
    if (!elevGrid) return null;
    const [x0, y0, x1, y1] = elevGrid.bounds;
    const n = elevGrid.n;
    const gx = (wx - x0) / (x1 - x0) * (n - 1);
    const gy = (wy - y0) / (y1 - y0) * (n - 1);
    if (gx < 0 || gy < 0 || gx > n - 1 || gy > n - 1) return null;
    const x = Math.min(Math.floor(gx), n - 2), y = Math.min(Math.floor(gy), n - 2);
    const fx = gx - x, fy = gy - y;
    const at = (ix, iy) => elevGrid.z[iy * n + ix];
    return at(x, y) * (1 - fx) * (1 - fy) + at(x + 1, y) * fx * (1 - fy)
      + at(x, y + 1) * (1 - fx) * fy + at(x + 1, y + 1) * fx * fy;
  };
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(20, extent / 500), 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xff3333, depthTest: false, transparent: true, opacity: 0.9 }));
  marker.visible = false;
  marker.renderOrder = 999;
  scene.add(marker);
  const elevLine = document.createElement('div');
  infoEl.appendChild(elevLine);
  const raycaster = new THREE.Raycaster();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
    downAt = null;
    if (moved > 5) return; // was a drag, not a click
    const rect = renderer.domElement.getBoundingClientRect();
    const ptr = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ptr, camera);
    const hits = raycaster.intersectObjects([terrainGroup, buildingsGroup], true);
    if (!hits.length) return;
    const p = hits[0].point;
    // Back to absolute frame: undo centre offset and exaggeration, then
    // re-apply the manifest origin (mesh coords are origin-relative).
    const k = scaleGroup.scale.z;
    const ox = (manifest.origin && manifest.origin[0]) || 0;
    const oy = (manifest.origin && manifest.origin[1]) || 0;
    const wx = p.x - scaleGroup.position.x + ox;
    const wy = p.y - scaleGroup.position.y + oy;
    const h = sampleElev(wx, wy);
    const ll = utmToLonLat(wx, wy);
    marker.position.copy(p);
    marker.visible = true;
    elevLine.innerHTML = (h === null || h === undefined || Number.isNaN(h) ? 'no elevation data' : `${h.toFixed(1)} m`)
      + (ll ? ` · ${ll[1].toFixed(5)}°, ${ll[0].toFixed(5)}°` : '');
  });

  // Shadows default on for desktop, off on small screens; remembered after.
  const chkShadow = el('chkShadow');
  chkShadow.checked = settings.shadow !== undefined
    ? settings.shadow : window.innerWidth > 700;
  const applyShadow = () => {
    hillSun.castShadow = chkShadow.checked;
    persist();
  };
  chkShadow.onchange = applyShadow;
  applyShadow();

  // Apply remembered settings, then reveal.
  if (settings.az) sunAz.value = settings.az;
  if (settings.alt) sunAlt.value = settings.alt;
  updateHillSun();
  if (settings.exagg) {
    exagg.value = Math.min(5, Math.max(1, Number(settings.exagg)));
    exagg.dispatchEvent(new Event('input'));
  }
  if (chkBld && settings.bld === false) {
    chkBld.checked = false;
    chkBld.dispatchEvent(new Event('change'));
  }
  setMode(['untextured', 'textured', 'hillshade'].includes(settings.mode) ? settings.mode : 'textured');

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Perf guard: if frames stay slow with shadows on, drop the shadow map
  // to 1024 once and say so (phones on big scenes).
  let frameEMA = 16, frames = 0, shadowDowngraded = false, lastT = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    frameEMA = frameEMA * 0.95 + (now - lastT) * 0.05;
    lastT = now;
    if (!shadowDowngraded && ++frames > 180 && frameEMA > 50
        && hillSun.castShadow && hillSun.shadow.mapSize.x > 1024) {
      shadowDowngraded = true;
      hillSun.shadow.mapSize.set(1024, 1024);
      if (hillSun.shadow.map) { hillSun.shadow.map.dispose(); hillSun.shadow.map = null; }
      infoEl.innerHTML += `<br><span style="color:#a60">shadows lowered to 1024 (slow device)</span>`;
    }
    controls.update();
    renderer.render(scene, camera);
  });
}

main().catch((e) => {
  showError(`failed: ${e.message}`);
});
