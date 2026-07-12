#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Calc Python kernel.

A persistent REPL driven by the Rust backend over newline-delimited JSON on
stdin/stdout. State (variables, imports) persists across requests, like a
Jupyter kernel, so a cell can build on values defined earlier.

Requests (one JSON object per line):
    {"id": 1, "code": "x = 2+2", "cwd": "C:/docs", "reset": false}
    {"id": 2, "evals": ["x", "x*2-3/2"], "cwd": "C:/docs"}     # for \\py{...}

Responses:
    {"id": 1, "ok": true, "stdout": "...", "stderr": "", "result": "4",
     "result_html": null, "render": null, "images": []}
    {"id": 2, "ok": true, "evals": {"x": {"ok": true, "value": "4"}, ...}}

Only these JSON lines are written to the real stdout; user print() output is
captured into "stdout", so it never corrupts the framing.

handcalcs support
-----------------
A cell can use the same cell magics as in Jupyter (``%%render`` / ``%%tex``).
We don't run IPython, so we replicate what handcalcs.render does: run the cell,
then feed its source to ``handcalcs.handcalcs.LatexRenderer`` and return the
LaTeX in the "render" field. The compiler injects that LaTeX into the document
at the cell's position, so the calculation is typeset automatically and nothing
is shown as cell output (matching the user's Jupyter workflow).
"""

import sys
import os
import io
import json
import ast
import types
import base64
import warnings
import linecache
import traceback

os.environ.setdefault("MPLBACKEND", "Agg")  # headless matplotlib
# Agg can't "show" a window; figures are captured automatically instead, so the
# warning plt.show() raises is noise (and doesn't appear in Jupyter either).
warnings.filterwarnings("ignore", message=".*non-interactive.*")
warnings.filterwarnings("ignore", message=".*cannot be shown.*")

# Rich outputs (display(), HTML, images, video…) collected during one cell run.
DISPLAYS = []

# --- protocol integrity -------------------------------------------------
# The JSON frames are the ONLY thing that may ever reach the real stdout.
# A user cell that starts a background thread (threading, joblib, futures…)
# can print AFTER its cell returned; if sys.stdout were the real pipe at that
# moment, the stray text could split a JSON frame and hang the kernel forever.
# So: frames are written through _REAL_STDOUT (captured in main()), while
# sys.stdout/sys.stderr idle on absorbing buffers whose content is surfaced
# with the NEXT cell's output (Jupyter-like, nothing is lost).
_REAL_STDOUT = None  # set once in main()


class _CellIO(io.StringIO):
    """StringIO with the attributes libraries probe on sys.stdout (pandas,
    tqdm… read .encoding; StringIO lacks it)."""
    encoding = "utf-8"
    errors = "strict"


_BG_OUT = _CellIO()  # stray background stdout between requests
_BG_ERR = _CellIO()  # stray background stderr (thread tracebacks…)


def _drain(buf):
    v = buf.getvalue()
    if v:
        buf.seek(0)
        buf.truncate()
    return v


class _StdinGuard:
    """input() would otherwise read the NEXT JSON request from the pipe and
    desynchronize the protocol (request eaten, response never sent). Raise a
    clear error instead, like Jupyter's StdinNotImplementedError."""
    encoding = "utf-8"
    errors = "strict"
    closed = False
    def isatty(self):
        return False
    def close(self):
        pass
    def fileno(self):
        raise io.UnsupportedOperation("fileno")
    def _no(self, *_a, **_k):
        raise RuntimeError(
            "input()/sys.stdin no está disponible en las celdas de Pyx; "
            "asigna los valores directamente en el código."
        )
    read = readline = readlines = __next__ = _no
    def __iter__(self):
        return self


def _patch_mpl_show():
    """plt.show() → no-op (figures are auto-captured; Agg can't open windows).
    Tolerates being called while pyplot is still half-initialized (the import
    hook fires during matplotlib's own internal imports)."""
    plt_mod = sys.modules.get("matplotlib.pyplot")
    show = getattr(plt_mod, "show", None) if plt_mod is not None else None
    if show is not None and getattr(show, "__name__", "") != "_pyx_noop_show":
        def _pyx_noop_show(*_a, **_k):
            pass
        plt_mod.show = _pyx_noop_show


def _patch_plotly_show():
    """plotly fig.show() opens the system BROWSER by default — route it to an
    in-app rich display instead (interactive hover/zoom/3D inside Pyx).

    Reads the ALREADY-LOADED module from sys.modules; it must NOT import
    anything itself, or the import hook would re-fire and recurse forever."""
    bd = sys.modules.get("plotly.basedatatypes")
    base_figure = getattr(bd, "BaseFigure", None) if bd is not None else None
    if base_figure is None:
        return
    if getattr(base_figure.show, "__name__", "") != "_pyx_show":
        def _pyx_show(self, *_a, **_k):
            DISPLAYS.append({
                "kind": "html",
                "data": self.to_html(include_plotlyjs="cdn", full_html=False),
            })
        base_figure.show = _pyx_show


_in_import_patch = False


def _install_import_hook():
    """Patch matplotlib/plotly show() the moment they are imported, so even a
    single cell that imports AND shows stays in-app. The patching is guarded by
    a re-entrancy flag and a try/except, so it can NEVER recurse or break the
    user's import (a failed patch must not turn into an ImportError)."""
    import builtins
    if getattr(builtins.__import__, "__name__", "") == "_pyx_import":
        return
    _orig_import = builtins.__import__

    def _pyx_import(name, *args, **kwargs):
        mod = _orig_import(name, *args, **kwargs)
        global _in_import_patch
        if not _in_import_patch:
            _in_import_patch = True
            try:
                root = name.split(".", 1)[0]
                if root == "matplotlib":
                    _patch_mpl_show()
                elif root == "plotly":
                    _patch_plotly_show()
            except Exception:
                pass
            finally:
                _in_import_patch = False
        return mod

    _pyx_import.__name__ = "_pyx_import"
    builtins.__import__ = _pyx_import

# Persistent namespace shared by every cell in this kernel session.
NS = {}


def _register_render_stub():
    """``import handcalcs.render`` registers IPython cell magics at import time
    and crashes outside a Jupyter shell. We handle %%render / %%tex natively,
    so install a harmless stub module: the user's Jupyter-style
    ``import handcalcs.render`` then becomes a silent no-op."""
    if "handcalcs.render" in sys.modules:
        return
    try:
        import handcalcs  # the package itself imports fine
    except Exception:
        return
    stub = types.ModuleType("handcalcs.render")
    stub.__doc__ = "Calc stub: handcalcs cell magics are handled natively."
    sys.modules["handcalcs.render"] = stub
    try:
        handcalcs.render = stub
    except Exception:
        pass


def _mime_route(obj):
    """Route an object to its richest representation, Jupyter-style.

    Returns {"kind": "html"|"svg"|"image"|"markdown", "data": ...} or None.
    Order matters: html (plotly, pandas, widgets) > svg > png (PIL, anything
    with _repr_png_) > markdown."""
    rh = getattr(obj, "_repr_html_", None)
    if callable(rh):
        try:
            h = rh()
            if h:
                return {"kind": "html", "data": h}
        except Exception:
            pass
    rs = getattr(obj, "_repr_svg_", None)
    if callable(rs):
        try:
            s = rs()
            if s:
                return {"kind": "svg", "data": s}
        except Exception:
            pass
    rp = getattr(obj, "_repr_png_", None)
    if callable(rp):
        try:
            p = rp()
            if p:
                if isinstance(p, str):
                    return {"kind": "image", "data": p}
                return {"kind": "image", "data": base64.b64encode(p).decode("ascii")}
        except Exception:
            pass
    rm = getattr(obj, "_repr_markdown_", None)
    if callable(rm):
        try:
            m = rm()
            if m:
                return {"kind": "markdown", "data": m}
        except Exception:
            pass
    # matplotlib Figure passed explicitly to display()
    if hasattr(obj, "savefig"):
        try:
            buf = io.BytesIO()
            obj.savefig(buf, format="png", dpi=110, bbox_inches="tight")
            return {"kind": "image", "data": base64.b64encode(buf.getvalue()).decode("ascii")}
        except Exception:
            pass
    # numpy image array via PIL — ONLY when it plausibly IS an image (uint8
    # H×W×3/4, or a uint8 grayscale of reasonable size). A small numeric
    # matrix like np.array([[1,2],[3,4]], dtype=uint8) must show as a matrix
    # repr, never as a 2×2 black PNG.
    try:
        import numpy as np
        from PIL import Image as _PILImage
        if isinstance(obj, np.ndarray):
            looks_like_image = (
                (obj.ndim == 3 and obj.shape[-1] in (3, 4) and obj.dtype == np.uint8)
                or (obj.ndim == 2 and obj.dtype == np.uint8 and min(obj.shape) >= 16)
            )
            if looks_like_image:
                img = _PILImage.fromarray(obj)
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                return {"kind": "image", "data": base64.b64encode(buf.getvalue()).decode("ascii")}
    except Exception:
        pass
    return None


def _md_to_html(md):
    """Markdown → HTML via the `markdown` package, with a plain fallback."""
    try:
        import markdown as _md
        return _md.markdown(md, extensions=["tables", "fenced_code"])
    except Exception:
        import html as _html
        return "<pre style='white-space:pre-wrap'>%s</pre>" % _html.escape(md)


def _data_uri(source, mime):
    """Build a data: URI from a file path or raw bytes."""
    if isinstance(source, (bytes, bytearray)):
        data = bytes(source)
    else:
        with open(source, "rb") as f:
            data = f.read()
    return "data:%s;base64,%s" % (mime, base64.b64encode(data).decode("ascii"))


def _install_helpers():
    def figure(name, fig=None, dpi=150):
        """Save the current matplotlib figure next to the document and return
        its relative path, e.g. p = figure("g") -> \\includegraphics{\\py{p}}."""
        import matplotlib.pyplot as plt
        figs_dir = os.path.join(os.getcwd(), "_calc_figs")
        os.makedirs(figs_dir, exist_ok=True)
        rel = os.path.join("_calc_figs", str(name) + ".png").replace("\\", "/")
        (fig or plt.gcf()).savefig(os.path.join(os.getcwd(), rel), dpi=dpi, bbox_inches="tight")
        return rel

    NS["figure"] = figure

    def texesc(s):
        """Escape LaTeX special characters in plain text, so any Python string
        can be inserted with \\py{texesc(s)} without breaking the compile."""
        rep = {
            "\\": r"\textbackslash{}", "&": r"\&", "%": r"\%", "$": r"\$",
            "#": r"\#", "_": r"\_", "{": r"\{", "}": r"\}",
            "~": r"\textasciitilde{}", "^": r"\textasciicircum{}",
        }
        return "".join(rep.get(c, c) for c in str(s))

    def tex(obj, prec=None, env="bmatrix", index=False):
        """Convert a Python object to LaTeX — the bridge for full formatting
        control from the document: \\py{tex(obj)}.

        sympy expr/matrix -> sympy.latex()           (math mode)
        pint Quantity     -> value + units in LaTeX  (math mode)
        numpy array       -> matrix environment `env` (math mode)
        pandas DataFrame  -> tabular (to_latex)      (text mode)
        float + prec      -> rounded                 (either)
        anything else     -> str(obj)
        """
        try:
            import sympy
            if isinstance(obj, (sympy.Basic, sympy.matrices.MatrixBase)):
                return sympy.latex(obj)
        except Exception:
            pass
        try:
            import pint
            if isinstance(obj, pint.Quantity):
                m = obj.magnitude
                if prec is not None and isinstance(m, (int, float)):
                    obj = round(obj, prec)
                return "{:~L}".format(obj)
        except Exception:
            pass
        try:
            import pandas as pd
            if isinstance(obj, pd.Series):
                obj = obj.to_frame()
            if isinstance(obj, pd.DataFrame):
                ff = ("%%.%dg" % prec) if prec is not None else None
                return obj.to_latex(index=index,
                                    float_format=(lambda v: ff % v) if ff else None)
        except Exception:
            pass
        try:
            import numpy as np
            if isinstance(obj, np.ndarray):
                arr = np.atleast_2d(obj)
                fmt = (lambda v: "%.*g" % (prec, v)) if prec is not None else str
                rows = [" & ".join(fmt(v) for v in row) for row in arr]
                return "\\begin{%s} %s \\end{%s}" % (env, " \\\\ ".join(rows), env)
        except Exception:
            pass
        if prec is not None and isinstance(obj, float):
            return "%.*f" % (prec, obj)
        return str(obj)

    NS["tex"] = tex
    NS["texesc"] = texesc

    class HTML:
        """Jupyter-style HTML display: make any HTML string a rich cell output.
        e.g. HTML(anim.to_html5_video()) shows a playable video."""
        def __init__(self, data):
            self.data = data
        def _repr_html_(self):
            return self.data
        def __repr__(self):
            return "<HTML>"

    class Markdown:
        """Jupyter-style Markdown display: Markdown(\"# Título\\n**negrita**\")."""
        def __init__(self, data):
            self.data = data
        def _repr_markdown_(self):
            return self.data
        def __repr__(self):
            return "<Markdown>"

    class Image:
        """Show an image file or raw bytes (png/jpg/gif): Image(\"foto.png\")."""
        def __init__(self, source, mime=None):
            self.source = source
            if mime is None and isinstance(source, str):
                ext = os.path.splitext(source)[1].lower().lstrip(".")
                mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
                        "svg": "image/svg+xml", "webp": "image/webp"}.get(ext, "image/png")
            self.mime = mime or "image/png"
        def _repr_html_(self):
            return '<img src="%s" style="max-width:100%%">' % _data_uri(self.source, self.mime)
        def __repr__(self):
            return "<Image>"

    class Audio:
        """Playable audio: Audio(\"voz.mp3\") or Audio(bytes, mime=\"audio/wav\")."""
        def __init__(self, source, mime=None):
            self.source = source
            if mime is None and isinstance(source, str):
                ext = os.path.splitext(source)[1].lower().lstrip(".")
                mime = {"mp3": "audio/mpeg", "ogg": "audio/ogg", "m4a": "audio/mp4"}.get(ext, "audio/wav")
            self.mime = mime or "audio/wav"
        def _repr_html_(self):
            return '<audio controls src="%s"></audio>' % _data_uri(self.source, self.mime)
        def __repr__(self):
            return "<Audio>"

    class Video:
        """Playable video with controls/loop: Video(\"anim.mp4\", loop=True)."""
        def __init__(self, source, mime=None, loop=False, autoplay=False):
            self.source = source
            if mime is None and isinstance(source, str):
                ext = os.path.splitext(source)[1].lower().lstrip(".")
                mime = {"webm": "video/webm", "ogv": "video/ogg", "mov": "video/quicktime"}.get(ext, "video/mp4")
            self.mime = mime or "video/mp4"
            self.loop = loop
            self.autoplay = autoplay
        def _repr_html_(self):
            attrs = "controls" + (" loop" if self.loop else "") + (" autoplay muted" if self.autoplay else "")
            return '<video %s style="max-width:100%%" src="%s"></video>' % (attrs, _data_uri(self.source, self.mime))
        def __repr__(self):
            return "<Video>"

    def display(*objs):
        """Jupyter-style display(): route each object to its richest output
        (HTML, SVG, PNG, Markdown, …) and show it under the cell."""
        for obj in objs:
            r = _mime_route(obj)
            if r is None:
                print(repr(obj))
            else:
                if r["kind"] == "markdown":
                    r = {"kind": "html", "data": _md_to_html(r["data"])}
                DISPLAYS.append(r)

    NS["HTML"] = HTML
    NS["Markdown"] = Markdown
    NS["Image"] = Image
    NS["Audio"] = Audio
    NS["Video"] = Video
    NS["display"] = display

    # handcalcs + pint: render textbook-style calculations straight into the
    # document. hc(func, *args) returns display-math LaTeX (no double render —
    # the value is returned, not printed, so it only appears via \py{...}).
    try:
        from handcalcs.decorator import handcalc as _handcalc
        NS["handcalc"] = _handcalc

        def hc(func, *args, **kwargs):
            out = _handcalc(jupyter_display=False)(func)(*args, **kwargs)
            latex = out[0] if isinstance(out, tuple) else out
            return "\\[" + latex + "\\]"

        NS["hc"] = hc
    except Exception:
        pass
    try:
        import pint
        NS["ureg"] = pint.UnitRegistry()
    except Exception:
        pass

    _register_render_stub()


# ---------------------------------------------------------------------------
# handcalcs cell magics (%%render / %%tex)
# ---------------------------------------------------------------------------
def _parse_line_args(line):
    """Validate the arguments on a %%render / %%tex magic line. Mirrors
    handcalcs.render.parse_line_args (params/long/short/sympy/precision)."""
    valid_args = ["params", "long", "short", "sympy", "symbolic", "_testing"]
    sympy_arg = ["sympy"]
    parsed = {"override": "", "precision": None, "sympy": False, "sci_not": None}
    precision = ""
    for arg in (line or "").split():
        low = arg.lower()
        if low in sympy_arg:
            parsed["sympy"] = True
            continue
        if low == "sci_not":
            parsed["sci_not"] = True
        for valid in valid_args:
            if low in valid:
                parsed["override"] = valid
                break
        try:
            precision = int(arg)
        except ValueError:
            pass
        if precision or precision == 0:
            parsed["precision"] = precision
    return parsed


def _detect_magic(code):
    """If the cell uses a handcalcs cell magic, split it into the parts we need.

    Returns ``{"setup", "calc", "args"}`` or ``None``. ``setup`` is everything
    before the magic line (imports, assignments) — run but not rendered;
    ``calc`` is everything after — run and rendered by handcalcs."""
    lines = code.split("\n")
    idx = None
    args = ""
    kind = "render"
    for i, ln in enumerate(lines):
        s = ln.strip()
        if s.startswith("%%render"):
            idx, args, kind = i, s[len("%%render"):].strip(), "render"
            break
        if s.startswith("%%tex"):
            idx, args, kind = i, s[len("%%tex"):].strip(), "tex"
            break
    if idx is None:
        return None
    return {
        "setup": "\n".join(lines[:idx]),
        "calc": "\n".join(lines[idx + 1:]),
        "args": args,
        "kind": kind,
        "magic_idx": idx,  # 0-based line of the magic within the cell
        "full": code,      # the whole cell, for traceback line mapping
    }


def _render_handcalcs(magic):
    """Execute a %%render/%%tex cell and return its handcalcs LaTeX.

    Variables persist in NS (so later cells and \\py{...} can use them). Import
    lines are executed but not typeset (handcalcs renders assignments).

    The cell registers under a `<calc-cell-N>` filename with PADDED line
    numbers, so a traceback inside a handcalcs cell maps to the exact editor
    line (clickable) just like a normal cell — setup lines start at line 1 and
    the calc part starts right after the %%render/%%tex line."""
    global _cell_seq, _last_cell_file
    import handcalcs.handcalcs as _hand

    _cell_seq += 1
    filename = "<calc-cell-%d>" % _cell_seq
    _last_cell_file = filename
    full = magic.get("full", "")
    linecache.cache[filename] = (
        len(full), None, [ln + "\n" for ln in full.split("\n")], filename,
    )

    setup = magic["setup"]
    if setup.strip():
        exec(compile(setup, filename, "exec"), NS, NS)

    args = _parse_line_args(magic["args"])
    calc = magic["calc"]
    if args.get("sympy"):
        try:
            from handcalcs import sympy_kit as _skit
            calc = _skit.convert_sympy_cell_to_py_cell(calc, NS)
        except Exception:
            pass

    if calc.strip():
        # Pad so exec line numbers equal FULL-cell line numbers (magic line is
        # cell line magic_idx+1, 1-based; calc starts at magic_idx+2).
        pad = "\n" * (magic.get("magic_idx", 0) + 1)
        exec(compile(pad + calc, filename, "exec"), NS, NS)

    # Render source: drop import lines (handcalcs renders assignments/comments).
    render_src = "\n".join(
        ln for ln in calc.split("\n")
        if not ln.strip().startswith(("import ", "from "))
    ).strip()
    if not render_src:
        return None
    return _hand.LatexRenderer(render_src, NS, args).render()


def _latex_display_html(latex):
    """Render a LaTeX math block as a rich HTML display (KaTeX from CDN), so
    handcalcs results are VISIBLE in the cell output even without a LaTeX
    document (Python-only .pltx use)."""
    body = latex.strip()
    if body.startswith("\\["):
        body = body[2:]
    if body.endswith("\\]"):
        body = body[:-2]
    return (
        '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">'
        '<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>'
        '<div class="pyx-katex"></div>'
        "<script>katex.render(" + json.dumps(body.strip())
        + ", document.querySelector('.pyx-katex'), {displayMode:true, throwOnError:false});</script>"
    )


def _capture_images():
    """Return open matplotlib figures as base64 PNGs, then close them."""
    images = []
    if sys.modules.get("matplotlib") is None:
        return images
    try:
        import matplotlib.pyplot as plt
        for num in plt.get_fignums():
            buf = io.BytesIO()
            plt.figure(num).savefig(buf, format="png", dpi=110, bbox_inches="tight")
            images.append(base64.b64encode(buf.getvalue()).decode("ascii"))
        plt.close("all")
    except Exception:
        pass
    return images


_cell_seq = 0
_last_cell_file = ""  # filename of the cell being executed (for error mapping)


def _format_cell_tb(exc):
    """VSCode-grade error reporting: a CLEAN traceback showing only the user's
    cell frames (kernel internals hidden) plus structured location info.

    Returns (text, info); info = {"type", "msg", "line"} where line is 1-based
    WITHIN the current cell's code — the editor maps it to the document line so
    the error is clickable and precise, never a bare message without location."""
    tbe = traceback.TracebackException.from_exception(exc)
    stack = [f for f in tbe.stack if f.filename.startswith("<calc-cell")]
    line = None
    for f in stack:  # last frame INSIDE the current cell = the failing line
        if f.filename == _last_cell_file:
            line = f.lineno
    if isinstance(exc, SyntaxError) and getattr(exc, "lineno", None):
        if not exc.filename or exc.filename == _last_cell_file:
            line = exc.lineno
    parts = []
    if stack:
        parts.append("Traceback (most recent call last):\n")
        for f in stack:
            where = "" if f.name in ("<module>", None, "") else ", en %s()" % f.name
            parts.append("  Línea %d%s\n" % (f.lineno, where))
            if f.line:
                parts.append("    %s\n" % f.line.strip())
    parts.extend(tbe.format_exception_only())
    import re as _re
    # Any remaining internal filenames read as plain line references.
    text = _re.sub(r'File "<calc-cell-\d+>", line (\d+)', r"Línea \1",
                   "".join(parts))
    msg = _re.sub(r"\s*\(<calc-cell-\d+>, line \d+\)$", "", str(exc))
    # Structured frames so the editor can render a COLORED, clickable traceback
    # (Jupyter/VSCode-style) instead of a plain red text block.
    frames = [{
        "line": f.lineno,
        "name": None if f.name in ("<module>", "", None) else f.name,
        "code": (f.line or "").strip(),
        "cur": f.filename == _last_cell_file,
    } for f in stack]
    syntax = None
    if isinstance(exc, SyntaxError) and getattr(exc, "lineno", None):
        syntax = {
            "line": exc.lineno,
            "code": (exc.text or "").rstrip("\n"),
            "col": exc.offset or 0,
            "cur": (not exc.filename) or exc.filename == _last_cell_file,
        }
    info = {"type": type(exc).__name__, "msg": msg, "line": line,
            "frames": frames, "syntax": syntax}
    return text, info


def _run(code):
    """Exec a block, echoing the last bare expression like a notebook cell.

    Returns ``{"result", "html"}`` — ``html`` is the object's ``_repr_html_``
    (e.g. a pandas DataFrame) so cell output looks like Jupyter. The cell's
    source is registered in ``linecache`` under a unique filename so
    ``inspect.getsource`` works for functions defined here (handcalcs etc.)."""
    global _cell_seq, _last_cell_file
    _cell_seq += 1
    filename = "<calc-cell-%d>" % _cell_seq
    _last_cell_file = filename
    linecache.cache[filename] = (
        len(code), None, [ln + "\n" for ln in code.split("\n")], filename,
    )

    # Re-apply the show() patches in case a library slipped in unpatched.
    _patch_mpl_show()
    _patch_plotly_show()

    parsed = ast.parse(code, filename, mode="exec")
    body = parsed.body
    result = None
    if body and isinstance(body[-1], ast.Expr):
        last = ast.Expression(body.pop().value)
        if body:
            exec(compile(ast.Module(body, []), filename, "exec"), NS, NS)
        value = eval(compile(last, filename, "eval"), NS, NS)
        if value is not None:
            # Route the bare last expression like Jupyter: richest MIME wins,
            # plain repr only when nothing rich is available.
            r = _mime_route(value)
            if r is not None:
                if r["kind"] == "markdown":
                    r = {"kind": "html", "data": _md_to_html(r["data"])}
                DISPLAYS.append(r)
            else:
                result = repr(value)
    else:
        exec(compile(parsed, filename, "exec"), NS, NS)
    return {"result": result}


def _fmt(value):
    """Format an evaluated \\py{} value for SAFE insertion into LaTeX.

    Engineering documents carry legal weight, so this is deliberately strict:
      * int / numpy int  -> exact digits, never ".0"
      * float / float64  -> FIXED-POINT, never scientific (``1.5e+05`` would be
                            wrong in the typeset document); 12 significant
                            figures so binary-float noise (0.1+0.2) disappears;
                            trailing zeros trimmed. NaN / Inf RAISE so a non-
                            finite result can never reach the PDF.
      * numpy array      -> RAISE (point the user to ``\\py{tex(arr)}``)
      * anything else    -> str()
    A raised error is turned by the caller into a visible "[\\py{...}]" problem
    and substitutes "??", so a bad value never compiles silently.
    """
    import math
    # numpy scalars are fine (treated as python scalars); arrays are an error.
    try:
        import numpy as _np
        if isinstance(value, _np.ndarray):
            raise TypeError(
                "es un array NumPy de forma %s; usa \\py{tex(...)} para una matriz LaTeX"
                % (getattr(value, "shape", "?"),)
            )
        if isinstance(value, _np.generic):
            value = value.item()
    except ImportError:
        pass

    if isinstance(value, int):  # bool is an int subclass → str gives True/False
        return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            raise ValueError("el resultado es NaN (no es un número)")
        if math.isinf(value):
            raise ValueError("el resultado es infinito (Inf)")
        s = "%.12g" % value
        if "e" in s or "E" in s:  # expand scientific notation to plain digits
            from decimal import Decimal
            s = format(Decimal(s), "f")
        if "." in s:
            s = s.rstrip("0").rstrip(".")
        return s if s and s != "-0" else "0"
    # decimal.Decimal: str() can be scientific ("1E+15") — same strict rules.
    import decimal
    if isinstance(value, decimal.Decimal):
        if value.is_nan():
            raise ValueError("el resultado es NaN (no es un número)")
        if value.is_infinite():
            raise ValueError("el resultado es infinito (Inf)")
        s = format(value, "f")
        if "." in s:
            s = s.rstrip("0").rstrip(".")
        return s if s and s != "-0" else "0"
    return str(value)


def handle(req):
    if req.get("reset"):
        NS.clear()
        _install_helpers()
    if "figure" not in NS:
        _install_helpers()

    cwd = req.get("cwd")
    if cwd:
        try:
            os.chdir(cwd)
        except Exception:
            pass

    # Expression evaluation for \py{...} in the LaTeX document.
    if "evals" in req:
        results = {}
        for expr in req["evals"]:
            try:
                results[expr] = {"ok": True, "value": _fmt(eval(expr, NS, NS))}
            except Exception as ex:
                results[expr] = {"ok": False, "value": "%s: %s" % (type(ex).__name__, ex)}
        return {"id": req.get("id"), "ok": True, "evals": results}

    # Static syntax check (editor squiggles, VSCode-style): compile each cell's
    # code WITHOUT running it and report every syntax error with line/column.
    if "lint" in req:
        found = []
        for i, code in enumerate(req.get("lint") or []):
            try:
                compile(code, "<lint>", "exec")
            except SyntaxError as e:
                found.append({
                    "cell": i,
                    "line": e.lineno or 1,
                    "col": e.offset or 1,
                    "msg": e.msg or "error de sintaxis",
                })
            except Exception:
                pass
        return {"id": req.get("id"), "ok": True, "lint": found}

    # Normal cell execution.
    DISPLAYS.clear()
    out, err = _CellIO(), _CellIO()
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    ok, result, render_latex, error = True, None, None, None
    try:
        code = req.get("code", "")
        magic = _detect_magic(code)
        if magic is not None:
            render_latex = _render_handcalcs(magic)
            # Show the calculation in the cell output too (KaTeX), so handcalcs
            # is usable without a LaTeX document; with one, it ALSO compiles
            # into the PDF as before.
            if render_latex:
                DISPLAYS.append({"kind": "html", "data": _latex_display_html(render_latex)})
                # Jupyter parity: %%tex ALSO prints the raw LaTeX source so it
                # can be copied straight into a document.
                if magic.get("kind") == "tex":
                    print(render_latex)
        else:
            result = _run(code).get("result")
    except BaseException as exc:
        ok = False
        try:
            # The editor renders `error` as a colored, clickable traceback —
            # writing the plain text to stderr too would just duplicate it.
            _text, error = _format_cell_tb(exc)
        except Exception:
            err.write(traceback.format_exc())
    finally:
        sys.stdout, sys.stderr = old_out, old_err

    # Surface anything background threads printed since the last cell (their
    # sys.stdout/sys.stderr idle on the absorbing buffers, never the pipe).
    bg_out = _drain(_BG_OUT)
    bg_err = _drain(_BG_ERR)
    return {
        "id": req.get("id"),
        "ok": ok,
        "stdout": (bg_out + out.getvalue()) if bg_out else out.getvalue(),
        "stderr": (bg_err + err.getvalue()) if bg_err else err.getvalue(),
        "result": result,
        "error": error,  # {type, msg, line} — line is 1-based within the cell
        "displays": list(DISPLAYS),
        "render": render_latex,
        "images": _capture_images(),
    }


def main():
    global _REAL_STDOUT
    # Take exclusive ownership of the protocol pipes. From here on, user code
    # can never reach the real stdout/stdin — not even via sys.__stdout__ —
    # so the JSON framing is physically incorruptible from Python code.
    _REAL_STDOUT = sys.stdout
    real_stdin = sys.stdin
    sys.stdin = sys.__stdin__ = _StdinGuard()
    sys.stdout = sys.__stdout__ = _BG_OUT
    sys.stderr = sys.__stderr__ = _BG_ERR

    _install_import_hook()
    _install_helpers()
    _REAL_STDOUT.write(json.dumps({"type": "ready", "python": sys.version.split()[0]}) + "\n")
    _REAL_STDOUT.flush()
    for line in real_stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        if req.get("type") == "shutdown":
            break
        try:
            resp = handle(req)
        except BaseException:
            resp = {"id": req.get("id"), "ok": False, "stdout": "",
                    "stderr": traceback.format_exc(), "result": None,
                    "displays": [], "render": None, "images": []}
        _REAL_STDOUT.write(json.dumps(resp) + "\n")
        _REAL_STDOUT.flush()


if __name__ == "__main__":
    main()
