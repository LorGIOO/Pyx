//! Persistent Python kernel manager.
//!
//! Owns a long-lived `python kernel.py` child process and talks to it over
//! newline-delimited JSON on stdin/stdout. Access is serialized through a
//! `Mutex`, so requests are handled one at a time and the response that comes
//! back always matches the request we just sent.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

/// The embedded kernel script. Shipped in the binary so there is nothing to
/// install or locate at runtime — we drop it into a temp file and run it.
const KERNEL_PY: &str = include_str!("../python/kernel.py");

pub struct KernelProc {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
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

/// PID of the live kernel process, kept OUTSIDE the kernel mutex so `interrupt`
/// can kill a runaway cell while `exec` is still blocked holding that mutex.
static KERNEL_PID: std::sync::OnceLock<Mutex<Option<u32>>> = std::sync::OnceLock::new();
fn kernel_pid() -> &'static Mutex<Option<u32>> {
    KERNEL_PID.get_or_init(|| Mutex::new(None))
}

/// Kill the running kernel process so a stuck/long cell stops immediately
/// (Jupyter-style interrupt). The blocked `request` then gets EOF → `exec`
/// drops the dead proc → the NEXT request respawns a fresh kernel. Deliberately
/// does NOT lock the kernel mutex (a running `exec` holds it).
pub fn interrupt() {
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
    let mut cands: Vec<std::path::PathBuf> =
        ["python", "python3", "py"].iter().map(std::path::PathBuf::from).collect();
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

fn kernel_path() -> std::path::PathBuf {
    std::env::temp_dir().join("calc_kernel.py")
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

    let stdin = child.stdin.take().ok_or("sin stdin")?;
    let stdout = child.stdout.take().ok_or("sin stdout")?;
    let mut reader = BufReader::new(stdout);

    // Drain stderr on a thread (an unread pipe fills up and would BLOCK the
    // interpreter mid-cell); keep only a bounded tail for diagnostics.
    let stderr_tail = Arc::new(Mutex::new(String::new()));
    if let Some(err) = child.stderr.take() {
        let buf = stderr_tail.clone();
        std::thread::spawn(move || {
            let mut rd = BufReader::new(err);
            let mut line = String::new();
            while matches!(rd.read_line(&mut line), Ok(n) if n > 0) {
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
                line.clear();
            }
        });
    }

    // Wait for the kernel's "ready" handshake, skipping stray banner lines.
    // EOF means Python died on startup — surface its stderr as the cause.
    let mut got_ready = false;
    for _ in 0..50 {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("El kernel no respondió: {e}"))?;
        if n == 0 {
            break;
        }
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
        return Err(if tail.trim().is_empty() {
            "El kernel de Python terminó al arrancar (sin handshake).".to_string()
        } else {
            format!("El kernel de Python falló al arrancar:\n{tail}")
        });
    }

    Ok(KernelProc {
        child,
        stdin,
        reader,
        python,
        stderr_tail,
    })
}

impl KernelProc {
    /// Send one request object and return the matching response object.
    fn request(&mut self, req: &serde_json::Value) -> Result<serde_json::Value, String> {
        let line = serde_json::to_string(req).map_err(|e| e.to_string())?;
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("Error escribiendo al kernel: {e}"))?;

        let want_id = req.get("id").cloned();
        loop {
            let mut buf = String::new();
            let n = self
                .reader
                .read_line(&mut buf)
                .map_err(|e| format!("Error leyendo del kernel: {e}"))?;
            if n == 0 {
                let tail = self
                    .stderr_tail
                    .lock()
                    .map(|b| b.clone())
                    .unwrap_or_default();
                return Err(if tail.trim().is_empty() {
                    "El kernel de Python terminó inesperadamente.".to_string()
                } else {
                    format!("El kernel de Python terminó inesperadamente:\n{tail}")
                });
            }
            let trimmed = buf.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                // Skip stray notices (e.g. a late "ready"); match the id we sent.
                if want_id.is_none() || val.get("id") == want_id.as_ref() {
                    return Ok(val);
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

pub fn exec(
    state: &Mutex<Option<KernelProc>>,
    req: serde_json::Value,
) -> Result<serde_json::Value, String> {
    ensure(state)?;
    let mut guard = state.lock().map_err(|_| "kernel lock")?;
    let proc = guard.as_mut().ok_or("kernel no iniciado")?;
    match proc.request(&req) {
        Ok(v) => Ok(v),
        Err(e) => {
            // A broken pipe means the interpreter died; drop it so the next
            // call respawns a fresh one instead of failing forever.
            let _ = proc.child.kill();
            *guard = None;
            Err(e)
        }
    }
}

pub fn reset(state: &Mutex<Option<KernelProc>>) -> Result<serde_json::Value, String> {
    exec(
        state,
        serde_json::json!({ "id": 0, "code": "", "reset": true }),
    )
}

pub fn shutdown(state: &Mutex<Option<KernelProc>>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "kernel lock")?;
    if let Some(mut proc) = guard.take() {
        let _ = proc
            .stdin
            .write_all(b"{\"type\":\"shutdown\"}\n")
            .and_then(|_| proc.stdin.flush());
        let _ = proc.child.wait();
    }
    Ok(())
}
