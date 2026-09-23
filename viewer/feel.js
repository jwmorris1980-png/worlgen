// feel.js - makes walking FEEL like walking, without a rigged character.
//
// The Hunyuan3D hero is a static statue: no skeleton, so no leg animation. A
// body that glides at constant height reads as a chess piece being pushed. What
// sells a walk is mostly not the legs:
//   - a small rise and fall twice per stride, a slight side-to-side roll, and a
//     forward lean that follows speed;
//   - a footstep sound on every stride, in a room that sounds like the room;
//   - breathing when standing still, so the figure is never frozen.
// All of it is procedural. The sounds are synthesised with WebAudio (filtered
// noise + a low thump through a generated reverb), so there are no audio files
// and nothing leaves the machine. Press M to mute.

import * as THREE from 'three';

const STRIDE = 0.78;       // metres per step
const BOB = 0.032;         // metres of rise per step at walking pace
const ROLL = 0.035;        // radians of side sway
const LEAN = 0.07;         // radians of forward lean at full walk
const WALK = 1.4;          // m/s that counts as "a normal walk"

export function installFeel({ scene, getHero, getWorld, getMode }) {
  const state = { steps: 0, muted: false, audio: 'off', wet: 0 };
  let lastHero = null, model = null, baseY = 0;
  let lastPos = new THREE.Vector3(), lastT = performance.now();
  let phase = 0, speedS = 0, leanS = 0, lastWorld = null;

  // ---- audio ---------------------------------------------------------------
  let ctx = null, master = null, wetGain = null, noiseBuf = null;
  function impulse(seconds, decay) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return b;
  }
  function ensureAudio() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain(); master.gain.value = 0.55;
      const verb = ctx.createConvolver(); verb.buffer = impulse(2.4, 3.2);
      wetGain = ctx.createGain(); wetGain.gain.value = state.wet;
      master.connect(ctx.destination);
      master.connect(verb); verb.connect(wetGain); wetGain.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.2), ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      state.audio = 'on';
    } catch (_) { ctx = null; state.audio = 'unavailable'; }
  }
  // Browsers only allow sound after a real key press or click.
  addEventListener('keydown', ensureAudio);
  addEventListener('pointerdown', ensureAudio);
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyM' || (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName))) return;
    state.muted = !state.muted;
    if (master) master.gain.value = state.muted ? 0 : 0.55;
    publish();
  });

  function footstep(intensity) {
    state.steps++;
    if (!ctx || state.muted || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    // Scuff: band-passed noise, pitch varied a little every step.
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = 650 + Math.random() * 700; bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5 * intensity, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    src.connect(bp); bp.connect(g); g.connect(master);
    src.start(t); src.stop(t + 0.16);
    // Heel: a short low thump.
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(95 + Math.random() * 20, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.08);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.35 * intensity, t + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(og); og.connect(master);
    o.start(t); o.stop(t + 0.1);
  }

  // How enclosed is this world? Cast rays upward from the capture point: a
  // nave with a vaulted roof catches nearly all of them, an open courtyard few.
  // That decides how much echo the footsteps get.
  function measureRoom(world) {
    const rc = new THREE.Raycaster(); rc.far = 60;
    rc.firstHitOnly = true;
    let hit = 0, total = 0;
    const o = new THREE.Vector3(0, 0, 0), d = new THREE.Vector3();
    for (const el of [30, 50, 70, 88]) {
      const e = (el * Math.PI) / 180;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        d.set(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a));
        rc.set(o, d); total++;
        if (rc.intersectObject(world, true).length) hit++;
      }
    }
    const enclosed = hit / total;
    state.wet = +(0.08 + 0.42 * enclosed).toFixed(2);
    state.enclosed = +enclosed.toFixed(2);
    if (wetGain) wetGain.gain.value = state.wet;
  }

  // ---- per frame -------------------------------------------------------------
  const prev = scene.onBeforeRender;
  scene.onBeforeRender = function (...args) {
    if (prev) prev.apply(this, args);
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;

    let world = null;
    try { world = getWorld(); } catch (_) {}
    if (world && world !== lastWorld) { lastWorld = world; try { measureRoom(world); } catch (_) {} publish(); }
    if (wetGain && ctx) wetGain.gain.value = state.wet;

    let hero = null;
    try { hero = getHero(); } catch (_) {}
    if (!hero || !hero.children.length) return;
    if (hero !== lastHero) {
      lastHero = hero; model = hero.children[0];
      baseY = model.position.y;
      lastPos.copy(hero.position);
      phase = 0;
    }
    let walking = true;
    try { walking = getMode() === 'walk'; } catch (_) {}

    const dx = hero.position.x - lastPos.x, dz = hero.position.z - lastPos.z;
    const dist = Math.hypot(dx, dz);
    lastPos.copy(hero.position);
    // Teleports (loading a world, respawn) are not steps.
    const speed = dt > 0 && dist < 1.5 ? dist / dt : 0;
    speedS += (speed - speedS) * Math.min(1, 8 * dt);
    const k = Math.min(1.6, speedS / WALK);

    if (walking && speedS > 0.15) {
      const before = Math.floor(phase / Math.PI);
      phase += (dist / STRIDE) * Math.PI;
      if (Math.floor(phase / Math.PI) !== before) footstep(Math.min(1, 0.45 + 0.4 * k));
    } else {
      // Settle the stride back to standing.
      const target = Math.round(phase / Math.PI) * Math.PI;
      phase += (target - phase) * Math.min(1, 6 * dt);
    }

    leanS += (LEAN * Math.min(1, k) - leanS) * Math.min(1, 5 * dt);
    const breathe = 1 + 0.006 * Math.sin(now * 0.0017) * (1 - Math.min(1, k));
    model.position.y = baseY + Math.abs(Math.sin(phase)) * BOB * Math.min(1.3, k);
    model.rotation.z = Math.sin(phase) * ROLL * Math.min(1, k);
    model.rotation.x = leanS;
    model.scale.y = model.scale.x * breathe;
  };

  function publish() {
    try { document.body.dataset.feel = JSON.stringify(state); } catch (_) {}
  }
  setInterval(publish, 1000);
  return state;
}
