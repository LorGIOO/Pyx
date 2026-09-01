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

Control messages (handled while a cell is still running):
    {"type": "interrupt"}     raise KeyboardInterrupt in the running cell
    {"type": "shutdown"}      exit

Requests are READ on the main thread and EXECUTED on a worker thread. That
split is what makes a real interrupt possible: the reader keeps listening while
a cell runs, so an interrupt can be delivered to the executing thread instead of
the host having to kill the whole process and lose the session's variables.

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
import ctypes
import base64
import queue
import threading
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
                elif root == "IPython":
                    # Done here, not lazily: `from IPython import get_ipython`
                    # binds the value the instant IPython finishes loading.
                    _patch_ipython_shell()
            except Exception:
                pass
            finally:
                _in_import_patch = False
        return mod

    _pyx_import.__name__ = "_pyx_import"
    builtins.__import__ = _pyx_import

# Persistent namespace shared by every cell in this kernel session.
NS = {}


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
    #
    # numpy is read from sys.modules rather than imported: if the object is an
    # ndarray then the document already imported it, and a session that never
    # touches numpy must not pay for loading it here. PIL is only imported once
    # the array has already been recognised as an image.
    np = sys.modules.get("numpy")
    if np is not None:
        try:
            if isinstance(obj, np.ndarray):
                looks_like_image = (
                    (obj.ndim == 3 and obj.shape[-1] in (3, 4) and obj.dtype == np.uint8)
                    or (obj.ndim == 2 and obj.dtype == np.uint8 and min(obj.shape) >= 16)
                )
                if looks_like_image:
                    from PIL import Image as _PILImage
                    buf = io.BytesIO()
                    _PILImage.fromarray(obj).save(buf, format="PNG")
                    return {"kind": "image",
                            "data": base64.b64encode(buf.getvalue()).decode("ascii")}
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


# ---------------------------------------------------------------------------
# The `pyx` module — the app's own helpers, imported like any other library
# ---------------------------------------------------------------------------
# NOTHING is injected into the user namespace. A cell starts as empty as a
# Jupyter cell does: numpy, matplotlib, handcalcs, pint and everything else must
# be imported by the document that uses them.
#
# It used to be the other way round. The kernel pre-defined `figure`, `tex`,
# `hc`, a live `pint.UnitRegistry()` and more, and it REPLACED
# `handcalcs.render` with a stub — so `%%render` appeared to work without ever
# importing handcalcs, and the real library could not be imported, inspected or
# upgraded. That is not an IDE, it is a framework pretending to be one.
#
# What the kernel still provides is the NOTEBOOK PROTOCOL, which belongs to the
# kernel and not to any library: `display()`, `get_ipython()`, routing an object
# to its richest representation, and capturing matplotlib figures. Every Jupyter
# kernel provides exactly these.
#
# Pyx's own helpers live in a real module:  from pyx import figure, tex


def _need(module_name, who):
    """Import a module on behalf of a `pyx` helper, with an error that names the
    missing library instead of a bare ImportError."""
    try:
        __import__(module_name)
        return sys.modules[module_name]
    except Exception:
        root = module_name.split(".")[0]
        raise ImportError(
            "%s necesita %s, que no esta instalado. Instalalo con "
            "`pip install %s` en la terminal integrada." % (who, root, root)
        )


def _display(*objs):
    """Jupyter-style display(): route each object to its richest output
    (HTML, SVG, PNG, Markdown, ...) and show it under the cell."""
    for obj in objs:
        r = _mime_route(obj)
        if r is None:
            print(repr(obj))
        else:
            if r["kind"] == "markdown":
                r = {"kind": "html", "data": _md_to_html(r["data"])}
            DISPLAYS.append(r)


def _build_pyx_module():
    """The `pyx` module: figure/table helpers for the LaTeX bridge, plus the
    display wrappers Jupyter keeps in `IPython.display`."""
    mod = types.ModuleType("pyx")
    mod.__doc__ = (
        "Ayudantes de Pyx para el puente LaTeX <-> Python.\n\n"
        "    from pyx import figure, figtex, tabletex, tex, texesc\n"
        "    from pyx import display, HTML, Markdown, Image, Audio, Video\n"
    )

    def figure(name, fig=None, dpi=150):
        """Save the current matplotlib figure into the project's single image
        folder and return its relative path:

            p = figure("g")  ->  \\includegraphics{\\py{p}}

        ALL Python-generated graphics live in ONE folder, ``xref``, next to the
        ROOT document — never one folder per file. The kernel's cwd is always
        the root document's directory (the app guarantees it, even when running
        a cell from an included chapter), so a bare relative path here lands in
        exactly one place, and the returned path compiles from any child file
        because the engine resolves the graphic against that same cwd."""
        plt = _need("matplotlib.pyplot", "figure()")
        figs_dir = os.path.join(os.getcwd(), "xref")
        os.makedirs(figs_dir, exist_ok=True)
        rel = "xref/" + str(name) + ".png"
        (fig or plt.gcf()).savefig(
            os.path.join(figs_dir, str(name) + ".png"), dpi=dpi, bbox_inches="tight")
        return rel

    def figtex(name, caption=None, label=None, width=0.8, fig=None, dpi=150,
               placement="htbp"):
        """Save the current figure AND return the whole LaTeX float, ready to
        drop into the document with a single \\py{}."""
        rel = figure(name, fig=fig, dpi=dpi)
        parts = ["\\begin{figure}[%s]" % placement, "\\centering",
                 "\\includegraphics[width=%s\\linewidth]{%s}" % (width, rel)]
        if caption:
            parts.append("\\caption{%s}" % caption)
        if label:
            parts.append("\\label{%s}" % label)
        parts.append("\\end{figure}")
        return "\n".join(parts)

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

        sympy expr/matrix -> sympy.latex()            (math mode)
        pint Quantity     -> value + units in LaTeX   (math mode)
        numpy array       -> matrix environment `env` (math mode)
        pandas DataFrame  -> tabular (to_latex)       (text mode)
        float + prec      -> rounded                  (either)
        anything else     -> str(obj)

        Every branch is gated on the library being ALREADY imported by the
        document. Importing them here just to run an isinstance() check would
        pull sympy, pandas and numpy into a session that never asked for
        them — seconds of startup, and libraries the user cannot then swap."""
        sympy = sys.modules.get("sympy")
        if sympy is not None:
            try:
                if isinstance(obj, (sympy.Basic, sympy.matrices.MatrixBase)):
                    return sympy.latex(obj)
            except Exception:
                pass
        pint = sys.modules.get("pint")
        if pint is not None:
            try:
                if isinstance(obj, pint.Quantity):
                    m = obj.magnitude
                    if prec is not None and isinstance(m, (int, float)):
                        obj = round(obj, prec)
                    return "{:~L}".format(obj)
            except Exception:
                pass
        pd = sys.modules.get("pandas")
        if pd is not None:
            try:
                if isinstance(obj, pd.Series):
                    obj = obj.to_frame()
                if isinstance(obj, pd.DataFrame):
                    ff = ("%%.%dg" % prec) if prec is not None else None
                    return obj.to_latex(
                        index=index, float_format=(lambda v: ff % v) if ff else None)
            except Exception:
                pass
        np = sys.modules.get("numpy")
        if np is not None:
            try:
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

    def tabletex(obj, caption=None, label=None, prec=None, index=False,
                 placement="htbp"):
        """A pandas DataFrame (or anything `tex` can typeset) as a complete,
        captioned LaTeX table."""
        body = tex(obj, prec=prec, index=index)
        parts = ["\\begin{table}[%s]" % placement, "\\centering"]
        if caption:
            parts.append("\\caption{%s}" % caption)
        if label:
            parts.append("\\label{%s}" % label)
        parts.append(body)
        parts.append("\\end{table}")
        return "\n".join(parts)

    class HTML:
        """Rich HTML output, like IPython.display.HTML."""
        def __init__(self, data):
            self.data = data
        def _repr_html_(self):
            return self.data
        def __repr__(self):
            return "<HTML>"

    class Markdown:
        """Markdown output."""
        def __init__(self, data):
            self.data = data
        def _repr_markdown_(self):
            return self.data
        def __repr__(self):
            return "<Markdown>"

    class Image:
        """Show an image file or raw bytes (png/jpg/gif)."""
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
        """Playable audio."""
        def __init__(self, source, mime=None):
            self.source = source
            if mime is None and isinstance(source, str):
                ext = os.path.splitext(source)[1].lower().lstrip(".")
                mime = {"mp3": "audio/mpeg", "ogg": "audio/ogg",
                        "m4a": "audio/mp4"}.get(ext, "audio/wav")
            self.mime = mime or "audio/wav"
        def _repr_html_(self):
            return '<audio controls src="%s"></audio>' % _data_uri(self.source, self.mime)
        def __repr__(self):
            return "<Audio>"

    class Video:
        """Playable video with controls/loop."""
        def __init__(self, source, mime=None, loop=False, autoplay=False):
            self.source = source
            if mime is None and isinstance(source, str):
                ext = os.path.splitext(source)[1].lower().lstrip(".")
                mime = {"webm": "video/webm", "ogv": "video/ogg",
                        "mov": "video/quicktime"}.get(ext, "video/mp4")
            self.mime = mime or "video/mp4"
            self.loop = loop
            self.autoplay = autoplay
        def _repr_html_(self):
            attrs = ("controls" + (" loop" if self.loop else "")
                     + (" autoplay muted" if self.autoplay else ""))
            return '<video %s style="max-width:100%%" src="%s"></video>' % (
                attrs, _data_uri(self.source, self.mime))
        def __repr__(self):
            return "<Video>"

    mod.figure = figure
    mod.figtex = figtex
    mod.tabletex = tabletex
    mod.tex = tex
    mod.texesc = texesc
    mod.display = _display
    mod.HTML = HTML
    mod.Markdown = Markdown
    mod.Image = Image
    mod.Audio = Audio
    mod.Video = Video
    mod.__all__ = ["figure", "figtex", "tabletex", "tex", "texesc", "display",
                   "HTML", "Markdown", "Image", "Audio", "Video"]
    return mod


# Names the kernel used to define for free. Kept ONLY so the resulting
# NameError can carry an instruction instead of being a dead end.
_MOVED_TO_PYX = {
    "figure", "figtex", "tabletex", "tex", "texesc",
    "HTML", "Markdown", "Image", "Audio", "Video",
}
_REMOVED_HINTS = {
    "hc": "importa handcalcs: from handcalcs.decorator import handcalc",
    "handcalc": "importalo: from handcalcs.decorator import handcalc",
    "ureg": "crealo tu: import pint; ureg = pint.UnitRegistry()",
}


def _name_hint(name):
    """Migration hint for a name this kernel used to define implicitly."""
    if name in _MOVED_TO_PYX:
        return ("ahora vive en el modulo pyx: escribe `from pyx import %s` "
                "al principio de la celda" % name)
    return _REMOVED_HINTS.get(name)


class _PyxShell:
    """The minimal `get_ipython()` that every notebook kernel exposes.

    It exists so libraries that register cell magics at import time — handcalcs
    is the one that matters here — can be imported FOR REAL instead of being
    replaced by a stub. `import handcalcs.render` then does what it does in
    Jupyter: it registers its magics, and that registration is what tells this
    kernel that `%%render` is available in this session."""

    def __init__(self):
        self.magics = {}
        self.user_ns = NS

    def register_magics(self, *objs):
        for o in objs:
            self.magics[getattr(o, "__name__", str(o))] = o

    def register_magic_function(self, func, magic_kind="line", magic_name=None):
        self.magics[magic_name or getattr(func, "__name__", "magic")] = func

    # Attributes libraries commonly probe for before registering.
    def run_line_magic(self, *_a, **_k):
        return None

    def run_cell_magic(self, *_a, **_k):
        return None

    def __repr__(self):
        return "<PyxShell>"


_SHELL = _PyxShell()


def _patch_ipython_shell():
    """Make IPython's own ``get_ipython()`` return this kernel.

    Libraries that register cell magics do not call the builtin
    ``get_ipython``; they do ``from IPython import get_ipython``, and IPython's
    version returns ``None`` unless an InteractiveShell exists. handcalcs then
    fails at import with ``'NoneType' object has no attribute
    'register_magic_function'``.

    Announcing itself as the current shell is what a kernel is FOR — it is the
    same thing ipykernel does by instantiating an InteractiveShell, only
    without dragging the whole machinery in. It happens exclusively when the
    document imports IPython itself, so a session that never does pays nothing
    and no library is treated as special.

    Reads from ``sys.modules`` (never imports IPython) and patches every
    already-loaded IPython module that re-exported the function, since
    ``from X import get_ipython`` binds the value, not the module."""
    ipy = sys.modules.get("IPython")
    if ipy is None:
        return
    getter = lambda: _SHELL  # noqa: E731
    if getattr(getattr(ipy, "get_ipython", None), "__name__", "") == "_pyx_get_ipython":
        return
    getter.__name__ = "_pyx_get_ipython"
    for name, mod in list(sys.modules.items()):
        if mod is None or not (name == "IPython" or name.startswith("IPython.")):
            continue
        if getattr(mod, "get_ipython", None) is not None:
            try:
                mod.get_ipython = getter
            except Exception:
                pass


def _install_kernel_builtins():
    """What the KERNEL provides, as opposed to what a LIBRARY provides:
    `display()` and `get_ipython()`. They live in builtins, so a namespace reset
    does not have to put them back and `dir()` in a cell lists only the
    document's own names."""
    import builtins
    builtins.display = _display
    builtins.get_ipython = lambda: _SHELL
    if "pyx" not in sys.modules:
        sys.modules["pyx"] = _build_pyx_module()


def _magic_registered(name):
    """True when some library has registered `%%name` in THIS session.

    This is the whole point: `%%render` works because the document ran
    `import handcalcs.render` and that import registered the magic, exactly as
    in Jupyter — not because the kernel decided handcalcs is special. The
    registry is filled by the library itself through `get_ipython()`."""
    return name in _SHELL.magics or "handcalcs.render" in sys.modules


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


class MagicNotRegistered(Exception):
    """A cell magic was used that no library has registered in this session."""


def _detect_magic(code):
    """If the cell uses a handcalcs cell magic, split it into the parts we need.

    Returns ``{"setup", "calc", "args"}`` or ``None``. ``setup`` is everything
    before the magic line (imports, assignments) — run but not rendered;
    ``calc`` is everything after — run and rendered by handcalcs.

    The magic is honoured ONLY when the session has actually imported
    handcalcs' magics. Before, the kernel implemented `%%render` itself and
    stubbed the real module out, so the magic worked in a session that had
    never heard of handcalcs — and the genuine library could not be used."""
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

    _cell_seq += 1
    filename = "<calc-cell-%d>" % _cell_seq
    _last_cell_file = filename
    full = magic.get("full", "")
    _register_cell_source(filename, full)

    # The setup runs FIRST, so a cell that imports handcalcs on its own first
    # line and then uses the magic works — the check below has to see the
    # imports this very cell performs.
    setup = magic["setup"]
    if setup.strip():
        exec(compile(setup, filename, "exec"), NS, NS)

    kind = magic.get("kind", "render")
    if not _magic_registered(kind):
        raise MagicNotRegistered(
            "la celda usa %%" + kind + " pero ninguna libreria ha registrado esa "
            "magia en esta sesion. Anade `import handcalcs.render` (igual que en "
            "Jupyter) en una celda anterior o al principio de esta."
        )
    _hand = sys.modules.get("handcalcs.handcalcs")
    if _hand is None:
        import handcalcs.handcalcs as _hand  # part of the library already loaded

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


def _latex_display(latex):
    """A handcalcs result, as a display entry the app renders itself.

    This used to emit an HTML blob that pulled KaTeX off a CDN and called it
    from a <script> tag. It made the flagship feature — seeing a textbook-style
    calculation beside its cell — depend on an internet connection, and it
    forced the output into a script-bearing frame. The app bundles KaTeX and
    renders this locally instead (see js/editor/math-render.js), so the kernel
    just hands over the LaTeX."""
    return {"kind": "latex", "data": latex}


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
_registered = []      # cell filenames currently held in linecache
_REGISTERED_MAX = 200


def _register_cell_source(filename, code):
    """Publish a cell's source to `linecache` so `inspect.getsource` works for
    functions defined in it (handcalcs needs this) and tracebacks can show the
    offending line.

    Bounded: every execution minted a new `<calc-cell-N>` entry and none were
    ever removed, so a long session slowly accumulated every version of every
    cell it had ever run."""
    linecache.cache[filename] = (
        len(code), None, [ln + "\n" for ln in code.split("\n")], filename,
    )
    _registered.append(filename)
    while len(_registered) > _REGISTERED_MAX:
        linecache.cache.pop(_registered.pop(0), None)


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
    # A name this kernel used to define implicitly: say where it went instead of
    # leaving a bare "name 'figure' is not defined".
    if isinstance(exc, NameError):
        missing = getattr(exc, "name", None)
        if missing is None:
            m = _re.search(r"name '([^']+)' is not defined", str(exc))
            missing = m.group(1) if m else None
        hint = _name_hint(missing) if missing else None
        if hint:
            msg = "%s — %s" % (msg, hint)
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
    _register_cell_source(filename, code)

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
    # Read from sys.modules: a value can only BE a numpy type if the document
    # already imported numpy, so importing it here would only slow down every
    # \py{} in a session that never uses it.
    _np = sys.modules.get("numpy")
    if _np is not None:
        if isinstance(value, _np.ndarray):
            raise TypeError(
                "es un array NumPy de forma %s; usa \\py{tex(...)} para una "
                "matriz LaTeX (from pyx import tex)"
                % (getattr(value, "shape", "?"),)
            )
        if isinstance(value, _np.generic):
            value = value.item()

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
        # A reset empties the namespace and NOTHING is put back. The kernel's
        # own protocol (display, get_ipython, the `pyx` module) lives in
        # builtins and sys.modules, so a cell after a reset starts exactly as
        # empty as the first cell of a fresh Jupyter session.
        NS.clear()

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
                DISPLAYS.append(_latex_display(render_latex))
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
            if isinstance(exc, KeyboardInterrupt):
                # A user interrupt is not a defect: say what happened, and say
                # that the session survived it.
                error["msg"] = ("ejecución interrumpida. Las variables "
                                "calculadas hasta aquí siguen en memoria.")
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


# ---------------------------------------------------------------------------
# interrupt support
# ---------------------------------------------------------------------------
# The executing thread's id, so an interrupt can be aimed at it. Set by the
# worker; read by the reader thread.
_exec_tid = None
_interrupt_pending = False


def _raise_in_thread(tid, exctype):
    """Deliver (or clear, with exctype=None) an asynchronous exception in a
    thread. This is the mechanism behind Jupyter's interrupt: the running cell
    raises KeyboardInterrupt at its next bytecode boundary, and everything it
    had already computed stays in the namespace."""
    if tid is None:
        return
    obj = ctypes.py_object(exctype) if exctype is not None else ctypes.py_object()
    try:
        ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(tid), obj)
    except Exception:
        pass


def _request_interrupt():
    global _interrupt_pending
    if _exec_tid is None:
        return
    _interrupt_pending = True
    _raise_in_thread(_exec_tid, KeyboardInterrupt)


def _worker(req_q):
    """Execute requests one at a time and write their responses."""
    global _exec_tid, _interrupt_pending
    _exec_tid = threading.get_ident()
    while True:
        req = req_q.get()
        if req is None:
            return
        try:
            resp = handle(req)
        except BaseException:
            resp = {"id": req.get("id"), "ok": False, "stdout": "",
                    "stderr": traceback.format_exc(), "result": None,
                    "error": None, "displays": [], "render": None, "images": []}
        # An interrupt aimed at this thread can still be in flight when the
        # cell has already finished; clearing it here keeps it from surfacing
        # inside the NEXT, unrelated cell.
        if _interrupt_pending:
            _raise_in_thread(_exec_tid, None)
            _interrupt_pending = False
        try:
            _REAL_STDOUT.write(json.dumps(resp) + "\n")
            _REAL_STDOUT.flush()
        except Exception:
            return


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
    _install_kernel_builtins()

    req_q = queue.Queue()
    worker = threading.Thread(target=_worker, args=(req_q,), daemon=True)
    worker.start()

    _REAL_STDOUT.write(json.dumps({"type": "ready", "python": sys.version.split()[0]}) + "\n")
    _REAL_STDOUT.flush()

    # READER loop. It must never execute anything itself: staying free is what
    # lets a control message be seen while a cell is still running.
    for line in real_stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        kind = req.get("type")
        if kind == "shutdown":
            break
        if kind == "interrupt":
            _request_interrupt()
            continue
        req_q.put(req)

    req_q.put(None)
    worker.join(timeout=1.0)


if __name__ == "__main__":
    main()
