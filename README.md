# worlgen - walkable 3D worlds from text, entirely local

The name is spelled **worlgen** on purpose: "worldgen" is too common.
(The local folder is still called `worldgen`; only the project name differs.)

Type a prompt, get a world you can walk around in. Runs on one PC with ComfyUI;
no cloud services, no API keys.

Double-click **worlgen.bat**. That's the only thing to start: it opens the site,
and pressing *Build it* starts the 3D engine (ComfyUI's backend, headless - no
window, no web UI) by itself, then stops it a few minutes after the build so it
frees RAM and VRAM. Closing the worlgen window stops everything.

    worlgen.bat            # or: python serve.py, then http://127.0.0.1:8777/viewer/

Pipeline (worldgen.py, driven through ComfyUI's HTTP API on port 8189):
Z-Image-Turbo panorama -> seam repair (masked inpaint) -> MoGe 360 depth -> textured GLB.

Viewer (viewer/): three.js, vendored in viewer/lib.
- app.js     viewer, scene editor (drag .glb props in), third-person hero
- look.js    render polish: distance dissolve into the panorama, spike/curtain removal
- ground.js  fills holes in the walkable floor; BVH-accelerated raycasts
- feel.js    walk bob/sway/lean, synthesised footsteps with room echo (M mutes)

Controls: Mode: Play, then W A S D (Shift runs). Click the scene for mouse-look.
Test hooks: ?look=off, ?ground=off, ?curtains=off, ?spawn=x,z,yaw
