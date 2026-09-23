// look.js - makes a MoGe panorama world look better, without relighting it.
//
// Drop this file next to app.js; apply_look.py adds the one import and the one
// call it needs. Everything here is additive and switchable: open the page with
// ?look=off to see the world exactly as it was before, side by side.
//
// What it does, and why each thing helps a single-panorama reconstruction:
//
// 1. DISTANCE DISSOLVE. The mesh is only trustworthy near where the panorama
//    was shot. Far away it turns into ragged edges, holes and stretched skin.
//    Instead of a flat fog colour, far surfaces fade into the panorama pixel
//    that lies in the SAME DIRECTION - the original image itself - so the ragged
//    edge of the world melts into the backdrop instead of cutting against it.
//    Inside the walkable zone nothing changes.
//
// 2. SECOND SPOKE PASS. app.js trims the worst stretched triangles; this trims
//    the next tier (the debris clump that was still visible near the hero).
//
// 3. FORM SHADING. The panorama's lighting is baked in, which reads as flat once
//    you look from a new angle. A very small up/down term (floors a touch
//    brighter, overhangs a touch darker) restores a sense of shape without the
//    muddy double-lighting that proper lights caused.
//
// 4. CONTACT SHADOW under the hero - a small soft blob, the single cue that most
//    makes a character look like it stands ON the floor. Small on purpose: the
//    big floor disc that broke twice was big.
//
// 5. LIGHT FOR THE HERO. The hero is a lit mesh; if the scene has no lights,
//    add a sky/ground light tinted from the panorama so it sits in the scene.
//
// 6. A GENTLE GRADE (contrast/saturation) on the whole canvas, applied equally
//    to mesh and backdrop so the two never disagree.

import * as THREE from 'three';

const DEFAULTS = {
  dissolveNear: 24,     // metres: nothing inside this changes (roam limit is 14)
  dissolveFar: 70,      // metres: beyond this you see the pure panorama
  shade: 0.07,          // +/- brightness for up/down facing surfaces
  spokeRatio: 0.40,     // app.js uses 0.55; this catches the next tier
  spokeMinEdge: 0.6,    // metres
  curtains: true,       // drop edge-on depth-jump skins (?curtains=off to compare)
  curtainCos: 0.12,     // |cos| between surface and capture ray below this = edge-on
  curtainMinEdge: 0.08, // metres; tiny triangles are harmless
  grade: 'contrast(1.05) saturate(1.08)',
  shadowRadius: 0.55,
  shadowOpacity: 0.5,
};

export function installLook({ scene, renderer, getWorld, getHero }, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  let curtains = 0;
  const params = new URLSearchParams(location.search);
  if (params.get('curtains') === 'off') cfg.curtains = false;
  const state = { on: params.get('look') !== 'off', patched: 0, extraSpokes: 0, pano: false, lightsAdded: false };
  publish();
  if (!state.on) return state;

  // Shared uniforms: every patched material points at these same objects, so
  // changing a value here updates all of them at once.
  const U = {
    uLookPano: { value: null },
    uLookHasPano: { value: 0 },
    uLookNear: { value: cfg.dissolveNear },
    uLookFar: { value: cfg.dissolveFar },
    uLookShade: { value: cfg.shade },
  };

  renderer.domElement.style.filter = cfg.grade;

  // ---- per-material shader patch ------------------------------------------
  function patch(material) {
    if (!material || material.userData.look || !material.isMeshBasicMaterial) return;
    material.userData.look = true;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLookWorld;')
        .replace('#include <project_vertex>',
          '#include <project_vertex>\nvLookWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', [
          '#include <common>',
          'varying vec3 vLookWorld;',
          'uniform sampler2D uLookPano;',
          'uniform float uLookHasPano, uLookNear, uLookFar, uLookShade;',
        ].join('\n'))
        .replace('#include <fog_fragment>', [
          '#include <fog_fragment>',
          '{',
          '  vec3 toFrag = vLookWorld - cameraPosition;',
          '  float d = length(toFrag);',
          '  vec3 dir = toFrag / max(d, 1e-4);',
          // Face normal from screen derivatives, turned to face the viewer so a
          // floor seen from above always has +y regardless of winding.
          '  vec3 fn = normalize(cross(dFdx(vLookWorld), dFdy(vLookWorld)));',
          '  if (dot(fn, dir) > 0.0) fn = -fn;',
          '  float nearW = 1.0 - smoothstep(uLookNear * 0.6, uLookNear, d);',
          '  gl_FragColor.rgb *= mix(1.0, 1.0 + uLookShade * fn.y, nearW);',
          '  if (uLookHasPano > 0.5) {',
          '    float f = smoothstep(uLookNear, uLookFar, d);',
          // Fixed LOD: automatic mip selection breaks at the u=0/1 wrap of an
          // equirect and draws a hairline seam.
          '    vec3 pano = linearToOutputTexel(textureLod(uLookPano, equirectUv(dir), 1.0)).rgb;',
          '    gl_FragColor.rgb = mix(gl_FragColor.rgb, pano, f);',
          '  }',
          '}',
        ].join('\n'));
    };
    material.customProgramCacheKey = () => 'look-v1';
    material.needsUpdate = true;
    state.patched++;
  }

  // ---- second spoke pass, in world space (metres) --------------------------
  function trimSpokes(root) {
    root.updateMatrixWorld(true);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nn = new THREE.Vector3(), cen = new THREE.Vector3();
    let dropped = 0; curtains = 0;
    root.traverse((o) => {
      if (!o.isMesh || o.userData.isGround) return;
      const geo = o.geometry, pos = geo.getAttribute('position');
      if (!pos) return;
      const idx = geo.getIndex();
      const count = idx ? idx.count : pos.count;
      const get = (i) => (idx ? idx.getX(i) : i);
      const kept = [];
      let d0 = 0;
      for (let t = 0; t < count; t += 3) {
        const i0 = get(t), i1 = get(t + 1), i2 = get(t + 2);
        a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
        b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
        c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
        const maxEdge = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
        const dist = (a.length() + b.length() + c.length()) / 3;   // capture point = origin
        if (maxEdge > cfg.spokeMinEdge && maxEdge > cfg.spokeRatio * dist) { d0++; continue; }
        // Curtains: surfaces the capture camera saw exactly edge-on. MoGe
        // stretches a skin across every depth jump (pillar in front of a wall)
        // and it faces sideways to the camera. From the capture point it is
        // invisible; one step to the side it is a smeared rubber sheet. Floors
        // are kept even at grazing angles.
        if (cfg.curtains) {
          e1.subVectors(b, a); e2.subVectors(c, a); nn.crossVectors(e1, e2);
          const len = nn.length();
          if (len > 1e-9 && maxEdge > cfg.curtainMinEdge) {
            nn.divideScalar(len);
            cen.addVectors(a, b).add(c).divideScalar(3).normalize();
            if (Math.abs(nn.y) < 0.9 && Math.abs(nn.dot(cen)) < cfg.curtainCos) { d0++; curtains++; continue; }
          }
        }
        kept.push(i0, i1, i2);
      }
      if (d0) {
        geo.setIndex(kept); geo.clearGroups(); dropped += d0;
        if (geo.boundsTree) geo.computeBoundsTree();   // keep the BVH in step with the index
      }
    });
    return dropped;
  }

  // ---- panorama-derived colours for the hero's light ------------------------
  function panoColours(tex) {
    try {
      const img = tex.image;
      const cv = document.createElement('canvas');
      cv.width = 64; cv.height = 32;
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, 64, 32);
      const band = (y0, y1) => {
        const d = g.getImageData(0, y0, 64, y1 - y0).data;
        let r = 0, gg = 0, bb = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; bb += d[i + 2]; }
        const n = d.length / 4;
        return new THREE.Color().setRGB(r / n / 255, gg / n / 255, bb / n / 255, THREE.SRGBColorSpace);
      };
      return { sky: band(0, 10), ground: band(24, 32) };
    } catch (_) {
      return { sky: new THREE.Color(0xdfe6ee), ground: new THREE.Color(0x6b6355) };
    }
  }

  let hemi = null, sun = null;
  function ensureLights(tex) {
    let has = false;
    scene.traverse((o) => { if (o.isLight && !o.userData.look) has = true; });
    if (has) return;
    const { sky, ground } = tex ? panoColours(tex) : panoColours(null);
    if (!hemi) {
      hemi = new THREE.HemisphereLight(sky, ground, 1.6);
      sun = new THREE.DirectionalLight(0xffffff, 1.4);
      sun.position.set(4, 9, 3);
      hemi.userData.look = sun.userData.look = true;
      scene.add(hemi, sun);
      state.lightsAdded = true;
    } else {
      hemi.color.copy(sky); hemi.groundColor.copy(ground);
    }
  }

  // ---- contact shadow ------------------------------------------------------
  const blobTex = (() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(0,0,0,1)');
    grd.addColorStop(0.55, 'rgba(0,0,0,0.45)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(cfg.shadowRadius, 32),
    new THREE.MeshBasicMaterial({
      map: blobTex, transparent: true, opacity: cfg.shadowOpacity, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false,
    })
  );
  blob.rotation.x = -Math.PI / 2;
  blob.renderOrder = 2;
  blob.userData.look = true;
  blob.visible = false;
  scene.add(blob);

  // ---- per-frame bookkeeping (no change to app.js's own loop) ---------------
  let lastWorld = null, lastBg = null;
  const prevBefore = scene.onBeforeRender;
  scene.onBeforeRender = function (...args) {
    if (prevBefore) prevBefore.apply(this, args);

    const bg = scene.background;
    if (bg !== lastBg) {
      lastBg = bg;
      const isPano = !!(bg && bg.isTexture);
      U.uLookPano.value = isPano ? bg : null;
      U.uLookHasPano.value = isPano ? 1 : 0;
      state.pano = isPano;
      ensureLights(isPano ? bg : null);
      publish();
    }

    let world = null;
    try { world = getWorld(); } catch (_) { /* never let polish break the frame */ }
    if (world && world !== lastWorld) {
      lastWorld = world;
      state.extraSpokes = trimSpokes(world);
      state.curtains = curtains;
      world.traverse((o) => {
        if (!o.isMesh) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(patch);
      });
      publish();
    }

    let hero = null;
    try { hero = getHero && getHero(); } catch (_) {}
    if (hero && hero.parent && hero.visible) {
      blob.visible = true;
      blob.position.set(hero.position.x, hero.position.y + 0.03, hero.position.z);
    } else {
      blob.visible = false;
    }
  };

  function publish() {
    try { document.body.dataset.look = JSON.stringify(state); } catch (_) {}
  }
  return state;
}
