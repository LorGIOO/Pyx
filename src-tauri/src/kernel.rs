//! Persistent Python kernel manager.
//!
//! Owns a long-lived `python kernel.py` child process and talks to it over
//! newline-delimited JSON on stdin/stdout. Access is serialized through a
//! `Mutex`, so requests are handled one at a time and the response that comes
//! back always matches the request we just sent.
//!
//! NO REQUEST WAITS FOR EVER. The answer used to be read with a blocking
//! `read_until` while holding that mutex: a Python that had died without its
//! pipe closing (something it started still held it), or a housekeeping
//! request stuck on a busy Jupyter, never returned — the compile that was
//! waiting never ended, every later one queued behind it, and the only way
//! out was to restart Pyx. The pipe is now drained by a thread of its own and
//! the wait is a timed one: it notices a dead interpreter, and it enforces a
//! time limit per request (`request_limit`).

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The embedded kernel script. Shipped in the binary so there is nothing to
/// install or locate at runtime — we drop it into a temp file and run it.
const KERNEL_PY: &str = include_str!("../python/kernel.py");

pub struct KernelProc {
    child: Child,
    /// Shared so an INTERRUPT can reach the kernel while `exec` is blocked
    /// reading the response. `exec` holds this only for the microseconds it
    /// takes to write a request, never for the duration of a cell.
    stdin: Arc<Mutex<ChildStdin>>,
    /// The interpreter's stdout, one line per message, read by a thread of its
    /// own so that waiting for an answer can be timed. Closed at end of file.
    lines: Receiver<Vec<u8>>,
    python: String,
    /// Tail of the interpreter's stderr (drained by a thread so the pipe can
    /// never fill up and block Python). Shown when the kernel dies, so a crash
    /// has a visible cause instead of a generic "terminó inesperadamente".
    stderr_tail: Arc<Mutex<String>>,
}

/// Shared handle to the kernel process. Arc so async commands can move a clone
/// into `spawn_blocking` — kernel requests must run OFF the main thread
/// (synchronous commands execute on the UI thread and freeze typing).
pub type KernelHandle = Arc<Mutex<Option<KernelProc>>>;

#[derive(Default)]
pub struct KernelState(KernelHandle);

impl KernelState {
    pub fn handle(&self) -> KernelHandle {
        self.0.clone()
    }
}

/// User-chosen interpreter override (Python tab / Configuración). When set and
/// the path exists, the kernel launches it; otherwise it auto-detects.
static PY_OVERRIDE: std::sync::OnceLock<Mutex<Option<String>>> = std::sync::OnceLock::new();
fn py_override() -> &'static Mutex<Option<String>> {
    PY_OVERRIDE.get_or_init(|| Mutex::new(None))
}
pub fn set_python_override(path: Option<String>) {
    if let Ok(mut g) = py_override().lock() {
        *g = path.filter(|p| !p.trim().is_empty());
    }
}

/// PID of the live kernel process, kept OUTSIDE the kernel mutex so an
/// interrupt can reach a runaway cell while `exec` is still blocked holding
/// that mutex.
static KERNEL_PID: std::sync::OnceLock<Mutex<Option<u32>>> = std::sync::OnceLock::new();
fn kernel_pid() -> &'static Mutex<Option<u32>> {
    KERNEL_PID.get_or_init(|| Mutex::new(None))
}

/// Writable end of the live kernel, also kept outside the kernel mutex — this
/// is the channel a soft interrupt travels on.
type StdinHandle = Arc<Mutex<ChildStdin>>;
static KERNEL_IN: std::sync::OnceLock<Mutex<Option<StdinHandle>>> = std::sync::OnceLock::new();
fn kernel_in() -> &'static Mutex<Option<StdinHandle>> {
    KERNEL_IN.get_or_init(|| Mutex::new(None))
}

/// Jupyter-style SOFT interrupt: ask the kernel to raise `KeyboardInterrupt`
/// inside the cell that is running. The session's variables survive — which is
/// the whole point, since stopping a runaway loop used to also throw away the
/// minutes of computation that came before it.
///
/// The control line goes down the SAME stdin pipe as ordinary requests, but
/// through a separately held handle: the kernel reads its input on a dedicated
/// thread, so a control line is seen even while a cell is executing.
/// Deliberately does NOT touch the kernel mutex (a running `exec` holds it).
pub fn interrupt_soft() {
    let handle = kernel_in().lock().ok().and_then(|g| g.clone());
    if let Some(h) = handle {
        if let Ok(mut w) = h.lock() {
            let _ = w
                .write_all(b"{\"type\":\"interrupt\"}\n")
                .and_then(|_| w.flush());
        }
    }
}

/// Kill the kernel process outright. The escalation path for a cell that never
/// yields to Python (a C extension spinning without checking signals). The
/// blocked `request` then gets EOF → `exec` drops the dead proc → the NEXT
/// request respawns a fresh kernel.
pub fn interrupt_hard() {
    let pid = kernel_pid().lock().ok().and_then(|g| *g);
    if let Some(pid) = pid {
        #[cfg(windows)]
        {
            let mut c = Command::new("taskkill");
            c.args(["/PID", &pid.to_string(), "/F", "/T"]);
            crate::quiet(&mut c);
            let _ = c.status();
        }
        #[cfg(not(windows))]
        {
            let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
        }
    }
    if let Ok(mut g) = kernel_pid().lock() {
        *g = None;
    }
    if let Ok(mut g) = kernel_in().lock() {
        *g = None;
    }
}

/// Result of probing a candidate interpreter.
#[derive(serde::Serialize, Clone)]
pub struct PyProbe {
    /// Real `sys.executable` (absolute path) — pins the exact interpreter.
    pub exe: String,
    /// Interpreter version (e.g. "3.13.7").
    pub version: String,
    /// Whether `import numpy` succeeds — our proxy for "has the scientific
    /// stack". Used to prefer a real environment over an empty one.
    pub has_numpy: bool,
}

/// Probe a candidate interpreter. Returns `None` if it is NOT a genuine, usable
/// Python; otherwise its real `sys.executable` and whether numpy imports.
///
/// Two Windows traps this avoids:
///   * The Microsoft Store "App execution alias" `python.exe` prints a
///     "Python was not found; install from the Store…" notice and STILL exits
///     0, so a plain `--version` check wrongly accepts it. We require the
///     interpreter to actually run code and echo a sentinel — the stub never
///     reaches the code, so it is rejected.
///   * An empty project `.venv` (e.g. one that happens to be first on PATH when
///     the app is launched from an activated shell) is a real interpreter but
///     has no packages. We report `has_numpy` so `find_python` can prefer an
///     interpreter that can actually do scientific work.
fn probe_python(cmd: &std::path::Path) -> Option<PyProbe> {
    // Print PYX_OK<exe>|<version> on one line, then NUMPY only if numpy imports.
    let code = "import sys\n\
                sys.stdout.write('PYX_OK' + sys.executable + '|' + sys.version.split()[0] + '\\n')\n\
                try:\n import numpy\n sys.stdout.write('NUMPY')\n\
                except Exception:\n pass\n";
    let mut c = Command::new(cmd);
    c.arg("-c")
        .arg(code)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::quiet(&mut c);
    let out = c.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let idx = s.find("PYX_OK")?;
    let rest = &s[idx + "PYX_OK".len()..];
    let line = rest.lines().next().unwrap_or("");
    let mut parts = line.splitn(2, '|');
    let exe = parts.next().unwrap_or("").trim().to_string();
    let version = parts.next().unwrap_or("").trim().to_string();
    if exe.is_empty() {
        return None;
    }
    Some(PyProbe { exe, version, has_numpy: s.contains("NUMPY") })
}

/// Candidate interpreters to probe, in priority order: PATH names first
/// (`python`, `python3`, `py`), then the common Windows install dirs (newest
/// version first). GUI processes don't always inherit the user PATH, so the
/// install dirs are scanned as a fallback. Shared by `find_python` and
/// `list_interpreters` so the discovery logic lives in ONE place.
fn candidate_pythons() -> Vec<std::path::PathBuf> {
    let mut cands: Vec<std::path::PathBuf> = Vec::new();
    // The environment Pyx prepared itself (runtime.rs) comes first: the user
    // asked for it, and it has the scientific stack by construction.
    if let Some(p) = crate::runtime::env_python() {
        cands.push(p);
    }
    cands.extend(["python", "python3", "py"].iter().map(std::path::PathBuf::from));
    // macOS: Finder-launched apps get a MINIMAL PATH that misses Homebrew —
    // try the canonical absolute locations too. Linux: distro python3.
    #[cfg(target_os = "macos")]
    {
        for p in ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"] {
            cands.push(std::path::PathBuf::from(p));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for p in ["/usr/bin/python3", "/usr/local/bin/python3"] {
            cands.push(std::path::PathBuf::from(p));
        }
    }
    #[cfg(windows)]
    {
        let mut roots: Vec<std::path::PathBuf> = Vec::new();
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            roots.push(std::path::PathBuf::from(local).join(r"Programs\Python"));
        }
        roots.push(std::path::PathBuf::from(r"C:\"));
        for root in roots {
            if let Ok(entries) = std::fs::read_dir(&root) {
                let mut dirs: Vec<std::path::PathBuf> = entries
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| {
                        p.file_name()
                            .map(|n| n.to_string_lossy().to_lowercase().starts_with("python"))
                            .unwrap_or(false)
                    })
                    .collect();
                dirs.sort();
                dirs.reverse();
                for dir in dirs {
                    let exe = dir.join("python.exe");
                    if exe.exists() {
                        cands.push(exe);
                    }
                }
            }
        }
    }
    cands
}

/// Find a Python interpreter. PREFERS one that has numpy, so an empty `.venv`
/// sitting first on PATH is skipped in favour of a real scientific environment;
/// if none has numpy, the first interpreter that runs is used (pure Python still
/// works). Always returns an absolute path, and never the Store stub.
pub fn find_python() -> Option<String> {
    let mut fallback: Option<String> = None;
    for cand in candidate_pythons() {
        if let Some(p) = probe_python(&cand) {
            if p.has_numpy {
                return Some(p.exe);
            }
            if fallback.is_none() {
                fallback = Some(p.exe);
            }
        }
    }
    fallback
}

/// The interpreter to launch: the user's override if set and it exists, else
/// the autodetected one (prefers an interpreter with numpy).
fn chosen_python() -> Option<String> {
    if let Ok(g) = py_override().lock() {
        if let Some(p) = g.clone() {
            if std::path::Path::new(&p).exists() {
                return Some(p);
            }
        }
    }
    find_python()
}

/// Enumerate the usable interpreters for the Python-tab picker (PATH first, then
/// the common Windows install dirs), de-duplicated by real path.
pub fn list_interpreters() -> Vec<PyProbe> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<PyProbe> = Vec::new();
    for cand in candidate_pythons() {
        if let Some(info) = probe_python(&cand) {
            if seen.insert(info.exe.to_lowercase()) {
                out.push(info);
            }
        }
    }
    out
}

/// Where the embedded kernel script is dropped before Python runs it.
///
/// The name carries a fingerprint of the script itself, so an installation that
/// upgrades Pyx can never keep running the PREVIOUS version's kernel out of a
/// stale temp file — a failure mode that looks like the new features simply not
/// existing.
fn kernel_path() -> std::path::PathBuf {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in KERNEL_PY.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    std::env::temp_dir().join(format!("pyx_kernel_{h:016x}.py"))
}

fn spawn() -> Result<KernelProc, String> {
    let python = chosen_python().ok_or_else(|| {
        "No se encontró Python (elige el intérprete en la pestaña Python).".to_string()
    })?;

    let path = kernel_path();
    std::fs::write(&path, KERNEL_PY).map_err(|e| format!("No se pudo escribir el kernel: {e}"))?;

    let mut cmd = Command::new(&python);
    cmd.arg("-u") // unbuffered: responses arrive immediately
        .arg(&path)
        .env("MPLBACKEND", "Agg")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::quiet(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("No se pudo iniciar Python: {e}"))?;

    // Record the PID outside the kernel mutex so `interrupt` can kill it while a
    // cell is running (and `exec` is blocked holding the mutex).
    if let Ok(mut g) = kernel_pid().lock() {
        *g = Some(child.id());
    }

    let stdin: StdinHandle = Arc::new(Mutex::new(child.stdin.take().ok_or("sin stdin")?));
    if let Ok(mut g) = kernel_in().lock() {
        *g = Some(stdin.clone());
    }
    let stdout = child.stdout.take().ok_or("sin stdout")?;
    let (tx, lines) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut rd = BufReader::new(stdout);
        loop {
            let mut raw: Vec<u8> = Vec::new();
            match rd.read_until(b'\n', &mut raw) {
                Ok(n) if n > 0 => {
                    if tx.send(raw).is_err() {
                        break; // the kernel was dropped: nobody is listening
                    }
                }
                _ => break, // end of file (or a broken pipe): `tx` closes
            }
        }
    });

    // Drain stderr on a thread (an unread pipe fills up and would BLOCK the
    // interpreter mid-cell); keep only a bounded tail for diagnostics.
    let stderr_tail = Arc::new(Mutex::new(String::new()));
    if let Some(err) = child.stderr.take() {
        let buf = stderr_tail.clone();
        std::thread::spawn(move || {
            let mut rd = BufReader::new(err);
            // Bytes, not `read_line`: one line that is not UTF-8 (a child
            // process writing in the console's code page) used to END this
            // loop — and an undrained pipe then blocked the interpreter.
            let mut raw: Vec<u8> = Vec::new();
            while matches!(rd.read_until(b'\n', &mut raw), Ok(n) if n > 0) {
                let line = String::from_utf8_lossy(&raw).into_owned();
                raw.clear();
                if let Ok(mut b) = buf.lock() {
                    b.push_str(&line);
                    if b.len() > 16384 {
                        let mut cut = b.len() - 8192;
                        while !b.is_char_boundary(cut) {
                            cut += 1;
                        }
                        b.replace_range(..cut, "");
                    }
                }
            }
        });
    }

    // Wait for the kernel's "ready" handshake, skipping stray banner lines.
    // EOF means Python died on startup — surface its stderr as the cause.
    let mut got_ready = false;
    // An interpreter that starts but never says "ready" (an antivirus holding
    // it, a site hook waiting on the network) is a failed start, not a wait.
    let give_up = Instant::now() + Duration::from_secs(90);
    for _ in 0..50 {
        // A banner printed before the kernel takes over its descriptors
        // (a sitecustomize, a noisy site hook) may not be UTF-8: skip it.
        let left = give_up.saturating_duration_since(Instant::now());
        let Ok(raw) = lines.recv_timeout(left) else { break };
        let line = String::from_utf8_lossy(&raw);
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) {
            if v.get("type").and_then(|t| t.as_str()) == Some("ready") {
                got_ready = true;
                break;
            }
        }
    }
    if !got_ready {
        let tail = stderr_tail.lock().map(|b| b.clone()).unwrap_or_default();
        let _ = child.kill();
        if let Ok(mut g) = kernel_in().lock() {
            *g = None;
        }
        if let Ok(mut g) = kernel_pid().lock() {
            *g = None;
        }
        return Err(if tail.trim().is_empty() {
            "El kernel de Python terminó al arrancar (sin handshake).".to_string()
        } else {
            format!("El kernel de Python falló al arrancar:\n{tail}")
        });
    }

    Ok(KernelProc {
        child,
        stdin,
        lines,
        python,
        stderr_tail,
    })
}

/// Just the `id` of a response frame. Deserializing into this skips every
/// other field without building it — a 1 MB response (a long print, a
/// figure) is scanned once instead of being turned into a tree of values.
#[derive(serde::Deserialize)]
struct FrameId {
    #[serde(default)]
    id: Option<serde_json::Value>,
}

/// How long a request may take before the kernel is interrupted.
///
/// The user's own code — a cell, a `\\py{}` expression, a macro — has no limit
/// unless one was asked for (`timeout_ms`, from the "tiempo máximo por celda"
/// setting): a simulation that runs for ten minutes is a simulation, the
/// status bar says Python is running, and "Detener" stops it.
///
/// Everything else is Pyx's own housekeeping (completions, the values of a
/// linked notebook, the imports warmed up in the background…), which the user
/// did not start, cannot see and so cannot stop. Those always have a limit.
fn request_limit(req: &serde_json::Value) -> Option<Duration> {
    if let Some(ms) = req.get("timeout_ms").and_then(|v| v.as_u64()).filter(|ms| *ms > 0) {
        return Some(Duration::from_millis(ms));
    }
    let has = |k: &str| req.get(k).is_some();
    if has("code") || has("evals") || has("macro") {
        return None;
    }
    // Importing a scientific stack from a cold disk takes its time.
    Some(Duration::from_secs(if has("prewarm") || has("starnames") { 300 } else { 120 }))
}

/// After the limit: how long the interrupted request has to answer before the
/// interpreter is given up on and replaced.
const INTERRUPT_GRACE: Duration = Duration::from_secs(5);

impl KernelProc {
    /// Send one request and return the matching response frame as its JSON
    /// TEXT, untouched. The app parses it once; the old path parsed it here
    /// into a value tree and Tauri serialized that tree back into text for
    /// the window — twice the work on every result, megabytes for a figure.
    ///
    /// Err means the interpreter is no longer usable (it died, or it did not
    /// answer in time even after being interrupted): the caller drops it.
    fn request_raw(&mut self, req: &serde_json::Value) -> Result<String, String> {
        let line = serde_json::to_string(req).map_err(|e| e.to_string())?;
        {
            // Scoped: the stdin lock is released before we start waiting for
            // the response, so a soft interrupt can be written mid-cell.
            let mut w = self.stdin.lock().map_err(|_| "kernel stdin lock")?;
            w.write_all(line.as_bytes())
                .and_then(|_| w.write_all(b"\n"))
                .and_then(|_| w.flush())
                .map_err(|e| format!("Error escribiendo al kernel: {e}"))?;
        }

        let want_id = req.get("id").cloned();
        let limit = request_limit(req);
        let started = Instant::now();
        let mut interrupted: Option<Instant> = None;
        let mut exited: Option<Instant> = None;
        let died = |stderr_tail: &Arc<Mutex<String>>| {
            let tail = stderr_tail.lock().map(|b| b.clone()).unwrap_or_default();
            if tail.trim().is_empty() {
                "El kernel de Python terminó inesperadamente.".to_string()
            } else {
                format!("El kernel de Python terminó inesperadamente:\n{tail}")
            }
        };
        loop {
            let raw = match self.lines.recv_timeout(Duration::from_millis(200)) {
                Ok(raw) => raw,
                Err(RecvTimeoutError::Disconnected) => return Err(died(&self.stderr_tail)),
                Err(RecvTimeoutError::Timeout) => {
                    // Dead, but its pipe still open (a process it started
                    // inherited it): end of file will not come. What it wrote
                    // before dying is already here or a moment away.
                    if exited.is_none() && matches!(self.child.try_wait(), Ok(Some(_))) {
                        exited = Some(Instant::now());
                    }
                    if exited.map(|t| t.elapsed() > Duration::from_secs(1)).unwrap_or(false) {
                        return Err(died(&self.stderr_tail));
                    }
                    if let Some(limit) = limit {
                        match interrupted {
                            None if started.elapsed() > limit => {
                                // First the polite way: KeyboardInterrupt in
                                // whatever is running, which keeps the session.
                                if let Ok(mut w) = self.stdin.lock() {
                                    let _ = w.write_all(b"{\"type\":\"interrupt\"}\n").and_then(|_| w.flush());
                                }
                                interrupted = Some(Instant::now());
                            }
                            Some(t) if t.elapsed() > INTERRUPT_GRACE => {
                                return Err(format!(
                                    "Python no respondió en {} s ni atendió a la interrupción: \
                                     Pyx ha cerrado ese proceso y abrirá uno nuevo.",
                                    limit.as_secs().max(1)
                                ));
                            }
                            _ => {}
                        }
                    }
                    continue;
                }
            };
            // Bytes, then lossy text: a frame is always valid UTF-8 (the kernel
            // guarantees it), but a stray invalid byte on this pipe must be a
            // skipped line, not an error that kills the kernel and the session.
            let buf = String::from_utf8_lossy(&raw);
            let trimmed = buf.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(frame) = serde_json::from_str::<FrameId>(trimmed) {
                // Skip stray notices (e.g. a late "ready"); match the id we sent.
                if want_id.is_none() || frame.id.as_ref() == want_id.as_ref() {
                    return Ok(trimmed.to_string());
                }
            }
        }
    }
}

fn ensure(state: &Mutex<Option<KernelProc>>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "kernel lock")?;
    if guard.is_none() {
        *guard = Some(spawn()?);
    }
    Ok(())
}

pub fn start(state: &Mutex<Option<KernelProc>>) -> Result<serde_json::Value, String> {
    ensure(state)?;
    let guard = state.lock().map_err(|_| "kernel lock")?;
    let python = guard.as_ref().map(|k| k.python.clone()).unwrap_or_default();
    Ok(serde_json::json!({ "ready": true, "python": python }))
}

/// Run one request in the kernel; the answer is the response frame's JSON
/// text as the kernel wrote it (see `request_raw`).
pub fn exec_raw(
    state: &Mutex<Option<KernelProc>>,
    req: serde_json::Value,
) -> Result<String, String> {
    ensure(state)?;
    let mut guard = state.lock().map_err(|_| "kernel lock")?;
    let proc = guard.as_mut().ok_or("kernel no iniciado")?;
    match proc.request_raw(&req) {
        Ok(v) => Ok(v),
        Err(e) => {
            // A broken pipe means the interpreter died; drop it so the next
            // call respawns a fresh one instead of failing forever.
            let _ = proc.child.kill();
            *guard = None;
            if let Ok(mut g) = kernel_in().lock() {
                *g = None;
            }
            if let Ok(mut g) = kernel_pid().lock() {
                *g = None;
            }
            Err(e)
        }
    }
}

/// Restart the kernel: a NEW interpreter process, not just an emptied
/// namespace.
///
/// Clearing the namespace leaves `sys.modules` untouched, so a library the user
/// had just upgraded with `pip install -U …` kept serving its old code until
/// the app was closed and reopened. "Reiniciar el kernel" has to mean what it
/// says. The compiler's own reset (`{"reset": true}`, which only empties the
/// namespace) is a different, much cheaper operation and stays as it was.
pub fn reset(state: &Mutex<Option<KernelProc>>) -> Result<serde_json::Value, String> {
    shutdown(state)?;
    start(state)
}

pub fn shutdown(state: &Mutex<Option<KernelProc>>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "kernel lock")?;
    if let Some(mut proc) = guard.take() {
        if let Ok(mut w) = proc.stdin.lock() {
            let _ = w
                .write_all(b"{\"type\":\"shutdown\"}\n")
                .and_then(|_| w.flush());
        }
        let _ = proc.child.wait();
    }
    if let Ok(mut g) = kernel_in().lock() {
        *g = None;
    }
    if let Ok(mut g) = kernel_pid().lock() {
        *g = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Matching a response reads its `id` and nothing else.
    #[test]
    fn frame_id_reads_only_the_id() {
        let big = format!(
            "{{\"id\": 7, \"stdout\": \"{}\", \"displays\": [{{\"kind\": \"html\", \"data\": \"<b>x</b>\"}}]}}",
            "x".repeat(100_000)
        );
        let f: FrameId = serde_json::from_str(&big).unwrap();
        assert_eq!(f.id, Some(serde_json::json!(7)));
        let ready: FrameId = serde_json::from_str("{\"type\": \"ready\", \"python\": \"3.13\"}").unwrap();
        assert_eq!(ready.id, None);
    }

    /// The real kernel, end to end: the response comes back as the kernel's
    /// own JSON text, for the request that was sent. Skipped without Python.
    #[test]
    fn exec_raw_returns_the_kernels_frame() {
        if chosen_python().is_none() {
            return;
        }
        let state: Mutex<Option<KernelProc>> = Mutex::new(None);
        let raw = exec_raw(&state, serde_json::json!({"id": 41, "code": "x = 2\nx * 21"})).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["id"], serde_json::json!(41));
        assert_eq!(v["ok"], serde_json::json!(true));
        assert_eq!(v["result"], serde_json::json!("42"));
        let raw = exec_raw(&state, serde_json::json!({"id": 42, "evals": ["x + 1"]})).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["evals"]["x + 1"]["value"], serde_json::json!("3"));
        shutdown(&state).unwrap();
    }

    /// The user's code has no limit unless one is asked for; Pyx's own
    /// housekeeping always has one.
    #[test]
    fn only_housekeeping_requests_are_limited_by_default() {
        let j = |s: &str| serde_json::from_str::<serde_json::Value>(s).unwrap();
        assert!(request_limit(&j(r#"{"id":1,"code":"x=1"}"#)).is_none());
        assert!(request_limit(&j(r#"{"id":1,"evals":["x"]}"#)).is_none());
        assert!(request_limit(&j(r#"{"id":1,"macro":"x"}"#)).is_none());
        assert_eq!(request_limit(&j(r#"{"id":1,"code":"x=1","timeout_ms":2500}"#)), Some(Duration::from_millis(2500)));
        assert!(request_limit(&j(r#"{"id":1,"code":"x=1","timeout_ms":0}"#)).is_none());
        assert_eq!(request_limit(&j(r#"{"id":1,"nblink":"fetch"}"#)), Some(Duration::from_secs(120)));
        assert_eq!(request_limit(&j(r#"{"id":1,"complete":"np."}"#)), Some(Duration::from_secs(120)));
        assert_eq!(request_limit(&j(r#"{"id":1,"prewarm":["scipy"]}"#)), Some(Duration::from_secs(300)));
    }

    /// A request past its limit is interrupted and ANSWERS (the session's
    /// variables survive); the kernel is usable right after.
    #[test]
    fn a_request_past_its_limit_is_interrupted_not_waited_for() {
        if chosen_python().is_none() {
            return;
        }
        let state: Mutex<Option<KernelProc>> = Mutex::new(None);
        exec_raw(&state, serde_json::json!({"id": 1, "code": "guardado = 7"})).unwrap();
        let t = Instant::now();
        let res = exec_raw(
            &state,
            serde_json::json!({"id": 2, "code": "import time\nfor _ in range(600):\n    time.sleep(0.1)", "timeout_ms": 1000}),
        );
        assert!(t.elapsed() < Duration::from_secs(15), "esperó {:?}", t.elapsed());
        let v: serde_json::Value = serde_json::from_str(&res.expect("la interrupción responde")).unwrap();
        assert_eq!(v["ok"], serde_json::json!(false), "{v}");
        let raw = exec_raw(&state, serde_json::json!({"id": 3, "evals": ["guardado"]})).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["evals"]["guardado"]["value"], serde_json::json!("7"));
        shutdown(&state).unwrap();
    }

    /// An interpreter that dies mid-request is an error at once — and the next
    /// request starts a new one — never a wait.
    #[test]
    fn a_dead_interpreter_fails_the_request_and_is_replaced() {
        if chosen_python().is_none() {
            return;
        }
        let state: Mutex<Option<KernelProc>> = Mutex::new(None);
        let t = Instant::now();
        let res = exec_raw(&state, serde_json::json!({"id": 1, "code": "import os\nos._exit(3)"}));
        assert!(res.is_err(), "{res:?}");
        assert!(t.elapsed() < Duration::from_secs(20), "esperó {:?}", t.elapsed());
        let raw = exec_raw(&state, serde_json::json!({"id": 2, "code": "1 + 1"})).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["result"], serde_json::json!("2"));
        shutdown(&state).unwrap();
    }
}
