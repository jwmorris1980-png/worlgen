"""Serve the world builder locally.

    python serve.py            # http://127.0.0.1:8777/viewer/
    python serve.py 9000       # pick a different port

Everything is local: no CDN, no account, no outbound network calls. three.js is
vendored under viewer/lib.

Layout
    worlds/     .glb world shells (the big panorama meshes)
    props/      .glb objects you drop onto the page
    scenes/     saved layouts, one JSON per world

API
    GET  /viewer/worlds.json     world .glb names, newest first
    GET  /api/props              prop .glb names
    GET  /api/scene?world=NAME   saved layout for that world
    POST /api/scene?world=NAME   save a layout (JSON body)
    POST /api/upload?name=FILE   store a dropped .glb into props/

Listens on 127.0.0.1 only - this writes files, so it is not for a public port.
"""

import http.server
import json
import os
import re
import socketserver
import sys
import threading

ROOT = os.path.dirname(os.path.abspath(__file__))
WORLDS = os.path.join(ROOT, "worlds")
PROPS = os.path.join(ROOT, "props")
SCENES = os.path.join(ROOT, "scenes")

MAX_UPLOAD = 256 * 1024 * 1024
SAFE = re.compile(r"[^A-Za-z0-9._ -]")


def safe_name(name, default="untitled"):
    """Strip anything that could escape the folder. Never trust a client path."""
    name = SAFE.sub("_", os.path.basename(name or "")).strip()
    return name or default


# ---- world generation job -------------------------------------------------
# One at a time: the GPU cannot run two of these at once, and a queue would only
# hide that. State lives in memory; a restart mid-build loses the status, not
# the output, because finished files are written straight into worlds/.
JOB = {"state": "idle", "message": "", "world": None, "error": None, "result": None}
JOB_LOCK = threading.Lock()


def run_build(subject, name):
    import worldgen                      # imported here so serve.py starts
                                          # even if numpy/Pillow are missing
    def progress(msg):
        with JOB_LOCK:
            JOB["message"] = msg

    try:
        with JOB_LOCK:
            JOB.update(state="running", message="Starting", world=None,
                       error=None, result=None)
        import engine
        # Starts the 3D engine only if it isn't already running, and stops it
        # again a few minutes after the build so it frees RAM and VRAM.
        with engine.session(progress):
            out = worldgen.build_world(subject, name, on_progress=progress)
        with JOB_LOCK:
            JOB.update(state="done", message="Finished", world=out["world"], result=out)
    except Exception as exc:
        with JOB_LOCK:
            JOB.update(state="error", message="", error="%s: %s" % (type(exc).__name__, exc))


def listing(folder, suffix=".glb"):
    try:
        names = [f for f in os.listdir(folder) if f.lower().endswith(suffix)]
    except FileNotFoundError:
        os.makedirs(folder, exist_ok=True)
        return []
    names.sort(key=lambda f: os.path.getmtime(os.path.join(folder, f)), reverse=True)
    return names


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    # -- helpers ----------------------------------------------------------
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _query(self, key, default=""):
        from urllib.parse import urlparse, parse_qs, unquote
        q = parse_qs(urlparse(self.path).query)
        return unquote(q.get(key, [default])[0])

    def _scene_path(self, world):
        stem = os.path.splitext(safe_name(world, "default"))[0]
        return os.path.join(SCENES, stem + ".json")

    # -- routes -----------------------------------------------------------
    def do_GET(self):
        route = self.path.split("?")[0]
        if route in ("/viewer/worlds.json", "/worlds.json"):
            return self._json(listing(WORLDS))
        if route == "/api/props":
            return self._json(listing(PROPS))
        if route == "/api/generate":
            with JOB_LOCK:
                return self._json(dict(JOB))
        if route == "/api/scene":
            path = self._scene_path(self._query("world"))
            if not os.path.isfile(path):
                return self._json({"objects": []})
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    return self._json(json.load(fh))
            except (OSError, ValueError) as exc:
                return self._json({"error": str(exc), "objects": []}, 200)
        return super().do_GET()

    def do_POST(self):
        route = self.path.split("?")[0]
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json({"error": "bad Content-Length"}, 400)
        if length <= 0 or length > MAX_UPLOAD:
            return self._json({"error": "body must be 1 byte to 256 MB"}, 413)
        body = self.rfile.read(length)

        if route == "/api/generate":
            try:
                req = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, ValueError) as exc:
                return self._json({"error": "invalid JSON: %s" % exc}, 400)
            subject = (req.get("prompt") or "").strip()
            if len(subject) < 3:
                return self._json({"error": "describe the place in a few words"}, 400)
            with JOB_LOCK:
                if JOB["state"] == "running":
                    return self._json({"error": "already building: " + JOB["message"]}, 409)
            t = threading.Thread(target=run_build, args=(subject, req.get("name")),
                                 daemon=True)
            t.start()
            return self._json({"ok": True, "state": "running"})

        if route == "/api/scene":
            try:
                data = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, ValueError) as exc:
                return self._json({"error": "invalid JSON: %s" % exc}, 400)
            os.makedirs(SCENES, exist_ok=True)
            path = self._scene_path(self._query("world"))
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2)
            return self._json({"ok": True, "saved": os.path.basename(path),
                               "objects": len(data.get("objects", []))})

        if route == "/api/upload":
            name = safe_name(self._query("name"), "dropped.glb")
            if not name.lower().endswith(".glb"):
                return self._json({"error": "only .glb files, got %r" % name}, 415)
            os.makedirs(PROPS, exist_ok=True)
            # Don't silently overwrite a prop already placed in someone's scene.
            stem, ext = os.path.splitext(name)
            final, n = name, 2
            while os.path.exists(os.path.join(PROPS, final)):
                final = "%s-%d%s" % (stem, n, ext)
                n += 1
            with open(os.path.join(PROPS, final), "wb") as fh:
                fh.write(body)
            return self._json({"ok": True, "name": final, "bytes": len(body)})

        return self._json({"error": "unknown endpoint %s" % route}, 404)

    def end_headers(self):
        # Blanket no-store meant the browser re-downloaded the whole 89 MB world
        # on every single load. Only the JSON endpoints actually change; the
        # .glb and the vendored three.js are immutable once written.
        path = self.path.split("?")[0].lower()
        # Cache the big immutable things: meshes, panoramas, vendored three.js.
        # NOT app.js / index.html - those are edited constantly, and caching them
        # means a fix silently never reaches the browser.
        heavy = path.endswith((".glb", ".png", ".jpg", ".jpeg")) or "/lib/" in path
        if heavy:
            self.send_header("Cache-Control", "public, max-age=604800")
        else:
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        # .glb must arrive as a binary model type or GLTFLoader rejects it.
        if path.lower().endswith(".glb"):
            return "model/gltf-binary"
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    for d in (WORLDS, PROPS, SCENES):
        os.makedirs(d, exist_ok=True)
    # Threaded: the single-threaded server stalled the whole page while one
    # 89 MB .glb streamed, so worlds.json and the props list queued behind it.
    class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
        daemon_threads = True
        allow_reuse_address = True

    with Server(("127.0.0.1", port), Handler) as httpd:
        print("World builder: http://127.0.0.1:%d/viewer/" % port)
        print("  worlds: %s" % WORLDS)
        print("  props : %s   (or just drag a .glb onto the page)" % PROPS)
        print("  scenes: %s" % SCENES)
        print("Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")
        finally:
            try:
                import engine
                engine.shutdown()          # never leave our engine holding VRAM
            except Exception:
                pass


if __name__ == "__main__":
    main()
