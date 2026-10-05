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
    {"id": 3, "lint": ["cell code", ...]}                        # squiggles
    {"id": 4, "prewarm": ["numpy", "scipy.optimize"], "cwd": ...}

Control messages (handled while a cell is still running):
    {"type": "interrupt"}     raise KeyboardInterrupt in the running cell
    {"type": "shutdown"}      exit

Requests are READ on the main thread and EXECUTED on a worker thread. That
split is what makes a real interrupt possible: the reader keeps listening while
a cell runs, so an interrupt can be delivered to the executing thread instead of
the host having to kill the whole process and lose the session's variables.

Responses:
    {"id": 1, "ok": true, "stdout": "...", "stderr": "", "result": "4",
     "displays": [], "render": null, "images": []}
    {"id": 2, "ok": true, "evals": {"x": {"ok": true, "value": "4"}, ...}}

The protocol runs on PRIVATE file descriptors (see _isolate_protocol_fds).
fd 0 is NUL and fd 1 a pipe drained into the running cell, so neither Python
code, C extensions nor child processes can reach the JSON stream.

handcalcs support
-----------------
A cell can use the same cell magics as in Jupyter (``%%render`` / ``%%tex``).
The kernel runs the cell, then feeds its source to
``handcalcs.handcalcs.LatexRenderer`` and returns the LaTeX in the "render"
field. The compiler injects that LaTeX into the document at the cell's
position, so the calculation is typeset automatically (matching the user's
Jupyter workflow).
"""

import sys
import os
import io
import json
import re
import ast
import time
import types
import ctypes
import base64
import queue
import threading
import warnings
import linecache
import traceback
import textwrap
import tokenize
import uuid
import weakref
from importlib.machinery import FileFinder as _FileFinder

os.environ.setdefault("MPLBACKEND", "Agg")  # headless matplotlib
# plotly: with IPython importable, plotly picks the "plotly_mimetype+notebook"
# renderer, whose activation PRINTS all of plotly.js (4.8 MB) and whose HTML
# expects a notebook-global Plotly object that a Pyx output frame never has.
os.environ.setdefault("PLOTLY_RENDERER", "plotly_mimetype")
# Agg can't "show" a window; figures are captured automatically instead, so the
# warning plt.show() raises is noise (and doesn't appear in Jupyter either).
warnings.filterwarnings("ignore", message=".*non-interactive.*")
warnings.filterwarnings("ignore", message=".*cannot be shown.*")

_orig_formatwarning = warnings.formatwarning


def _pyx_formatwarning(message, category, filename, lineno, line=None):
    """A warning raised by a cell's own code names its line in the cell, not
    the kernel's internal file name (`<calc-cell-7>:4: DeprecationWarning`)."""
    if isinstance(filename, str) and filename.startswith("<calc-cell"):
        if line is None:
            line = linecache.getline(filename, lineno)
        s = "línea %s: %s: %s\n" % (lineno, category.__name__, message)
        if line and line.strip():
            s += "    %s\n" % line.strip()
        return s
    return _orig_formatwarning(message, category, filename, lineno, line)


warnings.formatwarning = _pyx_formatwarning

# Rich outputs (display(), HTML, images, video…) collected during one cell run.
DISPLAYS = []
# Figure OBJECTS already emitted during THIS cell, so the end-of-cell sweep
# does not show the same plot a second time. Objects, not pyplot numbers:
# pyplot reuses a closed figure's number, and a new figure that inherited it
# was silently dropped. Cleared at the start of every execution.
_EMITTED_FIGS = weakref.WeakSet()
_LAST_SHOWN = [None]  # last figure plt.show() closed in this cell (pyx.figure)

# Every compile() of user code allows top-level `await`, as IPython does.
_FLAGS = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
_MISSING = object()


# ---------------------------------------------------------------------------
# protocol integrity
# ---------------------------------------------------------------------------
# The JSON frames are the ONLY thing that may ever reach the real stdout.
# Frames are written through _REAL_STDOUT (a private descriptor, set in
# main()); sys.stdout/sys.stderr are the session's _OutStream objects, pointed
# at the running cell's buffer, or between cells at absorbing buffers whose
# content is surfaced with the NEXT cell's output (Jupyter-like, nothing lost).
_REAL_STDOUT = None  # set once in main()


class _CellIO(io.StringIO):
    """StringIO with the attributes libraries probe on sys.stdout (pandas,
    tqdm… read .encoding; StringIO lacks it)."""
    encoding = "utf-8"
    errors = "strict"


_BG_OUT = _CellIO()  # stray background stdout between requests
_BG_ERR = _CellIO()  # stray background stderr (thread tracebacks…)
_IDLE_CAP = 1 << 20  # at most 1 MB of between-cells output is kept
_STREAM_CAP = 1 << 20  # a cell's stdout/stderr beyond this is trimmed


def _drain(buf):
    v = buf.getvalue()
    if v:
        buf.seek(0)
        buf.truncate()
    return v


class _OutStream(io.TextIOBase):
    """THE sys.stdout / sys.stderr of the session (ipykernel's OutStream).

    It never changes; the kernel re-points it at the running cell's buffer and
    back at the idle buffer. A new StringIO per cell used to BE sys.stdout, so
    anything that kept a reference to it — a logging.basicConfig() handler, a
    tqdm bar, `def f(out=sys.stdout)`, loguru, rich — wrote into the dead
    buffer of the cell that created it, and its output silently vanished from
    every later cell. A cell cannot close it either."""
    encoding = "utf-8"
    errors = "strict"

    def __init__(self, name, fd, idle):
        super().__init__()
        self.name = "<%s>" % name
        self._fd = fd
        self._idle = idle
        self._target = idle
        self._lock = threading.Lock()

    def writable(self):
        return True

    def isatty(self):
        return False

    def fileno(self):
        # fd 1 is the kernel's capture pipe and fd 2 the stderr the app
        # drains: never the protocol, so `subprocess.run(..., stdout=
        # sys.stdout)` and `faulthandler.enable()` work as in Jupyter.
        return self._fd

    def write(self, s):
        if not isinstance(s, str):
            raise TypeError("write() argument must be str, not %s" % type(s).__name__)
        with self._lock:
            t = self._target
            if t is self._idle and t.tell() > _IDLE_CAP:
                return len(s)  # runaway background printer: never grow forever
            return t.write(s)

    def flush(self):
        pass

    def close(self):
        pass

    @property
    def closed(self):
        return False

    def point_to(self, buf):
        with self._lock:
            self._target = buf


_STDOUT = _OutStream("stdout", 1, _BG_OUT)
_STDERR = _OutStream("stderr", 2, _BG_ERR)


def _safe_str(obj):
    """str() that cannot fail (an exception whose __str__ raises used to
    replace the user's error with the kernel's own traceback)."""
    try:
        s = str(obj)
        return s if isinstance(s, str) else repr(s)
    except BaseException:
        return "<str() falló: %s>" % type(obj).__name__


# ---- fd-level isolation of the protocol -----------------------------------
_FD_SYNC = b"\x1bPYX-FD-SYNC\x1b"
_fd_synced = threading.Event()
_fd_pump_alive = False


def _isolate_protocol_fds():
    """Move the protocol to PRIVATE, non-inheritable descriptors.

    fd 1 used to BE the protocol pipe: os.write(1, …), C printf, solver logs
    (HiGHS), and every child process that inherits the standard handles
    (os.system, subprocess without capture, multiprocessing workers) wrote
    straight into the JSON stream; a missing newline or cp850 bytes then hung
    or killed the app. fd 0 WAS the request pipe: a child that reads stdin
    (findstr, `set /p`, a script's input()) ate the app's requests, including
    the interrupt.

    Now fd 0 is NUL (readers get EOF at once) and fd 1 is a pipe the kernel
    drains into the running cell's output. os.dup2 on fds 0-2 also updates the
    Win32 standard handles that child processes inherit."""
    global _fd_pump_alive
    proto_in = os.dup(0)    # PEP 446: not inheritable by children
    proto_out = os.dup(1)
    nul = os.open(os.devnull, os.O_RDONLY)
    os.dup2(nul, 0)
    os.close(nul)
    r, w = os.pipe()
    os.dup2(w, 1)
    os.close(w)
    _fd_pump_alive = True
    threading.Thread(target=_pump_fd1, args=(r,), daemon=True, name="pyx-fd1").start()
    return proto_in, proto_out


def _decode_fd_bytes(b):
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        # cmd.exe & co. write in the console's OEM code page (cp850 here).
        try:
            return b.decode("oem", "replace")
        except Exception:
            return b.decode("utf-8", "replace")


def _utf8_complete(b, n):
    """Largest index <= n such that b[:index] does not end mid UTF-8 char."""
    for back in range(1, min(4, n) + 1):
        c = b[n - back]
        if c < 0x80:
            return n
        if c >= 0xC0:
            need = 2 if c < 0xE0 else 3 if c < 0xF0 else 4
            return n if back >= need else n - back
    return n


def _pump_fd1(rfd):
    # A blocking read is safe HERE (unlike on the request pipe, see
    # _request_lines): a DLL's CRT start-up only queries the STANDARD
    # handles, and this is the private read end of the capture pipe.
    global _fd_pump_alive
    buf = b""
    try:
        while True:
            try:
                chunk = os.read(rfd, 65536)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk
            while True:
                i = buf.find(_FD_SYNC)
                if i < 0:
                    break
                if i:
                    _STDOUT.write(_decode_fd_bytes(buf[:i]))
                buf = buf[i + len(_FD_SYNC):]
                _fd_synced.set()
            # keep a possible partial marker / partial UTF-8 char for later
            keep = 0
            for n in range(len(_FD_SYNC) - 1, 0, -1):
                if buf.endswith(_FD_SYNC[:n]):
                    keep = n
                    break
            cut = _utf8_complete(buf, len(buf) - keep)
            if cut > 0:
                _STDOUT.write(_decode_fd_bytes(buf[:cut]))
                buf = buf[cut:]
    finally:
        _fd_pump_alive = False


def _sync_fd1(timeout=0.5):
    """Wait until everything written to fd 1 so far reached the cell."""
    if not _fd_pump_alive:
        return
    _fd_synced.clear()
    try:
        os.write(1, _FD_SYNC)
    except OSError:
        return
    _fd_synced.wait(timeout)


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


def _patch_console_input():
    """getpass.getpass() and msvcrt.getwch() read the (hidden, windowless)
    CONSOLE, not stdin: they blocked forever in C, beyond the reach of a soft
    interrupt. Fail fast like input() does."""
    def _no_console(*_a, **_k):
        raise RuntimeError(
            "getpass()/msvcrt.getch() no están disponibles en las celdas de Pyx "
            "(no hay consola); asigna el valor directamente en el código.")
    try:
        import getpass
        getpass.getpass = _no_console
    except Exception:
        pass
    if os.name == "nt":
        try:
            import msvcrt
            for n in ("getch", "getwch", "getche", "getwche"):
                setattr(msvcrt, n, _no_console)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# figures and library show() functions
# ---------------------------------------------------------------------------
def _fig_png(fig):
    """PNG of a figure the way matplotlib-inline makes it: at the figure's own
    dpi (Pyx's 110 when the user left matplotlib's default untouched)."""
    dpi = getattr(fig, "dpi", None) or 100
    mpl = sys.modules.get("matplotlib")
    try:
        if mpl is not None and dpi == mpl.rcParamsDefault["figure.dpi"]:
            dpi = 110
    except Exception:
        pass
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=dpi, bbox_inches="tight")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _flush_figures():
    """matplotlib-inline's show(): every open figure not shown yet is emitted
    HERE, in order, and all are closed, so the next plt.plot() starts a new
    figure (a loop with plt.show() gives one picture per iteration, and text
    printed between two plots stays between them)."""
    plt_mod = sys.modules.get("matplotlib.pyplot")
    if plt_mod is None:
        return
    try:
        for num in plt_mod.get_fignums():
            fig = plt_mod.figure(num)
            if fig in _EMITTED_FIGS:
                continue
            _EMITTED_FIGS.add(fig)
            DISPLAYS.append(_mark({"kind": "image", "data": _fig_png(fig)}))
            _LAST_SHOWN[0] = fig
        plt_mod.close("all")
    except Exception:
        pass


def _patch_mpl_show():
    """plt.show() -> show the open figures now (Jupyter inline semantics).
    Tolerates being called while pyplot is still half-initialized (the import
    hook fires during matplotlib's own internal imports)."""
    plt_mod = sys.modules.get("matplotlib.pyplot")
    show = getattr(plt_mod, "show", None) if plt_mod is not None else None
    if show is not None and getattr(show, "__name__", "") != "_pyx_show_figs":
        def _pyx_show_figs(*_a, **_k):
            _flush_figures()
        plt_mod.show = _pyx_show_figs


def _patch_plotly_show():
    """plotly fig.show() opens the system BROWSER by default — route it to an
    in-app rich display instead (interactive hover/zoom/3D inside Pyx).

    Reads the ALREADY-LOADED module from sys.modules; it must NOT import
    anything itself, or the import hook would re-fire and recurse forever."""
    bd = sys.modules.get("plotly.basedatatypes")
    base_figure = getattr(bd, "BaseFigure", None) if bd is not None else None
    if base_figure is not None and getattr(base_figure.show, "__name__", "") != "_pyx_show":
        def _pyx_show(self, *_a, **_k):
            DISPLAYS.append({
                "kind": "html",
                "data": self.to_html(include_plotlyjs="cdn", full_html=False),
            })
        base_figure.show = _pyx_show
    # plotly.io.show(fig, renderer="browser") starts a local web server and
    # WAITS for a browser to fetch the page: the cell never finished. Every
    # renderer shows the figure in-app instead.
    #
    # plotly.io loads `show` lazily, through a module __getattr__, the first
    # time it is used — after the import hook has already run. Wrap that
    # loader, so the patch lands the moment `show` exists.
    pio_mod = sys.modules.get("plotly.io")
    lazy = getattr(pio_mod, "__dict__", {}).get("__getattr__") if pio_mod is not None else None
    if callable(lazy) and not getattr(lazy, "_pyx", False):
        def _pyx_lazy(name, _orig=lazy):
            value = _orig(name)
            if name == "show":
                _patch_plotly_show()
                rdm = sys.modules.get("plotly.io._renderers")
                value = getattr(rdm, "show", value)
            return value
        _pyx_lazy._pyx = True
        try:
            pio_mod.__getattr__ = _pyx_lazy
        except Exception:
            pass
    rd = sys.modules.get("plotly.io._renderers")
    show = getattr(rd, "show", None) if rd is not None else None
    if show is not None and getattr(show, "__name__", "") != "_pyx_pio_show":
        def _pyx_pio_show(fig, renderer=None, validate=True, **_k):
            pio = sys.modules.get("plotly.io")
            DISPLAYS.append({"kind": "html", "data": pio.to_html(
                fig, include_plotlyjs="cdn", full_html=False, validate=validate)})
        try:
            rd.show = _pyx_pio_show
            pio = sys.modules.get("plotly.io")
            if pio is not None and "show" in vars(pio):
                pio.show = _pyx_pio_show
        except Exception:
            pass
    # init_notebook_mode() prints a require.js loader that later outputs then
    # wait for — and they stayed blank. Pyx needs no notebook mode.
    off = sys.modules.get("plotly.offline.offline")
    init = getattr(off, "init_notebook_mode", None) if off is not None else None
    if init is not None and getattr(init, "__name__", "") != "_pyx_init_nb":
        def _pyx_init_nb(*_a, **_k):
            return None
        try:
            off.init_notebook_mode = _pyx_init_nb
            top = sys.modules.get("plotly.offline")
            if top is not None:
                top.init_notebook_mode = _pyx_init_nb
        except Exception:
            pass


def _patch_bokeh_show():
    """bokeh.io.show() writes an HTML file and opens the system browser; in
    notebook mode it needs BokehJS loaded in the same page, which a sandboxed
    per-output frame never has. Emit a self-contained HTML display instead."""
    def _pyx_bokeh_show(obj, *_a, **_k):
        from bokeh.embed import file_html
        from bokeh.resources import CDN
        DISPLAYS.append({"kind": "html", "data": file_html(obj, CDN)})
    _pyx_bokeh_show.__name__ = "_pyx_bokeh_show"
    for name in ("bokeh.io", "bokeh.io.showing", "bokeh.plotting"):
        m = sys.modules.get(name)
        cur = getattr(m, "show", None) if m is not None else None
        if cur is not None and getattr(cur, "__name__", "") != "_pyx_bokeh_show":
            try:
                m.show = _pyx_bokeh_show
            except Exception:
                pass


def _main_global_in(data):
    """Name of the first `__main__.<name>` reference in a pickle, or None."""
    import pickletools
    strings = []
    try:
        for op, arg, _pos in pickletools.genops(data):
            n = op.name
            if n == "GLOBAL":
                mod, _, name = str(arg).partition(" ")
                if mod == "__main__":
                    return name
            elif n in ("SHORT_BINUNICODE", "BINUNICODE", "BINUNICODE8", "UNICODE"):
                strings.append(arg)
            elif n == "STACK_GLOBAL":
                if len(strings) >= 2 and strings[-2] == "__main__":
                    return strings[-1]
    except Exception:
        return None
    return None


_MAIN_BYTES = re.compile(b"__main__")


def _patch_mp_pickler():
    """With a real __main__, a function/class defined in a cell pickles by
    reference (`__main__.f`) — as in Jupyter — but a spawn child cannot import
    it: the worker dies unpickling the task and Pool.map() waits forever
    (Jupyter on Windows hangs the same way). Refuse it in the PARENT instead,
    with an explanation. Only pickles that mention b"__main__" pay the scan."""
    red = sys.modules.get("multiprocessing.reduction")
    fp = getattr(red, "ForkingPickler", None) if red is not None else None
    if fp is None or getattr(fp.dumps, "_pyx", False):
        return
    orig = fp.dumps.__func__

    def dumps(cls, obj, protocol=None):
        buf = orig(cls, obj, protocol)
        # re searches the buffer in place: a 100 MB array sent to a worker is
        # not copied just to look for a module name.
        if _MAIN_BYTES.search(buf):
            raw = bytes(buf)
            mp = sys.modules.get("multiprocessing")
            try:
                method = mp.get_start_method(allow_none=True) or mp.get_all_start_methods()[0]
            except Exception:
                method = "spawn"
            name = _main_global_in(raw) if method != "fork" else None
            if name:
                import pickle
                # Release the buffer first: a live export of the BytesIO in
                # the traceback's frame made the garbage collector print
                # "BufferError: Existing exports of data" into a LATER cell.
                try:
                    buf.release()
                except Exception:
                    pass
                del buf
                raise pickle.PicklingError(
                    "'%s' está definido en una celda: los procesos hijos (multiprocessing, "
                    "ProcessPoolExecutor) no pueden importarlo. Muévelo a un archivo .py e "
                    "impórtalo, o usa joblib.Parallel (lo envía por valor)." % name)
        return buf

    dumps._pyx = True
    fp.dumps = classmethod(dumps)


# ---------------------------------------------------------------------------
# import hook
# ---------------------------------------------------------------------------
_in_import_patch = False


def _may_load(name, args, kwargs):
    """Could this import statement execute module code? False for a plain
    cache hit — the common case, a library's function-level `import x` run
    in a hot loop — which must stay as cheap as the builtin import."""
    fromlist = args[2] if len(args) > 2 else kwargs.get("fromlist")
    level = args[3] if len(args) > 3 else kwargs.get("level", 0)
    if level:
        g = args[0] if args else kwargs.get("globals")
        pkg = (g or {}).get("__package__") if isinstance(g, dict) else None
        if not pkg:
            return True
        bits = pkg.rsplit(".", level - 1)
        if len(bits) < level:
            return True
        name = bits[0] + "." + name if name else bits[0]
    m = sys.modules.get(name)
    if m is None:
        return True
    for f in fromlist or ():
        if isinstance(f, str) and f != "*" and not hasattr(m, f):
            return True
    return False


def _install_import_hook():
    """Adapt libraries the moment they are imported (matplotlib/plotly/bokeh
    show(), IPython's get_ipython/display, multiprocessing's pickler), so even
    a single cell that imports AND shows stays in-app; and keep the process
    state a library sets up while loading (see _keep_library_changes).

    Guarded by a re-entrancy flag and try/except: a failed adaptation must
    never turn into an ImportError in the user's cell."""
    import builtins
    if getattr(builtins.__import__, "__name__", "") == "_pyx_import":
        return
    _orig_import = builtins.__import__
    depth = threading.local()

    def _pyx_import(name, *args, **kwargs):
        d = getattr(depth, "n", 0)
        before = None
        if d == 0:
            try:
                if _may_load(name, args, kwargs):
                    before = _import_state()
            except Exception:
                before = None
        depth.n = d + 1
        try:
            mod = _orig_import(name, *args, **kwargs)
        finally:
            depth.n = d
            if before is not None:
                try:
                    _keep_library_changes(before)
                except Exception:
                    pass
        if _MAGIC_OWNERS:
            level = args[3] if len(args) > 3 else kwargs.get("level", 0)
            if not level:
                _activate_magics(name, args[2] if len(args) > 2 else kwargs.get("fromlist"))
        global _in_import_patch
        if not _in_import_patch:
            _in_import_patch = True
            try:
                root = name.split(".", 1)[0]
                if root == "matplotlib":
                    _patch_mpl_show()
                elif root == "plotly":
                    _patch_plotly_show()
                elif root == "bokeh":
                    _patch_bokeh_show()
                elif root in ("multiprocessing", "concurrent", "joblib"):
                    _patch_mp_pickler()
                elif root == "IPython":
                    # Done here, not lazily: `from IPython import get_ipython`
                    # binds the value the instant IPython finishes loading.
                    _patch_ipython_shell()
                if before is not None:
                    _after_toplevel_import()
            except Exception:
                pass
            finally:
                _in_import_patch = False
        return mod

    _pyx_import.__name__ = "_pyx_import"
    builtins.__import__ = _pyx_import


def _after_toplevel_import():
    """Runs after every OUTERMOST import statement that loaded something."""
    if (_ASYNC_LOOP is None and "asyncio" in sys.modules
            and threading.get_ident() == _exec_tid):
        _event_loop()  # asyncio.get_event_loop() works in a cell
    if _REAL is None and _ipython_ready():
        # `from IPython.display import display` must work right away:
        # IPython's display() prints the repr unless a shell is initialized.
        _real_shell()
    _snapshot_libraries()


# Persistent namespace shared by every cell in this kernel session. It is the
# __dict__ of a real module installed as sys.modules["__main__"] (IPython's
# user_module): __name__ == "__main__" in a cell, functions and classes defined
# in cells have __module__ == "__main__", so pickle, joblib.dump, enum,
# typing.get_type_hints and `if __name__ == "__main__":` behave as in Jupyter,
# and DeprecationWarnings raised by the cell's own code are shown.
_USER_MAIN = types.ModuleType("__main__")
NS = _USER_MAIN.__dict__


def _init_user_ns():
    import builtins
    NS.update({"__name__": "__main__", "__builtins__": builtins,
               "__doc__": None, "__package__": None, "__loader__": None,
               "__spec__": None})


_init_user_ns()


# ---------------------------------------------------------------------------
# rich output: routing an object to its richest representation
# ---------------------------------------------------------------------------
def _safe_attr(obj, name):
    """A formatter method of `obj`, IPython-style: never on a class, never
    from a proxy object that claims to have every attribute."""
    if isinstance(obj, type):
        return None
    try:
        m = getattr(obj, name, None)
    except Exception:
        return None
    if not callable(m):
        return None
    try:
        if callable(getattr(obj, "_ipython_canary_method_should_not_exist_", None)):
            return None
    except Exception:
        return None
    return m


def _fig_number(obj):
    """The pyplot figure number of `obj`, or None if it isn't a figure.

    Duck-typed on purpose: matplotlib must not be imported to answer this, and
    a session that never plots must not pay for loading it. A pyplot-managed
    Figure is the only common object carrying both `savefig` and an integer
    `number`."""
    try:
        num = getattr(obj, "number", None)
    except Exception:
        return None
    if isinstance(num, bool) or not isinstance(num, int):
        return None
    return num if _safe_attr(obj, "savefig") is not None else None


_HANDLED = object()   # the object displayed itself (_ipython_display_)

_REPR_METHODS = (
    ("text/html", "_repr_html_"), ("text/markdown", "_repr_markdown_"),
    ("text/latex", "_repr_latex_"), ("image/svg+xml", "_repr_svg_"),
    ("image/png", "_repr_png_"), ("image/jpeg", "_repr_jpeg_"),
    ("image/gif", "_repr_gif_"), ("application/json", "_repr_json_"),
)
# JupyterLab's renderer ranks: html 50, markdown 60, latex 70, svg 80, images 90.
_MIME_ORDER = ("text/html", "text/markdown", "text/latex", "image/svg+xml",
               "image/png", "image/jpeg", "image/gif")


def _formatter():
    """IPython's DisplayFormatter, when this session has a real shell:
    sympy.init_printing and rich.pretty.install register their printers
    there, and Jupyter consults it for every output."""
    sh = _REAL
    if sh is None:
        return None
    try:
        return sh.display_formatter
    except Exception:
        return None


def _mime_bundle(obj, full=False):
    """{mime: data} with IPython's DisplayFormatter rules: _repr_mimebundle_
    first, then the _repr_*_ methods fill what is missing — but LAZILY, in
    JupyterLab's order, stopping at the first renderable one (unless `full`).
    IPython computes every format; after sympy.init_printing() that means an
    external LaTeX+dvipng run per value for a PNG nobody shows (30 s here).
    Only instances (never classes); a (data, metadata) tuple is unwrapped; a
    method that raises or returns None contributes nothing."""
    if isinstance(obj, type):
        return {}
    fmt = _formatter()
    data = {}
    mb = _safe_attr(obj, "_repr_mimebundle_")
    if mb is not None:
        try:
            b = mb(include=None, exclude=None)
            if isinstance(b, tuple):
                b = b[0]
            if isinstance(b, dict):
                data.update(b)
        except Exception:
            pass
    for mime, meth in _REPR_METHODS:
        if not full and any(m in data for m in _MIME_ORDER):
            break
        if mime in data:
            continue
        v = None
        try:
            if fmt is not None and mime in fmt.formatters:
                v = fmt.formatters[mime](obj)
            else:
                f = _safe_attr(obj, meth)
                v = f() if f is not None else None
        except Exception:
            v = None
        if isinstance(v, tuple):
            v = v[0]
        if v is not None and v != "" and v != b"":
            data[mime] = v
    return data


def _strip_math(s):
    """'$x$', '$$x$$', '\\[x\\]' -> 'x' for KaTeX display mode."""
    s = str(s).strip()
    for a, b in (("$$", "$$"), ("\\[", "\\]"), ("\\(", "\\)"), ("$", "$")):
        if s.startswith(a) and s.endswith(b) and len(s) > len(a) + len(b):
            inner = s[len(a):len(s) - len(b)]
            if "$" not in inner:
                return inner.strip()
    return s


def _vega_html(spec, mime):
    m = re.search(r"vegalite\.v(\d+)", mime)
    lite = ('<script src="https://cdn.jsdelivr.net/npm/vega-lite@%s"></script>' % m.group(1)) if m else ""
    div = "vg" + uuid.uuid4().hex[:10]
    return ('<div id="%s"></div><script src="https://cdn.jsdelivr.net/npm/vega@5"></script>%s'
            '<script src="https://cdn.jsdelivr.net/npm/vega-embed@6"></script>'
            '<script>vegaEmbed("#%s", %s);</script>') % (div, lite, div, json.dumps(spec))


def _display_from_bundle(data):
    """The Pyx display entry for a mime bundle (richest renderable wins)."""
    for mime in _MIME_ORDER:
        v = data.get(mime)
        if v is None:
            continue
        if mime == "text/html":
            return {"kind": "html", "data": str(v)}
        if mime == "text/markdown":
            return {"kind": "html", "data": _md_to_html(str(v))}
        if mime == "text/latex":
            # As Jupyter receives it, delimiters and all: the app tells a
            # formula from text with formulas in it (js/editor/math-split.js).
            return {"kind": "latex", "data": str(v)}
        if mime == "image/svg+xml":
            return {"kind": "svg", "data": v.decode("utf-8") if isinstance(v, bytes) else str(v)}
        b64 = base64.b64encode(v).decode("ascii") if isinstance(v, (bytes, bytearray)) else str(v)
        return {"kind": "image", "data": b64, "mime": mime}
    for mime, v in data.items():
        if mime.startswith(("application/vnd.vegalite.", "application/vnd.vega.")):
            return {"kind": "html", "data": _vega_html(v, mime)}
        if mime == "application/vnd.plotly.v1+json":
            pio = sys.modules.get("plotly.io")
            if pio is not None:
                try:
                    return {"kind": "html", "data": pio.to_html(
                        v, include_plotlyjs="cdn", full_html=False, validate=False)}
                except Exception:
                    pass
    if "application/json" in data:
        import html as _html
        return {"kind": "html", "data": "<pre>%s</pre>" % _html.escape(
            json.dumps(data["application/json"], indent=2, default=str))}
    return None


def _mime_route(obj):
    """Route an object to its richest representation, with Jupyter's rules.

    Returns a display entry, _HANDLED (the object displayed itself), or None
    (plain text)."""
    if isinstance(obj, type):
        return None
    ipd = _safe_attr(obj, "_ipython_display_")
    if ipd is not None:
        try:
            ipd()
            return _HANDLED
        except Exception:
            pass
    # A matplotlib figure — or an object that OWNS one and can save it
    # (seaborn's FacetGrid/PairGrid/JointGrid): show the figure once, and mark
    # it so the end-of-cell sweep does not show it a second time.
    fig = obj if _fig_number(obj) is not None else None
    if fig is None and _safe_attr(obj, "savefig") is not None:
        try:
            owner = getattr(obj, "figure", None)
        except Exception:
            owner = None
        fig = owner if _fig_number(owner) is not None else None
        if fig is None and hasattr(obj, "canvas"):
            fig = obj                      # Figure() not managed by pyplot
    if fig is not None:
        try:
            _EMITTED_FIGS.add(fig)
            return {"kind": "image", "data": _fig_png(fig)}
        except Exception:
            pass
    # A numpy array is data, never a picture: a uint8 matrix used to be
    # shown as an image, hiding the numbers of a calculation (Jupyter shows
    # the array; plt.imshow or PIL show it as an image when that is meant).
    return _display_from_bundle(_mime_bundle(obj))


def _text_of(obj):
    """text/plain the way Jupyter shows it (IPython's pretty printer when this
    session has one, e.g. after sympy.init_printing), else repr(). A broken
    __repr__ must not fail the cell: IPython shows the error and moves on."""
    fmt = _formatter()
    if fmt is not None:
        try:
            t = fmt.formatters["text/plain"](obj)
            if isinstance(t, str):
                return t
        except Exception:
            pass
    try:
        t = repr(obj)
        return t if isinstance(t, str) else _safe_str(t)
    except BaseException as e:
        return "<%s object: repr() falló: %s: %s>" % (
            type(obj).__name__, type(e).__name__, _safe_str(e))


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
# display() — IPython.display's API, answered by this kernel
# ---------------------------------------------------------------------------
class _DisplayHandle:
    """IPython.display.DisplayHandle: display()/update() by display_id."""
    def __init__(self, display_id=None):
        self.display_id = display_id or uuid.uuid4().hex

    def display(self, obj, **kwargs):
        _display(obj, display_id=self.display_id, **kwargs)

    def update(self, obj, **kwargs):
        _display(obj, display_id=self.display_id, update=True, **kwargs)

    def __repr__(self):
        return "<DisplayHandle display_id=%s>" % self.display_id


def _mark(r):
    """Where in the cell's stdout this output was produced, so the app shows
    print('A'); display(x); print('B') as A, x, B — not A B, then x."""
    try:
        t = _STDOUT._target
        r["at"] = t.tell() if (t is not _BG_OUT and t is not _BG_ERR) else 0
    except Exception:
        pass
    return r


def _add_display(r, display_id=None, update=False):
    """Append a display entry; an update replaces the entry with that id (the
    cell's FINAL state is what Pyx sends, as Jupyter would show it)."""
    _mark(r)
    if display_id:
        r["display_id"] = display_id
        if update:
            for i, d in enumerate(DISPLAYS):
                if d.get("display_id") == display_id:
                    DISPLAYS[i] = r
            return
    DISPLAYS.append(r)


def _display(*objs, include=None, exclude=None, metadata=None, transient=None,
             display_id=None, raw=False, clear=False, update=False, **kwargs):
    """IPython.display.display, same signature and semantics."""
    if clear:
        _clear_output(wait=True)
    if transient and not display_id:
        display_id = transient.get("display_id")
    if display_id is True:
        display_id = uuid.uuid4().hex
    for obj in objs:
        if raw or include or exclude:
            if raw:
                data = dict(obj) if isinstance(obj, dict) else None
            else:
                data = dict(_mime_bundle(obj, full=True), **{"text/plain": _text_of(obj)})
            if data is None:
                r = {"text": _safe_str(obj)}
            else:
                if include:
                    data = {k: v for k, v in data.items() if k in include}
                if exclude:
                    data = {k: v for k, v in data.items() if k not in exclude}
                r = _display_from_bundle(data)
                if r is None and "text/plain" in data:
                    r = {"text": _safe_str(data["text/plain"])}
        else:
            r = _mime_route(obj)
            if r is None:
                r = {"text": _text_of(obj)}
        if r is None or r is _HANDLED:
            continue
        if "text" in r:
            if not display_id:
                print(r["text"])
                continue
            import html as _html
            r = {"kind": "html", "data": "<pre>%s</pre>" % _html.escape(r["text"])}
        _add_display(r, display_id, update)
    if display_id and not update:
        return _DisplayHandle(display_id)
    return None


def _update_display(obj, *, display_id, **kwargs):
    kwargs["update"] = True
    _display(obj, display_id=display_id, **kwargs)


def _clear_output(wait=False):
    """IPython.display.clear_output: drop what the cell has shown so far."""
    DISPLAYS.clear()
    for s in (_STDOUT, _STDERR):
        t = s._target
        if t is not _BG_OUT and t is not _BG_ERR:
            t.seek(0)
            t.truncate()


def _publish_display_data(data, metadata=None, source=None, *, transient=None,
                          update=False, **kwargs):
    """IPython.display.publish_display_data, answered by the kernel."""
    r = _display_from_bundle(data or {})
    if r is not None:
        _add_display(r, (transient or {}).get("display_id"), update)
    elif data and "text/plain" in data:
        print(data["text/plain"])


# ---------------------------------------------------------------------------
# The `pyx` module — the app's own helpers, imported like any other library
# ---------------------------------------------------------------------------
# NOTHING is injected into the user namespace. A cell starts as empty as a
# Jupyter cell does: numpy, matplotlib, handcalcs, pint and everything else must
# be imported by the document that uses them.
#
# What the kernel provides is the NOTEBOOK PROTOCOL, which belongs to the
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
        if fig is None and not plt.get_fignums() and _LAST_SHOWN[0] is not None:
            fig = _LAST_SHOWN[0]   # plt.show() already showed and closed it
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
        return _texesc_text(str(s))

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


# ---------------------------------------------------------------------------
# magics: which ones THIS session has asked for
# ---------------------------------------------------------------------------
# `%%render` works because the document ran `import handcalcs.render` and that
# import registered the magic, exactly as in Jupyter — not because the kernel
# decided handcalcs is special. A library module stays in sys.modules across a
# reset, so its presence proves nothing: a document that DROPPED the import
# kept a working %%render until Pyx was restarted. So a magic is active only
# once registered, and after a reset only once the import statement of the
# module that registered it runs again.
_MAGIC_OWNERS = {}      # module -> magic names it registered (IPython's own excluded)
_MAGICS_ACTIVE = set()  # magic names usable in this session


def _note_magic(name, owner):
    owner = owner or ""
    if owner == "IPython" or owner.startswith("IPython."):
        return  # IPython's own magics are always there
    _MAGIC_OWNERS.setdefault(owner, set()).add(name)
    _MAGICS_ACTIVE.add(name)


def _note_magics_of(obj):
    """A Magics class/instance: note every line and cell magic it defines."""
    table = getattr(obj, "magics", None)
    owner = getattr(obj if isinstance(obj, type) else type(obj), "__module__", "")
    if isinstance(table, dict):
        for kind in ("line", "cell"):
            for name in (table.get(kind) or {}):
                _note_magic(name, owner)


def _activate_magics(name, fromlist):
    """`import X` / `from X import m` ran: X's magics are usable again."""
    names = _MAGIC_OWNERS.get(name)
    if names:
        _MAGICS_ACTIVE.update(names)
    for f in fromlist or ():
        if isinstance(f, str):
            names = _MAGIC_OWNERS.get(name + "." + f)
            if names:
                _MAGICS_ACTIVE.update(names)


def _magic_registered(name):
    return name in _MAGICS_ACTIVE


# ---------------------------------------------------------------------------
# get_ipython()
# ---------------------------------------------------------------------------
class _PyxEvents:
    """IPython's EventManager surface. matplotlib registers `post_execute`
    the first time pyplot resolves its backend in a session where IPython is
    loaded; without it EVERY plot of that session raised AttributeError."""
    def __init__(self):
        self.callbacks = {}

    def register(self, event, function):
        self.callbacks.setdefault(event, []).append(function)

    def unregister(self, event, function):
        try:
            self.callbacks.get(event, []).remove(function)
        except ValueError:
            pass

    def trigger(self, event, *args, **kwargs):
        for fn in list(self.callbacks.get(event, [])):
            try:
                fn(*args, **kwargs)
            except Exception:
                pass


class _PyxShell:
    """The `get_ipython()` of a session that has not loaded IPython.

    It exists so libraries that register cell magics at import time — handcalcs
    is the one that matters here — can be imported FOR REAL instead of being
    replaced by a stub, and so the probes libraries make (`.events`,
    `hasattr(ip, "kernel")`, `.config`) are answered without importing IPython.

    Anything else a library asks of it (display_formatter, run_line_magic,
    system, push...) upgrades the session to a REAL IPython InteractiveShell
    (see _real_shell) and is answered by it, instead of an AttributeError or
    — worse — a silent no-op."""
    colors = "NoColor"
    # pandas' is_terminal() and friends: a notebook kernel, not a terminal
    # (wide DataFrames get Jupyter's 20 columns, not an 80-character console).
    kernel = None

    def __init__(self):
        self.magics = {}
        self.user_ns = NS
        self.events = _PyxEvents()
        self.config = {}
        self._pending = []  # registrations to hand over to a real shell

    def enable_gui(self, gui=None):
        return None

    def register_magics(self, *objs):
        for o in objs:
            self.magics[getattr(o, "__name__", str(o))] = o
            _note_magics_of(o)
            self._pending.append(("class", o))
        if _REAL is not None:
            _REAL.register_magics(*objs)

    def register_magic_function(self, func, magic_kind="line", magic_name=None):
        name = magic_name or getattr(func, "__name__", "magic")
        self.magics[name] = func
        _note_magic(name, getattr(func, "__module__", ""))
        self._pending.append(("function", func, magic_kind, name))
        if _REAL is not None:
            _REAL.register_magic_function(func, magic_kind, magic_name)

    def run_cell_magic(self, magic_name, line, cell):
        if magic_name in ("render", "tex"):
            return _run_magic_cell(magic_name, line, cell)
        real = _real_shell()
        if real is not None:
            return real.run_cell_magic(magic_name, line, cell)
        fn = self.magics.get(magic_name)
        if callable(fn):
            return fn(line, cell)
        raise NotImplementedError(
            "la magia %%%%%s no esta disponible: IPython no esta instalado en "
            "este Python (pip install ipython)" % magic_name)

    def run_line_magic(self, magic_name, line, _stack_depth=1):
        real = _real_shell()
        if real is not None:
            return real.run_line_magic(magic_name, line, _stack_depth + 1)
        fn = self.magics.get(magic_name)
        if callable(fn):
            return fn(line)
        raise NotImplementedError(
            "la magia %%%s no esta disponible: IPython no esta instalado en "
            "este Python (pip install ipython)" % magic_name)

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        real = _real_shell() if ("IPython" not in sys.modules or _ipython_ready()) else None
        if real is None:
            raise AttributeError(
                "get_ipython().%s no esta disponible: IPython no esta instalado "
                "en este Python (pip install ipython)" % name)
        return getattr(real, name)

    def __repr__(self):
        return "<PyxShell>"


_SHELL = _PyxShell()
_REAL = None           # the real IPython shell, created on demand
_REAL_EVENTS0 = None   # its event callbacks right after creation (for reset)


def _real_shell(create=True):
    """A real IPython InteractiveShell bound to the kernel namespace.

    Created lazily — importing IPython costs ~0.9 s — the first time a cell
    uses IPython syntax (%magic, !cmd, obj?), the document imports IPython
    (e.g. `from IPython.display import display`, or handcalcs), or a library
    asks get_ipython() for something the minimal shell lacks. Pyx still
    executes the cells itself; the shell provides what IPython provides:
    magics, `!` escapes, display_formatter, events, config..."""
    global _SHELL_BUILDING
    if _REAL is not None or not create or _SHELL_BUILDING:
        # Re-entrancy: building the shell imports IPython modules, which run
        # the import hook, which may ask for the shell again. A second build
        # nested inside the first raised MultipleInstanceError, and the first
        # %magic of a session (`%matplotlib inline`) failed as a SyntaxError.
        return _REAL
    _SHELL_BUILDING = True
    try:
        return _build_real_shell()
    finally:
        _SHELL_BUILDING = False


_SHELL_BUILDING = False
_SHELL_CLASS = None   # PyxInteractiveShell, defined once


def _shell_class():
    global _SHELL_CLASS
    if _SHELL_CLASS is not None:
        return _SHELL_CLASS
    from IPython.core.interactiveshell import InteractiveShell
    from IPython.core.displaypub import DisplayPublisher
    from IPython.core.displayhook import DisplayHook
    from traitlets import Type

    class _Pub(DisplayPublisher):
        def publish(self, data, metadata=None, source=None, *, transient=None,
                    update=False, **_kw):
            _publish_display_data(data, metadata, source, transient=transient, update=update)

        def clear_output(self, wait=False):
            _clear_output(wait)

    class _Hook(DisplayHook):
        # Pyx renders a cell's result itself.
        def write_output_prompt(self):
            pass

        def write_format_data(self, format_dict, md_dict=None):
            pass

    class PyxInteractiveShell(InteractiveShell):
        display_pub_class = Type(_Pub)
        displayhook_class = Type(_Hook)
        kernel = None  # see _PyxShell.kernel

        def init_sys_modules(self):
            pass  # the kernel owns sys.modules["__main__"] (_USER_MAIN)

        def init_virtualenv(self):
            pass  # no "Attempting to work in a virtualenv" warnings

        def enable_matplotlib(self, gui=None):
            # `%matplotlib inline`: Pyx always captures figures inline.
            return ("inline", "agg")

        def enable_gui(self, gui=None):
            pass

        def register_magic_function(self, func, magic_kind="line", magic_name=None):
            super().register_magic_function(func, magic_kind, magic_name)
            _note_magic(magic_name or func.__name__, getattr(func, "__module__", ""))

        def register_magics(self, *objs):
            super().register_magics(*objs)
            for o in objs:
                _note_magics_of(o)

        def run_cell_magic(self, magic_name, line, cell):
            if magic_name in ("render", "tex"):
                return _run_magic_cell(magic_name, line, cell)
            return super().run_cell_magic(magic_name, line, cell)

    _SHELL_CLASS = PyxInteractiveShell
    return _SHELL_CLASS


def _build_real_shell():
    global _REAL, _REAL_EVENTS0
    try:
        from traitlets.config import Config
        cls = _shell_class()
        cfg = Config()
        cfg.HistoryManager.enabled = False  # never touch ~/.ipython history.sqlite
        cfg.InteractiveShell.cache_size = 0  # Out/_ are kept by the kernel; no gc per reset
        cfg.InteractiveShell.colors = "NoColor"
        # IPython's start-up resets _, __, ___, In and Out: keep the session's.
        keep = {k: NS[k] for k in ("_", "__", "___", "In", "Out") if k in NS}
        if cls.initialized():
            sh = cls.instance()
        else:
            sh = cls.instance(config=cfg, user_module=_USER_MAIN, user_ns=NS)
    except Exception:
        return None
    for k in ("_", "__", "___"):
        if k in keep:
            NS[k] = keep[k]
    if isinstance(keep.get("In"), list) and isinstance(NS.get("In"), list) and NS["In"] is not keep["In"]:
        NS["In"][:] = keep["In"]
    if isinstance(keep.get("Out"), dict) and isinstance(NS.get("Out"), dict) and NS["Out"] is not keep["Out"]:
        NS["Out"].update(keep["Out"])
    _UNDERS[:] = [NS.get("_", ""), NS.get("__", ""), NS.get("___", "")]
    # Registrations made on the minimal shell before the upgrade (handcalcs).
    for item in list(_SHELL._pending):
        try:
            if item[0] == "class":
                sh.register_magics(item[1])
            else:
                _k, func, kind, name = item
                sh.register_magic_function(func, kind, name)
        except Exception:
            pass
    # Event callbacks registered on the minimal shell (matplotlib).
    for ev, cbs in list(_SHELL.events.callbacks.items()):
        for cb in cbs:
            try:
                sh.events.register(ev, cb)
            except Exception:
                pass
    _SHELL.events.callbacks.clear()
    _REAL = sh
    _REAL_EVENTS0 = {k: list(v) for k, v in sh.events.callbacks.items()}
    # InteractiveShell puts IPython's display() in builtins; the kernel's wins.
    _install_kernel_builtins()
    if _PROC0 is not None:
        import builtins
        _PROC0["builtins"]["__IPYTHON__"] = builtins.__dict__.get("__IPYTHON__", True)
    _patch_ipython_shell()
    return sh


def _ipython_ready():
    """IPython is loaded AND no part of it is still initialising: creating
    the shell from inside IPython's own import is a circular import."""
    for name in ("IPython", "IPython.core.interactiveshell"):
        m = sys.modules.get(name)
        if m is None or getattr(getattr(m, "__spec__", None), "_initializing", False):
            return False
    return True


def _pyx_get_ipython():
    """What get_ipython() returns: the real shell once IPython is loaded
    (cheap then: ~10 ms), the minimal one otherwise."""
    if _REAL is not None:
        return _REAL
    if _ipython_ready():
        return _real_shell() or _SHELL
    return _SHELL


def _trigger(event, *args):
    """IPython events (pre/post_run_cell…): autoreload, libraries' hooks."""
    try:
        if _REAL is not None:
            _REAL.events.trigger(event, *args)
        else:
            _SHELL.events.trigger(event, *args)
    except Exception:
        pass


def _exec_info(code):
    if _REAL is None:
        return None
    try:
        from IPython.core.interactiveshell import ExecutionInfo
        return ExecutionInfo(code, True, False, True, None)
    except Exception:
        return None


def _exec_result(info, exc):
    if _REAL is None:
        return None
    try:
        from IPython.core.interactiveshell import ExecutionResult
        r = ExecutionResult(info)
        r.error_in_exec = exc
        return r
    except Exception:
        return None


def _patch_ipython_shell():
    """Make IPython's own module-level API talk to THIS kernel.

    `from IPython.display import display` (the most common line in any
    notebook) bound IPython's display(), which without an InteractiveShell
    just PRINTS "<IPython.core.display.HTML object>". Same for clear_output,
    update_display, publish_display_data — and get_ipython(), which returns
    None without a shell: handcalcs then failed at import with
    ``'NoneType' object has no attribute 'register_magic_function'``.

    Runs on every IPython import (idempotent), because IPython.display and
    friends load lazily and `from X import name` binds the value, not the
    module. Reads from sys.modules; never imports IPython."""
    if sys.modules.get("IPython") is None:
        return
    repl = {"get_ipython": _pyx_get_ipython, "display": _display,
            "clear_output": _clear_output, "update_display": _update_display,
            "publish_display_data": _publish_display_data}
    for name, mod in list(sys.modules.items()):
        if mod is None or not (name == "IPython" or name.startswith("IPython.")):
            continue
        d = getattr(mod, "__dict__", None)
        if not isinstance(d, dict):
            continue
        for attr, fn in repl.items():
            cur = d.get(attr)
            if cur is not None and cur is not fn:
                try:
                    setattr(mod, attr, fn)
                except Exception:
                    pass


def _install_kernel_builtins():
    """What the KERNEL provides, as opposed to what a LIBRARY provides:
    `display()` and `get_ipython()`. They live in builtins, so a namespace reset
    does not have to put them back and `dir()` in a cell lists only the
    document's own names. Re-asserted before every cell: a library that
    instantiated IPython's shell rebinds builtins.display."""
    import builtins
    if builtins.__dict__.get("display") is not _display:
        builtins.display = _display
    if builtins.__dict__.get("get_ipython") is not _pyx_get_ipython:
        builtins.get_ipython = _pyx_get_ipython
    if "pyx" not in sys.modules:
        sys.modules["pyx"] = _build_pyx_module()


# ---------------------------------------------------------------------------
# handcalcs cell magics (%%render / %%tex)
# ---------------------------------------------------------------------------
def _parse_line_args(line):
    """Validate the arguments on a %%render / %%tex magic line.

    handcalcs' own parser is used whenever the library is loaded — and it
    always is by the time a magic runs, since `import handcalcs.render` is what
    registers the magic. That way a handcalcs release that adds or changes an
    argument is honoured as Jupyter would honour it, instead of meeting a copy
    of the parser frozen at the version this kernel was written against. The
    copy below is only the fallback."""
    real = getattr(sys.modules.get("handcalcs.render"), "parse_line_args", None)
    if callable(real):
        try:
            return real(line or "")
        except Exception:
            pass
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


# A whole word, as IPython requires: %%renderx / %%texture are not it.
_MAGIC_LINE = re.compile(r"%%(render|tex)(?:[ \t]+(.*))?$")
# Could this cell contain IPython-only syntax? (%magic, !cmd, x = !cmd, obj?)
_IPY_SYNTAX = re.compile(r"(?m)^\s*(%|!)|=\s*!|\?\s*$")


def _plain_prefix(lines):
    """True when the lines before a magic line are code on their own — so the
    magic is not, say, the inside of a triple-quoted string."""
    src = "\n".join(lines)
    try:
        compile(src, "<magic-check>", "exec", ast.PyCF_ONLY_AST | _FLAGS)
        return True
    except SyntaxError:
        # IPython lines before the magic (`%matplotlib inline`) are not a string
        return bool(_IPY_SYNTAX.search(src)) and src.count('"""') % 2 == 0 \
            and src.count("'''") % 2 == 0
    except Exception:
        return False


def _detect_magic(code):
    """If the cell uses a handcalcs cell magic, split it into the parts we need.

    Returns ``{"setup", "calc", "args", "kind", "magic_idx", "full"}`` or
    ``None``. ``setup`` is everything before the magic line (imports,
    assignments) — run but not rendered; ``calc`` is everything after — run
    and rendered by handcalcs."""
    lines = code.split("\n")
    for i, ln in enumerate(lines):
        m = _MAGIC_LINE.match(ln.strip())
        if not m:
            continue
        if i and not _plain_prefix(lines[:i]):
            continue
        return {
            "setup": "\n".join(lines[:i]),
            "calc": "\n".join(lines[i + 1:]),
            "args": (m.group(2) or "").strip(),
            "kind": m.group(1),
            "magic_idx": i,  # 0-based line of the magic within the cell
            "full": code,    # the whole cell, for traceback line mapping
        }
    return None


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
        tree = compile(setup, filename, "exec", ast.PyCF_ONLY_AST | _FLAGS)
        _scan_for_patches(tree)
        _exec_code(compile(tree, filename, "exec", _FLAGS))

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
    # IPython removes a uniform leading indent before running the body.
    calc = textwrap.dedent(magic["calc"])
    if args.get("sympy"):
        # As in Jupyter: a line handcalcs cannot convert is an error, not a
        # silent fall-back to the unconverted cell.
        from handcalcs import sympy_kit as _skit
        calc = _skit.convert_sympy_cell_to_py_cell(calc, NS)

    if calc.strip():
        # Pad so exec line numbers equal FULL-cell line numbers (magic line is
        # cell line magic_idx+1, 1-based; calc starts at magic_idx+2).
        pad = "\n" * (magic.get("magic_idx", 0) + 1)
        tree = compile(pad + calc, filename, "exec", ast.PyCF_ONLY_AST | _FLAGS)
        _scan_for_patches(tree)
        _exec_code(compile(tree, filename, "exec", _FLAGS))

    # Render source: drop import lines (handcalcs renders assignments/comments).
    # NOT stripped: handcalcs reads the cell type (# Parameters / # long /
    # # short / # symbolic) from the FIRST line, and in Jupyter a blank first
    # line means "no cell type".
    render_src = "\n".join(
        ln for ln in calc.split("\n")
        if not ln.strip().startswith(("import ", "from "))
    )
    if not render_src.strip():
        return None
    try:
        return _hand.LatexRenderer(render_src, NS, args).render()
    except Exception as exc:
        # The code ran; handcalcs could not TYPESET it. Point at the first
        # line it cannot typeset on its own, so the error is clickable.
        first = magic.get("magic_idx", 0) + 2
        for i, ln in enumerate(calc.split("\n")):
            s = ln.strip()
            if not s or s.startswith(("#", "import ", "from ")):
                continue
            try:
                _hand.LatexRenderer(ln, NS, args).render()
            except Exception:
                exc._pyx_line = first + i
                break
        raise


def _run_magic_cell(kind, line, cell):
    """get_ipython().run_cell_magic('render', '', '...') — what `jupyter
    nbconvert --to script` writes for every %%render cell: run it for real."""
    global _last_cell_file
    if not _magic_registered(kind):
        raise MagicNotRegistered(
            "la magia %%" + kind + " no esta registrada en esta sesion: anade "
            "`import handcalcs.render` antes de usarla.")
    outer = _last_cell_file  # keep the calling cell's error mapping
    try:
        latex = _render_handcalcs({"setup": "", "calc": cell, "args": line or "",
                                   "kind": kind, "magic_idx": -1, "full": cell})
    finally:
        _last_cell_file = outer
    if latex:
        DISPLAYS.append(_latex_display(latex))
        if kind == "tex":
            print(latex)
    return None


def _latex_display(latex):
    """A handcalcs result, as a display entry the app renders itself (the app
    bundles KaTeX; see js/editor/math-render.js)."""
    return {"kind": "latex", "data": latex}


def _capture_images():
    """Open matplotlib figures not shown yet in this cell, as PNGs; then
    close them all (matplotlib-inline's flush_figures). A figure already
    shown as the cell's result, by display() or by plt.show() is skipped: it
    is the SAME figure, and emitting it here too printed the plot twice."""
    images = []
    if sys.modules.get("matplotlib") is None:
        return images
    try:
        import matplotlib.pyplot as plt
        for num in plt.get_fignums():
            fig = plt.figure(num)
            if fig in _EMITTED_FIGS:
                continue
            images.append(_fig_png(fig))
        plt.close("all")
    except Exception:
        pass
    return images


# ---------------------------------------------------------------------------
# cell sources and tracebacks
# ---------------------------------------------------------------------------
_cell_seq = 0
_last_cell_file = ""  # filename of the cell being executed (for error mapping)
_registered = []      # cell filenames currently held in linecache
_REGISTERED_MAX = 200


def _register_cell_source(filename, code):
    """Publish a cell's source to `linecache` so `inspect.getsource` works for
    functions defined in it (handcalcs needs this) and tracebacks can show the
    offending line.

    Bounded — but never by evicting a cell that still owns live code: the
    handcalcs decorator calls inspect.getsource every time its function runs,
    and after ~200 cell runs a function defined early in the session stopped
    working with "could not get source code"."""
    linecache.cache[filename] = (
        len(code), None, [ln + "\n" for ln in code.split("\n")], filename,
    )
    _registered.append(filename)
    if len(_registered) > _REGISTERED_MAX:
        live = _live_cell_files()
        excess = len(_registered) - _REGISTERED_MAX
        dead = [f for f in _registered if f not in live and f != filename][:excess]
        for f in dead:
            linecache.cache.pop(f, None)
        gone = set(dead)
        _registered[:] = [f for f in _registered if f not in gone]


def _live_cell_files():
    """Cell filenames referenced by functions/classes still in the namespace
    (unwrapping decorators: functools.wraps sets __wrapped__)."""
    live = set()
    for v in list(NS.values()):
        try:
            objs = [v, getattr(v, "__wrapped__", None), getattr(v, "__func__", None)]
            if isinstance(v, type):
                objs += [getattr(m, "__func__", m) for m in list(vars(v).values())]
            for o in objs:
                c = getattr(o, "__code__", None)
                if c is not None:
                    live.add(c.co_filename)
        except Exception:
            continue
    return live


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
    if line is None:
        line = getattr(exc, "_pyx_line", None)  # handcalcs typesetting error

    # A RecursionError is ~1000 identical frames: keep three, then say so.
    groups = []
    for f in stack:
        if groups and (groups[-1][0].filename, groups[-1][0].lineno, groups[-1][0].name) \
                == (f.filename, f.lineno, f.name):
            groups[-1][1] += 1
        else:
            groups.append([f, 1])

    parts = []
    frames = []
    if stack:
        parts.append("Traceback (most recent call last):\n")
    for f, n in groups:
        name = None if f.name in ("<module>", "", None) else f.name
        where = "" if name is None else ", en %s()" % name
        for _ in range(min(n, 3)):
            parts.append("  Línea %d%s\n" % (f.lineno, where))
            if f.line:
                parts.append("    %s\n" % f.line.strip())
            frames.append({"line": f.lineno, "name": name,
                           "code": (f.line or "").strip(),
                           "cur": f.filename == _last_cell_file})
        if n > 3:
            note = "[la línea anterior se repite %d veces más]" % (n - 3)
            parts.append("  %s\n" % note)
            frames.append({"line": f.lineno, "name": name, "code": note,
                           "cur": f.filename == _last_cell_file})
    try:
        parts.extend(tbe.format_exception_only())
    except Exception:
        parts.append("%s: %s\n" % (type(exc).__name__, _safe_str(exc)))
    # Any remaining internal filenames read as plain line references.
    text = re.sub(r'File "<calc-cell-\d+>", line (\d+)', r"Línea \1", "".join(parts))
    msg = re.sub(r"\s*\(<calc-cell-\d+>, line \d+\)$", "", _safe_str(exc))
    # A name this kernel used to define implicitly: say where it went instead of
    # leaving a bare "name 'figure' is not defined".
    if isinstance(exc, NameError):
        missing = getattr(exc, "name", None)
        if missing is None:
            m = re.search(r"name '([^']+)' is not defined", _safe_str(exc))
            missing = m.group(1) if m else None
        hint = _name_hint(missing) if missing else None
        if hint:
            msg = "%s — %s" % (msg, hint)
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


# ---------------------------------------------------------------------------
# running a cell
# ---------------------------------------------------------------------------
_ASYNC_LOOP = None
_EXEC_COUNT = 0
_UNDERS = ["", "", ""]  # what the kernel last put in _, __, ___
_OUT_KEEP = 50          # results kept in Out / _N (they hold references)


def _exec_code(co):
    """eval() a code object; a cell with top-level await is a coroutine and
    is run to completion on the session's event loop."""
    r = eval(co, NS, NS)
    if co.co_flags & 0x0080:  # inspect.CO_COROUTINE
        r = _event_loop().run_until_complete(r)
    return r


def _event_loop():
    """One event loop per session, also installed as the worker thread's
    current loop so `asyncio.get_event_loop()` works in a cell as it does in
    Jupyter (it raised "There is no current event loop in thread
    'Thread-1 (_worker)'")."""
    global _ASYNC_LOOP
    import asyncio
    if _ASYNC_LOOP is None or _ASYNC_LOOP.is_closed():
        _ASYNC_LOOP = asyncio.new_event_loop()
    asyncio.set_event_loop(_ASYNC_LOOP)
    return _ASYNC_LOOP


def _quiet(code):
    """IPython's semicolon rule: `x;` shows nothing."""
    try:
        toks = [t for t in tokenize.generate_tokens(io.StringIO(code).readline)
                if t.type not in (tokenize.NL, tokenize.NEWLINE, tokenize.COMMENT,
                                  tokenize.ENDMARKER, tokenize.INDENT, tokenize.DEDENT)]
    except Exception:
        return False
    return bool(toks) and toks[-1].type == tokenize.OP and toks[-1].string == ";"


def _clip_text(s, cap=200_000):
    if isinstance(s, str) and len(s) > cap:
        return s[:cap] + "\n… [salida truncada: %d caracteres en total]" % len(s)
    return s


def _clip_stream(s, cap=_STREAM_CAP):
    """Head and tail of a huge stdout/stderr, as Jupyter's rate limit would
    leave it: a 20 MB print loop must not become one 20 MB frame."""
    if len(s) <= cap:
        return s
    half = cap // 2
    return "%s\n… [%d caracteres omitidos] …\n%s" % (s[:half], len(s) - 2 * half, s[-half:])


def _record_input(raw):
    """In / _i / _ii / _iii / _iN, like IPython."""
    global _EXEC_COUNT
    if not raw.strip():
        return  # IPython does not count blank cells (the reset request)
    _EXEC_COUNT += 1
    n = _EXEC_COUNT
    In = NS.get("In")
    if not isinstance(In, list):
        In = NS["In"] = [""]
    while len(In) < n:
        In.append("")
    In.append(raw)
    NS["_iii"], NS["_ii"], NS["_i"] = NS.get("_ii", ""), NS.get("_i", ""), raw
    NS["_i%d" % n] = raw
    if n > _OUT_KEEP:
        NS.pop("_i%d" % (n - _OUT_KEEP), None)
    if _REAL is not None:
        try:
            _REAL.execution_count = n
        except Exception:
            pass


def _record_output(value):
    """Out / _ / __ / ___ / _N, like IPython's DisplayHook — which leaves
    `_` and friends alone once the user has bound one of them."""
    n = _EXEC_COUNT
    Out = NS.get("Out")
    if not isinstance(Out, dict):
        Out = NS["Out"] = {}
    Out[n] = value
    NS["_%d" % n] = value
    for k in [k for k in Out if k <= n - _OUT_KEEP]:
        Out.pop(k, None)
        NS.pop("_%d" % k, None)
    update = True
    for i, u in enumerate(("_", "__", "___")):
        if u in NS and NS[u] is not _UNDERS[i]:
            update = False
    _UNDERS[:] = [value, _UNDERS[0], _UNDERS[1]]
    if update:
        NS["_"], NS["__"], NS["___"] = _UNDERS


def _run(code):
    """Exec a block, echoing the last bare expression like a notebook cell.

    The cell's source is registered in ``linecache`` under a unique filename so
    ``inspect.getsource`` works for functions defined here (handcalcs etc.)."""
    global _cell_seq, _last_cell_file
    _cell_seq += 1
    filename = "<calc-cell-%d>" % _cell_seq
    _last_cell_file = filename
    _register_cell_source(filename, code)

    # Re-apply the adaptations in case a library slipped in unpatched.
    _patch_mpl_show()
    _patch_plotly_show()
    _patch_mp_pickler()

    raw = code
    try:
        parsed = compile(code, filename, "exec", ast.PyCF_ONLY_AST | _FLAGS)
    except SyntaxError:
        # IPython syntax (%magic, %%magic, !cmd, x = !cmd, obj?) is only
        # looked at when the cell is not valid Python — plain cells never pay
        # for importing IPython. IPython's transform keeps line numbers.
        sh = _real_shell() if _IPY_SYNTAX.search(code) else None
        if sh is None:
            raise
        code = sh.transform_cell(code)
        parsed = compile(code, filename, "exec", ast.PyCF_ONLY_AST | _FLAGS)
    _record_input(raw)
    quiet = _quiet(code)
    _scan_for_patches(parsed)
    body = parsed.body
    result = None
    if body and isinstance(body[-1], ast.Expr):
        last = ast.Expression(body.pop().value)
        if body:
            _exec_code(compile(ast.Module(body, []), filename, "exec", _FLAGS))
        value = _exec_code(compile(last, filename, "eval", _FLAGS))
        if value is not None and not quiet:
            _record_output(value)
            # Route the bare last expression like Jupyter: richest MIME wins,
            # plain text only when nothing rich is available.
            r = _mime_route(value)
            if r is None:
                result = _clip_text(_text_of(value))
            elif r is not _HANDLED:
                DISPLAYS.append(_mark(r))
    else:
        _exec_code(compile(parsed, filename, "exec", _FLAGS))
    return {"result": result}


# ---------------------------------------------------------------------------
# library state the document changed that no reset can undo
# ---------------------------------------------------------------------------
# A reset puts back what the kernel knows how to put back (options, filters,
# rcParams, locale, seeds…). It cannot undo a MONKEYPATCH: `scipy.constants.g
# = 10`, `math.pi = 3.14`, `Fraction.__str__ = f` live in the library for the
# rest of the process. Delete that line, compile again, and the result still
# depended on it. For a calculation that is unacceptable, so the kernel
# notices such statements, and the next reset asks the app for a brand-new
# Python process — the only reset that is certainly complete.
_IMPORTED_NAMES = set()   # names bound by import statements since the reset
_TAINT = []               # what the document changed in a library

# What a reset DOES restore: assigning to these is not a monkeypatch.
_RESTORED_ATTRS = frozenset({"rcParams", "rc", "options", "environ"})
_RESTORED_ROOTS = {"sys": {"path", "modules", "stdout", "stderr"},
                   "warnings": {"filters", "showwarning", "formatwarning"},
                   "mpmath": {"dps", "prec", "pretty"}}


def _library_module(modname):
    """True for a module of the Python installation (or a built-in one) —
    never the document's own code, which a reset forgets anyway."""
    if not modname or modname == "__main__":
        return False
    mod = sys.modules.get(modname)
    if mod is None:
        return False
    f = getattr(mod, "__file__", None)
    if not f:
        return True  # built-in (math, sys…)
    try:
        nf = os.path.normcase(os.path.abspath(f))
    except Exception:
        return False
    return any(nf.startswith(r + os.sep) for r in _installed_roots())


def _owner_module(obj):
    if isinstance(obj, types.ModuleType):
        return obj.__name__
    if isinstance(obj, (type, types.FunctionType, types.BuiltinFunctionType)):
        return getattr(obj, "__module__", None)
    return getattr(type(obj), "__module__", None)


def _note_imports(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                _IMPORTED_NAMES.add(a.asname or a.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and not node.level:
            for a in node.names:
                if a.name != "*":
                    _IMPORTED_NAMES.add(a.asname or a.name)


def _check_patch_target(t):
    chain = []
    while isinstance(t, (ast.Attribute, ast.Subscript)):
        if isinstance(t, ast.Attribute):
            chain.append(t.attr)
        t = t.value
    if not isinstance(t, ast.Name) or not chain or t.id not in _IMPORTED_NAMES:
        return
    chain.reverse()
    if _RESTORED_ATTRS.intersection(chain):
        return
    obj = NS.get(t.id)
    if obj is None:
        return
    owner = _owner_module(obj)
    top = (owner or "").split(".")[0]
    if top in _RESTORED_ROOTS and (chain[0] in _RESTORED_ROOTS[top]
                                   or chain[-1] in _RESTORED_ROOTS[top]):
        return  # sys.path = …, mpmath.mp.dps = … : put back by the reset
    if _library_module(owner):
        what = "%s.%s" % (t.id, ".".join(chain))
        if what not in _TAINT:
            _TAINT.append(what)


def _scan_for_patches(tree):
    """Record the cell's imports, and any assignment into a library object.
    Called BEFORE the code runs (a cell that fails half-way may already have
    patched) and resolved against the namespace as it is then — so the
    import in the same cell is looked up again after it ran."""
    try:
        _note_imports(tree)
        _PENDING_SCANS.append(tree)
    except Exception:
        pass


_PENDING_SCANS = []


def _resolve_patch_scans():
    """After a cell ran: check its assignments against what the names now
    are (an `import scipy.constants` in the same cell is bound by now)."""
    trees = _PENDING_SCANS[:]
    del _PENDING_SCANS[:]
    for tree in trees:
        try:
            for node in ast.walk(tree):
                targets = ()
                if isinstance(node, ast.Assign):
                    targets = node.targets
                elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
                    targets = (node.target,)
                elif isinstance(node, ast.Delete):
                    targets = node.targets
                elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                      and node.func.id in ("setattr", "delattr") and node.args):
                    targets = (ast.Attribute(value=node.args[0], attr="?", ctx=ast.Store()),)
                for t in targets:
                    for tt in (t.elts if isinstance(t, (ast.Tuple, ast.List)) else (t,)):
                        _check_patch_target(tt)
        except Exception:
            pass



# ---------------------------------------------------------------------------
# \py{...} values
# ---------------------------------------------------------------------------
def _texesc_text(s):
    rep = {"\\": r"\textbackslash{}", "&": r"\&", "%": r"\%", "$": r"\$",
           "#": r"\#", "_": r"\_", "{": r"\{", "}": r"\}",
           "~": r"\textasciitilde{}", "^": r"\textasciicircum{}"}
    return "".join(rep.get(c, c) for c in s)


def _fmt(value):
    """Format an evaluated \\py{} value for SAFE insertion into LaTeX.

    Engineering documents carry legal weight, so this is deliberately strict:
      * int / numpy int  -> exact digits, never ".0"
      * float / float64  -> FIXED-POINT, never scientific (``1.5e+05`` would be
                            wrong in the typeset document); 12 significant
                            figures so binary-float noise (0.1+0.2) disappears
                            — but never fake zeros in a big integer part;
                            trailing zeros trimmed. NaN / Inf RAISE so a non-
                            finite result can never reach the PDF.
      * float32/float16  -> their own shortest repr ("0.1", not 0.10000000149)
      * numpy array      -> RAISE (point the user to ``\\py{tex(arr)}``)
      * pint / sympy     -> typeset (``\\ensuremath{...}``)
      * str              -> the user's own LaTeX, as is — except a lone ``%``
      * anything else    -> its text, LaTeX-escaped
    A raised error is turned by the caller into a visible "[\\py{...}]" problem
    and substitutes "??", so a bad value never compiles silently.
    """
    import math
    # Read from sys.modules: a value can only BE a numpy type if the document
    # already imported numpy, so importing it here would only slow down every
    # \py{} in a session that never uses it.
    _np = sys.modules.get("numpy")
    if _np is not None:
        if isinstance(value, _np.ndarray) and value.ndim == 0:
            value = value[()]  # a 0-d array IS a scalar
        if isinstance(value, _np.ndarray):
            raise TypeError(
                "es un array NumPy de forma %s; usa \\py{tex(...)} para una "
                "matriz LaTeX (from pyx import tex)"
                % (getattr(value, "shape", "?"),)
            )
        if isinstance(value, _np.floating) and value.dtype.itemsize < 8:
            value = float(_np.format_float_positional(value, unique=True))
        elif isinstance(value, _np.generic):
            value = value.item()

    # pint Quantity: the magnitude under the same strict rules, plus units.
    _pint = sys.modules.get("pint")
    if _pint is not None:
        try:
            is_q = isinstance(value, _pint.Quantity)
        except Exception:
            is_q = False
        if is_q:
            m = value.magnitude
            if _np is not None and isinstance(m, _np.ndarray) and m.ndim:
                raise TypeError("es un Quantity con un array; usa \\py{tex(...)}")
            units = format(value.units, "~L")
            num = _fmt(m)
            return "\\ensuremath{%s\\,%s}" % (num, units) if units else num

    if isinstance(value, int):  # bool is an int subclass → str gives True/False
        return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            raise ValueError("el resultado es NaN (no es un número)")
        if math.isinf(value):
            raise ValueError("el resultado es infinito (Inf)")
        from decimal import Decimal
        if value != 0 and (abs(value) < 1e-9 or abs(value) >= 1e21):
            # Fixed point stops being readable here (1e-300 was 300 digits
            # across the page): typeset powers of ten — never a bare "1e-300".
            m, e = ("%.12e" % value).split("e")
            if "." in m:
                m = m.rstrip("0").rstrip(".")
            return "\\ensuremath{%s\\times10^{%d}}" % (m, int(e))
        if abs(value) >= 1e12:
            # 12 significant digits would pad the integer part with FAKE
            # zeros (12345678901234.5 -> "12345678901200"): use the shortest
            # round-trip repr instead, which is exact.
            s = format(Decimal(repr(value)), "f")
        else:
            s = "%.12g" % value
            if "e" in s or "E" in s:  # expand scientific notation to plain digits
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
    # sympy numbers follow the numeric rules (sp.Float(0.1) printed
    # "0.100000000000000"); other sympy objects are typeset, not str()'d
    # ("x**2 + 1", "sqrt(2)", "Matrix([[1, 2]])" are Python, not LaTeX).
    _sp = sys.modules.get("sympy")
    if _sp is not None:
        try:
            if isinstance(value, _sp.Basic):
                if value.is_Integer:
                    return str(int(value))
                if value.is_Float:
                    return _fmt(float(value))
                return "\\ensuremath{%s}" % _sp.latex(value)
            if isinstance(value, _sp.matrices.MatrixBase):
                return "\\ensuremath{%s}" % _sp.latex(value)
        except Exception:
            pass
    if isinstance(value, str):
        # A str is the user's own LaTeX and goes in as is — except an
        # unescaped `%` on a one-line value: TeX would take it for a comment
        # and silently drop the rest of the SOURCE line that holds the \py{}.
        # f"{r:.1%}" is the everyday way to format a percentage.
        if "\n" not in value:
            value = re.sub(r"(?<!\\)%", r"\\%", value)
        return value
    # An object that knows its own LaTeX (forallpeople, astropy, IPython's
    # Math/Latex…): math is wrapped so it works inside a sentence.
    rl = _safe_attr(value, "_repr_latex_")
    if rl is not None:
        try:
            s = rl()
            if isinstance(s, tuple):
                s = s[0]
            if isinstance(s, str) and s.strip():
                s = s.strip()
                if s.startswith(("$", "\\[", "\\(")):
                    return "\\ensuremath{%s}" % _strip_math(s)
                return s
        except Exception:
            pass
    # Anything else is str() of an arbitrary object: text, not LaTeX
    # ({'a': 1} lost its braces, Path('a_b.csv') broke the compile).
    return _texesc_text(_safe_str(value))


# The editor's live preview evaluates \py{} expressions every half second,
# between compiles. An expression with a side effect — \py{lst.pop()},
# \py{next(it)}, \py{rng.random()} — would then change the namespace the NEXT
# compile builds on, and the values drift from compile to compile. The preview
# leaves those to the compile.
_PREVIEW_UNSAFE = frozenset({
    "pop", "popitem", "popleft", "append", "appendleft", "extend", "insert",
    "remove", "clear", "update", "setdefault", "add", "discard", "send",
    "throw", "close", "write", "writelines", "seed", "shuffle", "permutation",
    "random", "randint", "rand", "randn", "randrange", "choice", "choices",
    "sample", "uniform", "normal", "integers", "rvs", "next", "exec", "eval",
    "compile", "open", "input", "print", "__import__", "setattr", "delattr",
    "exit", "quit", "sort", "reverse", "fill", "resize", "put", "itemset",
    "to_csv", "to_excel", "to_pickle", "savefig", "set_option", "sleep",
    "system", "unlink", "rmdir", "mkdir", "makedirs", "rename", "replace_inplace",
    "run", "call", "Popen", "iloc_set", "__setitem__", "__delitem__",
})


def _preview_safe(expr):
    try:
        tree = ast.parse(expr.strip(), mode="eval")
    except SyntaxError:
        return True  # eval reports it
    for node in ast.walk(tree):
        if isinstance(node, (ast.NamedExpr, ast.Await, ast.Yield, ast.YieldFrom)):
            return False
        if isinstance(node, ast.Call):
            f = node.func
            chain = []
            while isinstance(f, ast.Attribute):
                chain.append(f.attr)
                f = f.value
            if isinstance(f, ast.Name):
                chain.append(f.id)
            elif not chain:
                return False  # (lambda: ...)(), f()() — cannot tell
            if chain[0] in _PREVIEW_UNSAFE or any(
                    p in ("random", "rng") for p in chain):
                return False
    return True


# ---------------------------------------------------------------------------
# a reset is a fresh session: library settings and process state
# ---------------------------------------------------------------------------
def _reset_library_state():
    """Put the configuration that libraries keep INSIDE their modules back to
    what a freshly started interpreter would have.

    Emptying NS is not a fresh session on its own. A library imported once
    stays in sys.modules for the life of the kernel, and so does any setting
    stored in the module itself. handcalcs keeps every `handcalcs.set_option`
    in a module-level dict, so one `set_option("math_environment_start",
    "gathered")` — in a test line deleted since, or in ANOTHER open document,
    since all documents share this kernel — kept typesetting every later
    %%render cell with `gathered`. That environment has a single centred
    column, TeX turns each `&` into a new row, and `a = 2` came out as `a` on
    one line and `= 2` on the next, with nothing in the document to explain it.

    Each library is restored the way it initialises itself, so a default the
    user saved on purpose (`handcalcs.save_config()`, their matplotlibrc) is
    kept, and a library that was never imported is not imported here."""
    g = sys.modules.get("handcalcs.global_config")
    if g is not None:
        try:
            fresh = g._load_global_config(g._config_file)
            # In place: handcalcs' other modules hold this very dict object.
            g._config.clear()
            g._config.update(fresh)
        except Exception:
            pass
    h = sys.modules.get("handcalcs.handcalcs")
    if h is not None and "dec_sep" in vars(h.LatexRenderer):
        try:
            del h.LatexRenderer.dec_sep  # set only by the %decimal_separator magic
        except Exception:
            pass
    fap = sys.modules.get("forallpeople")
    if fap is not None:
        # forallpeople keeps the active environment (si.environment(...)) in a
        # module-level singleton and, with top_level=True, pushes every unit
        # into BUILTINS: both survived NS.clear(). Forget the module so the
        # document's next `import forallpeople` starts from the SI base (the
        # builtins it pushed are taken back by _restore_process_state).
        try:
            for n in [n for n in sys.modules
                      if n == "forallpeople" or n.startswith("forallpeople.")]:
                del sys.modules[n]
        except Exception:
            pass
    mpl = sys.modules.get("matplotlib")
    if mpl is not None:
        try:
            # rcParamsOrig is what matplotlib loaded at import (its defaults
            # plus the user's matplotlibrc). The backend stays as it is: the
            # kernel is headless and switching it mid-session is not a reset.
            skip = {"backend", "backend_fallback", "interactive"}
            orig = {k: v for k, v in mpl.rcParamsOrig.items() if k not in skip}
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                mpl.rcParams.update(orig)
        except Exception:
            pass
        plt_mod = sys.modules.get("matplotlib.pyplot")
        if plt_mod is not None:
            try:
                plt_mod.close("all")
            except Exception:
                pass
        # matplotlib.use("pdf") in a line since deleted: back to the headless
        # backend the kernel captures figures with. Read raw — asking
        # matplotlib for the backend may RESOLVE (import) one.
        try:
            raw = dict.__getitem__(mpl.rcParams, "backend")
            if isinstance(raw, str) and raw.lower() != "agg":
                if plt_mod is not None:
                    plt_mod.switch_backend("agg")
                else:
                    mpl.rcParams["backend"] = "agg"
        except Exception:
            pass


_PROC0 = None      # process state snapshot, taken in main() before any cell
_LIB_FILTERS = []  # warning filters installed by library imports
_LIB0 = {}         # per-library defaults, taken the first time each is imported


def _snapshot_process_state():
    import builtins
    import gc
    import locale
    global _PROC0
    _PROC0 = {
        "path": list(sys.path),
        "environ": dict(os.environ),
        "recursion": sys.getrecursionlimit(),
        "int_digits": getattr(sys, "get_int_max_str_digits", lambda: None)(),
        "switch": sys.getswitchinterval(),
        "warn_filters": list(warnings.filters),
        "showwarning": warnings.showwarning,
        "formatwarning": warnings.formatwarning,
        "builtins": dict(builtins.__dict__),
        "excepthook": sys.excepthook,
        "thread_excepthook": threading.excepthook,
        "gc": gc.isenabled(),
        "gc_threshold": gc.get_threshold(),
        "locale": {},
        "modules": set(sys.modules),
    }
    for c in ("LC_CTYPE", "LC_COLLATE", "LC_MONETARY", "LC_NUMERIC", "LC_TIME"):
        try:
            cat = getattr(locale, c)
            _PROC0["locale"][cat] = locale.setlocale(cat)
        except Exception:
            pass


def _import_state():
    import builtins
    return (list(warnings.filters), list(sys.path), dict(os.environ),
            dict(builtins.__dict__))


def _keep_library_changes(before):
    """What a LIBRARY sets up while it is being imported — a warning filter,
    a sys.path entry, an environment variable, a builtin — stays after a
    reset: the library stays loaded and relies on it. Only what the
    document's own code did is undone."""
    p = _PROC0
    if p is None:
        return
    import builtins
    f0, path0, env0, b0 = before
    for f in warnings.filters:
        if f not in f0 and f not in _LIB_FILTERS:
            _LIB_FILTERS.append(f)
    for e in sys.path:
        if e not in path0 and e not in p["path"]:
            p["path"].append(e)
    for k, v in os.environ.items():
        if env0.get(k) != v:
            p["environ"][k] = v
    for k, v in builtins.__dict__.items():
        if b0.get(k, _MISSING) is not v:
            p["builtins"][k] = v


def _snapshot_libraries():
    """Defaults of libraries whose options are module-level, recorded the
    first time the session imports them (so a library never imported is
    never touched) — right after the import statement, before the cell that
    imported it can change anything."""
    np = sys.modules.get("numpy")
    if np is not None and "numpy" not in _LIB0:
        try:
            _LIB0["numpy"] = (np.get_printoptions(), np.geterr())
        except Exception:
            pass
    # plotly.io loads these lazily, and loading _renderers imports IPython and
    # nbformat (~1 s): only read what the document itself already loaded.
    pio = sys.modules.get("plotly.io")
    if pio is not None:
        if "plotly_tpl" not in _LIB0 and "plotly.io._templates" in sys.modules:
            try:
                _LIB0["plotly_tpl"] = sys.modules["plotly.io._templates"].templates.default
            except Exception:
                pass
        if "plotly_rnd" not in _LIB0 and "plotly.io._renderers" in sys.modules:
            try:
                _LIB0["plotly_rnd"] = sys.modules["plotly.io._renderers"].renderers.default
            except Exception:
                pass
    pint = sys.modules.get("pint")
    if pint is not None and "pint" not in _LIB0:
        try:
            _LIB0["pint"] = pint.application_registry.get()
        except Exception:
            pass
    mpm = sys.modules.get("mpmath")
    if mpm is not None and "mpmath" not in _LIB0:
        try:
            _LIB0["mpmath"] = (mpm.mp.prec, mpm.mp.pretty)
        except Exception:
            pass
    lg = sys.modules.get("logging")
    if lg is not None and "logging" not in _LIB0:
        try:
            root = lg.getLogger()
            _LIB0["logging"] = (root.level, list(root.handlers), lg.root.manager.disable)
        except Exception:
            pass


def _restore_process_state():
    """Undo what the previous run did to the PROCESS, so a compile's output
    cannot depend on code that is no longer in the document:
    np.seterr(all='raise'), warnings.simplefilter('error'), a Spanish locale,
    logging handlers, pd.set_option, sympy's global evaluate=False,
    decimal precision, sys.setrecursionlimit, os.environ, builtins…"""
    import builtins
    import gc
    p = _PROC0
    if p is None:
        return
    sys.path[:] = p["path"]
    if os.environ != p["environ"]:
        for k in [k for k in os.environ if k not in p["environ"]]:
            try:
                del os.environ[k]
            except Exception:
                pass
        for k, v in p["environ"].items():
            if os.environ.get(k) != v:
                try:
                    os.environ[k] = v
                except Exception:
                    pass
    try:
        sys.setrecursionlimit(p["recursion"])
    except Exception:
        pass
    if p["int_digits"] is not None:
        try:
            sys.set_int_max_str_digits(p["int_digits"])
        except Exception:
            pass
    sys.setswitchinterval(p["switch"])
    keep = p["warn_filters"] + _LIB_FILTERS
    warnings.filters[:] = [f for f in warnings.filters if f in keep] + [
        f for f in p["warn_filters"] if f not in warnings.filters]
    try:
        warnings._filters_mutated()
    except Exception:
        pass
    warnings.showwarning = p["showwarning"]
    warnings.formatwarning = p["formatwarning"]
    b0 = p["builtins"]
    for k in list(builtins.__dict__):
        if k not in b0:
            del builtins.__dict__[k]
    for k, v in b0.items():
        if builtins.__dict__.get(k, _MISSING) is not v:
            builtins.__dict__[k] = v
    sys.excepthook = p["excepthook"]
    threading.excepthook = p["thread_excepthook"]
    (gc.enable if p["gc"] else gc.disable)()
    gc.set_threshold(*p["gc_threshold"])
    lg = sys.modules.get("logging")
    if lg is not None and "logging" in _LIB0:
        level, handlers, disable = _LIB0["logging"]
        root = lg.getLogger()
        for h in list(root.handlers):
            if h not in handlers:
                root.removeHandler(h)
                try:
                    h.close()
                except Exception:
                    pass
        root.setLevel(level)
        lg.disable(disable)
    if sys.modules.get("locale") is not None:
        import locale
        for c, v in p["locale"].items():
            try:
                if locale.setlocale(c) != v:
                    locale.setlocale(c, v)
            except Exception:
                pass
    dec = sys.modules.get("decimal")
    if dec is not None:
        dec.setcontext(dec.Context())  # a fresh thread's context
    sock = sys.modules.get("socket")
    if sock is not None:
        sock.setdefaulttimeout(None)
    rnd = sys.modules.get("random")
    if rnd is not None:
        rnd.seed()  # fresh-interpreter state: seeded from os.urandom
    # fake / non-module entries a cell pushed into sys.modules
    for name in list(sys.modules):
        if name not in p["modules"] and not isinstance(sys.modules.get(name), types.ModuleType):
            sys.modules.pop(name, None)
    np = sys.modules.get("numpy")
    if np is not None:
        if "numpy" in _LIB0:
            po, er = _LIB0["numpy"]
            try:
                np.set_printoptions(**po)
                np.seterr(**er)
                np.seterrcall(None)
            except Exception:
                pass
        try:
            np.random.seed()  # legacy global RandomState: fresh entropy
        except Exception:
            pass
    pd = sys.modules.get("pandas")
    if pd is not None:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                pd.reset_option("all")
        except Exception:
            pass
    sp = sys.modules.get("sympy")
    if sp is not None:
        try:
            from sympy.printing.printer import Printer
            Printer._global_settings.clear()
            from sympy.core.parameters import global_parameters as gp
            gp.evaluate = True
            gp.distribute = True
            gp.exp_is_pow = False
        except Exception:
            pass
    if "plotly_tpl" in _LIB0 and "plotly.io._templates" in sys.modules:
        try:
            sys.modules["plotly.io._templates"].templates.default = _LIB0["plotly_tpl"]
        except Exception:
            pass
    if "plotly_rnd" in _LIB0 and "plotly.io._renderers" in sys.modules:
        try:
            sys.modules["plotly.io._renderers"].renderers.default = _LIB0["plotly_rnd"]
        except Exception:
            pass
    if "pint" in _LIB0 and sys.modules.get("pint") is not None:
        try:
            sys.modules["pint"].application_registry.set(_LIB0["pint"])
        except Exception:
            pass
    if "mpmath" in _LIB0 and sys.modules.get("mpmath") is not None:
        try:
            mp = sys.modules["mpmath"].mp
            mp.prec, mp.pretty = _LIB0["mpmath"]  # mp.dps = 50 in a deleted line
        except Exception:
            pass


_ROOTS_CACHE = None


def _installed_roots():
    """Folders of the interpreter's own library and site-packages."""
    global _ROOTS_CACHE
    if _ROOTS_CACHE is not None:
        return _ROOTS_CACHE
    import site
    import sysconfig
    roots = set()
    for key in ("stdlib", "platstdlib", "purelib", "platlib"):
        p = sysconfig.get_paths().get(key)
        if p:
            roots.add(os.path.normcase(os.path.abspath(p)))
    try:
        roots.add(os.path.normcase(os.path.abspath(site.getusersitepackages())))
    except Exception:
        pass
    for p in getattr(site, "getsitepackages", lambda: [])():
        roots.add(os.path.normcase(os.path.abspath(p)))
    _ROOTS_CACHE = roots
    return roots


def _purge_user_modules(roots):
    """Forget modules loaded from the document's folder (helper.py next to
    the document, a src/ package) or from a folder the document added to
    sys.path. A fresh session imports them from disk again; keeping them
    meant a compile kept running the version of the helper that was on disk
    the first time — edit, compile, same old result.

    Never a module of the Python installation (a venv INSIDE the project
    folder included), and never a package with a compiled extension: its C
    part cannot be loaded twice in one process."""
    norm = []
    for r in roots:
        if not r:
            continue
        try:
            n = os.path.normcase(os.path.abspath(r))
        except Exception:
            continue
        if "site-packages" in n or "dist-packages" in n:
            continue
        norm.append(n.rstrip("\\/") + os.sep)
    if not norm:
        return
    installed = [r + os.sep for r in _installed_roots()]
    doomed = {}
    compiled = set()
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, "__file__", None)
        if not isinstance(f, str) or not f:
            continue
        nf = os.path.normcase(os.path.abspath(f))
        if any(nf.startswith(r) for r in installed):
            continue
        if not any(nf.startswith(r) for r in norm):
            continue
        top = name.split(".", 1)[0]
        if nf.endswith((".pyd", ".so", ".dll", ".dylib")):
            compiled.add(top)
            continue
        doomed[name] = top
    purged = [n for n, top in doomed.items() if top not in compiled]
    for name in purged:
        sys.modules.pop(name, None)
    if purged:
        # Only the project's own finders: a full invalidate_caches() would
        # make every later import re-list every site-packages folder.
        for r in norm:
            fnd = sys.path_importer_cache.get(r.rstrip("\\/"))
            if fnd is not None and hasattr(fnd, "invalidate_caches"):
                try:
                    fnd.invalidate_caches()
                except Exception:
                    pass


def _lint_compile(code):
    """compile() for the editor's squiggles, understanding what the kernel
    itself executes: the %%render/%%tex line is not Python, top-level await
    is allowed, and IPython lines (%magic, !cmd, x = !cmd, obj?) are blanked —
    line numbers preserved — so only REAL errors are reported, at their real
    line (a typo inside a %%render cell used to be reported on the magic
    line, line 1)."""
    # full compile (not ONLY_AST): 'return' outside function, nonlocal at
    # module level, misplaced __future__... are compiler-stage errors
    m = _detect_magic(code)
    if m is not None:
        lines = code.split("\n")
        lines[m["magic_idx"]] = ""
        code = "\n".join(lines)
    try:
        return compile(code, "<lint>", "exec", _FLAGS)
    except SyntaxError:
        if not _IPY_SYNTAX.search(code):
            raise
    lines = code.split("\n")
    first = next((ln.strip() for ln in lines if ln.strip()), "")
    if first.startswith("%%"):
        return None  # a cell magic's body need not be Python (%%bash, %%html)
    out = []
    for ln in lines:
        s = ln.lstrip()
        ind = ln[:len(ln) - len(s)]
        if s.startswith(("%", "!")) or (re.search(r"\?\??\s*$", s) and not s.startswith("#")):
            out.append(ind + "pass")
        elif re.search(r"=\s*!", ln):
            out.append(re.sub(r"=\s*!.*$", "= None", ln))
        else:
            out.append(ln)
    return compile("\n".join(out), "<lint>", "exec", _FLAGS)


_DOC_DIR = None      # the project folder, on sys.path[0] like Jupyter's ''
_USER_CWD = None     # where the last cell's os.chdir() left the session
_FRESH_DETAILS = None


def _fresh_loader_details():
    """FileFinder loaders for the document's folder: extensions and bytecode
    as usual, but .py files always compiled from SOURCE."""
    global _FRESH_DETAILS
    if _FRESH_DETAILS is None:
        from importlib.machinery import (
            SourceFileLoader, ExtensionFileLoader, SourcelessFileLoader,
            EXTENSION_SUFFIXES, SOURCE_SUFFIXES, BYTECODE_SUFFIXES)

        class _FreshSourceLoader(SourceFileLoader):
            def get_code(self, fullname):
                path = self.get_filename(fullname)
                return self.source_to_code(self.get_data(path), path)

        _FRESH_DETAILS = [(ExtensionFileLoader, EXTENSION_SUFFIXES),
                          (_FreshSourceLoader, SOURCE_SUFFIXES),
                          (SourcelessFileLoader, BYTECODE_SUFFIXES)]
    return _FRESH_DETAILS


def _project_path_hook(path):
    """The document's own modules (helper.py, a src/ package) are imported
    from SOURCE, never from a cached .pyc. CPython trusts a .pyc when the
    source's mtime in WHOLE SECONDS and its size match, so a constant changed
    from 1.5 to 2.5 and compiled within the same second ran the old bytecode.
    It also leaves no __pycache__ litter in the user's folder. Libraries —
    a virtual environment inside the project included — keep their .pyc."""
    # Runs INSIDE the import machinery: it must import nothing itself (an
    # import here asks the path hooks again — endless recursion). The
    # installed roots and the loaders are prepared in main().
    roots = _ROOTS_CACHE
    if not _DOC_DIR or not isinstance(path, str) or roots is None or _FRESH_DETAILS is None:
        raise ImportError
    try:
        n = os.path.normcase(os.path.abspath(path or "."))
    except Exception:
        raise ImportError
    root = os.path.normcase(_DOC_DIR)
    if not (n == root or n.startswith(root.rstrip("\\/") + os.sep)):
        raise ImportError
    if "site-packages" in n or "dist-packages" in n or any(
            n == r or n.startswith(r + os.sep) for r in roots):
        raise ImportError
    return _FileFinder(path, *_FRESH_DETAILS)


def _forget_finders(root):
    """Drop cached finders at or below `root`, so the hook above builds them."""
    if not root:
        return
    r = os.path.normcase(os.path.abspath(root)).rstrip("\\/")
    for key in list(sys.path_importer_cache):
        try:
            k = os.path.normcase(os.path.abspath(key or "."))
        except Exception:
            continue
        if k == r or k.startswith(r + os.sep):
            sys.path_importer_cache.pop(key, None)


def _enter_cwd(cwd):
    """chdir into the project folder AND put it first on sys.path, so
    `import helper` finds helper.py next to the document (Jupyter: the
    notebook's folder is on sys.path). If the previous cell os.chdir()'d
    somewhere, and the project folder did not change, go back THERE: in
    Jupyter a chdir persists to the next cell."""
    global _DOC_DIR, _USER_CWD
    if cwd:
        cwd = os.path.abspath(cwd)
        if _DOC_DIR != cwd:
            if _DOC_DIR in sys.path:
                sys.path.remove(_DOC_DIR)
            _DOC_DIR = cwd
            _USER_CWD = None
            _forget_finders(cwd)
        if not sys.path or sys.path[0] != cwd:
            if cwd in sys.path:
                sys.path.remove(cwd)
            sys.path.insert(0, cwd)
    target = _USER_CWD or cwd
    if target:
        try:
            os.chdir(target)
        except Exception:
            if cwd:
                try:
                    os.chdir(cwd)
                except Exception:
                    pass


# ---------------------------------------------------------------------------
# warm-up
# ---------------------------------------------------------------------------
# Never imported ahead of time: importing them DOES something.
_PREWARM_NEVER = frozenset({"antigravity", "this", "__hello__", "__phello__",
                            "idlelib", "turtledemo"})


def _prewarm(names):
    """Import the libraries a document's cells use, ahead of its compile.

    A first compile after opening Pyx spent most of its time importing: 6 s of
    a 10 s compile on a typical report went to scipy, matplotlib, IPython,
    pint and handcalcs, before a single cell had done any work. The app sends
    the document's imports here when the document is opened, so the modules
    are already in sys.modules when the compile runs its cells.

    The namespace is not touched: the cells still run their own `import`
    lines, now instantly, which keeps the incremental-run ledger exact — and
    a magic a library registers while being warmed up is NOT active until the
    document's own import runs (a cell missing `import handcalcs.render` must
    fail as it would in Jupyter). Only modules that belong to the Python
    installation are imported — never a module that sits next to the
    document, whose top-level code is the user's and must run when the
    user's cell says so."""
    import importlib.util
    roots = None
    done = {}
    active = set(_MAGICS_ACTIVE)
    sink = _CellIO()
    _STDOUT.point_to(sink)
    _STDERR.point_to(sink)
    try:
        for mod in names:
            if not isinstance(mod, str) or not re.fullmatch(r"[A-Za-z_]\w*(\.[A-Za-z_]\w*)*", mod):
                continue
            if mod.split(".")[0] in _PREWARM_NEVER:
                continue
            if mod in sys.modules:
                done[mod] = True
                continue
            try:
                spec = importlib.util.find_spec(mod.split(".")[0])
                origin = getattr(spec, "origin", None) if spec else None
                if origin in (None, "built-in", "frozen"):
                    ok = spec is not None
                else:
                    if roots is None:
                        roots = _installed_roots()
                    o = os.path.normcase(os.path.abspath(origin))
                    ok = any(o.startswith(r + os.sep) for r in roots)
                if not ok:
                    done[mod] = "no instalado en Python"
                    continue
                # Through builtins.__import__, NOT importlib: the kernel's
                # import hook lives there, and it is what adapts IPython,
                # matplotlib and plotly the moment they load.
                with _USER_CODE:
                    __import__(mod)
                done[mod] = True
            except BaseException as ex:  # a failing import is the cell's to report
                if isinstance(ex, KeyboardInterrupt):
                    raise
                done[mod] = "%s: %s" % (type(ex).__name__, _safe_str(ex))
    finally:
        _sync_fd1()
        _STDOUT.point_to(_BG_OUT)
        _STDERR.point_to(_BG_ERR)
        _MAGICS_ACTIVE.clear()
        _MAGICS_ACTIVE.update(active)
    return done


# ---------------------------------------------------------------------------
# requests
# ---------------------------------------------------------------------------
def _reset_session(cwd):
    """A fresh session: namespace, process state, the project's own modules,
    library settings, the IPython shell's state. The kernel's own protocol
    (display, get_ipython, the `pyx` module) lives in builtins and
    sys.modules, so a cell after a reset starts exactly as empty as the first
    cell of a fresh Jupyter session."""
    global _EXEC_COUNT, _USER_CWD
    roots = [cwd, _DOC_DIR]
    if _PROC0 is not None:
        roots += [p for p in sys.path if isinstance(p, str) and p not in _PROC0["path"]]
    try:
        _purge_user_modules(roots)
    except Exception:
        pass
    try:
        _restore_process_state()
    except Exception:
        pass
    _EXEC_COUNT = 0
    _USER_CWD = None
    _IMPORTED_NAMES.clear()
    _UNDERS[:] = ["", "", ""]
    _MAGICS_ACTIVE.clear()
    _LAST_SHOWN[0] = None
    NS.clear()
    _init_user_ns()
    if _REAL is not None:
        try:
            _REAL.reset(new_session=True)
            _REAL.events.callbacks.clear()
            _REAL.events.callbacks.update(
                {k: list(v) for k, v in (_REAL_EVENTS0 or {}).items()})
            _REAL.extension_manager.loaded.clear()
        except Exception:
            pass
        _init_user_ns()
        _UNDERS[:] = [NS.get("_", ""), NS.get("__", ""), NS.get("___", "")]
    _reset_library_state()


def _evals(req):
    """\\py{...} values. One bad expression never costs the others — not even
    a SystemExit or an exception whose message cannot be printed."""
    results = {}
    pure = bool(req.get("pure"))
    interrupted = False
    sink = _CellIO()
    _STDOUT.point_to(sink)
    _STDERR.point_to(sink)
    try:
        for expr in req.get("evals") or []:
            if interrupted:
                results[expr] = {"ok": False, "value": "KeyboardInterrupt: interrumpido"}
                continue
            if pure and not _preview_safe(expr):
                results[expr] = {"ok": False, "skipped": True,
                                 "value": "se calcula al compilar (la expresión modifica datos)"}
                continue
            try:
                with _USER_CODE:
                    value = _fmt(eval(expr, NS, NS))
                results[expr] = {"ok": True, "value": value}
            except KeyboardInterrupt:
                interrupted = True
                results[expr] = {"ok": False, "value": "KeyboardInterrupt: interrumpido"}
            except BaseException as ex:
                results[expr] = {"ok": False, "value": "%s: %s" % (type(ex).__name__, _safe_str(ex))}
    finally:
        _STDOUT.point_to(_BG_OUT)
        _STDERR.point_to(_BG_ERR)
    return results


def _lint(cells):
    """Static syntax check (editor squiggles, VSCode-style): compile each
    cell's code WITHOUT running it and report every syntax error with
    line/column."""
    found = []
    for i, code in enumerate(cells or []):
        try:
            _lint_compile(code)
        except SyntaxError as e:
            found.append({
                "cell": i,
                "line": e.lineno or 1,
                "col": e.offset or 1,
                "msg": e.msg or "error de sintaxis",
            })
        except Exception:
            pass
    return found


def _run_request(req):
    """Execute one cell and collect everything it produced."""
    global _USER_CWD
    DISPLAYS.clear()
    _EMITTED_FIGS.clear()
    _LAST_SHOWN[0] = None
    _install_kernel_builtins()
    out, err = _CellIO(), _CellIO()
    _STDOUT.point_to(out)
    _STDERR.point_to(err)
    sys.stdout, sys.stderr = _STDOUT, _STDERR
    if _ASYNC_LOOP is not None:
        try:
            sys.modules["asyncio"].set_event_loop(_ASYNC_LOOP)
        except Exception:
            pass
    code = req.get("code", "")
    ok, result, render_latex, error = True, None, None, None
    info = _exec_info(code)
    exc_obj = None
    try:
        with _USER_CODE:
            _trigger("pre_execute")
            _trigger("pre_run_cell", info)
            magic = _detect_magic(code)
            if magic is not None:
                render_latex = _render_handcalcs(magic)
                # Show the calculation in the cell output too (KaTeX), so
                # handcalcs is usable without a LaTeX document; with one, it
                # ALSO compiles into the PDF.
                if render_latex:
                    DISPLAYS.append(_latex_display(render_latex))
                    # Jupyter parity: %%tex ALSO prints the raw LaTeX source
                    # so it can be copied straight into a document.
                    if magic.get("kind") == "tex":
                        print(render_latex)
            else:
                result = _run(code).get("result")
    except BaseException as exc:
        ok = False
        exc_obj = exc
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
        _resolve_patch_scans()
        try:
            _trigger("post_execute")
            _trigger("post_run_cell", _exec_result(info, exc_obj))
        except BaseException:
            pass
        _sync_fd1()  # fd-level output of this cell lands in THIS cell
        _STDOUT.point_to(_BG_OUT)
        _STDERR.point_to(_BG_ERR)
        sys.stdout, sys.stderr = _STDOUT, _STDERR
    # A chdir done by the cell (os.chdir, %cd) persists, as in Jupyter.
    try:
        here = os.getcwd()
        _USER_CWD = here if (_DOC_DIR and os.path.normcase(here)
                             != os.path.normcase(_DOC_DIR)) else None
    except Exception:
        pass

    # Surface anything background threads printed since the last cell (their
    # sys.stdout/sys.stderr idle on the absorbing buffers, never the pipe).
    bg_out = _drain(_BG_OUT)
    bg_err = _drain(_BG_ERR)
    if bg_out:
        for d in DISPLAYS:
            if isinstance(d.get("at"), int):
                d["at"] += len(bg_out)
    try:
        with _USER_CODE:  # saving a huge figure can take a while: stoppable
            images = _capture_images()
    except KeyboardInterrupt:
        images = []
    return {
        "id": req.get("id"),
        "ok": ok,
        "stdout": _clip_stream(bg_out + out.getvalue()),
        "stderr": _clip_stream(bg_err + err.getvalue()),
        "result": result,
        "error": error,  # {type, msg, line} — line is 1-based within the cell
        "displays": list(DISPLAYS),
        "render": render_latex,
        "images": images,
    }


def handle(req):
    restart = None
    if req.get("reset"):
        if _TAINT:
            # The document modified a library in this process: only a new
            # process is a clean slate. The app replaces this one.
            restart = list(_TAINT)
        _reset_session(req.get("cwd"))
    _enter_cwd(req.get("cwd"))
    if restart is not None:
        # Nothing runs in this process any more: the app replaces it and
        # sends the request again to the new one.
        return {"id": req.get("id"), "ok": True, "stdout": "", "stderr": "",
                "result": None, "error": None, "displays": [], "render": None,
                "images": [], "restart": restart}

    if "prewarm" in req:
        return {"id": req.get("id"), "ok": True, "prewarm": _prewarm(req.get("prewarm") or [])}
    if "evals" in req:
        return {"id": req.get("id"), "ok": True, "evals": _evals(req)}
    if "lint" in req:
        return {"id": req.get("id"), "ok": True, "lint": _lint(req.get("lint"))}
    return _run_request(req)


# ---------------------------------------------------------------------------
# interrupt support
# ---------------------------------------------------------------------------
# The executing thread's id, so an interrupt can be aimed at it. Set by the
# worker; read by the reader thread.
_exec_tid = None
_interrupt_pending = False   # an async KeyboardInterrupt is in flight
_interrupt_deferred = False  # Stop arrived during the kernel's own work
_exec_lock = threading.Lock()
_in_user_code = False        # the worker is running the document's code
_busy = False                # the worker is handling a request
# Where the kernel waits between requests: never a folder of the user's.
_IDLE_DIR = os.path.abspath(os.environ.get("TEMP") or os.environ.get("TMPDIR") or os.path.expanduser("~"))


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
    """Stop, as the app sends it.

    A KeyboardInterrupt is aimed at the worker ONLY while it runs the
    document's own code (a cell, a \\py{} expression, an import it asked
    for). Anywhere else it would land in the kernel's housekeeping — a reset
    half done, a response never written. So: during the kernel's own work of
    a request the Stop is DEFERRED to the moment that request's user code
    starts; between requests it is a no-op, as in Jupyter. (An interrupt that
    fired in `req_q.get()` used to kill the worker thread, and one that fired
    between taking a request and starting it lost the request: the app then
    waited forever.)"""
    global _interrupt_pending, _interrupt_deferred
    with _exec_lock:
        if _exec_tid is None:
            return
        if _in_user_code:
            _interrupt_pending = True
            _raise_in_thread(_exec_tid, KeyboardInterrupt)
        elif _busy:
            _interrupt_deferred = True


def _set_user_code(active):
    """Enter/leave the interruptible window. Leaving also cancels an interrupt
    still in flight, so it cannot fire in the kernel's own code."""
    global _in_user_code, _interrupt_pending
    with _exec_lock:
        _in_user_code = active
        if not active and _interrupt_pending:
            _raise_in_thread(_exec_tid, None)
            _interrupt_pending = False


def _set_busy(active):
    global _busy, _interrupt_deferred, _in_user_code, _interrupt_pending
    with _exec_lock:
        _busy = active
        _interrupt_deferred = False
        if not active:
            _in_user_code = False
            if _interrupt_pending:
                _raise_in_thread(_exec_tid, None)
                _interrupt_pending = False


class _UserCode:
    """`with _USER_CODE:` — the document's code runs here, and only here can
    a Stop reach it. A Stop that came while the kernel was preparing the run
    fires right at the start."""

    def __enter__(self):
        global _in_user_code, _interrupt_deferred
        with _exec_lock:
            fire = _interrupt_deferred
            _interrupt_deferred = False
            if not fire:
                _in_user_code = True
        if fire:
            raise KeyboardInterrupt
        return self

    def __exit__(self, *_exc):
        _set_user_code(False)
        return False


_USER_CODE = _UserCode()


_SURROGATE = re.compile("[\ud800-\udfff]")


def _frame_text(resp):
    """One protocol line. A lone surrogate (print('\\ud800'), bytes decoded
    with surrogateescape, odd file names) is legal in a Python str but not in
    JSON text: serde_json rejects the \\udXXX escape, the app dropped the
    frame and waited forever. Pair what pairs, replace the rest with U+FFFD.
    NaN/Infinity are not JSON either (serde_json rejects them too): refused
    here, so the caller sends an explicit error instead of a lost frame."""
    s = json.dumps(resp, ensure_ascii=False, default=_safe_str, allow_nan=False)
    if _SURROGATE.search(s):
        s = s.encode("utf-16", "surrogatepass").decode("utf-16", "replace")
    return s + "\n"


_INTERRUPTED_MSG = ("ejecución interrumpida. Las variables calculadas hasta "
                    "aquí siguen en memoria.")


def _failure(req, exc):
    """The response a request gets when it could not complete normally —
    never no response at all."""
    rid = req.get("id") if isinstance(req, dict) else None
    interrupted = exc is None or isinstance(exc, KeyboardInterrupt)
    if isinstance(req, dict) and "evals" in req:
        why = "KeyboardInterrupt: interrumpido" if interrupted else "%s: %s" % (
            type(exc).__name__, _safe_str(exc))
        return {"id": rid, "ok": True, "evals": {
            e: {"ok": False, "value": why} for e in (req.get("evals") or []) if isinstance(e, str)}}
    if isinstance(req, dict) and "lint" in req:
        return {"id": rid, "ok": True, "lint": []}
    if isinstance(req, dict) and "prewarm" in req:
        return {"id": rid, "ok": True, "prewarm": {}}
    if interrupted:
        return {"id": rid, "ok": False, "stdout": "", "stderr": "", "result": None,
                "error": {"type": "KeyboardInterrupt", "msg": _INTERRUPTED_MSG,
                          "line": None, "frames": [], "syntax": None},
                "displays": [], "render": None, "images": []}
    try:
        tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    except BaseException:
        tb = "%s: %s" % (type(exc).__name__, _safe_str(exc))
    return {"id": rid, "ok": False, "stdout": "", "stderr": tb, "result": None,
            "error": None, "displays": [], "render": None, "images": []}


def _respond(req):
    """handle() with a guarantee: a request that was taken ALWAYS gets a
    response. Whatever is cut short — by a Stop, by a bug — answers with an
    explicit failure instead of leaving the app waiting forever."""
    resp = _failure(req, None)  # the answer if everything below is cut short
    try:
        _set_busy(True)
        resp = handle(req)
    except BaseException as exc:
        try:
            resp = _failure(req, exc)
        except BaseException:
            pass
    while True:
        try:
            _set_busy(False)
            break
        except KeyboardInterrupt:
            continue
    return resp


def _write_frame(resp):
    """Write one response; False when the app has gone (closed pipe)."""
    rid = resp.get("id") if isinstance(resp, dict) else None
    text = None
    for _ in range(3):
        try:
            text = _frame_text(resp)
            break
        except KeyboardInterrupt:
            continue
        except Exception as e:
            resp = {"id": rid, "ok": False, "stdout": "", "result": None, "error": None,
                    "stderr": "Pyx: la respuesta no se pudo enviar (%s)" % _safe_str(e),
                    "displays": [], "render": None, "images": []}
    if text is None:
        try:
            rid_json = json.dumps(rid)
        except Exception:
            rid_json = "null"
        text = ('{"id": %s, "ok": false, "stdout": "", "stderr": "Pyx: respuesta '
                'no enviada", "result": null, "error": null, "displays": [], '
                '"render": null, "images": []}\n' % rid_json)
    while True:
        try:
            _REAL_STDOUT.write(text)
            _REAL_STDOUT.flush()
            return True
        except KeyboardInterrupt:
            continue
        except (OSError, ValueError):
            return False


def _worker(req_q):
    """Execute requests one at a time and write their responses."""
    global _exec_tid
    _exec_tid = threading.get_ident()
    while True:
        try:
            req = req_q.get()
        except KeyboardInterrupt:
            continue
        if req is None:
            return
        resp = _respond(req)
        try:
            _STDOUT.point_to(_BG_OUT)
            _STDERR.point_to(_BG_ERR)
            sys.stdout, sys.stderr = _STDOUT, _STDERR
            # Leave the project folder between requests. On Windows no folder
            # can be renamed, moved or deleted while it is some process's
            # current directory: with the kernel parked in it, the user could
            # not rename their own project folder until Pyx was closed. Every
            # request sets its cwd again before running anything.
            os.chdir(_IDLE_DIR)
        except BaseException:
            pass
        if not _write_frame(resp):
            return


def _request_lines(stream):
    """Yield protocol lines, never leaving a blocking read in flight.

    On Windows, a pending blocking read on the stdin pipe stops native
    extension modules from loading in EVERY other thread of the process: with
    the reader parked on the pipe, `import numpy` (or matplotlib, pandas…)
    inside a cell never returned. The cell hung, the compile hung behind it,
    and the interrupt could not even be read — because reading it was the very
    thing that was blocked. Reproduced down to twenty lines: main thread on a
    pipe read + `import numpy` in another thread = deadlock; the same import
    with the main thread asleep takes 0.2 s.

    So: ask the pipe what it already holds, read exactly that, and sleep. The
    sleep starts at 2 ms right after a message and grows to 20 ms while the
    app is quiet, so a compile's burst of requests is not paced at 20 ms per
    round trip. Elsewhere (Linux, macOS) the plain blocking iteration is kept.
    """
    if os.name != "nt":
        for line in stream:
            yield line
        return

    import msvcrt
    from ctypes import wintypes

    k32 = ctypes.windll.kernel32
    avail = wintypes.DWORD()
    try:
        fd = stream.fileno()
        handle = wintypes.HANDLE(msvcrt.get_osfhandle(fd))
        if not k32.PeekNamedPipe(handle, None, 0, None, ctypes.byref(avail), None):
            raise OSError("stdin is not a pipe")
    except Exception:
        for line in stream:  # a console or a file: nothing to poll
            yield line
        return

    buf = b""
    idle = 0.002
    while True:
        if not k32.PeekNamedPipe(handle, None, 0, None, ctypes.byref(avail), None):
            return  # the other end closed
        if not avail.value:
            time.sleep(idle)
            idle = min(idle * 2, 0.02)
            continue
        idle = 0.002
        chunk = os.read(fd, avail.value)
        if not chunk:
            return
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            yield line.decode("utf-8", "replace")


def main():
    global _REAL_STDOUT
    # Take exclusive ownership of the protocol pipes. From here on, user code
    # can never reach the real stdout/stdin — not from Python, not from C, not
    # from a child process — so the JSON framing is physically incorruptible.
    try:
        proto_in, proto_out = _isolate_protocol_fds()
        _REAL_STDOUT = io.TextIOWrapper(io.FileIO(proto_out, "w"), encoding="utf-8",
                                        errors="strict", newline="\n", write_through=True)
        real_stdin = io.TextIOWrapper(io.FileIO(proto_in, "r"), encoding="utf-8",
                                      errors="replace")
    except Exception:
        _REAL_STDOUT = sys.stdout
        real_stdin = sys.stdin
    sys.stdin = sys.__stdin__ = _StdinGuard()
    sys.stdout = sys.__stdout__ = _STDOUT
    sys.stderr = sys.__stderr__ = _STDERR

    # sys.path[0] is the folder of THIS script's temp copy (%TEMP%): any X.py
    # lying in %TEMP% would shadow library X. The project folder takes that
    # slot per request instead (_enter_cwd).
    here = os.path.dirname(os.path.abspath(__file__))
    if sys.path and os.path.normcase(os.path.abspath(sys.path[0] or ".")) == os.path.normcase(here):
        sys.path.pop(0)
    # The user namespace is sys.modules["__main__"] (the kernel stays reachable).
    sys.modules["_pyx_kernel"] = sys.modules.get("__main__")
    sys.modules["__main__"] = _USER_MAIN
    _init_user_ns()
    _patch_console_input()
    try:
        _installed_roots()
        _fresh_loader_details()
        sys.path_hooks.insert(0, _project_path_hook)
    except Exception:
        pass

    _install_import_hook()
    _install_kernel_builtins()
    _snapshot_process_state()  # what a reset restores

    req_q = queue.Queue()
    worker = threading.Thread(target=_worker, args=(req_q,), daemon=True)
    worker.start()

    _REAL_STDOUT.write(_frame_text({"type": "ready", "python": sys.version.split()[0]}))
    _REAL_STDOUT.flush()

    # READER loop. It must never execute anything itself: staying free is what
    # lets a control message be seen while a cell is still running.
    for line in _request_lines(real_stdin):
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        if not isinstance(req, dict):
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
    # Exit NOW. A normal interpreter exit waits for every non-daemon thread
    # a cell started (a `while True` worker, a server): the app's restart
    # then waited on this process forever.
    try:
        _REAL_STDOUT.flush()
    except Exception:
        pass
    os._exit(0)


if __name__ == "__main__":
    main()
