# Image of a formula -> its LaTeX. Run by Pyx in ITS OWN environment (never the
# user's Python): `python img2latex.py <image>`; prints ONE line of JSON on
# stdout — {"ok": true, "latex": "..."} or {"ok": false, "error": "..."}.
#
# Everything else the recognizer says (download progress the first time, its
# logging) goes to stderr, so stdout is always exactly that one line.
import json
import os
import sys


def main():
    if len(sys.argv) < 2 or not os.path.isfile(sys.argv[1]):
        return {"ok": False, "error": "no se encuentra la imagen"}
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        try:
            from rapid_latex_ocr import LaTeXOCR
        except Exception as e:  # not installed, or a broken install
            return {"ok": False, "missing": True, "error": "%s: %s" % (type(e).__name__, e)}
        with open(sys.argv[1], "rb") as f:
            data = f.read()
        model = LaTeXOCR()
        out = model(data)
        # (latex, seconds) in every version so far; be lenient about the shape.
        latex = out[0] if isinstance(out, (tuple, list)) else out
        latex = str(latex or "").strip()
        if not latex:
            return {"ok": False, "error": "no se reconoció ninguna fórmula en la imagen"}
        return {"ok": True, "latex": latex}
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    finally:
        sys.stdout = real_stdout


if __name__ == "__main__":
    res = main()
    sys.stdout.write(json.dumps(res, ensure_ascii=True) + "\n")
    sys.stdout.flush()
