# Image of a formula -> its LaTeX. Run by Pyx in ITS OWN environment (never the
# user's Python), as a small server that stays up between recognitions:
#
#   python -c <this> --serve
#
# It loads the recognizer ONCE (that is the slow part: seconds), prints READY,
# and then answers one line of JSON per image path it reads from stdin:
#   {"ok": true, "latex": "..."}  or  {"ok": false, "error": "..."}
#
# `python -c <this> <image>` recognizes a single image and exits.
#
# Everything else the recognizer says (its logging) goes to stderr, so stdout
# carries exactly the protocol.
import json
import os
import sys

OUT = sys.stdout
sys.stdout = sys.stderr


def say(obj):
    OUT.write((obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=True)) + "\n")
    OUT.flush()


def load():
    from rapid_latex_ocr import LaTeXOCR
    return LaTeXOCR()


def recognize(model, path):
    if not os.path.isfile(path):
        return {"ok": False, "error": "no se encuentra la imagen"}
    try:
        with open(path, "rb") as f:
            data = f.read()
        out = model(data)
        # (latex, seconds) in every version so far; be lenient about the shape.
        latex = out[0] if isinstance(out, (tuple, list)) else out
        latex = str(latex or "").strip()
        if not latex:
            return {"ok": False, "error": "no se reconoció ninguna fórmula en la imagen"}
        return {"ok": True, "latex": latex}
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}


def main():
    args = sys.argv[1:]
    try:
        model = load()
    except Exception as e:  # not installed, or a broken install
        say({"ok": False, "missing": True, "error": "%s: %s" % (type(e).__name__, e)})
        return
    if args and args[0] == "--serve":
        say("READY")
        for line in sys.stdin:
            path = line.strip()
            if not path:
                continue
            if path == "quit":
                break
            say(recognize(model, path))
        return
    say(recognize(model, args[0]) if args else {"ok": False, "error": "falta la imagen"})


if __name__ == "__main__":
    main()
