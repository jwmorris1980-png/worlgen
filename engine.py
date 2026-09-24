"""engine.py - runs the AI engine only while a world is being built.

The engine is ComfyUI's backend: it is what actually runs Z-Image and MoGe.
It is started headless (no window, no web UI opened), used through its HTTP
API, and stopped again after a short idle period so it gives back the RAM and
VRAM its models hold. Nothing needs to be started by hand.

If an engine is already running on the port (e.g. the Comfy Desktop app), it
is used as-is and left running - only an engine this file started is stopped.

Settings (environment variables, all optional):
    COMFY_DIR          the ComfyUI folder containing main.py
    COMFY_MODEL_PATHS  extra_model_paths yaml (default: newest one the desktop app wrote)
    ENGINE_KEEPALIVE   seconds to keep the engine after a build (default 180)
"""
import glob
import os
import subprocess
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = os.path.abspath(os.path.join(HERE, ".."))
PORT = 8189
URL = "http://127.0.0.1:%d" % PORT
COMFY_DIR = os.environ.get("COMFY_DIR", r"D:\Comfy-Desktop\ComfyUI-Installs\iamgod\ComfyUI")
KEEPALIVE = int(os.environ.get("ENGINE_KEEPALIVE", "180"))
LOG = os.path.join(HERE, "engine.log")

_lock = threading.Lock()
_proc = None          # the engine process, if we started it
_users = 0            # builds currently using it
_stop_timer = None


def is_up():
    try:
        with urllib.request.urlopen(URL + "/system_stats", timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


def _model_paths():
    p = os.environ.get("COMFY_MODEL_PATHS")
    if p and os.path.exists(p):
        return p
    folder = os.path.join(os.environ.get("APPDATA", ""), "Comfy Desktop", "instance-model-paths")
    found = sorted(glob.glob(os.path.join(folder, "*.yaml")), key=os.path.getmtime)
    return found[-1] if found else None


def _python():
    for rel in (r".venv\Scripts\python.exe", r"..\standalone-env\python.exe"):
        p = os.path.join(COMFY_DIR, rel)
        if os.path.exists(p):
            return p
    raise RuntimeError("Can't find ComfyUI's Python under %s (set COMFY_DIR)." % COMFY_DIR)


_job = None


def _die_with_site(proc):
    """Windows job object: if the site is closed (even by closing its window),
    Windows kills the engine with it, so it can never be left holding VRAM."""
    global _job
    if os.name != "nt":
        return
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.OpenProcess.restype = wintypes.HANDLE

        class BASIC(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                        ("SchedulingClass", wintypes.DWORD)]

        class IOC(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in ("r", "w", "o", "rb", "wb", "ob")]

        class EXT(ctypes.Structure):
            _fields_ = [("Basic", BASIC), ("Io", IOC), ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                        ("PeakJobMemoryUsed", ctypes.c_size_t)]

        job = k32.CreateJobObjectW(None, None)
        info = EXT()
        info.Basic.LimitFlags = 0x2000                    # KILL_ON_JOB_CLOSE
        k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))
        h = k32.OpenProcess(0x1F0FFF, False, proc.pid)
        k32.AssignProcessToJobObject(job, h)
        k32.CloseHandle(h)
        _job = job                                        # handle lives as long as the site
    except Exception:
        pass


def _start(say):
    global _proc
    say("Starting the 3D engine")
    args = [_python(), "main.py", "--port", str(PORT), "--listen", "127.0.0.1",
            "--disable-auto-launch",
            "--output-directory", os.path.join(SHARED, "output"),
            "--input-directory", os.path.join(SHARED, "input")]
    mp = _model_paths()
    if mp:
        args += ["--extra-model-paths-config", mp]
    log = open(LOG, "w", encoding="utf-8", errors="replace")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)       # no console window
    _proc = subprocess.Popen(args, cwd=COMFY_DIR, stdout=log, stderr=subprocess.STDOUT,
                             creationflags=flags)
    _die_with_site(_proc)
    t0 = time.time()
    while time.time() - t0 < 300:
        if _proc.poll() is not None:
            _proc = None
            tail = open(LOG, encoding="utf-8", errors="replace").read()[-1500:]
            raise RuntimeError("The 3D engine stopped while starting. Last log lines:\n" + tail)
        if is_up():
            say("3D engine ready (%ds)" % (time.time() - t0))
            return
        time.sleep(2)
    raise RuntimeError("The 3D engine did not come up within 5 minutes - see engine.log")


def _stop():
    global _proc, _stop_timer
    with _lock:
        _stop_timer = None
        if _users or _proc is None:
            return
        pid = _proc.pid
        # taskkill /T takes the whole tree, so no model worker is left holding VRAM.
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                       capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        _proc = None


class session:
    """with engine.session(say): ... - the engine is up inside the block."""
    def __init__(self, say=print):
        self.say = say

    def __enter__(self):
        global _users, _stop_timer
        with _lock:
            if _stop_timer:
                _stop_timer.cancel()
                _stop_timer = None
            _users += 1
            try:
                if not is_up():
                    _start(self.say)
            except Exception:
                _users -= 1
                raise
        return self

    def __exit__(self, *exc):
        global _users, _stop_timer
        with _lock:
            _users -= 1
            if _users == 0 and _proc is not None:
                # Keep it briefly so a second build right away skips the start-up.
                _stop_timer = threading.Timer(KEEPALIVE, _stop)
                _stop_timer.daemon = True
                _stop_timer.start()
        return False


def shutdown():
    """Stop an engine we started (called when the site itself exits)."""
    global _users
    _users = 0
    _stop()
