import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { OBJLoader } from 'three/addons/OBJLoader.js';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';

const hud = document.getElementById('hud');

async function main() {
  const params = new URLSearchParams(location.search);
  const manifestPath = './data/' + (params.get('m') || 'manifest.json');
  const res = await fetch(manifestPath);
  const manifest = await res.json();

  if (manifest.earth_model !== 'flat') {
    hud.innerHTML = `<span class="err">earth_model=${manifest.earth_model}: Step-1 viewer supports flat only.</span>`;
    return;
  }
  if (manifest.z_exaggeration !== 1.0) {
    hud.innerHTML = `<span class="err">z_exaggeration=${manifest.z_exaggeration}: export at 1.0 for the web viewer.</span>`;
    return;
  }

  // Render-verified per dataset (Mayon A/B): manifest.texture_flip_y
  // selects the upload flip. Mayon needs false; Isarog needs true.
  const flipY = manifest.texture_flip_y === true;

  const container = document.getElementById('app');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e13);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 1e7);
  camera.up.set(0, 0, 1); // Z-up: mesh Z is absolute elevation

  // Step 2: untextured + textured materials. Each tile gets its own
  // textured material (map differs per tile); toggle swaps mesh.material.
  const untexturedMat = new THREE.MeshLambertMaterial({ color: 0x9aa37a });
  const texLoader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // Step 3: hillshade = white Lambert + single directional sun, no ambient.
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
  const hillSun = new THREE.DirectionalLight(0xffffff, 1.6);
  hillSun.visible = false;
  scene.add(hillSun);
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

  // Step 4: exaggeration scales a parent group about Z=0. The terrain
  // group itself stays XY-centred with Z absolute, so sea level is fixed.
  // (Step 5 buildings will join the same parent to stay registered.)
  const scaleGroup = new THREE.Group();
  scene.add(scaleGroup);
  const terrainGroup = new THREE.Group();
  scaleGroup.add(terrainGroup);
  // Step 5: buildings live under the same scaled parent so bases stay
  // registered with the terrain at any exaggeration.
  const buildingsGroup = new THREE.Group();
  scaleGroup.add(buildingsGroup);
  const buildingsMat = new THREE.MeshLambertMaterial({
    color: 0xd8d3c8, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });

  const objLoader = new OBJLoader();
  const gltfLoader = new GLTFLoader();
  // Step 6: .glb (binary glTF) or .obj by file extension. GLB terrain
  // carries its texture embedded; its map is reused with flipY=true to
  // match the OBJ path exactly (same PNG bytes + same UVs + same flip).
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
        withMap.map.flipY = flipY; // match OBJ path (see loadModel note)
        withMap.map.needsUpdate = true;
        found = new THREE.MeshLambertMaterial({ map: withMap.map, alphaTest: 0.5 });
      }
    });
    return found;
  };

  const unionBox = new THREE.Box3();
  let loaded = 0;

  await Promise.all(manifest.tiles.map(async (t) => {
    const [obj, tex] = await Promise.all([
      loadModel('./data/' + t.file),
      t.texture ? texLoader.loadAsync('./data/' + t.texture) : Promise.resolve(null),
    ]);
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = flipY; // matches exporter: v=0 south, PNG row 0 north
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
        terrainGroup.add(mesh);
        g.computeBoundingBox();
        unionBox.union(g.boundingBox);
      }
    });
    loaded++;
    hud.textContent = `loading tiles ${loaded}/${manifest.tiles.length}…`;
  }));

  // Step 5: optional buildings layer (second group, same frame).
  let buildingCount = 0;
  if (manifest.buildings) {
    const bObj = await loadModel('./data/' + manifest.buildings);
    bObj.traverse((child) => {
      if (child.isMesh) {
        const g = child.geometry;
        if (!g.getAttribute('normal')) g.computeVertexNormals(); // keep file normals (crisp faces)
        const mesh = new THREE.Mesh(g, buildingsMat);
        mesh.userData.isBuilding = true;
        buildingsGroup.add(mesh);
        buildingCount++;
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

  hud.innerHTML =
    `<b>${manifest.name}</b> — ${manifest.tiles.length} tiles <span style="color:#888">(v10 flip:${flipY})</span><br>` +
    `extent: ${Math.round(size.x)} × ${Math.round(size.y)} m<br>` +
    `elevation: ${zRange[0].toFixed(1)} … ${zRange[1].toFixed(1)} m<br>` +
    `CRS ${manifest.crs} · flat · exaggeration 1.0<br>` +
    `${manifest.attribution}<br>` +
    `exaggeration <input id="exagg" type="range" min="1" max="5" value="1" step="0.1" style="width:90px"> <span id="exaggVal">1.0×</span><br>` +
    (manifest.buildings ? `<input type="checkbox" id="chkBld" checked> buildings (${buildingCount} meshes)<br>` : ``) +
    `<button id="btnUntex">Untextured</button> ` +
    `<button id="btnTex">Textured</button> ` +
    `<button id="btnHill">Hillshade</button><br>` +
    `<span id="hillCtrls" style="display:none">` +
    `azimuth <input id="sunAz" type="range" min="0" max="360" value="315" step="1" style="width:90px"> <span id="sunAzVal">315°</span><br>` +
    `altitude <input id="sunAlt" type="range" min="0" max="90" value="45" step="1" style="width:90px"> <span id="sunAltVal">45°</span>` +
    `</span>`;

  extentHillSunDist = () => extent * 3;
  const sunAz = document.getElementById('sunAz');
  const sunAlt = document.getElementById('sunAlt');
  const sunAzVal = document.getElementById('sunAzVal');
  const sunAltVal = document.getElementById('sunAltVal');
  const updateHillSun = () => {
    sunAzVal.textContent = `${sunAz.value}°`;
    sunAltVal.textContent = `${sunAlt.value}°`;
    placeHillSun(Number(sunAz.value), Number(sunAlt.value));
  };
  sunAz.oninput = updateHillSun;
  sunAlt.oninput = updateHillSun;
  updateHillSun();

  let mode = 'textured';
  const setMode = (next) => {
    mode = next;
    const hill = mode === 'hillshade';
    sun.visible = !hill;
    hemi.visible = !hill;
    hillSun.visible = hill;
    document.getElementById('hillCtrls').style.display = hill ? '' : 'none';
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
    document.getElementById('btnUntex').disabled = mode === 'untextured';
    document.getElementById('btnTex').disabled = mode === 'textured';
    document.getElementById('btnHill').disabled = hill;
  };
  document.getElementById('btnUntex').onclick = () => setMode('untextured');
  document.getElementById('btnTex').onclick = () => setMode('textured');
  document.getElementById('btnHill').onclick = () => setMode('hillshade');
  setMode('textured'); // start textured; falls back per-tile where texture is null

  const chkBld = document.getElementById('chkBld');
  if (chkBld) chkBld.onchange = () => { buildingsGroup.visible = chkBld.checked; };

  const exagg = document.getElementById('exagg');
  const exaggVal = document.getElementById('exaggVal');
  const zMid = (zRange[0] + zRange[1]) / 2;
  exagg.oninput = () => {
    const k = Number(exagg.value);
    exaggVal.textContent = `${k.toFixed(1)}×`;
    scaleGroup.scale.z = k;
    controls.target.z = zMid * k;
    camera.far = extent * 20 + Math.abs(zRange[1] * k) + Math.abs(zRange[0] * k) + dist * 4;
    camera.updateProjectionMatrix();
  };

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}

main().catch((e) => {
  hud.innerHTML = `<span class="err">failed: ${e.message}</span>`;
  console.error(e);
});
