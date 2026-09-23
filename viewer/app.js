import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { installLook } from './look.js';
import { buildGround, accelerate } from './ground.js';
import { installFeel } from './feel.js';

// Unconditional build marker, set before anything can fail: if this is missing
// from the DOM the browser is running an older app.js, not a broken new one.
document.documentElement.dataset.appBuild = 'floor-below-3';

const $ = (id) => document.getElementById(id);
const statusEl = $('status'), pickEl = $('pick'), propsEl = $('props'), modeEl = $('mode');
const saveEl = $('save'), listEl = $('list'), emptyEl = $('empty'), crossEl = $('cross');
const speedEl = $('speed'), speedOut = $('speedOut'), dropEl = $('drop'), toastEl = $('toast');
const helpEl = $('help');

function say(msg, isErr) {
  statusEl.textContent = msg || '';
  statusEl.className = isErr ? 'err' : '';
  statusEl.style.display = msg ? 'block' : 'none';
}
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 2600);
}

// Worlds are normalised to this many units across, so every tuning number
// (walk speed, prop size, bounds) is against a known scale rather than
// whatever metric scale MoGe happened to emit.
// Everything below is in METRES. The world is scaled so the panorama's capture
// height becomes EYE_METRES, which makes every other number here mean something
// physical instead of being tuned against an arbitrary bounding box.
const EYE_METRES = 1.7;        // eye height of a standing adult
const ROAM_METRES = 14;        // how far from the capture point you may walk
const WORLD_SIZE = 40;         // only still used for prop sizing defaults

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;   // panorama is already tone-mapped
document.body.appendChild(renderer.domElement);
const maxAniso = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
// Near/far in metres. Far has to be generous: once the world is human-scaled,
// the hills MoGe reconstructs really are kilometres away.
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 60000);
// Props are separate meshes with real materials, so unlike the baked world
// shell they do need light.
scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4048, 2.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(6, 14, 8);
scene.add(sun);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---- state ---------------------------------------------------------------
const loader = new GLTFLoader();
const propGroup = new THREE.Group();     // everything the user placed
scene.add(propGroup);

let worldMesh = null;
let floorLevel = 0;     // height to stand at where the mesh has no floor
let worldName = '';
let selected = null;
let mode = 'walk';                       // 'walk' | 'build'
let bound = WORLD_SIZE * 0.42;

// ---- world shell ---------------------------------------------------------
function unlit(src) {
  // The world shell carries the panorama's lighting baked in. Lighting it again
  // multiplies light by light and turns it muddy, so it renders unlit.
  const m = new THREE.MeshBasicMaterial({
    map: src && src.map ? src.map : null,
    vertexColors: !!(src && src.vertexColors),
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  if (!m.map && !m.vertexColors && src && src.color) m.color.copy(src.color);
  if (m.map) {
    m.map.colorSpace = THREE.SRGBColorSpace;
    m.map.anisotropy = maxAniso;          // or floors smear at grazing angles
    m.map.needsUpdate = true;
  }
  return m;
}

// Remove the spokes.
//
// MoGe reconstructs from a single viewpoint, so wherever it has no depth it
// leaves triangles stretched along the line of sight - long thin spikes that
// all converge on the capture point, which is exactly where the hero stands.
// They cannot be culled by size alone: a distant hillside legitimately has
// huge triangles. What makes a spoke is being huge RELATIVE TO how far away it
// is. A 10 m triangle 200 m away is landscape; a 5 m triangle 2 m away is a
// spike through your head.
function stripSpokes(mesh, worldScale) {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  if (!pos) return 0;
  const idx = geo.getIndex();
  const count = idx ? idx.count : pos.count;
  const get = (i) => (idx ? idx.getX(i) : i);

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const kept = [];
  let dropped = 0;

  for (let t = 0; t < count; t += 3) {
    const i0 = get(t), i1 = get(t + 1), i2 = get(t + 2);
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    const maxEdge = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) * worldScale;
    // Distance from the capture point, which sits at the local origin.
    const dist = ((a.length() + b.length() + c.length()) / 3) * worldScale;
    if (maxEdge > 1.0 && maxEdge > 0.55 * dist) { dropped++; continue; }
    kept.push(i0, i1, i2);
  }

  if (dropped) {
    geo.setIndex(kept);
    geo.clearGroups();
  }
  return dropped;
}

function captureHeight(root) {
  root.scale.setScalar(1);
  root.updateMatrixWorld(true);
  const rc = new THREE.Raycaster();
  const from = new THREE.Vector3(0, 0, 0), dir = new THREE.Vector3();
  const ys = [];
  for (const deg of [20, 30, 40, 50, 60, 70, 80]) {
    const e = (deg * Math.PI) / 180;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      dir.set(Math.cos(e) * Math.cos(a), -Math.sin(e), Math.cos(e) * Math.sin(a));
      rc.set(from, dir);
      const hit = rc.intersectObject(root, true)[0];
      if (hit && hit.point.y < 0) ys.push(hit.point.y);
    }
  }
  if (ys.length < 20) return 0;            // too little floor seen: caller falls back
  ys.sort((a, b) => a - b);
  const h = -ys[Math.floor(ys.length / 2)];
  document.body.dataset.capture = JSON.stringify({ raw: +h.toFixed(3), rays: ys.length });
  return h;
}

function fitWorld(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.material = Array.isArray(o.material) ? o.material.map(unlit) : unlit(o.material);
    o.frustumCulled = false;
    o.userData.isWorld = true;
  });
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return;

  // Scale the world to HUMAN SIZE, using the one real measurement it contains.
  //
  // Normalising the longest axis to a fixed size was wrong, and it is what made
  // walking feel like leaping: MoGe reconstructs distant hills and sky hundreds
  // of units out, so "longest axis" spans a landscape, and the courtyard you
  // actually stand in ended up about two units wide. Any sane walking speed then
  // crossed it in a second.
  //
  // The panorama was shot from the origin, so the drop from the origin to the
  // lowest reconstructed point IS the camera height of the capture - a real
  // distance, in metres. Scale so that becomes a human 1.7 m and the whole world
  // is suddenly in metres: a 1.4 m/s walk is a walk, and a doorway is a doorway.
  // How high the panorama camera stood, measured by casting rays DOWN from it
  // (between 20 and 80 degrees below the horizon; straight down is the nadir
  // hole) and taking the median hit. The bounding box's lowest point is NOT the
  // floor: a stray fragment 5-20x deeper than the real floor is normal in a
  // MoGe mesh, and using it shrank whole worlds into tabletop models with the
  // hero standing outside them.
  const measured = captureHeight(root);
  const dropToFloor = measured || Math.max(0.001, -box.min.y);
  const scale = EYE_METRES / dropToFloor;
  // MoGe builds around its own viewpoint at the origin: scale about the origin,
  // never recentre on the bounding box or you end up outside the shell.
  root.scale.setScalar(scale);

  let spokes = 0;
  root.traverse((o) => { if (o.isMesh) spokes += stripSpokes(o, scale); });
  if (spokes) toast('Trimmed ' + spokes.toLocaleString() + ' stretched triangles');

  // How far you may wander from the capture point. A single panorama is only
  // geometrically valid near where it was shot; past that, surfaces stretch.
  bound = ROAM_METRES;

  // Park the catch-all floor CLEARLY BELOW the reconstruction. Putting it
  // slightly ABOVE the lowest point (which is what shipped first) is a disaster:
  // at eye level you look along the plane, and a surface even a few centimetres
  // above the real floor occludes it all the way to the horizon - the whole
  // lower half of the screen becomes a flat beige sheet. It must only ever be
  // visible through genuine holes, so it sits well under everything.
  const scaled = new THREE.Box3().setFromObject(root);
  // The reconstruction's lowest point is effectively the ground. Remember it as
  // the height to stand at wherever the mesh has no geometry underfoot - which
  // includes straight below the starting point, because the nadir of a panorama
  // is the one direction the original camera could not see.
  floorLevel = -EYE_METRES;             // the measured floor, now in metres
  EYE = EYE_METRES;
  if (floorMesh) {
    // Just under the floor: close enough to read as the floor continuing across
    // a hole, far enough not to occlude it at a grazing angle.
    floorMesh.position.y = floorLevel - 0.06;
    floorMesh.scale.setScalar(1);
  }
}

// Every world .glb may sit next to a .jpg of the panorama it was built from.
// Showing that as the scene background does two jobs at once: the page stops
// being a black rectangle while the big mesh downloads, and afterwards every
// hole in the reconstruction shows the original scenery behind it instead of
// a void. It is 0.4 MB against the mesh's tens of MB, so it arrives instantly.
const texLoader = new THREE.TextureLoader();
let floorMesh = null;

async function setBackdrop(worldFile) {
  const jpg = '../worlds/' + encodeURIComponent(worldFile.replace(/\.glb$/i, '.jpg'));
  try {
    const tex = await texLoader.loadAsync(jpg);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    scene.background = tex;
    // NO fallback floor plane. It has now caused the same bug twice: any plane
    // near the real floor wins at a grazing angle and paints the bottom of the
    // screen a flat colour, whether it is 8 cm above (first attempt) or 6 cm
    // below (second). The backdrop sphere already fills holes with the real
    // scenery, which looks better than a disc ever did, and floorLevel still
    // catches the hero numerically. Keeping this deleted on purpose.
  } catch (_) {
    scene.background = new THREE.Color(0x141922);   // no panorama saved: plain sky
  }
}

function addFloor(tex) {
  if (floorMesh) { scene.remove(floorMesh); floorMesh = null; }
  // Catch-all ground so you can never fall through a hole in the floor. Colour
  // is sampled from the bottom of the panorama - the part looking straight down
  // - so it reads as the same ground rather than a grey slab.
  let colour = new THREE.Color(0x6b6355);
  try {
    const img = tex.image;
    const c = document.createElement('canvas');
    c.width = 32; c.height = 8;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, Math.floor(img.height * 0.86), img.width, Math.floor(img.height * 0.14),
      0, 0, 32, 8);
    const d = g.getImageData(0, 0, 32, 8).data;
    let r = 0, gg = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    colour = new THREE.Color(r / n / 255, gg / n / 255, b / n / 255);
  } catch (_) { /* cross-origin or not decoded yet: keep the default */ }

  floorMesh = new THREE.Mesh(
    // Only big enough to cover the reconstruction. A huge one reads as an
    // endless plain through the nadir hole instead of as missing floor.
    new THREE.CircleGeometry(60, 64),
    new THREE.MeshBasicMaterial({ color: colour, toneMapped: false })
  );
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.renderOrder = -1;
  scene.add(floorMesh);
}

async function loadWorld(name) {
  say('Loading ' + name + ' …');
  if (worldMesh) { scene.remove(worldMesh); worldMesh = null; }
  clearProps();
  await setBackdrop(name);      // instant: gives you something to look at
  try {
    const gltf = await loader.loadAsync('../worlds/' + encodeURIComponent(name), (e) => {
      if (e.lengthComputable) say('Loading… ' + Math.round((e.loaded / e.total) * 100) + '%');
      else say('Loading… ' + (e.loaded / 1048576).toFixed(1) + ' MB');
    });
    worldMesh = gltf.scene;
    fitWorld(worldMesh);
    accelerate(worldMesh);        // BVH: every floor/camera probe becomes cheap
    scene.add(worldMesh);
    worldName = name;
    vel.set(0, 0, 0);

    // Find the floor you actually stand on, which is NOT the bounding box's
    // lowest point - that is usually some distant low vertex far outside the
    // room. Straight down from the origin is a hole (the nadir a panorama
    // cannot see), so sample a ring just around the capture point and take the
    // median. Using min.y here sank the hero below the real floor and left the
    // camera grazing along it.
    const ring = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      // Search downward from the capture point itself (y = 0), since the hero
      // does not exist yet and the floor is roughly eye height below it.
      const g = groundAt(Math.cos(a) * 1.2, Math.sin(a) * 1.2, -EYE_METRES + STEP_UP);
      if (g !== null) ring.push(g);
    }
    ring.sort((a, b) => a - b);
    if (ring.length) floorLevel = ring[Math.floor(ring.length / 2)];
    if (floorMesh) floorMesh.position.y = floorLevel - 0.06;

    // Fill the holes in the walkable floor with a skin that follows the real
    // floor just beneath it (ground.js). The hero walks on it like any floor.
    try {
      const gs = buildGround(worldMesh, { floorY: floorLevel, radius: bound + 3, pano: scene.background });
      if (gs.walkRadius) bound = gs.walkRadius;
      if (gs.filled) toast('Floor filled · walkable area ' + Math.round(bound * 2) + ' m across');
    } catch (e) { console.warn('ground fill failed', e); }

    // Stand the hero at the capture point, on that floor.
    if (!hero) await loadHero();
    hero.position.set(0, floorLevel, 0);
    heroGroundY = null;
    heroYaw = 0;
    hero.rotation.y = 0;
    hero.visible = true;
    camYaw = 0;
    camPitch = -0.12;
    // ?spawn=x,z,yaw starts somewhere other than the capture point (testing).
    const sp = new URLSearchParams(location.search).get('spawn');
    if (sp) {
      const [sx, sz, syaw] = sp.split(',').map(Number);
      hero.position.x = sx || 0; hero.position.z = sz || 0;
      const gy = groundAt(hero.position.x, hero.position.z, floorLevel + 1);
      if (gy !== null) hero.position.y = gy;
      if (!Number.isNaN(syaw)) camYaw = syaw || 0;
    }
    updateCamera();
    say('');
    await loadScene();
  } catch (err) {
    say('Could not load ' + name + '\n\n' + (err && err.message ? err.message : err), true);
  }
}

// ---- props ---------------------------------------------------------------
function clearProps() {
  select(null);
  while (propGroup.children.length) propGroup.remove(propGroup.children[0]);
  refreshList();
}

async function addProp(file, transform) {
  const gltf = await loader.loadAsync('../props/' + encodeURIComponent(file));
  const obj = gltf.scene;
  obj.traverse((o) => {
    if (o.isMesh && o.material && o.material.map) {
      o.material.map.colorSpace = THREE.SRGBColorSpace;
      o.material.map.anisotropy = maxAniso;
    }
  });

  // Generated props arrive at wildly different scales - a Hunyuan3D mesh is
  // roughly unit-sized, a captured one can be hundreds of units. Normalise to a
  // sane default so a dropped asset is always visible and reachable.
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z) || 1;
  obj.scale.setScalar((WORLD_SIZE * 0.05) / longest);
  obj.userData.file = file;
  obj.name = file.replace(/\.glb$/i, '');
  propGroup.add(obj);
  applyTransform(obj, transform);
  refreshList();
  return obj;
}

function applyTransform(obj, t) {
  if (t) {
    obj.position.fromArray(t.position);
    obj.rotation.fromArray(t.rotation);
    obj.scale.setScalar(t.scale);
    return;
  }
  // No saved transform: drop it a few metres in front of where you are looking,
  // so a newly added prop lands in view rather than inside your head.
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  dir.y = 0;
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
  dir.normalize();
  obj.position.copy(camera.position).addScaledVector(dir, WORLD_SIZE * 0.12);
}

function select(obj) {
  selected = obj;
  refreshList();
}

function refreshList() {
  listEl.innerHTML = '';
  const kids = propGroup.children;
  emptyEl.style.display = kids.length ? 'none' : 'block';
  kids.forEach((o, i) => {
    const li = document.createElement('li');
    li.textContent = o.name || ('prop ' + (i + 1));
    if (o === selected) li.className = 'sel';
    li.addEventListener('click', () => select(o));
    listEl.appendChild(li);
  });
}

async function refreshPropLibrary() {
  try {
    const names = await fetch('/api/props', { cache: 'no-store' }).then((r) => r.json());
    propsEl.innerHTML = '';
    const head = document.createElement('option');
    head.value = '';
    head.textContent = names.length ? '— choose to place —' : '— library empty —';
    propsEl.appendChild(head);
    for (const n of names) {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = n.replace(/\.glb$/i, '');
      propsEl.appendChild(o);
    }
  } catch (_) { /* library is optional */ }
}

// ---- drag and drop -------------------------------------------------------
let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth) dropEl.classList.add('on'); });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; dropEl.classList.remove('on'); } });

addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropEl.classList.remove('on');
  const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
  const glbs = files.filter((f) => /\.glb$/i.test(f.name));
  if (!glbs.length) return toast(files.length ? 'Only .glb files can be dropped' : 'Nothing to add');

  for (const f of glbs) {
    try {
      toast('Uploading ' + f.name + ' …');
      const res = await fetch('/api/upload?name=' + encodeURIComponent(f.name), {
        method: 'POST',
        body: await f.arrayBuffer(),
      });
      const out = await res.json();
      if (!res.ok || out.error) throw new Error(out.error || ('HTTP ' + res.status));
      const obj = await addProp(out.name);
      select(obj);
      toast('Added ' + out.name);
    } catch (err) {
      toast('Failed: ' + (err && err.message ? err.message : err));
    }
  }
  refreshPropLibrary();
});

propsEl.addEventListener('change', async () => {
  const file = propsEl.value;
  if (!file) return;
  propsEl.value = '';
  try {
    select(await addProp(file));
    toast('Placed ' + file);
  } catch (err) {
    toast('Could not place ' + file);
  }
});

// ---- saving --------------------------------------------------------------
async function saveScene() {
  if (!worldName) return;
  const data = {
    world: worldName,
    savedAt: new Date().toISOString(),
    objects: propGroup.children.map((o) => ({
      file: o.userData.file,
      position: o.position.toArray(),
      rotation: [o.rotation.x, o.rotation.y, o.rotation.z],
      scale: o.scale.x,
    })),
  };
  try {
    const res = await fetch('/api/scene?world=' + encodeURIComponent(worldName), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const out = await res.json();
    if (!res.ok || out.error) throw new Error(out.error || ('HTTP ' + res.status));
    toast('Saved ' + out.objects + ' object' + (out.objects === 1 ? '' : 's'));
  } catch (err) {
    toast('Save failed: ' + (err && err.message ? err.message : err));
  }
}

async function loadScene() {
  if (!worldName) return;
  try {
    const data = await fetch('/api/scene?world=' + encodeURIComponent(worldName),
      { cache: 'no-store' }).then((r) => r.json());
    const objs = (data && data.objects) || [];
    for (const rec of objs) {
      try { await addProp(rec.file, rec); }
      catch (_) { /* a prop file that went missing should not break the load */ }
    }
    if (objs.length) toast('Restored ' + objs.length + ' object' + (objs.length === 1 ? '' : 's'));
  } catch (_) { /* no saved scene yet is normal */ }
}

saveEl.addEventListener('click', saveScene);

// ---- build mode: pick and place -----------------------------------------
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const plane = new THREE.Plane();
const hit = new THREE.Vector3();
const grab = new THREE.Vector3();
let dragging = false;

function pointerNdc(e) {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (mode !== 'build' || e.button !== 0) return;
  pointerNdc(e);
  ray.setFromCamera(ndc, camera);
  const picks = ray.intersectObjects(propGroup.children, true);
  if (!picks.length) return select(null);

  let obj = picks[0].object;
  while (obj.parent && obj.parent !== propGroup) obj = obj.parent;
  select(obj);

  // Drag across a horizontal plane through the object, so it slides along the
  // ground instead of flying toward the camera.
  plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), obj.position);
  if (ray.ray.intersectPlane(plane, hit)) grab.subVectors(obj.position, hit);
  dragging = true;
  renderer.domElement.setPointerCapture(e.pointerId);
});

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragging || !selected) return;
  pointerNdc(e);
  ray.setFromCamera(ndc, camera);
  if (ray.ray.intersectPlane(plane, hit)) selected.position.copy(hit).add(grab);
});

function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) {}
}
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

// ---- the hero -------------------------------------------------------------
// A body on the floor, not a floating eye. The camera orbits behind it; the
// character walks, turns to face where it is going, and steps up small rises.
// Climbing, ledges and jumping are deliberately out of scope for now.
const HERO_FILE = 'hero.glb';
const HERO_HEIGHT = 1.75;      // metres, head to foot
const HERO_RADIUS = 0.34;      // how wide the body is, for wall collision
const STEP_UP = 0.45;          // the tallest step it can walk up
const STEP_DOWN = 0.60;        // the biggest drop it will follow rather than fall

let hero = null;
let heroYaw = 0;               // where the body faces
let heroGroundY = null;
let camYaw = 0, camPitch = -0.12;
const CAM_DIST = 3.6, CAM_HEIGHT = 1.45;

function placeholderHero() {
  // Works before any character has been generated, so Play mode is never dead.
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(HERO_RADIUS, HERO_HEIGHT - HERO_RADIUS * 2, 6, 14),
    new THREE.MeshStandardMaterial({ color: 0xc98f4f, roughness: 0.7 })
  );
  body.position.y = HERO_HEIGHT / 2;
  g.add(body);
  return g;
}

async function loadHero() {
  if (hero) { scene.remove(hero); hero = null; }
  let obj = null;
  try {
    const gltf = await loader.loadAsync('../props/' + HERO_FILE + '?v=2')  /* bump when hero.glb changes: .glb is cached a week */;
    obj = gltf.scene;
    obj.traverse((o) => {
      if (o.isMesh && o.material && o.material.map) {
        o.material.map.colorSpace = THREE.SRGBColorSpace;
        o.material.map.anisotropy = maxAniso;
      }
    });
    // Generated characters arrive at an arbitrary scale and are usually
    // centred on their middle, not standing on their feet. Normalise to a real
    // height and sit the lowest vertex exactly on y=0 so the feet touch ground.
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const tall = Math.max(size.y, 0.001);
    const s = HERO_HEIGHT / tall;
    obj.scale.setScalar(s);
    const scaled = new THREE.Box3().setFromObject(obj);
    obj.position.y -= scaled.min.y;
    const mid = new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3());
    obj.position.x -= mid.x;
    obj.position.z -= mid.z;
  } catch (_) {
    obj = placeholderHero();
  }
  hero = new THREE.Group();
  hero.add(obj);
  scene.add(hero);
  return hero;
}

// ---- modes and movement --------------------------------------------------
const held = new Set();
let walkSpeed = 2.4;
const ACCEL = 14, DAMPING = 9;
const vel = new THREE.Vector3(), wish = new THREE.Vector3();
const fwdVec = new THREE.Vector3(), rightVec = new THREE.Vector3();
const clock = new THREE.Clock();

const HELP = {
  walk: '<b>W A S D</b> walk · <b>Shift</b> run<br>Mouse turns the camera · <b>Esc</b> release',
  build: '<b>Drag</b> to move · <b>Q / E</b> rotate<br><b>[ / ]</b> scale · <b>Del</b> remove',
};

// Third person needs its own camera, so PointerLockControls (which drives the
// camera directly, first-person style) is not used. Lock the pointer by hand
// and turn raw mouse movement into an orbit around the hero instead.
const isLocked = () => document.pointerLockElement === renderer.domElement;

function setMode(next) {
  mode = next;
  modeEl.textContent = next === 'walk' ? 'Mode: Play' : 'Mode: Build';
  helpEl.innerHTML = HELP[next];
  if (next === 'build') {
    if (isLocked()) document.exitPointerLock();
    select(selected);
  }
  // The hero stays visible in Build mode too - it is the reference for how big
  // a placed prop should be, and for where "here" is.
  if (hero) hero.visible = true;
  held.clear();
}

modeEl.addEventListener('click', () => {
  if (mode === 'walk') { setMode('build'); return; }
  setMode('walk');
  renderer.domElement.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  if (isLocked()) crossEl.classList.add('on');
  else { crossEl.classList.remove('on'); held.clear(); }
});

addEventListener('mousemove', (e) => {
  if (mode !== 'walk' || !isLocked()) return;
  camYaw -= e.movementX * 0.0024;
  camPitch -= e.movementY * 0.0020;
  // Stop short of straight up and straight down, where an orbit camera flips.
  camPitch = Math.max(-1.15, Math.min(0.75, camPitch));
});

speedEl.addEventListener('input', () => {
  walkSpeed = Number(speedEl.value);
  speedOut.textContent = walkSpeed.toFixed(1);
});

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') e.preventDefault();
  held.add(e.code);
  if (mode !== 'build' || !selected) return;
  if (e.code === 'KeyQ') selected.rotation.y -= 0.12;
  if (e.code === 'KeyE') selected.rotation.y += 0.12;
  if (e.code === 'BracketLeft') selected.scale.multiplyScalar(0.92);
  if (e.code === 'BracketRight') selected.scale.multiplyScalar(1.087);
  if (e.code === 'Delete' || e.code === 'Backspace') {
    propGroup.remove(selected);
    select(null);
    toast('Removed');
  }
});
addEventListener('keyup', (e) => held.delete(e.code));
addEventListener('blur', () => held.clear());

// Follow the floor instead of drifting at a fixed height. Raycasting an 80 MB
// mesh every frame would cost more than rendering it, so the ground height is
// re-measured a few times a second and the camera eases toward it in between -
// which also smooths out the jitter from a noisy reconstructed surface.
// Eye height is not a guess: the panorama was shot from the origin, so the
// distance from the reconstructed floor up to y=0 IS the original camera
// height. Standing at that height puts your eyes exactly where the shot was
// taken, which is the one height at which the scene looks undistorted.
let EYE = EYE_METRES;
const downRay = new THREE.Raycaster();
downRay.firstHitOnly = true;
const DOWN = new THREE.Vector3(0, -1, 0);
let groundY = null;
let lastProbe = 0;

const FOOT_OFFSETS = [[0, 0], [0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]];
const MAX_STEP = 0.28;          // metres of height change allowed per probe

function sampleGround() {
  // Sample a small footprint, not a single point, and take the HIGHEST surface.
  // A reconstructed floor is pitted with small holes and spikes; one ray drops
  // you into every one of them, which is the lurching that makes walking feel
  // broken. The highest of five is stable and errs toward standing on top of
  // things rather than falling through them.
  if (!worldMesh) return null;
  let best = null;
  for (const [ox, oz] of FOOT_OFFSETS) {
    const from = camera.position.clone();
    from.x += ox; from.z += oz; from.y += 8;
    downRay.set(from, DOWN);
    downRay.far = 40;
    const hit = downRay.intersectObject(worldMesh, true)[0];
    if (hit && (best === null || hit.point.y > best)) best = hit.point.y;
  }
  return best;
}

function stayGrounded(dt, flying) {
  if (flying) { groundY = null; return; }
  const now = performance.now();
  if (now - lastProbe > 90) {
    lastProbe = now;
    const measured = sampleGround();
    // Where there is no floor at all - the nadir hole at the start point, or a
    // gap in the mesh - HOLD the height we already had. Snapping to the
    // remembered floor level was a visible drop every time you crossed a hole.
    const target = measured !== null ? measured
      : (groundY !== null ? groundY : floorLevel);
    if (groundY === null) groundY = target;
    else groundY += THREE.MathUtils.clamp(target - groundY, -MAX_STEP, MAX_STEP);
  }
  if (groundY === null) return;
  const want = groundY + EYE;
  camera.position.y += (want - camera.position.y) * Math.min(1, 8 * dt);
}

// Debug hook: what is actually under the camera, and is it the real floor or
// the fallback disc? Used to verify grounding without needing pointer lock.
window.__probe = () => {
  const from = camera.position.clone();
  from.y += WORLD_SIZE * 0.5;
  downRay.set(from, DOWN);
  downRay.far = WORLD_SIZE * 1.5;
  const world = worldMesh ? downRay.intersectObject(worldMesh, true) : [];
  const disc = floorMesh ? downRay.intersectObject(floorMesh, true) : [];
  const wb = worldMesh ? new THREE.Box3().setFromObject(worldMesh) : null;
  return {
    heroAt: hero ? [+hero.position.x.toFixed(2), +hero.position.y.toFixed(2), +hero.position.z.toFixed(2)] : null,
    heroGroundY: heroGroundY === null ? null : +heroGroundY.toFixed(3),
    heroIsPlaceholder: hero ? !hero.children[0].children.length : null,
    cameraAt: [+camera.position.x.toFixed(2), +camera.position.y.toFixed(2), +camera.position.z.toFixed(2)],
    discY: floorMesh ? +floorMesh.position.y.toFixed(2) : null,
    cameraY: +camera.position.y.toFixed(3),
    floorUnderfoot: world.length ? +world[0].point.y.toFixed(3) : null,
    floorLevel: +floorLevel.toFixed(3),
    eyeHeight: +EYE.toFixed(3),
    shouldStandAt: +((world.length ? world[0].point.y : floorLevel) + EYE).toFixed(3),
    worldMinY: wb ? +wb.min.y.toFixed(3) : null,
    worldMaxY: wb ? +wb.max.y.toFixed(3) : null,
    // No mesh underfoot is NORMAL at the start point: the nadir of a panorama
    // is the one direction the capture could not see, so it reconstructs as a
    // hole and the remembered floor level carries you.
    usingFloorLevelFallback: !world.length,
  };
};

// Publish it to the DOM once a second. Browser automation and devtools consoles
// often run in an isolated world where page variables are invisible, but the
// DOM is shared - so a data attribute is readable from anywhere.
setInterval(() => {
  try { document.body.dataset.probe = JSON.stringify(window.__probe()); }
  catch (_) { /* before the world loads there is nothing to probe */ }
}, 1000);

// Stop at walls instead of gliding through them. One ray along the direction
// you are actually moving, at chest height, a stride ahead: if something is
// closer than BODY, cancel the part of the velocity heading into it, which lets
// you slide along a wall rather than sticking to it.
const wallRay = new THREE.Raycaster();
const moveDir = new THREE.Vector3();
const BODY = 0.45;              // metres from eye to the front of the body
let lastWallProbe = 0;
let wallNormal = null;

function blockByWalls(dt) {
  if (!worldMesh || vel.lengthSq() < 1e-5) { wallNormal = null; return; }
  const now = performance.now();
  if (now - lastWallProbe > 60) {
    lastWallProbe = now;
    moveDir.copy(vel).setY(0);
    if (moveDir.lengthSq() > 1e-6) {
      moveDir.normalize();
      const eye = camera.position.clone();
      eye.y -= EYE * 0.35;                 // probe at chest, not at the eyes
      wallRay.set(eye, moveDir);
      wallRay.far = BODY + vel.length() * dt * 4 + 0.35;
      const hit = wallRay.intersectObject(worldMesh, true)[0];
      wallNormal = (hit && hit.distance < wallRay.far && hit.face)
        ? hit.face.normal.clone().setY(0) : null;
      if (wallNormal && wallNormal.lengthSq() > 1e-6) {
        wallNormal.normalize();
        // A reconstructed mesh has no consistent winding and renders
        // double-sided, so a face normal may point either way. Force it to
        // oppose the direction of travel, or "blocking" would shove you
        // forward into the wall instead of stopping you.
        if (wallNormal.dot(moveDir) > 0) wallNormal.negate();
      } else wallNormal = null;
    }
  }
  if (!wallNormal) return;
  // Remove only the component pushing into the surface.
  const into = vel.dot(wallNormal);
  if (into < 0) vel.addScaledVector(wallNormal, -into);
}

// Ground height at a spot, sampling a footprint rather than a single point.
//
// Two things matter and I got both wrong first time:
//  - Start the ray just ABOVE the feet, not high in the air. Dropping from 8 m
//    up finds the ROOF of an enclosed room, and the hero then "stands" on the
//    ceiling. Starting a step above the feet and taking the NEAREST hit below
//    finds the surface you are actually on.
//  - Across the footprint take the HIGHEST of those nearest hits, so small
//    pits and holes in a reconstructed floor do not swallow you.
const probeFrom = new THREE.Vector3();
function groundAt(x, z, fromY) {
  if (!worldMesh) return null;
  const start = (fromY === undefined ? hero.position.y : fromY) + STEP_UP;
  let best = null;
  for (const [ox, oz] of FOOT_OFFSETS) {
    probeFrom.set(x + ox, start, z + oz);
    downRay.set(probeFrom, DOWN);
    downRay.far = STEP_UP + STEP_DOWN + 1.2;
    const hit = downRay.intersectObject(worldMesh, true)[0];   // nearest below
    if (hit && (best === null || hit.point.y > best)) best = hit.point.y;
  }
  return best;
}

const desired = new THREE.Vector3();
const camWant = new THREE.Vector3();
const camRay = new THREE.Raycaster();
camRay.firstHitOnly = true;

function updateCamera() {
  if (!hero) return;
  // Orbit behind the hero, and pull in if a wall gets between camera and body.
  const focus = hero.position.clone();
  focus.y += CAM_HEIGHT;
  const cp = Math.cos(camPitch);
  camWant.set(focus.x + Math.sin(camYaw) * cp * CAM_DIST,
              focus.y - Math.sin(camPitch) * CAM_DIST,
              focus.z + Math.cos(camYaw) * cp * CAM_DIST);
  const dir = camWant.clone().sub(focus).normalize();
  let dist = CAM_DIST;
  if (worldMesh) {
    camRay.set(focus, dir);
    camRay.far = CAM_DIST;
    const blocked = camRay.intersectObject(worldMesh, true)[0];
    if (blocked) dist = Math.max(0.6, blocked.distance - 0.2);
  }
  // Keep the camera inside the walkable zone as well: outside it the world is
  // seen from angles the panorama never captured, and it smears.
  const camBound = bound + 1.5;
  while (dist > 0.6) {
    const cx = focus.x + dir.x * dist, cz = focus.z + dir.z * dist;
    if (cx * cx + cz * cz <= camBound * camBound) break;
    dist -= 0.1;
  }
  camera.position.copy(focus).addScaledVector(dir, dist);
  camera.lookAt(focus);
}

function step(dt) {
  if (!hero) return;
  if (mode !== 'walk') { updateCamera(); return; }

  // Keys walk whether or not the mouse is captured - needing a click first made
  // the hero look broken. Capturing the mouse only adds mouse-look.
  const k = (a, b) => (held.has(a) || held.has(b) ? 1 : 0);
  const fwd = k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown');
  const side = k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft');
  const sprint = (held.has('ShiftLeft') || held.has('ShiftRight')) ? 2.2 : 1;

  // Move relative to where the camera is looking, the way every third-person
  // game does - pushing forward means "away from the camera", not "north".
  desired.set(Math.sin(camYaw) * -fwd + Math.cos(camYaw) * side, 0,
              Math.cos(camYaw) * -fwd - Math.sin(camYaw) * side);
  if (desired.lengthSq() > 0) desired.normalize();

  const target = desired.clone().multiplyScalar(walkSpeed * sprint);
  vel.addScaledVector(target.sub(vel), Math.min(1, ACCEL * dt));
  if (desired.lengthSq() === 0) vel.multiplyScalar(Math.max(0, 1 - DAMPING * dt));
  vel.y = 0;                                  // floor only: no flying, no falling off

  if (vel.lengthSq() > 1e-6) {
    const nx = hero.position.x + vel.x * dt;
    const nz = hero.position.z + vel.z * dt;

    // Can the feet reach the floor there? A rise within STEP_UP is a step and
    // gets walked up; anything taller is a wall and stops you. This is what
    // makes stairs work without any explicit stair handling.
    const gNow = heroGroundY === null ? groundAt(hero.position.x, hero.position.z) : heroGroundY;
    const gNext = groundAt(nx, nz);
    const climbable = gNext === null || gNow === null
      || (gNext - gNow <= STEP_UP && gNow - gNext <= STEP_DOWN);

    if (climbable) {
      hero.position.x = nx;
      hero.position.z = nz;
    } else {
      vel.multiplyScalar(0.2);                // bumped into a wall or a ledge
    }

    // Face the way we are actually travelling, easing round rather than snapping.
    const wantYaw = Math.atan2(vel.x, vel.z);
    let delta = wantYaw - heroYaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    heroYaw += delta * Math.min(1, 12 * dt);
    hero.rotation.y = heroYaw;
  }

  // Keep near the capture point, where the reconstruction is geometrically valid.
  const flat = Math.hypot(hero.position.x, hero.position.z);
  if (flat > bound) {
    hero.position.x *= bound / flat;
    hero.position.z *= bound / flat;
  }

  // Settle onto the floor.
  const g = groundAt(hero.position.x, hero.position.z);
  const targetY = g !== null ? g : (heroGroundY !== null ? heroGroundY : floorLevel);
  heroGroundY = heroGroundY === null ? targetY
    : heroGroundY + THREE.MathUtils.clamp(targetY - heroGroundY, -MAX_STEP, MAX_STEP);
  hero.position.y += (heroGroundY - hero.position.y) * Math.min(1, 10 * dt);

  updateCamera();
}

// In Build mode there is no pointer lock, so right-drag orbits the camera -
// otherwise you could place props but never look anywhere else.
let orbiting = false;
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (mode === 'build' && e.button === 2) {
    orbiting = true;
    renderer.domElement.setPointerCapture(e.pointerId);
  }
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!orbiting) return;
  camYaw -= e.movementX * 0.005;
  camPitch = Math.max(-1.15, Math.min(0.75, camPitch - e.movementY * 0.004));
});
addEventListener('pointerup', () => { orbiting = false; });

// Render polish: distance dissolve, spoke pass 2, form shading, hero shadow.
// Open the page with ?look=off to compare against the old look.
installLook({ scene, renderer, getWorld: () => worldMesh, getHero: () => hero });
// Walk feel: stride bob, sway, lean, breathing, synthesised footsteps (M mutes).
installFeel({ scene, getHero: () => hero, getWorld: () => worldMesh, getMode: () => mode });

renderer.setAnimationLoop(() => {
  step(Math.min(clock.getDelta(), 0.05));
  renderer.render(scene, camera);
});

// ---- world list ----------------------------------------------------------
// Separate from boot() so a freshly built world can appear in the dropdown and
// load immediately, without a page refresh.
async function refreshWorlds(select) {
  let worlds = [];
  try {
    const res = await fetch('./worlds.json', { cache: 'no-store' });
    if (res.ok) worlds = await res.json();
  } catch (_) { /* handled below */ }

  if (select && !worlds.includes(select)) worlds.unshift(select);
  if (!worlds.length) {
    say('No worlds yet.\n\nType what you want above and press Build it.', true);
    return null;
  }

  const keep = select || pickEl.value;
  pickEl.innerHTML = '';
  for (const w of worlds) {
    const o = document.createElement('option');
    o.value = w;
    o.textContent = w.replace(/\.glb$/i, '');
    pickEl.appendChild(o);
  }
  pickEl.value = worlds.includes(keep) ? keep : worlds[0];
  if (select) await loadWorld(pickEl.value);
  return pickEl.value;
}

// ---- boot ----------------------------------------------------------------
async function boot() {
  walkSpeed = Number(speedEl.value);
  speedOut.textContent = walkSpeed.toFixed(1);
  setMode('build');            // start in build mode: nothing is grabbed yet
  refreshPropLibrary();
  pickEl.addEventListener('change', () => loadWorld(pickEl.value));

  const fromUrl = new URLSearchParams(location.search).get('world');
  const chosen = await refreshWorlds(null);
  if (!chosen) return;
  if (fromUrl) pickEl.value = fromUrl;
  await loadWorld(pickEl.value);

  // A build may already be running from a previous tab or an earlier reload.
  try {
    const job = await fetch('/api/generate', { cache: 'no-store' }).then((r) => r.json());
    if (job.state === 'running') {
      buildEl.disabled = true;
      buildEl.textContent = 'Building…';
      showBuild(job.message || 'Working…');
      pollTimer = setInterval(pollBuild, 2000);
    }
  } catch (_) { /* generation is optional; the viewer works without it */ }
}

// ---- build a new world from a prompt -------------------------------------
// The server runs the whole chain against ComfyUI, so the site does not need
// anything else driving it. Builds take minutes, so this polls rather than
// holding a request open.
const buildEl = document.getElementById('build');
const promptEl = document.getElementById('newPrompt');
const buildStatusEl = document.getElementById('buildStatus');
let pollTimer = null;

function showBuild(msg) {
  buildStatusEl.style.display = msg ? 'block' : 'none';
  buildStatusEl.textContent = msg || '';
}

async function pollBuild() {
  let job;
  try {
    job = await fetch('/api/generate', { cache: 'no-store' }).then((r) => r.json());
  } catch (_) {
    return;   // server restarting mid-build: keep polling rather than giving up
  }

  if (job.state === 'running') {
    showBuild(job.message || 'Working…');
    return;
  }

  clearInterval(pollTimer);
  pollTimer = null;
  buildEl.disabled = false;
  buildEl.textContent = 'Build it';

  if (job.state === 'error') {
    showBuild('Failed: ' + job.error);
    toast('Build failed');
    return;
  }
  if (job.state === 'done' && job.world) {
    const r = job.result || {};
    showBuild('Built ' + job.world + (r.megabytes ? ' · ' + r.megabytes + ' MB' : '')
      + (r.seamAfter !== undefined ? ' · seam ' + r.seamBefore + '→' + r.seamAfter : ''));
    toast('World ready: ' + job.world);
    await refreshWorlds(job.world);
  }
}

buildEl.addEventListener('click', async () => {
  const subject = promptEl.value.trim();
  if (subject.length < 3) return toast('Describe the place first');
  buildEl.disabled = true;
  buildEl.textContent = 'Building…';
  showBuild('Starting…');
  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: subject }),
    });
    const out = await res.json();
    if (!res.ok || out.error) throw new Error(out.error || ('HTTP ' + res.status));
    pollTimer = setInterval(pollBuild, 2000);
  } catch (err) {
    buildEl.disabled = false;
    buildEl.textContent = 'Build it';
    showBuild('Failed: ' + (err && err.message ? err.message : err));
  }
});

// Started last, deliberately: boot() touches the build-panel elements declared
// above, and calling it earlier would hit them in the temporal dead zone.
boot();
