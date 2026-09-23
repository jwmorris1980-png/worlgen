"""Build a walkable world from a text prompt, start to finish.

    python worldgen.py "an overgrown stone temple courtyard at golden hour" --name temple

Talks to a running ComfyUI over its own HTTP API - no comfy-cli, no MCP, no
Claude. That is the point: the web UI calls this, so the site works on its own.

The chain
    1. Z-Image-Turbo paints a 2048x1024 equirectangular panorama.
    2. The panorama is rolled half a turn so its wrap seam sits mid-frame, a
       narrow band there is repainted, and it is rolled back. A generated
       panorama does not wrap on its own, and MoGe builds that mismatch into
       the world as a seam floor to sky.
    3. MoGe splits the panorama into perspective views, merges them into depth,
       and emits a textured GLB.
    4. The GLB and a JPEG of the panorama land in worlds/. The viewer shows the
       JPEG as the sky behind everything, so holes read as scenery, not void.

Only Z-Image and MoGe weights are needed; both are local and free to run.
"""

import json
import os
import shutil
import time
import urllib.request

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
WORLDS = os.path.join(HERE, "worlds")
SHARED = os.path.abspath(os.path.join(HERE, ".."))

COMFY = os.environ.get("COMFY_URL", "http://127.0.0.1:8189")
COMFY_IN = os.environ.get("COMFY_INPUT", os.path.join(SHARED, "input"))
COMFY_OUT = os.environ.get("COMFY_OUTPUT", os.path.join(SHARED, "output"))

UNET = "z_image_turbo_int8_convrot.safetensors"
CLIP = "qwen_3_4b_fp4_mixed.safetensors"
VAE = "ae.safetensors"
MOGE = "moge_2_vitl_normal_fp16.safetensors"

NEGATIVE = "seam, split, discontinuity, mismatched halves, people, text, watermark"


# ---- talking to ComfyUI --------------------------------------------------

def _post(path, payload):
    req = urllib.request.Request(
        COMFY + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def _get(path):
    with urllib.request.urlopen(COMFY + path, timeout=30) as r:
        return json.loads(r.read().decode())


def comfy_is_up():
    try:
        _get("/system_stats")
        return True
    except Exception:
        return False


def run_graph(graph, label, on_progress=None, timeout=1800):
    """Submit an API-format graph and block until it finishes.

    Returns the list of output files it produced, as (filename, subfolder)."""
    prompt_id = _post("/prompt", {"prompt": graph})["prompt_id"]
    started = time.time()
    while True:
        hist = _get("/history/" + prompt_id)
        entry = hist.get(prompt_id)
        if entry:
            status = (entry.get("status") or {})
            if status.get("status_str") == "error" or status.get("completed") is False:
                raise RuntimeError("%s failed inside ComfyUI - check its log" % label)
            files = []
            for out in (entry.get("outputs") or {}).values():
                for items in out.values():
                    if isinstance(items, list):
                        for it in items:
                            if isinstance(it, dict) and "filename" in it:
                                files.append((it["filename"], it.get("subfolder", "")))
            if files:
                return files
            if entry.get("outputs") is not None:
                raise RuntimeError("%s produced no files" % label)
        waited = time.time() - started
        if waited > timeout:
            raise TimeoutError("%s still running after %ds" % (label, timeout))
        if on_progress and int(waited) % 5 == 0:
            on_progress("%s… %ds" % (label, int(waited)))
        time.sleep(1.5)


# ---- graphs ---------------------------------------------------------------

def _zimage_base(prompt, seed):
    """Loaders and conditioning shared by the painting and healing passes."""
    return {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": CLIP, "type": "lumina2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "4": {"class_type": "ModelSamplingAuraFlow",
              "inputs": {"model": ["1", 0], "shift": 3.0}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": NEGATIVE}},
    }


def panorama_graph(subject, seed, width, height, prefix):
    # The wording matters as much as the model: asking for an equirectangular
    # projection with a level horizon is what makes MoGe's split-and-merge work.
    prompt = (
        "equirectangular 360 degree spherical panorama, seamless horizontal wrap, "
        + subject.strip().rstrip(".")
        + ", level horizon, open sky above, detailed ground below, "
          "video game environment art, no people, no text, highly detailed, "
          "even natural lighting"
    )
    g = _zimage_base(prompt, seed)
    g["7"] = {"class_type": "EmptySD3LatentImage",
              "inputs": {"width": width, "height": height, "batch_size": 1}}
    g["8"] = {"class_type": "KSampler", "inputs": {
        "model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0],
        "latent_image": ["7", 0], "seed": seed, "steps": 8, "cfg": 1.0,
        "sampler_name": "res_multistep", "scheduler": "simple", "denoise": 1.0}}
    g["9"] = {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}}
    g["10"] = {"class_type": "SaveImage",
               "inputs": {"images": ["9", 0], "filename_prefix": prefix}}
    return g


def heal_graph(image_name, mask_name, subject, seed, prefix):
    """Repaint ONLY a band over the seam.

    The mask is load-bearing. An unmasked img2img pass heals the middle but
    leaves a fresh mismatch at its own frame edges - which, after rolling back,
    is just the same seam in a new place. Masking preserves everything outside
    the band exactly, so nothing new breaks."""
    prompt = ("equirectangular 360 degree panorama, " + subject.strip().rstrip(".")
              + ", continuous unbroken scenery, no vertical seam, consistent sky")
    g = _zimage_base(prompt, seed)
    g["7"] = {"class_type": "LoadImage", "inputs": {"image": image_name, "upload": "image"}}
    g["8"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["7", 0], "vae": ["3", 0]}}
    g["11"] = {"class_type": "LoadImageMask",
               "inputs": {"image": mask_name, "channel": "red", "upload": "image"}}
    g["12"] = {"class_type": "SetLatentNoiseMask",
               "inputs": {"samples": ["8", 0], "mask": ["11", 0]}}
    g["9"] = {"class_type": "KSampler", "inputs": {
        "model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0],
        "latent_image": ["12", 0], "seed": seed, "steps": 8, "cfg": 1.0,
        "sampler_name": "res_multistep", "scheduler": "simple", "denoise": 0.85}}
    g["10"] = {"class_type": "VAEDecode", "inputs": {"samples": ["9", 0], "vae": ["3", 0]}}
    g["13"] = {"class_type": "SaveImage",
               "inputs": {"images": ["10", 0], "filename_prefix": prefix}}
    return g


def mesh_graph(image_name, prefix, split=1024, merge=2048, decimation=4, gap=0.18):
    """Panorama -> textured GLB.

    decimation=4 is not a quality compromise worth agonising over: it took the
    temple world from 89 MB to 8 MB with no visible difference at walking
    distance, and 89 MB is a black screen for ten seconds."""
    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": image_name, "upload": "image"}},
        "2": {"class_type": "LoadMoGeModel", "inputs": {"model_name": MOGE}},
        "3": {"class_type": "MoGePanoramaInference", "inputs": {
            "moge_model": ["2", 0], "image": ["1", 0], "resolution_level": 9,
            "split_resolution": split, "merge_resolution": merge, "batch_size": 4}},
        "4": {"class_type": "MoGePointMapToMesh", "inputs": {
            "moge_geometry": ["3", 0], "batch_index": 0, "decimation": decimation,
            "discontinuity_threshold": gap, "texture": True}},
        "5": {"class_type": "SaveGLB",
              "inputs": {"mesh": ["4", 0], "filename_prefix": prefix}},
    }


# ---- image helpers --------------------------------------------------------

def roll_half(src, dst):
    """Move the wrap seam to the middle of the frame, or back again.

    Rolling is a column permutation: exact, lossless, and its own inverse."""
    a = np.asarray(Image.open(src).convert("RGB"))
    Image.fromarray(np.roll(a, a.shape[1] // 2, axis=1)).save(dst)


def seam_error(path):
    """Mean difference between the wrap-around edges, 0-255. Lower is better."""
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.float32)
    return float(np.abs(a[:, 0, :] - a[:, -1, :]).mean())


def write_mask(width, height, dst, band_fraction=0.16, feather=0.35):
    x = np.arange(width)
    half = width * band_fraction / 2
    m = np.clip((half - np.abs(x - width // 2)) / max(half * feather, 1), 0, 1)
    rows = (m[None, :].repeat(height, axis=0) * 255).astype(np.uint8)
    Image.fromarray(np.dstack([rows] * 3)).save(dst)


def _out_path(filename, subfolder):
    return os.path.join(COMFY_OUT, subfolder, filename) if subfolder \
        else os.path.join(COMFY_OUT, filename)


def safe_stem(name):
    keep = "".join(c if (c.isalnum() or c in "-_ ") else "_" for c in (name or ""))
    return keep.strip().replace(" ", "_").lower() or "world"


# ---- the pipeline ---------------------------------------------------------

def build_world(subject, name=None, seed=None, width=2048, height=1024, on_progress=None):
    """Prompt in, world out. Returns a summary dict."""
    def say(msg):
        if on_progress:
            on_progress(msg)

    if not comfy_is_up():
        raise RuntimeError("ComfyUI is not answering at %s. Start it and retry." % COMFY)

    stem = safe_stem(name or subject[:40])
    seed = int(seed if seed is not None else (time.time() * 1000) % 2**31)
    os.makedirs(WORLDS, exist_ok=True)
    os.makedirs(COMFY_IN, exist_ok=True)

    say("Painting the panorama")
    files = run_graph(panorama_graph(subject, seed, width, height, "wg_" + stem),
                      "Painting the panorama", on_progress)
    pano = _out_path(*files[0])
    before = seam_error(pano)

    say("Closing the wrap seam (was %.1f/255)" % before)
    rolled = os.path.join(COMFY_IN, "wg_%s_rolled.png" % stem)
    mask = os.path.join(COMFY_IN, "wg_%s_mask.png" % stem)
    roll_half(pano, rolled)
    write_mask(width, height, mask)
    healed_files = run_graph(
        heal_graph(os.path.basename(rolled), os.path.basename(mask),
                   subject, seed + 1, "wg_%s_healed" % stem),
        "Closing the seam", on_progress)
    healed = _out_path(*healed_files[0])
    final = os.path.join(COMFY_IN, "wg_%s_final.png" % stem)
    roll_half(healed, final)          # roll back: the seam returns to the edge
    after = seam_error(final)
    say("Seam %.1f -> %.1f / 255" % (before, after))

    say("Reconstructing geometry")
    glb_files = run_graph(mesh_graph(os.path.basename(final), "wg/%s" % stem),
                          "Reconstructing geometry", on_progress)
    glb = _out_path(*glb_files[0])

    say("Publishing")
    world_glb = os.path.join(WORLDS, stem + ".glb")
    shutil.copyfile(glb, world_glb)
    # The panorama beside the mesh is what the viewer shows behind the holes.
    Image.open(final).convert("RGB").save(
        os.path.join(WORLDS, stem + ".jpg"), quality=88, optimize=True)

    return {
        "world": stem + ".glb",
        "seedUsed": seed,
        "seamBefore": round(before, 2),
        "seamAfter": round(after, 2),
        "megabytes": round(os.path.getsize(world_glb) / 1048576, 1),
    }


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Build a walkable world from a prompt.")
    ap.add_argument("subject", help="what the place is, e.g. 'a flooded subway station'")
    ap.add_argument("--name", help="file name for the world (default: from the prompt)")
    ap.add_argument("--seed", type=int)
    ap.add_argument("--width", type=int, default=2048)
    ap.add_argument("--height", type=int, default=1024)
    a = ap.parse_args()

    if a.width != a.height * 2:
        print("note: equirectangular wants width exactly 2x height")

    t0 = time.time()
    result = build_world(a.subject, a.name, a.seed, a.width, a.height,
                         on_progress=lambda m: print("  " + m, flush=True))
    print("\ndone in %ds" % int(time.time() - t0))
    for k, v in result.items():
        print("  %-12s %s" % (k, v))
