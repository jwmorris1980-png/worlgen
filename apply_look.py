"""apply_look.py - installs look.js into the worldgen viewer.

Put this file and look.js in  D:\\Comfy-Desktop\\ComfyUI-Shared\\worldgen
then run:   python apply_look.py

It makes backups first, changes exactly two lines in viewer/app.js (one import,
one call), bumps the cache-buster in viewer/index.html so the browser actually
picks up the change, and is safe to run twice.

Undo: python apply_look.py --undo   (restores the backups)
"""
import os, re, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
VIEWER = os.path.join(HERE, "viewer")
APP = os.path.join(VIEWER, "app.js")
INDEX = os.path.join(VIEWER, "index.html")
LOOK_SRC = os.path.join(HERE, "look.js")
LOOK_DST = os.path.join(VIEWER, "look.js")
SCRATCH = ["_grep.py", "_probe_env.py", "_hero_info.py", "_hero_fix.py"]


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def write(p, s):
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(s)


def bump_version(html):
    m = re.search(r"app\.js\?v=(\d+)", html)
    if m:
        n = int(m.group(1)) + 1
        return html.replace(m.group(0), "app.js?v=%d" % n), n
    new = re.sub(r"(src=[\"'][^\"']*app\.js)([\"'])", r"\1?v=1\2", html, count=1)
    return new, 1


def undo():
    for p in (APP, INDEX):
        b = p + ".bak-look"
        if os.path.exists(b):
            shutil.copy2(b, p)
            print("restored", os.path.relpath(p, HERE))
    print("Done. Reload the page with Ctrl+Shift+R.")


def main():
    if "--undo" in sys.argv:
        return undo()

    for p in (APP, INDEX):
        if not os.path.exists(p):
            sys.exit("Can't find %s - run this from the worldgen folder." % p)

    if os.path.exists(LOOK_SRC) and os.path.abspath(LOOK_SRC) != os.path.abspath(LOOK_DST):
        shutil.copy2(LOOK_SRC, LOOK_DST)
        print("copied look.js -> viewer/look.js")
    if not os.path.exists(LOOK_DST):
        sys.exit("look.js is missing - put it next to this script.")

    app = read(APP)
    if "installLook" in app:
        print("app.js already has the look installed - only bumping the cache-buster.")
    else:
        for p in (APP, INDEX):
            if not os.path.exists(p + ".bak-look"):
                shutil.copy2(p, p + ".bak-look")

        # 1. the import, after the last top-level import line
        imports = list(re.finditer(r"^import .*?;[ \t]*$", app, re.M))
        if not imports:
            sys.exit("No import lines found in app.js - not patching blind.")
        at = imports[-1].end()
        app = app[:at] + "\nimport { installLook } from './look.js';" + app[at:]

        # 2. the call, just before the render loop starts
        loop = app.find("renderer.setAnimationLoop(")
        if loop < 0:
            sys.exit("Couldn't find renderer.setAnimationLoop( in app.js - not patching blind.")

        def declared(name):
            return re.search(r"\b(let|const|var)\s+%s\b" % name, app) is not None

        if not declared("worldMesh"):
            sys.exit("app.js has no 'worldMesh' variable - not patching blind.")
        hero = "() => hero" if declared("hero") else "() => null"
        if hero == "() => null":
            print("note: no 'hero' variable found; the contact shadow will stay off.")

        call = ("// Render polish: distance dissolve, spoke pass 2, form shading, hero shadow.\n"
                "// Open the page with ?look=off to compare against the old look.\n"
                "installLook({ scene, renderer, getWorld: () => worldMesh, getHero: %s });\n\n" % hero)
        app = app[:loop] + call + app[loop:]
        write(APP, app)
        print("patched viewer/app.js (backup: app.js.bak-look)")

    html, n = bump_version(read(INDEX))
    write(INDEX, html)
    print("index.html now loads app.js?v=%d" % n)

    for name in SCRATCH:
        p = os.path.join(HERE, name)
        if os.path.exists(p):
            try:
                os.remove(p)
                print("removed scratch file", name)
            except OSError:
                print("left scratch file", name, "(safe to delete by hand)")

    print("\nDone. Reload the world page with Ctrl+Shift+R.")
    print("Compare: add ?look=off to the address to see the old look.")


if __name__ == "__main__":
    main()
