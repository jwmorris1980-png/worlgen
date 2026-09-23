// ground.js - makes the area around you a floor you can actually walk on.
//
// A single-panorama reconstruction is full of holes in the floor: everywhere the
// original camera could not see the ground (behind a pew, a pillar, a step) and
// straight down beneath the capture point, where there is no geometry at all.
// Through those holes you see the backdrop sky, and the hero falls back to a
// guessed height.
//
// This builds a "ground skin" across the whole walkable area:
//   - it follows the REAL floor, sampled on a 25 cm grid, and sits 6 cm beneath
//     it, so wherever the reconstruction has floor, the reconstruction wins and
//     the skin is never seen;
//   - across holes and under obstacles it carries the floor on smoothly, from
//     the surrounding floor heights;
//   - it is textured by projecting the panorama from the capture point - which
//     is exactly how the reconstruction's own floor got its texture - so it
//     matches in colour and pattern.
// It is a child of the world, so walking, the hero's footing and the camera all
// treat it as floor with no other changes.
//
// It also turns on three-mesh-bvh (vendored in lib/, no CDN): without it every
// floor probe tests all 250k triangles, and the skin alone needs ~19k probes.
//
// Why this is not the floor disc that failed twice: that was ONE flat plane at
// one height, so wherever the real floor sloped or dipped it poked through at a
// grazing angle and painted the screen beige. This skin has the real floor's
// shape at every grid point.

import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from './lib/three-mesh-bvh.module.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** Build (or rebuild) the BVH for every mesh under root. Cheap to call again. */
export function accelerate(root) {
  let n = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry || o.userData.isGround) return;
    if (o.geometry.boundsTree) o.geometry.disposeBoundsTree();
    o.geometry.computeBoundsTree();
    n++;
  });
  return n;
}

const DOWN = new THREE.Vector3(0, -1, 0);

// Box blur over a grid, ignoring cells with no value (weight 0).
function blur(vals, wts, n, r) {
  const outV = new Float32Array(n * n), outW = new Float32Array(n * n);
  const tmpV = new Float32Array(n * n), tmpW = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {                     // rows
    let sv = 0, sw = 0;
    for (let i = -r; i < n; i++) {
      const add = i + r, sub = i - r - 1;
      if (add < n) { sv += vals[j * n + add] * wts[j * n + add]; sw += wts[j * n + add]; }
      if (sub >= 0) { sv -= vals[j * n + sub] * wts[j * n + sub]; sw -= wts[j * n + sub]; }
      if (i >= 0) { tmpV[j * n + i] = sv; tmpW[j * n + i] = sw; }
    }
  }
  for (let i = 0; i < n; i++) {                     // columns
    let sv = 0, sw = 0;
    for (let j = -r; j < n; j++) {
      const add = j + r, sub = j - r - 1;
      if (add < n) { sv += tmpV[add * n + i]; sw += tmpW[add * n + i]; }
      if (sub >= 0) { sv -= tmpV[sub * n + i]; sw -= tmpW[sub * n + i]; }
      if (j >= 0) { outV[j * n + i] = sv; outW[j * n + i] = sw; }
    }
  }
  return { v: outV, w: outW };
}

function makeMaterial(pano) {
  return new THREE.ShaderMaterial({
    uniforms: { pano: { value: pano && pano.isTexture ? pano : null },
                hasPano: { value: pano && pano.isTexture ? 1 : 0 },
                tint: { value: new THREE.Color(0x6b6355) } },
    vertexShader: /* glsl */`
      attribute float fill;
      varying vec3 vW;
      varying float vFill;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vFill = fill;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      uniform sampler2D pano;
      uniform float hasPano;
      uniform vec3 tint;
      varying vec3 vW;
      varying float vFill;
      void main() {
        // The capture point is the world origin: look back along the ray the
        // panorama camera would have seen this spot on.
        vec3 d = normalize(vW);
        // Softer where the skin is filling a hole (the projected pixel there is
        // whatever stood in front of the missing floor) and near the nadir,
        // where the equirect squeezes a whole row into one point.
        float lod = mix(0.5, 3.0, vFill) + 4.0 * smoothstep(0.88, 0.995, -d.y);
        vec3 c = hasPano > 0.5 ? textureLod(pano, equirectUv(d), lod).rgb : tint;
        gl_FragColor = linearToOutputTexel(vec4(c, 1.0));
      }`,
    side: THREE.DoubleSide,
    polygonOffset: true,         // lose every depth tie to the real floor
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  });
}

/**
 * @param world  the fitted world root (scaled to metres, capture point at origin)
 * @param opts   { floorY, radius, cell, pano }
 * @returns stats { cells, realFloor, filled, ms }
 */
export function buildGround(world, { floorY, radius = 17, cell = 0.25, pano = null } = {}) {
  const t0 = performance.now();
  // ?ground=off shows the world without the skin, for comparison.
  if (new URLSearchParams(location.search).get('ground') === 'off') { accelerate(world); return { off: true, filled: 0 }; }
  const old = world.userData.ground;
  if (old) { old.parent && old.parent.remove(old); old.geometry.dispose(); old.material.dispose(); }

  world.updateMatrixWorld(true);
  accelerate(world);

  const n = Math.ceil((2 * radius) / cell) + 1;
  const half = ((n - 1) * cell) / 2;
  const R2 = (radius + cell) * (radius + cell);
  const rc = new THREE.Raycaster();
  const from = new THREE.Vector3(), nrm = new THREE.Vector3();
  const top = floorY + 1.2;
  const hits = new Array(n * n);
  let inside = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i, x = -half + i * cell, z = -half + j * cell;
      if (x * x + z * z > R2) { hits[k] = null; continue; }
      inside++;
      const rr = Math.hypot(x, z);
      from.set(x, top, z);
      rc.set(from, DOWN);
      rc.far = 3.4 + 0.35 * rr;   // reconstructed floors droop with distance
      const hs = rc.intersectObject(world, true);
      if (!hs.length) { hits[k] = null; continue; }
      // Keep only floor-like hits (surface facing up or down, not walls).
      const ys = [];
      for (const h of hs) {
        if (!h.face) continue;
        nrm.copy(h.face.normal).transformDirection(h.object.matrixWorld);
        if (Math.abs(nrm.y) > 0.6) ys.push(h.point.y);
      }
      hits[k] = ys.length ? ys : null;
    }
  }

  // Which hit is THE floor? Start from the measured floor height everywhere,
  // pick the hit nearest that estimate, smooth the picks into a new estimate,
  // and tighten. Tables, pew tops and step risers are rejected as "not floor"
  // and the skin carries on beneath them.
  // A single-panorama floor is not flat: depth error grows with distance, so
  // the reconstructed floor sags away from the capture point (the cathedral's is
  // ~1.8 m lower at 10 m). Fit that sag as a smooth radial profile h(r) from the
  // lowest floor-like hits in each 1 m ring, and use it wherever there is no
  // floor to copy - otherwise the skin floats above the far floor and buries
  // the bases of pillars.
  const ringN = Math.ceil(radius) + 1, ringYs = Array.from({ length: ringN }, () => []);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i; if (!hits[k]) continue;
    const r = Math.hypot(-half + i * cell, -half + j * cell);
    ringYs[Math.min(ringN - 1, Math.floor(r))].push(Math.min(...hits[k]));
  }
  // Weighted least squares for a straight sag y = a + b r, anchored at the
  // measured floor under the capture point. (A quadratic fitted the near rings
  // but extrapolated into a 30-degree slope at the edge of the walkable area.)
  let sw = 0, sr = 0, sy = 0, srr = 0, sry = 0;
  const addPt = (r, y, w) => { sw += w; sr += w * r; sy += w * y; srr += w * r * r; sry += w * r * y; };
  addPt(0, floorY, 200);
  for (let r = 0; r < Math.min(ringN, 13); r++) {     // far rings are mostly not floor
    const ys = ringYs[r]; if (ys.length < 6) continue;
    ys.sort((a, b) => a - b);
    addPt(r + 0.5, ys[Math.floor(ys.length * 0.4)], Math.min(ys.length, 300));
  }
  const den = sw * srr - sr * sr;
  let pb = Math.abs(den) > 1e-9 ? (sw * sry - sr * sy) / den : 0;
  pb = THREE.MathUtils.clamp(pb, -0.3, 0.1);          // never steeper than ~17 degrees
  const pa = (sy - pb * sr) / sw, pc = 0;
  const profile = (r) => pa + pb * r;
  let est = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) est[j * n + i] = profile(Math.hypot(-half + i * cell, -half + j * cell));
  const prof = new Float32Array(est);
  const chosen = new Float32Array(n * n), has = new Float32Array(n * n);
  for (const tol of [1.0, 0.5, 0.25]) {
    for (let k = 0; k < n * n; k++) {
      has[k] = 0;
      const hs = hits[k];
      if (!hs) continue;
      let best = null, bd = Infinity;
      for (const y of hs) { const d = Math.abs(y - est[k]); if (d < bd) { bd = d; best = y; } }
      if (bd < tol) { chosen[k] = best; has[k] = 1; }
    }
    const b = blur(chosen, has, n, 8);   // 2 m neighbourhood
    const next = new Float32Array(n * n);
    for (let k = 0; k < n * n; k++) {
      // Blend from local floor (plenty of samples nearby) to the profile (none).
      const t = Math.min(1, b.w[k] / 12);
      next[k] = b.w[k] > 0 ? t * (b.v[k] / b.w[k]) + (1 - t) * prof[k] : prof[k];
    }
    est = next;
  }

  // Holes: fill value smoothly into the gap so it meets the surrounding floor.
  const holeMask = new Float32Array(n * n);
  let real = 0;
  for (let k = 0; k < n * n; k++) { holeMask[k] = has[k] ? 0 : 1; if (has[k] && hits[k]) real++; }
  const fb = blur(holeMask, new Float32Array(n * n).fill(1), n, 2);

  const pos = new Float32Array(n * n * 3);
  const fill = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i, x = -half + i * cell, z = -half + j * cell;
      let y = (has[k] ? chosen[k] : est[k]) - 0.06;
      const r = Math.hypot(x, z);
      if (r > radius - cell) y -= 0.3;                // tuck the rim under the real floor
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      fill[k] = Math.min(1, fb.v[k] / Math.max(fb.w[k], 1e-6));
    }
  }
  const index = [];
  const inR = (i, j) => { const x = -half + i * cell, z = -half + j * cell; return x * x + z * z <= radius * radius; };
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      if (!(inR(i, j) && inR(i + 1, j) && inR(i, j + 1) && inR(i + 1, j + 1))) continue;
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('fill', new THREE.BufferAttribute(fill, 1));
  geo.setIndex(index);
  geo.computeBoundingSphere();
  geo.computeBoundsTree();

  const mesh = new THREE.Mesh(geo, makeMaterial(pano));
  mesh.userData.isGround = true;
  mesh.userData.isWorld = true;
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  // The world root is scaled to metres; the skin is built in metres already.
  const s = world.scale.x || 1;
  mesh.scale.setScalar(1 / s);
  world.add(mesh);
  world.userData.ground = mesh;

  // Per-ring diagnostics: how much floor each distance band actually has.
  const rings = [];
  for (let r0 = 0; r0 < radius; r0 += 2) {
    let c = 0, anyHit = 0, acc = 0; const ys = [], es = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i, x = -half + i * cell, z = -half + j * cell, r = Math.hypot(x, z);
      if (r < r0 || r >= r0 + 2) continue;
      c++; if (hits[k]) { anyHit++; ys.push(hits[k][0]); } if (has[k]) acc++; es.push(est[k]);
    }
    ys.sort((a, b) => a - b); es.sort((a, b) => a - b);
    rings.push([r0, c, anyHit, acc, ys.length ? +ys[ys.length >> 1].toFixed(2) : null, +es[es.length >> 1].toFixed(2)]);
  }
  try { document.body.dataset.groundRings = JSON.stringify(rings); } catch (_) {}
  // How far out the reconstruction is trustworthy: the first 1 m ring where
  // less than a quarter of the ground was actually seen. Past that you are mostly
  // walking on fill, looking at surfaces the panorama never captured.
  let walkRadius = radius - 3;
  for (let r = 3; r < ringN; r++) {
    let c = 0, seen = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const rr = Math.hypot(-half + i * cell, -half + j * cell);
      if (rr < r || rr >= r + 1) continue;
      c++; if (hits[j * n + i]) seen++;
    }
    if (c && seen / c < 0.25) { walkRadius = Math.max(4, r); break; }
  }
  walkRadius = Math.min(walkRadius, radius - 3);
  const stats = { walkRadius, profile: [+pa.toFixed(3), +pb.toFixed(4), +pc.toFixed(5)], cells: inside, realFloor: real, filled: inside - real,
                  filledPct: +(100 * (inside - real) / Math.max(inside, 1)).toFixed(1),
                  ms: Math.round(performance.now() - t0) };
  try { document.body.dataset.ground = JSON.stringify(stats); } catch (_) {}
  return stats;
}

/** Point the skin's texture at a (new) panorama. */
export function setGroundPano(world, pano) {
  const g = world && world.userData.ground;
  if (!g) return;
  g.material.uniforms.pano.value = pano && pano.isTexture ? pano : null;
  g.material.uniforms.hasPano.value = pano && pano.isTexture ? 1 : 0;
}
