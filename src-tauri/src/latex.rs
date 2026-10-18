//! LaTeX compilation and toolchain detection.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Serialize)]
pub struct CompileResult {
    pub ok: bool,
    pub pdf_path: Option<String>,
    pub log: String,
    pub engine: String,
    /// Why the engine was stopped before it finished, if it was: "cancelado"
    /// (the user), "bucle", "sin-progreso", "tiempo". None for a run that ended
    /// on its own.
    pub stopped: Option<String>,
    /// Every file the engine READ (its `-recorder` list plus the graphics its
    /// log names) that is not part of the TeX installation: the document's
    /// .sty, chapters, images, bibliographies… The app re-checks them before
    /// it trusts that nothing changed.
    /// None when the engine keeps no such list (Tectonic): the app then
    /// never skips a compile on the grounds that nothing changed.
    pub inputs: Option<Vec<String>>,
    /// When the engine started, in ms since the epoch: an input modified after
    /// this was modified DURING the compile, so the PDF may predate it.
    pub started_ms: u64,
}

// ---------------------------------------------------------------------------
// Running the engine under a watchdog
// ---------------------------------------------------------------------------
//
// `Command::output()` waits forever, and a TeX run CAN run forever: a macro
// that recurses, a package looping on bad input. It happened with nothing more
// exotic than `\includepdf[pages=-]{plano.pdf}` while AutoCAD was still writing
// plano.pdf: pdfpages counted 0 pages and xelatex looped for 40 minutes. The app
// waited on it, every later compile queued behind it, the PDF stopped updating
// — and closing Pyx left xelatex and its dvipdfmx running, holding the working
// directory's files (the SyncTeX index among them).
//
// So the engine runs watched:
//   - the same error at the same source line, over and over, is a loop;
//   - no output at all for a long while is a loop that prints nothing;
//   - a hard ceiling for anything else;
//   - the user can stop it (compile_cancel);
// and on Windows it runs inside a Job Object that dies with the app, so a
// crash or a closed window can never leave an engine behind.

/// When the watchdog stops a pass.
#[derive(Clone, Copy)]
struct Limits {
    /// The same `(error, line)` this many times: a loop, not a document.
    loop_repeats: u32,
    /// Seconds without a single byte of output.
    stall_secs: u64,
    /// Seconds for one pass, whatever it is doing.
    pass_secs: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { loop_repeats: 400, stall_secs: 120, pass_secs: 20 * 60 }
    }
}

#[cfg(windows)]
mod job {
    //! A Windows Job Object that kills every process in it when it closes —
    //! when the compile ends, when it is cancelled, and when Pyx itself exits
    //! or crashes (the OS closes the handle then).
    use std::os::windows::io::AsRawHandle;
    type Handle = *mut core::ffi::c_void;

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimit {
        per_process_user_time: i64,
        per_job_user_time: i64,
        limit_flags: u32,
        min_ws: usize,
        max_ws: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct IoCounters([u64; 6]);
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimit {
        basic: BasicLimit,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attrs: *mut core::ffi::c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *mut core::ffi::c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, code: u32) -> i32;
        fn CloseHandle(h: Handle) -> i32;
    }
    const EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const KILL_ON_JOB_CLOSE: u32 = 0x2000;

    pub struct Job(Handle);
    // The handle is only ever used through the kernel32 calls above, which are
    // thread-safe for job objects.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> Option<Job> {
            unsafe {
                let h = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
                if h.is_null() {
                    return None;
                }
                let mut info = ExtendedLimit::default();
                info.basic.limit_flags = KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    h,
                    EXTENDED_LIMIT_INFORMATION,
                    &mut info as *mut _ as *mut core::ffi::c_void,
                    std::mem::size_of::<ExtendedLimit>() as u32,
                );
                if ok == 0 {
                    CloseHandle(h);
                    return None;
                }
                Some(Job(h))
            }
        }
        pub fn assign(&self, child: &std::process::Child) -> bool {
            unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as Handle) != 0 }
        }
        pub fn kill(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// The engine run in flight, so `cancel()` can reach it.
struct Running {
    cancel: std::sync::atomic::AtomicBool,
    #[cfg(windows)]
    job: Option<job::Job>,
    pid: u32,
}

static RUNNING: std::sync::Mutex<Option<std::sync::Arc<Running>>> = std::sync::Mutex::new(None);

/// Stop the compile in flight (the engine and everything it started).
pub fn cancel() -> bool {
    let cur = RUNNING.lock().ok().and_then(|g| g.clone());
    let Some(r) = cur else { return false };
    r.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    kill_tree(&r);
    true
}

fn kill_tree(r: &Running) {
    #[cfg(windows)]
    {
        if let Some(j) = r.job.as_ref() {
            j.kill();
            return;
        }
        let mut c = Command::new("taskkill");
        c.args(["/PID", &r.pid.to_string(), "/F", "/T"]);
        crate::quiet(&mut c);
        let _ = c.status();
    }
    #[cfg(not(windows))]
    {
        // The whole group (see run_watched): killing only the engine's pid
        // left xdvipdfmx running, still writing the PDF and holding the
        // working directory, after "Detener" or a watchdog stop.
        let _ = Command::new("kill")
            .args(["-9", "--", &format!("-{}", r.pid)])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = Command::new("kill").arg("-9").arg(r.pid.to_string()).stderr(Stdio::null()).status();
    }
}

/// What one watched engine run produced.
struct Watched {
    stdout: String,
    stderr: String,
    success: bool,
    /// (code, explanation) when the watchdog or the user stopped it.
    stopped: Option<(String, String)>,
}

/// State the output reader shares with the watchdog.
#[derive(Default)]
struct OutWatch {
    last_output: Option<std::time::Instant>,
    /// (error line + its `l.NNN` context) -> times seen
    repeats: std::collections::HashMap<String, u32>,
    pending_error: Option<String>,
    worst: Option<(String, u32)>,
    partial: String,
    /// A warm engine printed its "preamble done, waiting" marker.
    ready: bool,
}

impl OutWatch {
    fn feed(&mut self, chunk: &str) {
        self.last_output = Some(std::time::Instant::now());
        self.partial.push_str(chunk);
        while let Some(nl) = self.partial.find('\n') {
            let line: String = self.partial[..nl].trim_end_matches('\r').to_string();
            self.partial.drain(..=nl);
            self.line(&line);
        }
        // A run that never prints a newline must not grow this forever.
        if self.partial.len() > 64 * 1024 {
            self.partial.clear();
        }
    }
    fn line(&mut self, l: &str) {
        if l == WARM_READY {
            self.ready = true;
            return;
        }
        if let Some(rest) = l.strip_prefix("! ") {
            self.pending_error = Some(rest.chars().take(200).collect());
            return;
        }
        // TeX prints the error, then the source context `l.NNN …`.
        if let Some(err) = self.pending_error.as_ref() {
            if l.starts_with("l.") {
                let key = format!("{err}\n{}", l.chars().take(160).collect::<String>());
                self.pending_error = None;
                let n = self.repeats.entry(key.clone()).or_insert(0);
                *n += 1;
                let n = *n;
                if self.worst.as_ref().map(|w| n > w.1).unwrap_or(true) {
                    self.worst = Some((key, n));
                }
                // Bounded: a long document with many DIFFERENT errors.
                if self.repeats.len() > 20_000 {
                    self.repeats.clear();
                }
            }
        }
    }
}

/// An engine process that has been started and whose output is being
/// collected, but that nobody is waiting on yet. A normal pass waits on it at
/// once; a warm one (see "Warm engine" below) is left paused after its
/// preamble and waited on only when the next compile continues it.
struct Spawned {
    child: std::process::Child,
    running: std::sync::Arc<Running>,
    watch: std::sync::Arc<std::sync::Mutex<OutWatch>>,
    out_buf: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    err_buf: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    readers: Vec<std::thread::JoinHandle<()>>,
    stdin: Option<std::process::ChildStdin>,
}

/// Start the engine and the threads that drain its output.
fn spawn_watched(mut cmd: Command, keep_stdin: bool) -> Result<Spawned, std::io::Error> {
    use std::io::Read;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(if keep_stdin { Stdio::piped() } else { Stdio::null() });
    // Its own process group, so stopping it reaches the PDF driver it starts
    // (xelatex pipes into xdvipdfmx) — the Unix counterpart of the Job Object.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn()?;

    #[cfg(windows)]
    let job = job::Job::new().filter(|j| j.assign(&child));
    let running = Arc::new(Running {
        cancel: std::sync::atomic::AtomicBool::new(false),
        #[cfg(windows)]
        job,
        pid: child.id(),
    });

    let watch = Arc::new(Mutex::new(OutWatch::default()));
    let out_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let err_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let mut readers = Vec::new();
    if let Some(mut so) = child.stdout.take() {
        let (w, b) = (watch.clone(), out_buf.clone());
        readers.push(std::thread::spawn(move || {
            let mut chunk = [0u8; 16 * 1024];
            while let Ok(n) = so.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                if let Ok(mut b) = b.lock() {
                    // A runaway run must not eat the machine's memory: keep the
                    // first 4 MB and the most recent 4 MB of output.
                    const HEAD: usize = 4 * 1024 * 1024;
                    if b.len() + n > 2 * HEAD {
                        let excess = b.len() + n - 2 * HEAD;
                        let end = (HEAD + excess).min(b.len());
                        b.drain(HEAD..end);
                    }
                    b.extend_from_slice(&chunk[..n]);
                }
                if let Ok(mut w) = w.lock() {
                    w.feed(&String::from_utf8_lossy(&chunk[..n]));
                }
            }
        }));
    }
    if let Some(mut se) = child.stderr.take() {
        let (w, b) = (watch.clone(), err_buf.clone());
        readers.push(std::thread::spawn(move || {
            let mut chunk = [0u8; 8 * 1024];
            while let Ok(n) = se.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                if let Ok(mut b) = b.lock() {
                    if b.len() < 1024 * 1024 {
                        b.extend_from_slice(&chunk[..n]);
                    }
                }
                if let Ok(mut w) = w.lock() {
                    w.last_output = Some(Instant::now());
                }
            }
        }));
    }
    let stdin = child.stdin.take();
    Ok(Spawned { child, running, watch, out_buf, err_buf, readers, stdin })
}

/// Stop a spawned engine that is no longer wanted, and everything it started.
fn kill_spawned(mut sp: Spawned) {
    drop(sp.stdin.take());
    kill_tree(&sp.running);
    let _ = sp.child.kill();
    let _ = sp.child.wait();
    for r in sp.readers.drain(..) {
        let _ = r.join();
    }
}

/// Wait for a spawned engine to finish; never longer than the watchdog allows.
fn wait_watched(mut sp: Spawned, limits: Limits) -> Result<Watched, std::io::Error> {
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    drop(sp.stdin.take());
    let running = sp.running.clone();
    if let Ok(mut g) = RUNNING.lock() {
        *g = Some(running.clone());
    }
    // A warm engine sat paused before this: its silence then was waiting, not
    // a loop. The watchdog's clock starts now.
    if let Ok(mut w) = sp.watch.lock() {
        w.last_output = Some(Instant::now());
    }

    let started = Instant::now();
    let mut stopped: Option<(String, String)> = None;
    let status = loop {
        if let Some(st) = sp.child.try_wait()? {
            // cancel() kills the tree from ANOTHER thread: the exit can be
            // seen here before the flag is. A killed run is not a finished one.
            if running.cancel.load(Ordering::SeqCst) {
                stopped = Some(("cancelado".into(), "Compilación detenida por el usuario.".into()));
            }
            break Some(st);
        }
        if running.cancel.load(Ordering::SeqCst) {
            stopped = Some(("cancelado".into(), "Compilación detenida por el usuario.".into()));
        } else if let Ok(w) = sp.watch.lock() {
            let quiet = w.last_output.map(|t| t.elapsed()).unwrap_or_else(|| started.elapsed());
            if let Some((key, n)) = w.worst.as_ref().filter(|(_, n)| *n >= limits.loop_repeats) {
                stopped = Some((
                    "bucle".into(),
                    format!(
                        "LaTeX ha entrado en un bucle: el mismo error se ha repetido {n} veces \
                         en la misma línea, y no iba a terminar nunca.\n\n! {key}\n\n\
                         Pyx ha detenido el motor para que la aplicación no se quede bloqueada. \
                         Corrige esa línea y vuelve a compilar."
                    ),
                ));
            } else if quiet > Duration::from_secs(limits.stall_secs) {
                stopped = Some((
                    "sin-progreso".into(),
                    format!(
                        "LaTeX llevaba {} s sin dar ninguna señal: casi seguro un bucle \
                         infinito (una macro que se llama a sí misma, un paquete atascado). \
                         Pyx ha detenido el motor; las últimas líneas del registro indican \
                         dónde estaba.",
                        limits.stall_secs
                    ),
                ));
            } else if started.elapsed() > Duration::from_secs(limits.pass_secs) {
                stopped = Some((
                    "tiempo".into(),
                    format!(
                        "La pasada superó los {} minutos y Pyx la ha detenido.",
                        limits.pass_secs / 60
                    ),
                ));
            }
        }
        if stopped.is_some() {
            kill_tree(&running);
            let _ = sp.child.kill();
            break sp.child.wait().ok();
        }
        // 20 ms: the time between the engine exiting and the PDF being shown
        // includes this sleep, on every compile.
        std::thread::sleep(Duration::from_millis(20));
    };
    // The readers end when the pipes close (the whole tree is gone by now).
    for r in sp.readers.drain(..) {
        let _ = r.join();
    }
    if let Ok(mut g) = RUNNING.lock() {
        if g.as_ref().map(|r| Arc::ptr_eq(r, &running)).unwrap_or(false) {
            *g = None;
        }
    }
    let stdout = String::from_utf8_lossy(&sp.out_buf.lock().map(|b| b.clone()).unwrap_or_default()).to_string();
    let stderr = String::from_utf8_lossy(&sp.err_buf.lock().map(|b| b.clone()).unwrap_or_default()).to_string();
    Ok(Watched {
        stdout,
        stderr,
        success: stopped.is_none() && status.map(|s| s.success()).unwrap_or(false),
        stopped,
    })
}

/// Run the engine; never longer than the watchdog allows.
fn run_watched(cmd: Command, limits: Limits) -> Result<Watched, std::io::Error> {
    wait_watched(spawn_watched(cmd, false)?, limits)
}

#[derive(Serialize)]
pub struct EnvInfo {
    pub python: Option<String>,
    pub latex: Option<String>,
    pub engines: Vec<String>,
}

fn runs(cmd: &str) -> bool {
    let mut c = Command::new(cmd);
    c.arg("--version").stdout(Stdio::null()).stderr(Stdio::null());
    crate::quiet(&mut c);
    c.status().map(|s| s.success()).unwrap_or(false)
}

/// Directories where a TeX engine binary commonly lives on Windows. GUI
/// processes don't always inherit the user PATH (where a per-user MiKTeX adds
/// itself), so we scan these as a fallback.
fn tex_dirs() -> Vec<PathBuf> {
    // The Tectonic Pyx downloads itself when no LaTeX is installed (runtime.rs).
    let mut dirs = vec![crate::runtime::tectonic_dir()];
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        dirs.push(PathBuf::from(&local).join(r"Programs\MiKTeX\miktex\bin\x64"));
    }
    if let Ok(up) = std::env::var("USERPROFILE") {
        dirs.push(PathBuf::from(&up).join(r"AppData\Local\Programs\MiKTeX\miktex\bin\x64"));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        dirs.push(PathBuf::from(&pf).join(r"MiKTeX\miktex\bin\x64"));
    }
    dirs.push(PathBuf::from(r"C:\Program Files\MiKTeX\miktex\bin\x64"));
    dirs.push(PathBuf::from(r"C:\Program Files (x86)\MiKTeX\miktex\bin\x64"));
    for year in ["2026", "2025", "2024", "2023"] {
        dirs.push(PathBuf::from(format!(r"C:\texlive\{year}\bin\windows")));
        dirs.push(PathBuf::from(format!(r"C:\texlive\{year}\bin\win32")));
    }
    // macOS: GUI apps launched from Finder get a MINIMAL PATH that excludes
    // MacTeX and Homebrew — resolve them by their canonical locations.
    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/Library/TeX/texbin")); // MacTeX symlinks
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    // Linux: TeX Live from the distro or from tug.org's installer.
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        for year in ["2026", "2025", "2024", "2023"] {
            dirs.push(PathBuf::from(format!("/usr/local/texlive/{year}/bin/x86_64-linux")));
        }
    }
    dirs
}

/// Where each tool was found, for the life of the process.
///
/// Answering "is xelatex on PATH?" means STARTING it (`xelatex --version`),
/// and that ran on every compile and on every SyncTeX Ctrl+click. With MiKTeX
/// on Windows one such probe costs 100–500 ms — paid before the engine even
/// began, on the compile a typing pause fires. Only hits are kept: a TeX
/// distribution installed while Pyx is open is still found on the next try.
static RESOLVED: std::sync::Mutex<Option<std::collections::HashMap<String, String>>> =
    std::sync::Mutex::new(None);

/// Resolve a TeX engine to a runnable command: the bare name if it's on PATH,
/// otherwise a full path from a known install location. Returns None if absent.
pub fn resolve_engine(name: &str) -> Option<String> {
    if let Some(hit) = RESOLVED.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(name).cloned())) {
        return Some(hit);
    }
    let found = probe_engine(name)?;
    if let Ok(mut g) = RESOLVED.lock() {
        g.get_or_insert_with(Default::default).insert(name.to_string(), found.clone());
    }
    Some(found)
}

/// Forget a resolved tool (it could not be started from where it was found).
fn forget_engine(name: &str) {
    if let Ok(mut g) = RESOLVED.lock() {
        if let Some(m) = g.as_mut() {
            m.remove(name);
        }
    }
}

fn probe_engine(name: &str) -> Option<String> {
    if runs(name) {
        return Some(name.to_string());
    }
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    for dir in tex_dirs() {
        let p = dir.join(&exe);
        if p.exists() {
            return Some(p.to_string_lossy().to_string());
        }
    }
    None
}

fn engine_works(name: &str) -> bool {
    resolve_engine(name).is_some()
}

/// Report which interpreters/engines are available so the UI can show status
/// and disable actions that cannot run.
pub fn detect_env() -> EnvInfo {
    let python = crate::kernel::find_python();

    let mut engines = Vec::new();
    for e in ["xelatex", "pdflatex", "lualatex", "tectonic"] {
        if engine_works(e) {
            engines.push(e.to_string());
        }
    }
    let latex = engines.first().cloned();

    EnvInfo {
        python,
        latex,
        engines,
    }
}

#[derive(Serialize)]
pub struct SyncTexHit {
    pub input: String,
    pub line: u32,
    pub column: i32,
}

#[derive(serde::Serialize)]
pub struct SyncTexLoc {
    pub page: u32,
    pub x: f64,
    pub y: f64,
}

/// Forward search (source line → PDF position) via `synctex view`.
/// Returns the first record: page + x/y in PDF points from the page's
/// top-left corner (the viewer scrolls there and flashes a marker).
pub fn synctex_view(tex: &str, line: u32, pdf: &str) -> Result<SyncTexLoc, String> {
    // The index itself first (synctex.rs): no process, and it works where no
    // `synctex` program exists (Tectonic).
    if let Some((page, x, y)) = crate::synctex::index_for(pdf).and_then(|i| i.view(tex, line)) {
        return Ok(SyncTexLoc { page, x, y });
    }
    let cmd = resolve_engine("synctex")
        .ok_or("No se encontró «synctex» (instala MiKTeX o TeX Live).")?;
    let mut c = Command::new(&cmd);
    c.arg("view")
        .arg("-i")
        .arg(format!("{line}:1:{tex}"))
        .arg("-o")
        .arg(pdf);
    crate::quiet(&mut c);
    let out = c
        .output()
        .map_err(|e| format!("No se pudo ejecutar synctex: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);

    let mut page: Option<u32> = None;
    let mut x: Option<f64> = None;
    let mut y: Option<f64> = None;
    for l in text.lines() {
        if let Some(v) = l.strip_prefix("Page:") {
            if page.is_none() {
                page = v.trim().parse().ok();
            }
        } else if let Some(v) = l.strip_prefix("x:") {
            if x.is_none() {
                x = v.trim().parse().ok();
            }
        } else if let Some(v) = l.strip_prefix("y:") {
            if y.is_none() {
                y = v.trim().parse().ok();
            }
        }
        if page.is_some() && x.is_some() && y.is_some() {
            break;
        }
    }
    match page {
        Some(p) => Ok(SyncTexLoc { page: p, x: x.unwrap_or(0.0), y: y.unwrap_or(0.0) }),
        None => Err("SyncTeX no encontró esa línea (recompila el documento).".into()),
    }
}

/// Inverse search (PDF position → source line) via the `synctex` CLI that
/// ships with MiKTeX/TeX Live. `x`/`y` are PDF points from the page's
/// top-left corner — the same coordinate system synctex reports.
pub fn synctex_edit(pdf: &str, page: u32, x: f64, y: f64) -> Result<SyncTexHit, String> {
    if let Some((input, line)) = crate::synctex::index_for(pdf).and_then(|i| i.edit(page, x, y)) {
        return Ok(SyncTexHit { input, line, column: -1 });
    }
    let cmd = resolve_engine("synctex")
        .ok_or("No se encontró «synctex» (instala MiKTeX o TeX Live).")?;
    let mut c = Command::new(&cmd);
    c.arg("edit")
        .arg("-o")
        .arg(format!("{page}:{x:.2}:{y:.2}:{pdf}"));
    crate::quiet(&mut c);
    let out = c
        .output()
        .map_err(|e| format!("No se pudo ejecutar synctex: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);

    let mut input: Option<String> = None;
    let mut line: Option<u32> = None;
    let mut column: i32 = -1;
    for l in text.lines() {
        if let Some(v) = l.strip_prefix("Input:") {
            if input.is_none() {
                input = Some(v.trim().to_string());
            }
        } else if let Some(v) = l.strip_prefix("Line:") {
            if line.is_none() {
                line = v.trim().parse().ok();
            }
        } else if let Some(v) = l.strip_prefix("Column:") {
            if column < 0 {
                column = v.trim().parse().unwrap_or(-1);
            }
        }
        if input.is_some() && line.is_some() {
            break;
        }
    }
    match (input, line) {
        (Some(i), Some(l)) => Ok(SyncTexHit { input: i, line: l, column }),
        _ => Err("SyncTeX no encontró esa posición (recompila el documento).".into()),
    }
}

/// The engine's `TEXINPUTS`, in precedence order:
///
///   1. `.` — the project folder the engine runs from. FIRST, so anything a
///      document already resolves (an image or `.sty` beside the main file)
///      keeps resolving to exactly that file.
///   2. the working directory, where the `.build.tex` copies live.
///   3. the folder of every file the document pulls in, so an image or package
///      sitting next to a chapter in a subfolder resolves too. Checked against
///      pdflatex and xelatex: with a chapter's folder AHEAD of `.`, an image in
///      that folder silently replaced a same-named one beside the main file.
///   4. the distribution's defaults. The separator is `;` on Windows and `:`
///      elsewhere, and the TRAILING one is what tells kpathsea "…and then the
///      usual places" — without it the engine stops finding LaTeX itself.
fn texinputs(out_dir: &Path, search_dirs: &[String]) -> String {
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut v = String::new();
    if let Ok(prev) = std::env::var("TEXINPUTS") {
        if !prev.is_empty() {
            v.push_str(&prev);
            if !prev.ends_with(sep) {
                v.push(sep);
            }
        }
    }
    v.push('.');
    v.push(sep);
    v.push_str(&out_dir.to_string_lossy());
    v.push(sep);
    for d in search_dirs.iter().filter(|d| !d.is_empty()) {
        v.push_str(d);
        v.push(sep);
    }
    v
}

/// Extensions of files a pass writes that the NEXT pass does not read back —
/// outputs, logs, and inputs of external tools (makeindex, bibtex, biber) that
/// another LaTeX pass cannot bring up to date. A change in any of these is
/// never a reason for one more pass. `.aux` and `.out` are left out too: a
/// label or bookmark that moved already makes LaTeX print "Rerun…".
const NOT_READ_BACK: &[&str] = &[
    "log", "pdf", "synctex", "synctex.gz", "fls", "xdv", "dvi", "ps", "aux", "out",
    "idx", "ilg", "ind", "glo", "gls", "glg", "acn", "acr", "alg", "ist",
    "bcf", "run.xml", "bbl", "blg",
];

/// Content fingerprint of every listing this job writes at `\end{document}`
/// and reads back on the next pass: the table of contents and the lists of
/// figures and tables — and just as much tocloft's `\newlistof` lists
/// (`.tocA`, `.tocB`, …), minitoc's `.mtc*`, listings' `.lol`, beamer's
/// `.nav`, any package's own list file.
///
/// It used to look at `.toc`, `.lof` and `.lot` only. A template that builds
/// each document's index with `\newlistof{tocA}` then got ONE pass for an edit
/// that only changed that index — renaming a section or a data table — and
/// the PDF kept the previous index until the user pressed compile again. It
/// looked random: an edit that also moved a label printed "Rerun" and was
/// settled, one that did not was not.
///
/// A list file that did not exist before the pass and does after counts as a
/// change too, which is what a first compile in a fresh working directory
/// needs.
fn listings_stamp(out_dir: &Path, job: &str) -> Vec<(String, Vec<u8>)> {
    let prefix = format!("{job}.");
    let mut v: Vec<(String, Vec<u8>)> = std::fs::read_dir(out_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let ext = name.strip_prefix(&prefix)?.to_string();
            let skip = ext.contains("(busy)")
                || ext.ends_with(".tex")
                || NOT_READ_BACK.contains(&ext.as_str());
            if skip || !e.file_type().ok()?.is_file() {
                return None;
            }
            Some((ext, std::fs::read(e.path()).ok()?))
        })
        .collect();
    v.sort();
    v
}

/// Does the file end like a PDF does? A writer that dies mid-document leaves a
/// file with a FRESH mtime and no trailer: with xelatex that happens every time
/// an `\includegraphics` target is missing — TeX recovers from the error, but
/// xdvipdfmx, which receives the pages through a pipe, stops with "Image
/// inclusion failed" and xelatex then fails writing to the dead pipe. Treating
/// that file as the result made the viewer fail with "Invalid PDF structure",
/// which is all the user ever got to see.
fn pdf_complete(p: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(p) else { return false };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let tail = len.min(2048) as i64;
    if tail == 0 || f.seek(SeekFrom::End(-tail)).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).is_ok() && buf.windows(5).any(|w| w == b"%%EOF")
}

/// Images the engine reported as missing (`File `x.png' not found`), in order,
/// without repeats.
fn missing_images(log: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for l in log.lines() {
        if let Some(rest) = l.strip_prefix("LaTeX Warning: File `") {
            if let Some(end) = rest.find("' not found") {
                let name = rest[..end].to_string();
                if !out.contains(&name) {
                    out.push(name);
                }
            }
        }
    }
    out
}

/// Forget what earlier passes left for this job: cross-reference data, lists,
/// the SyncTeX index (finished or not), the recorder file. The next pass then
/// starts exactly like a first compile — the PDF, the log and the processed
/// `.build.tex` copies are kept. Only ever touches the working directory.
///
/// Needed after a pass that did not end on its own (stopped, killed, crashed):
/// whatever it was writing — an `.aux` cut in half, a `.synctex(busy)` — would
/// otherwise poison the next compile, and an `.aux` cut in half is the classic
/// "it only works after deleting the temporary files".
fn clean_intermediates(out_dir: &Path, job: &str) {
    fn walk(dir: &Path, job_prefix: &str, depth: u32) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if depth > 0 {
                    walk(&p, job_prefix, depth - 1);
                }
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            let lower = name.to_lowercase();
            let doomed = if let Some(ext) = name.strip_prefix(job_prefix) {
                let ext = ext.to_lowercase();
                !(ext == "pdf" || ext == "log" || ext.ends_with("tex"))
            } else {
                // \include'd chapters write their own .aux; any interrupted
                // SyncTeX index too.
                lower.ends_with(".aux") || lower.contains(".synctex(busy)")
            };
            if doomed {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    walk(out_dir, &format!("{job}."), 3);
}

/// Did a previous pass of this job die before it finished? Its SyncTeX index
/// is still marked busy.
fn interrupted_before(out_dir: &Path, job: &str) -> bool {
    out_dir.join(format!("{job}.synctex(busy)")).exists()
}

/// Is the first error of this run one TeX met while reading the job's own
/// `.aux`? Then the error is in what an earlier run wrote, not in the document,
/// and the same compile from a clean state is the cure.
fn aux_poisoned(log: &str, job: &str) -> bool {
    let Some(first) = log.find("\n! ") else { return false };
    let before = &log[..first];
    let aux = format!("{job}.aux");
    match before.rfind(&aux) {
        Some(at) => !before[at..].contains(')'),
        None => false,
    }
}

/// Part of the TeX distribution or the system's fonts, not of the project.
/// `k` is a lowercased path with `\` separators.
fn installed_file(k: &str) -> bool {
    k.contains("\\miktex\\") || k.contains("texmf") || k.contains("\\texlive\\")
        || k.contains("/texlive/") || k.contains("\\windows\\fonts\\")
        || k.contains("\\fontconfig\\") || k.ends_with(".fmt")
}

/// Files the engine read that are not part of the TeX installation.
///
/// From the recorder list (`-recorder`: every file TeX opened) plus the
/// graphics the log names — images go to the PDF driver, which the recorder
/// does not always see. Relative names are resolved against the folder the
/// engine ran in.
fn recorded_inputs(out_dir: &Path, job: &str, run_dir: &Path, log: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let out_norm = out_dir.to_string_lossy().replace('/', "\\").to_lowercase();
    let mut add = |raw: &str, base: &Path| {
        let raw = raw.trim().trim_matches('"');
        if raw.is_empty() {
            return;
        }
        let p = Path::new(raw);
        let abs = if p.is_absolute() { p.to_path_buf() } else { base.join(p) };
        let s = abs.to_string_lossy().to_string();
        let k = s.replace('/', "\\").to_lowercase();
        // The distribution (MiKTeX, TeX Live), system fonts, and the working
        // directory itself (the .build.tex copies are tracked by content).
        if installed_file(&k) || k.starts_with(&out_norm) {
            return;
        }
        if seen.insert(k) {
            out.push(s);
        }
    };
    if let Ok(fls) = std::fs::read_to_string(out_dir.join(format!("{job}.fls"))) {
        let mut pwd = run_dir.to_path_buf();
        for l in fls.lines() {
            if let Some(d) = l.strip_prefix("PWD ") {
                pwd = PathBuf::from(d.trim());
            } else if let Some(f) = l.strip_prefix("INPUT ") {
                add(f, &pwd);
            }
        }
    }
    for l in log.lines() {
        if let Some(rest) = l.strip_prefix("File: ") {
            if let Some(end) = rest.find(" Graphic file") {
                add(&rest[..end], run_dir);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Warm engine: the preamble is typeset BEFORE you ask for the PDF
// ---------------------------------------------------------------------------
//
// Measured on an ordinary engineering report (fontspec, amsmath, TikZ,
// hyperref, booktabs): xelatex spends ~0.65 s of a ~0.70 s compile on the
// PREAMBLE — loading packages and fonts that are the same on every compile —
// and ~0.05 s on the document you actually changed.
//
// The idea is tex-fast-recompile's (github.com/user202729/tex-fast-recompile),
// itself an answer to the limits of mylatexformat (a precompiled preamble
// format): mylatexformat cannot dump the OpenType fonts fontspec loads, so it
// does nothing for xelatex or lualatex. Instead, right after a compile ends we
// START THE NEXT ONE: an engine runs the current preamble and then stops at
// `\read` on its stdin, waiting. When the next compile comes and the preamble
// is byte-for-byte the same — and no file the preamble read has changed — Pyx
// writes the body and sends a newline: the engine goes straight into
// `\begin{document}`. Fonts and packages are already in memory.
//
// Everything downstream sees an ordinary compile:
//   - the stub the engine starts from is the preamble verbatim, so an error in
//     the preamble is reported on the same line, of a file with the same name;
//   - the body is `\input` from the build file's OWN path, with the preamble
//     replaced by as many empty lines, so SyncTeX and every log line point at
//     the same file and line as a normal pass (checked both directions);
//   - the build file is put back exactly, mtime included, when the pass ends.
//
// Any doubt and it is not used: a different preamble, engine, folder or search
// path; a preamble input modified since the engine started; an engine that
// died; one older than WARM_MAX_AGE (\today must not be yesterday's). Then the
// pass runs normally — the warm engine only ever saves time.

/// Line the stub prints when its preamble is done and it starts waiting.
const WARM_READY: &str = "PYXWARMREADY";
/// A paused engine is discarded after this long (memory, and `\today`).
const WARM_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(15 * 60);
/// Folder of the working directory that holds the stubs.
pub(crate) const WARM_DIR: &str = "_pyxwarm";

struct Warm {
    id: u64,
    /// Engine, folders, job and search path: what the engine was started with.
    key: String,
    /// The exact preamble it has typeset.
    preamble: String,
    born: std::time::SystemTime,
    /// Project files the preamble read (from the last run's recorder list),
    /// with their (mtime, size) as they were when the engine started.
    deps: Vec<(PathBuf, Option<(std::time::SystemTime, u64)>)>,
    sp: Spawned,
}

static WARM: std::sync::Mutex<Option<Warm>> = std::sync::Mutex::new(None);
static WARM_IDS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Byte offset where the document body starts: the first `\begin{document}`
/// outside a comment, after a `\documentclass`. None when the file has no
/// preamble of its own (the class is in an \input'ed file) or no body.
fn body_start(text: &str) -> Option<usize> {
    let mut offset = 0usize;
    let mut seen_class = false;
    for line in text.split_inclusive('\n') {
        // The code part of the line: up to the first `%` not escaped as `\%`.
        let bytes = line.as_bytes();
        let mut end = bytes.len();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'\\' {
                i += 2;
                continue;
            }
            if bytes[i] == b'%' {
                end = i;
                break;
            }
            i += 1;
        }
        let code = &line[..end.min(line.len())];
        let mut from = 0;
        while let Some(at) = code[from..].find("\\begin") {
            let at = from + at;
            let rest = code[at + 6..].trim_start();
            if rest.starts_with("{document}") {
                let class_before = seen_class || code[..at].contains("\\documentclass");
                return if class_before { Some(offset + at) } else { None };
            }
            from = at + 6;
        }
        if code.contains("\\documentclass") {
            seen_class = true;
        }
        offset += line.len();
    }
    None
}

fn warm_key(engine_cmd: &str, dir: &Path, out_dir: &Path, job: &str, search_dirs: &[String]) -> String {
    format!(
        "{engine_cmd}\n{}\n{}\n{job}\n{}",
        dir.display(),
        out_dir.display(),
        texinputs(out_dir, search_dirs)
    )
}

/// The line Pyx sends to let a paused engine go on.
const WARM_GO: &str = "PYXWARMGO";

/// What the stub runs after the preamble: say it is ready, wait for a line on
/// stdin (scrollmode is the lowest mode in which TeX may read the terminal),
/// go back to nonstopmode, and — only if that line is Pyx's go-ahead — read
/// the body from the build file itself, found through TEXINPUTS so the path
/// recorded is the one a normal pass records.
///
/// Anything else (end of file because Pyx went away, an empty line, a TeX
/// that does not block on `\read` at all) ends the job right there, before
/// `\begin{document}`: no page, no .aux, and the PDF on disk is not touched.
fn warm_tail(build_name: &str) -> String {
    format!(
        "\n\\def\\pyxwarmok{{{WARM_GO} }}\
         \\def\\pyxwarmbody{{\\csname @@input\\endcsname\"{build_name}\"\\relax}}\
         \\def\\pyxwarmquit{{\\csname @@end\\endcsname}}\n\
         \\immediate\\write16{{{WARM_READY}}}\\scrollmode\\read-1 to\\pyxwarmgo\\nonstopmode\
         \\ifx\\pyxwarmgo\\pyxwarmok\\expandafter\\pyxwarmbody\\else\\expandafter\\pyxwarmquit\\fi\n"
    )
}

/// The SyncTeX scratch file an engine killed while paused leaves behind: it
/// would make the next compile believe a pass was interrupted (and start over
/// from nothing).
fn clear_busy(out_dir: &Path, job: &str) {
    let _ = std::fs::remove_file(out_dir.join(format!("{job}.synctex(busy)")));
}

/// Throw away the paused engine, if any, and what it left behind.
pub fn drop_warm() {
    let w = WARM.lock().ok().and_then(|mut g| g.take());
    if let Some(w) = w {
        let job_dir = w.key.lines().nth(2).map(PathBuf::from);
        let job = w.key.lines().nth(3).map(str::to_string);
        kill_spawned(w.sp);
        if let (Some(d), Some(j)) = (job_dir, job) {
            clear_busy(&d, &j);
        }
    }
}

/// Project files read while the PREAMBLE was being processed: the recorder's
/// INPUT lines before the job's `.aux` first appears (LaTeX opens it at
/// `\begin{document}`). Distribution files and the working directory are left
/// out, like in `recorded_inputs`.
fn preamble_inputs(out_dir: &Path, job: &str, run_dir: &Path) -> Vec<PathBuf> {
    let Ok(fls) = std::fs::read_to_string(out_dir.join(format!("{job}.fls"))) else {
        return Vec::new();
    };
    let aux = format!("{job}.aux").to_lowercase();
    let out_norm = out_dir.to_string_lossy().replace('/', "\\").to_lowercase();
    let mut pwd = run_dir.to_path_buf();
    let mut out: Vec<PathBuf> = Vec::new();
    for l in fls.lines() {
        if let Some(d) = l.strip_prefix("PWD ") {
            pwd = PathBuf::from(d.trim());
            continue;
        }
        let input = l.strip_prefix("INPUT ");
        let Some(f) = input.or_else(|| l.strip_prefix("OUTPUT ")).map(str::trim) else { continue };
        if f.to_lowercase().replace('\\', "/").ends_with(&aux) {
            break;
        }
        if input.is_none() {
            continue;
        }
        let p = Path::new(f);
        let abs = if p.is_absolute() { p.to_path_buf() } else { pwd.join(p) };
        let k = abs.to_string_lossy().replace('/', "\\").to_lowercase();
        if installed_file(&k) || k.starts_with(&out_norm) || out.contains(&abs) {
            continue;
        }
        out.push(abs);
    }
    out
}

/// Start the engine that will run the NEXT compile of this build file, and
/// leave it paused after the preamble. Best effort: any failure just means the
/// next compile runs the usual way.
fn spawn_warm(engine_cmd: &str, dir: &Path, out_dir: &Path, job: &str, build: &Path, search_dirs: &[String]) {
    drop_warm();
    let Ok(text) = std::fs::read_to_string(build) else { return };
    let Some(at) = body_start(&text) else { return };
    let Some(name) = build.file_name().map(|n| n.to_string_lossy().to_string()) else { return };
    // A quote would end the file name in the \input; such a name never warms.
    if name.contains('"') {
        return;
    }
    let preamble = text[..at].to_string();
    let stub_dir = out_dir.join(WARM_DIR);
    if std::fs::create_dir_all(&stub_dir).is_err() {
        return;
    }
    // Same NAME as the build file (in its own folder): an error in the
    // preamble is reported against the file the log parser already knows.
    let stub = stub_dir.join(&name);
    if std::fs::write(&stub, format!("{preamble}{}", warm_tail(&name))).is_err() {
        return;
    }
    // Stamped BEFORE the engine reads them: a change at any moment after this
    // shows up as a different stamp.
    let deps = preamble_inputs(out_dir, job, dir)
        .into_iter()
        .map(|p| {
            let st = file_stamp(&p);
            (p, st)
        })
        .collect();
    let mut cmd = Command::new(engine_cmd);
    cmd.current_dir(dir)
        .arg("-interaction=nonstopmode")
        .arg("-synctex=1")
        .arg(format!("-output-directory={}", out_dir.display()))
        .arg(format!("-jobname={job}"))
        .arg("-recorder")
        .env("TEXINPUTS", texinputs(out_dir, search_dirs))
        .arg(&stub);
    crate::quiet(&mut cmd);
    let Ok(sp) = spawn_watched(cmd, true) else { return };
    let id = WARM_IDS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let w = Warm {
        id,
        key: warm_key(engine_cmd, dir, out_dir, job, search_dirs),
        preamble,
        born: std::time::SystemTime::now(),
        deps,
        sp,
    };
    match WARM.lock() {
        Ok(mut g) => *g = Some(w),
        Err(_) => return,
    }
    // Reaper: a paused engine nobody continues is killed after WARM_MAX_AGE,
    // and one whose PREAMBLE never finishes (a loop before \begin{document})
    // after the same silence the watchdog allows a pass.
    let (out_dir, job) = (out_dir.to_path_buf(), job.to_string());
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let stall = std::time::Duration::from_secs(Limits::default().stall_secs);
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let Ok(mut g) = WARM.lock() else { return };
            let Some(w) = g.as_mut() else { return };
            if w.id != id {
                return; // continued or replaced
            }
            let stalled = w
                .sp
                .watch
                .lock()
                .map(|o| !o.ready && o.last_output.map(|t| t.elapsed()).unwrap_or_else(|| started.elapsed()) > stall)
                .unwrap_or(false);
            let exited = w.sp.child.try_wait().map(|s| s.is_some()).unwrap_or(true);
            if stalled || exited || started.elapsed() > WARM_MAX_AGE {
                let w = g.take();
                drop(g);
                if let Some(w) = w {
                    kill_spawned(w.sp);
                }
                clear_busy(&out_dir, &job);
                return;
            }
        }
    });
}

/// The paused engine, if it can run THIS pass: same command, folders and
/// search path, the identical preamble, alive, young enough, and no project
/// file its preamble read modified since it started. Anything else is killed.
fn take_warm(key: &str, preamble: &str, out_dir: &Path, job: &str) -> Option<Warm> {
    let mut w = WARM.lock().ok()?.take()?;
    let alive = w.sp.child.try_wait().map(|s| s.is_none()).unwrap_or(false);
    let young = w.born.elapsed().map(|a| a < WARM_MAX_AGE).unwrap_or(false);
    let deps_same = w.deps.iter().all(|(p, st)| st.is_some() && file_stamp(p) == *st);
    if alive && young && deps_same && w.key == key && w.preamble == preamble {
        return Some(w);
    }
    kill_spawned(w.sp);
    clear_busy(out_dir, job);
    None
}

fn file_stamp(p: &Path) -> Option<(std::time::SystemTime, u64)> {
    let m = std::fs::metadata(p).ok()?;
    Some((m.modified().ok()?, m.len()))
}

/// Puts the build file back as the compiler wrote it — content AND mtime, so
/// the compiler's "is the build file still the one I wrote?" check holds.
struct RestoreBuild {
    path: PathBuf,
    text: String,
    mtime: Option<std::time::SystemTime>,
}
impl Drop for RestoreBuild {
    fn drop(&mut self) {
        if std::fs::write(&self.path, self.text.as_bytes()).is_ok() {
            if let (Some(t), Ok(f)) = (self.mtime, std::fs::OpenOptions::new().write(true).open(&self.path)) {
                let _ = f.set_modified(t);
            }
        }
    }
}

/// Continue the paused engine on the body of `build`. Err when it could not be
/// handed the body (it is killed then, and the caller runs the pass normally).
fn run_warm(mut w: Warm, build: &Path, out_dir: &Path, job: &str, limits: Limits) -> Result<Watched, ()> {
    use std::io::Write;
    let fail = |w: Warm| {
        kill_spawned(w.sp);
        clear_busy(out_dir, job);
        Err(())
    };
    let Ok(text) = std::fs::read_to_string(build) else { return fail(w) };
    let Some(at) = body_start(&text) else { return fail(w) };
    let mtime = std::fs::metadata(build).and_then(|m| m.modified()).ok();
    let lines = text[..at].matches('\n').count();
    let _restore = RestoreBuild { path: build.to_path_buf(), text: text.clone(), mtime };
    let padded = format!("{}{}", "\n".repeat(lines), &text[at..]);
    if std::fs::write(build, padded.as_bytes()).is_err() {
        return fail(w);
    }
    let sent = w
        .sp
        .stdin
        .as_mut()
        .map(|s| s.write_all(format!("{WARM_GO}\n").as_bytes()).and_then(|_| s.flush()).is_ok())
        .unwrap_or(false);
    if !sent {
        return fail(w);
    }
    // `_restore` puts the build file back when this returns, whatever happened.
    wait_watched(w.sp, limits).map_err(|_| ())
}

/// The marker line is Pyx's, not the document's: keep it out of the log.
fn strip_warm_marker(out: String) -> String {
    if !out.contains(WARM_READY) {
        return out;
    }
    out.lines().filter(|l| *l != WARM_READY).collect::<Vec<_>>().join("\n")
}

// ---------------------------------------------------------------------------
// Bibliographies and indexes: the latexmk rules
// ---------------------------------------------------------------------------
//
// A `\cite` stays "[?]" until BibTeX or Biber has turned the references into a
// `.bbl`, and an index stays empty until makeindex has sorted the `.idx` into
// an `.ind` — no number of LaTeX passes changes that. latexmk's answer, which
// this follows: after a pass, run the tool whose INPUT changed since the last
// time it ran (and only then), and give LaTeX one more pass if its output
// changed. A fingerprint of each tool's inputs is kept in the working
// directory, so an edit to the prose costs nothing here.

/// Separator of a kpathsea search path on this platform.
const PATH_SEP: char = if cfg!(windows) { ';' } else { ':' };

/// `BIBINPUTS` / `BSTINPUTS`: the project and the folders of its files, then
/// the distribution's defaults (the trailing separator).
fn tool_path(dir: &Path, search_dirs: &[String]) -> String {
    let mut v = String::new();
    v.push_str(&dir.to_string_lossy());
    v.push(PATH_SEP);
    for d in search_dirs.iter().filter(|d| !d.is_empty()) {
        v.push_str(d);
        v.push(PATH_SEP);
    }
    v
}

/// The lines of the job's `.aux` (and of the `.aux` files it pulls in, one per
/// `\include`d chapter) that BibTeX reads.
fn bibtex_inputs(out_dir: &Path, job: &str) -> Option<String> {
    fn walk(path: &Path, out_dir: &Path, acc: &mut String, depth: u32) {
        let Ok(text) = std::fs::read_to_string(path) else { return };
        for l in text.lines() {
            if l.starts_with("\\citation{") || l.starts_with("\\bibdata{") || l.starts_with("\\bibstyle{") {
                acc.push_str(l);
                acc.push('\n');
            } else if let Some(rest) = l.strip_prefix("\\@input{") {
                if depth < 4 {
                    if let Some(name) = rest.strip_suffix('}') {
                        walk(&out_dir.join(name), out_dir, acc, depth + 1);
                    }
                }
            }
        }
    }
    let mut acc = String::new();
    walk(&out_dir.join(format!("{job}.aux")), out_dir, &mut acc, 0);
    acc.contains("\\bibdata{").then_some(acc)
}

/// Stamp of every `.bib` the project could be reading.
fn bib_stamps(dir: &Path, search_dirs: &[String]) -> String {
    let mut v: Vec<String> = Vec::new();
    let mut dirs: Vec<PathBuf> = vec![dir.to_path_buf()];
    dirs.extend(search_dirs.iter().map(PathBuf::from));
    for d in dirs {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.extension().map(|x| x.eq_ignore_ascii_case("bib")).unwrap_or(false) {
                if let Some((t, n)) = file_stamp(&p) {
                    let t = t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
                    v.push(format!("{}:{t}:{n}", p.display()));
                }
            }
        }
    }
    v.sort();
    v.join("\n")
}

fn fingerprint(s: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Run one auxiliary tool; its output goes to the log. None when it is not
/// installed.
fn run_tool(name: &str, args: &[String], cwd: &Path, envs: &[(&str, String)], log: &mut String) -> Option<bool> {
    let exe = resolve_engine(name)?;
    let mut c = Command::new(exe);
    c.current_dir(cwd).args(args);
    for (k, v) in envs {
        c.env(k, v);
    }
    crate::quiet(&mut c);
    log.push_str(&format!("===== Pyx: {name} =====\n"));
    match run_watched(c, Limits { loop_repeats: u32::MAX, stall_secs: 120, pass_secs: 5 * 60 }) {
        Ok(r) => {
            log.push_str(&r.stdout);
            log.push_str(&r.stderr);
            log.push('\n');
            Some(r.success)
        }
        Err(e) => {
            log.push_str(&format!("No se pudo ejecutar {name}: {e}\n"));
            Some(false)
        }
    }
}

/// After a pass: run BibTeX / Biber / makeindex when their input changed.
/// True when one of them produced output that the next pass must read.
fn run_aux_tools(dir: &Path, out_dir: &Path, job: &str, search_dirs: &[String], log: &mut String) -> bool {
    let stamp_file = out_dir.join(format!("{job}.pyxtools"));
    let old = std::fs::read_to_string(&stamp_file).unwrap_or_default();
    let old_of = |k: &str| {
        old.lines()
            .find_map(|l| l.strip_prefix(&format!("{k}=")).map(str::to_string))
            .unwrap_or_default()
    };
    let mut new_lines: Vec<String> = Vec::new();
    let mut rerun = false;
    let out_of = |ext: &str| file_stamp(&out_dir.join(format!("{job}.{ext}")));

    // Biber (biblatex): the .bcf is its whole input, plus the .bib files.
    let bcf = out_dir.join(format!("{job}.bcf"));
    if let Ok(text) = std::fs::read_to_string(&bcf) {
        let fp = fingerprint(&format!("{text}\n{}", bib_stamps(dir, search_dirs)));
        if fp != old_of("biber") || out_of("bbl").is_none() {
            let before = out_of("bbl");
            let args = vec![format!("--output-directory={}", out_dir.display()), job.to_string()];
            match run_tool("biber", &args, dir, &[], log) {
                None => log.push_str(
                    "===== Pyx: biber =====\nEl documento usa biblatex con Biber, pero «biber» no está \
                     instalado: las citas saldrán sin resolver. Instálalo desde MiKTeX o TeX Live.\n",
                ),
                Some(_) => rerun |= out_of("bbl") != before,
            }
        }
        new_lines.push(format!("biber={fp}"));
    } else if let Some(cites) = bibtex_inputs(out_dir, job) {
        // BibTeX: the \citation / \bibdata / \bibstyle lines, plus the .bib files.
        let fp = fingerprint(&format!("{cites}\n{}", bib_stamps(dir, search_dirs)));
        if fp != old_of("bibtex") || out_of("bbl").is_none() {
            let before = out_of("bbl");
            let paths = tool_path(dir, search_dirs);
            let envs = [("BIBINPUTS", paths.clone()), ("BSTINPUTS", paths)];
            if run_tool("bibtex", &[job.to_string()], out_dir, &envs, log).is_some() {
                rerun |= out_of("bbl") != before;
            }
        }
        new_lines.push(format!("bibtex={fp}"));
    }

    // makeindex: the .idx LaTeX wrote this pass.
    let idx = out_dir.join(format!("{job}.idx"));
    if let Ok(text) = std::fs::read_to_string(&idx) {
        let fp = fingerprint(&text);
        if fp != old_of("makeindex") || out_of("ind").is_none() {
            let before = out_of("ind");
            if run_tool("makeindex", &[format!("{job}.idx")], out_dir, &[], log).is_some() {
                rerun |= out_of("ind") != before;
            }
        }
        new_lines.push(format!("makeindex={fp}"));
    }

    if !new_lines.is_empty() || !old.is_empty() {
        let _ = std::fs::write(&stamp_file, new_lines.join("\n"));
    }
    rerun
}

// ---------------------------------------------------------------------------
// ChkTeX: style warnings, the way texlab offers them
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ChkHit {
    pub line: u32,
    pub column: u32,
    pub length: u32,
    pub kind: String,
    pub code: u32,
    pub message: String,
}

/// Run ChkTeX (shipped with TeX Live and MiKTeX) over `text` and return what
/// it reports. `-I0`: it looks at this text only, never at the files it
/// \inputs — the editor underlines what is on screen.
pub fn chktex(text: &str) -> Result<Vec<ChkHit>, String> {
    let exe = resolve_engine("chktex").ok_or("chktex no está instalado")?;
    let tmp = std::env::temp_dir().join(format!(
        "pyx-chktex-{}-{}.tex",
        std::process::id(),
        WARM_IDS.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    let mut c = Command::new(exe);
    c.arg("-q")
        .arg("-I0")
        .arg("-f")
        .arg("%l\t%c\t%d\t%k\t%n\t%m\n")
        .arg(&tmp);
    crate::quiet(&mut c);
    let run = run_watched(c, Limits { loop_repeats: u32::MAX, stall_secs: 10, pass_secs: 20 });
    let _ = std::fs::remove_file(&tmp);
    let run = run.map_err(|e| e.to_string())?;
    Ok(run
        .stdout
        .lines()
        .filter_map(|l| {
            let mut it = l.splitn(6, '\t');
            Some(ChkHit {
                line: it.next()?.trim().parse().ok()?,
                column: it.next()?.trim().parse().ok()?,
                length: it.next()?.trim().parse().ok()?,
                kind: it.next()?.trim().to_string(),
                code: it.next()?.trim().parse().ok()?,
                message: it.next()?.trim().to_string(),
            })
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Tectonic: a whole TeX system in one program
// ---------------------------------------------------------------------------
//
// Tectonic (github.com/tectonic-typesetting/tectonic) is XeTeX plus the TeX
// Live packages, packaged as ONE executable that downloads the packages a
// document needs the first time it needs them, and runs TeX, BibTeX and the
// reruns by itself. For Pyx it means a machine with no MiKTeX or TeX Live —
// a laptop where nobody may install a 4 GB distribution — can still compile.
//
// It takes no -jobname and no TEXINPUTS: the output is named after the input
// (`main.build.pdf`), so it is renamed to the job's name afterwards, and the
// folders a normal run finds through TEXINPUTS are handed over as
// `-Z search-path=…`. It writes no recorder list either, so the compile says
// it does not know what was read (`inputs: None`) and the app never skips a
// compile on its account.

/// The arguments of a Tectonic run (kept apart so they can be checked).
fn tectonic_args(src: &Path, dir: &Path, out_dir: &Path, search_dirs: &[String]) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "--outdir".into(),
        out_dir.to_string_lossy().to_string(),
        "--synctex".into(),
        "--keep-logs".into(),
        "--keep-intermediates".into(),
        "--chatter".into(),
        "minimal".into(),
    ];
    // Same precedence as TEXINPUTS in a normal run: the project, the working
    // directory (the .build.tex copies), then the chapters' folders.
    let mut dirs: Vec<String> = vec![dir.to_string_lossy().to_string(), out_dir.to_string_lossy().to_string()];
    dirs.extend(search_dirs.iter().filter(|d| !d.is_empty()).cloned());
    for d in dirs {
        a.push("-Z".into());
        a.push(format!("search-path={d}"));
    }
    a.push(src.to_string_lossy().to_string());
    a
}

fn compile_tectonic(
    exe: &str,
    src: &Path,
    dir: &Path,
    out_dir: &Path,
    job: &str,
    search_dirs: &[String],
    clean_first: bool,
) -> Result<CompileResult, String> {
    drop_warm();
    if clean_first || interrupted_before(out_dir, job) {
        clean_intermediates(out_dir, job);
    }
    let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| job.to_string());
    let pdf = out_dir.join(format!("{job}.pdf"));
    let stamp_of = |p: &Path| p.metadata().ok().map(|m| (m.modified().ok(), m.len()));
    let pdf_before = stamp_of(&pdf);
    let started_ms = now_ms();

    let mut cmd = Command::new(exe);
    cmd.current_dir(dir).args(tectonic_args(src, dir, out_dir, search_dirs));
    crate::quiet(&mut cmd);
    // The first compile may download packages for a while, quietly.
    let limits = Limits { loop_repeats: 400, stall_secs: 600, pass_secs: 20 * 60 };
    let run = run_watched(cmd, limits).map_err(|e| {
        forget_engine("tectonic");
        crate::spawn_error("tectonic", Some(dir), &e)
    })?;

    // Its outputs carry the INPUT's name: give them the job's.
    if stem != job {
        for ext in ["pdf", "synctex.gz", "log", "aux", "toc", "out"] {
            let from = out_dir.join(format!("{stem}.{ext}"));
            if from.exists() {
                let _ = std::fs::rename(&from, out_dir.join(format!("{job}.{ext}")));
            }
        }
    }
    let mut log = String::from("===== Pasada 1 (tectonic) =====\n");
    // The TeX log is what the Problems view reads; Tectonic's own notes go
    // after it.
    if let Ok(tex_log) = std::fs::read_to_string(out_dir.join(format!("{job}.log"))) {
        log.push_str(&tex_log);
        log.push('\n');
    }
    log.push_str(&run.stdout);
    log.push_str(&run.stderr);
    log.push('\n');
    let mut stopped = None;
    if let Some((code, why)) = run.stopped {
        clean_intermediates(out_dir, job);
        log.push_str("===== Pyx: compilación detenida =====\n");
        log.push_str(&why);
        log.push('\n');
        stopped = Some(code);
    }
    let written = match (pdf_before, stamp_of(&pdf)) {
        (None, Some(_)) => true,
        (Some(b), Some(a)) => a != b,
        _ => false,
    };
    let pdf_fresh = written && pdf_complete(&pdf);
    if written && !pdf_fresh {
        let _ = std::fs::remove_file(&pdf);
        log.push_str("===== Pyx: el PDF no se completó =====\n");
        log.push_str("Tectonic se detuvo mientras escribía el PDF; se mantiene el anterior.\n");
    }
    Ok(CompileResult {
        ok: run.success && stopped.is_none() && pdf_fresh,
        pdf_path: pdf_fresh.then(|| pdf.to_string_lossy().to_string()),
        log,
        engine: "tectonic".into(),
        stopped,
        inputs: None,
        started_ms,
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Recreate the document's subdirectory layout inside the build folder.
///
/// `\include{cap/uno}` makes TeX write `cap/uno.aux` *relative to the output
/// directory*. MiKTeX creates the missing folder; TeX Live does not — it stops
/// with "I can't write on file `cap/uno.aux'", which would make every
/// chaptered document fail to build on Linux and macOS while working fine on
/// the Windows machine it was written on. Creating the folders up front costs
/// nothing and removes the difference.
fn mirror_subdirs(src: &Path, dst: &Path, depth: u32) {
    if depth == 0 {
        return;
    }
    let rd = match std::fs::read_dir(src) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name();
        // Skip dot-folders (including the build folder itself) and the places
        // where generated images and dependencies live.
        let n = name.to_string_lossy();
        if n.starts_with('.') || n == "node_modules" || n == "xref" {
            continue;
        }
        let target = dst.join(&name);
        if std::fs::create_dir_all(&target).is_ok() {
            mirror_subdirs(&entry.path(), &target, depth - 1);
        }
    }
}

/// Compile a `.tex` file with the chosen engine. Runs `passes` times so table
/// of contents / cross references can settle (1 is fastest, 2 resolves refs).
///
/// `jobname` (optional) sets the TeX `-jobname`, so a build file like
/// `doc.build.tex` can produce `doc.pdf`. The output PDF is `<jobname>.pdf`
/// (or `<stem>.pdf` when no jobname is given).
pub fn compile(
    path: &str,
    project_dir: &str,
    engine: &str,
    passes: u32,
    jobname: Option<String>,
    search_dirs: &[String],
    clean_first: bool,
    warm: bool,
) -> Result<CompileResult, String> {
    let src = Path::new(path);
    if !src.exists() {
        return Err(format!("No existe el archivo: {path}"));
    }
    // The engine RUNS from the project folder — that is what makes relative
    // paths in the source (\includegraphics{xref/…}, a .sty next to the
    // document) resolve exactly as the author wrote them — but it WRITES to the
    // working directory, which lives outside the project entirely. See
    // workspace.rs for why.
    let dir = Path::new(project_dir);
    let out_dir = src
        .parent()
        .ok_or("El documento no tiene carpeta contenedora")?
        .to_path_buf();
    let file = src.to_string_lossy().to_string();

    let engine = match engine {
        "pdflatex" | "lualatex" | "xelatex" | "tectonic" => engine,
        _ => "xelatex",
    };
    let engine_cmd = resolve_engine(engine).ok_or_else(|| {
        format!(
            "No se encontró el motor «{engine}». Instala MiKTeX o TeX Live, o Tectonic \
             (un único programa que descarga los paquetes que necesita)."
        )
    })?;

    let out_name = jobname
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| src.file_stem().unwrap_or_default().to_string_lossy().to_string());

    // ---- one folder for every scratch file the engine produces ----
    //
    // A LaTeX run litters the document's folder with .aux, .log, .fls, .toc,
    // .out, .lof, .lot, .maf, .mtc*, .nav, .snm … On a document with chapters
    // that is dozens of files the author never asked for and cannot tell apart
    // from their own. `-output-directory` sends all of it into ONE place.
    //
    // The PDF and the SyncTeX index are then moved back next to the document,
    // because those two are not scratch: the viewer opens the PDF from there,
    // and `synctex` resolves its index relative to the PDF it is given.
    //
    // The engine still RUNS from the document's folder, so relative paths in
    // the source (\includegraphics{xref/…}, \input{cap/…}) resolve exactly as
    // they did before. And keeping the .aux files between runs is what lets
    // cross-references settle in two passes instead of three.
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("No se pudo crear la carpeta de compilación: {e}"))?;
    // Until this returns, a save must not pack this directory (workspace.rs).
    let _busy = crate::workspace::mark_busy(&out_dir);
    mirror_subdirs(dir, &out_dir, 3);

    // Snapshot the PDF's mtime BEFORE compiling: success is "this run wrote a
    // PDF", never "a PDF from some earlier compile is still lying around".
    let pdf = out_dir.join(format!("{out_name}.pdf"));
    // (modified, length): a PDF counts as written by this run if EITHER moved.
    // The mtime alone missed rewrites on filesystems with coarse timestamps
    // (FAT, some network shares), where a fast recompile can land in the same
    // tick — and then the viewer was never told there was a new PDF.
    let stamp_of = |p: &Path| p.metadata().ok().map(|m| (m.modified().ok(), m.len()));
    let pdf_before = stamp_of(&pdf);

    if engine == "tectonic" {
        // Its own reruns and BibTeX; none of the pass logic below applies.
        return compile_tectonic(&engine_cmd, src, dir, &out_dir, &out_name, search_dirs, clean_first);
    }

    let passes = passes.clamp(1, 3);
    const MAX_PASSES: u32 = 3;
    let mut log = String::new();
    let mut clean = false;
    let mut stopped: Option<String> = None;
    let started_ms = now_ms();

    // The engine left paused after the last compile, if it can run this one
    // (see "Warm engine"). Taken BEFORE the check below: while it waits, the
    // SyncTeX index it has open is marked busy, and that is not a dead pass.
    let mut warm_engine = if warm && !clean_first && passes == 1 {
        let key = warm_key(&engine_cmd, dir, &out_dir, &out_name, search_dirs);
        std::fs::read_to_string(src)
            .ok()
            .and_then(|t| body_start(&t).map(|at| t[..at].to_string()))
            .and_then(|pre| take_warm(&key, &pre, &out_dir, &out_name))
    } else {
        drop_warm();
        None
    };
    if warm_engine.is_none() {
        // A paused engine that could not be used is gone: so is its index.
        clear_busy(&out_dir, &out_name);
    }

    // A compile from scratch (asked for), or one after a pass that never
    // finished (its SyncTeX index is still marked busy): nothing an earlier
    // run left behind may take part in this one.
    if clean_first || (warm_engine.is_none() && interrupted_before(&out_dir, &out_name)) {
        clean_intermediates(&out_dir, &out_name);
    }
    let mut healed = false;

    let mut i = 0;
    while i < MAX_PASSES {
        let mut cmd = Command::new(&engine_cmd);
        // Like TeXstudio: NO -halt-on-error. In nonstopmode TeX recovers from
        // errors and still emits a PDF when it can; the problems stay visible
        // in the log panel. Halting on the first error made documents that
        // "work" in TeXstudio produce nothing here.
        cmd.current_dir(dir)
            .arg("-interaction=nonstopmode")
            .arg("-synctex=1")
            .arg(format!("-output-directory={}", out_dir.display()))
            // The generated `.build.tex` copies live in the working directory,
            // so the engine has to look there for the children a parent pulls
            // in. The trailing separator keeps the default search paths.
            .env("TEXINPUTS", texinputs(&out_dir, search_dirs));
        // A pass we ALREADY know is not the last one exists only to settle
        // references and the table of contents — its PDF is thrown away. In
        // draft mode the engine skips font loading, image processing and the
        // whole shipout, which is where most of the time in a figure-heavy
        // engineering report goes, and still writes the .aux/.toc the next pass
        // reads. xelatex has no -draftmode, but `-no-pdf` skips its PDF driver
        // (xdvipdfmx) the same way — exactly what latexmk does.
        let final_pass = i + 1 >= passes;
        if !final_pass {
            match engine {
                "pdflatex" | "lualatex" => {
                    cmd.arg("-draftmode");
                }
                _ => {
                    cmd.arg("-no-pdf");
                }
            }
        }
        if let Some(j) = jobname.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg(format!("-jobname={j}"));
        }
        // Every file the engine opens, for the app's "did anything change?"
        cmd.arg("-recorder");
        crate::quiet(&mut cmd);
        let listings_before = listings_stamp(&out_dir, &out_name);
        cmd.arg(&file);
        // The paused engine runs the first pass when it can; a failure to
        // hand it the body falls back to the ordinary pass, same result.
        let warm_run = warm_engine
            .take()
            .and_then(|w| run_warm(w, src, &out_dir, &out_name, Limits::default()).ok());
        let warmed = warm_run.is_some();
        let run = match warm_run {
            Some(r) => r,
            None => run_watched(cmd, Limits::default()).map_err(|e| {
                // Uninstalled or moved since it was found: look again next time.
                forget_engine(engine);
                crate::spawn_error(engine, Some(dir), &e)
            })?,
        };

        log.push_str(&format!(
            "===== Pasada {} ({}{}) =====\n",
            i + 1,
            engine,
            if warmed { ", preámbulo ya cargado" } else { "" }
        ));
        let pass_out = strip_warm_marker(run.stdout);
        log.push_str(&pass_out);
        if !run.stderr.trim().is_empty() {
            log.push_str(&run.stderr);
        }
        log.push('\n');
        if let Some((code, why)) = run.stopped {
            // Whatever this pass was writing is half-written: the next compile
            // must not build on it.
            clean_intermediates(&out_dir, &out_name);
            log.push_str("===== Pyx: compilación detenida =====\n");
            log.push_str(&why);
            log.push('\n');
            if code != "cancelado" {
                let tail: Vec<&str> = pass_out.lines().rev().take(12).collect();
                log.push_str("\nÚltimas líneas antes de detenerlo:\n");
                for l in tail.into_iter().rev() {
                    log.push_str("  ");
                    log.push_str(l);
                    log.push('\n');
                }
            }
            stopped = Some(code);
            clean = false;
            break;
        }
        // Exit status 0 = no TeX errors at all ("clean"). A nonzero status just
        // means errors were recovered — the pass still ran to completion, so
        // reference-settling reruns are still meaningful.
        clean = run.success;
        // The first error came from reading what an EARLIER run wrote (an .aux
        // cut short, from a version of the document with different macros):
        // start over from a clean state, once.
        if !clean && !healed && aux_poisoned(&pass_out, &out_name) {
            healed = true;
            clean_intermediates(&out_dir, &out_name);
            log.push_str("===== Pyx: datos auxiliares de una compilación anterior dañados; \
                          se repite desde cero =====\n");
            continue;
        }
        // Extra passes only when TeX actually needs one: unsettled references
        // ("Rerun to get…"), or a listing whose CONTENT this pass changed —
        // including one that did not exist before it. LaTeX warns when labels
        // move but says nothing when an index does: a new section title is
        // written to the list file at \end{document}, after the stale one was
        // already typeset. Comparing the files is what lets the compiler ask
        // for ONE pass and still never show an out-of-date index. Most
        // compiles still finish in a single, fast pass.
        // Bibliography and index tools run between passes, latexmk-style, and
        // only when their input changed; new output means one more pass.
        let tools_changed = run_aux_tools(dir, &out_dir, &out_name, search_dirs, &mut log);
        let needs_rerun = tools_changed
            || pass_out.contains("Rerun to get")
            || pass_out.contains("rerun LaTeX")
            || pass_out.contains("Rerun LaTeX")
            || listings_stamp(&out_dir, &out_name) != listings_before;
        if i + 1 >= passes && !needs_rerun {
            break;
        }
        i += 1;
    }

    // Nothing is moved back: the PDF and its SyncTeX index stay in the working
    // directory, side by side, which is exactly where the `synctex` CLI expects
    // to find the index for a given PDF. The viewer opens it from there, and
    // the user's folder keeps only what the user put in it.

    // Fresh = created now, or overwritten (mtime advanced) by this run.
    let written = match (pdf_before, stamp_of(&pdf)) {
        (None, Some(_)) => true,
        (Some(before), Some(after)) => after != before,
        _ => false,
    };
    // …and COMPLETE. A truncated file is not this run's PDF: it is removed, so
    // it can neither be shown nor packed into the .pltx on the next save, and
    // the viewer keeps the last good one. The log says why, in words.
    let pdf_fresh = written && pdf_complete(&pdf);
    if written && !pdf_fresh {
        let _ = std::fs::remove_file(&pdf);
        log.push_str("===== Pyx: el PDF no se completó =====\n");
        log.push_str(&format!(
            "El motor ({engine}) se detuvo mientras escribía el PDF; se mantiene el anterior.\n"
        ));
        let missing = missing_images(&log);
        if !missing.is_empty() {
            log.push_str(&format!(
                "Imágenes que no se encuentran: {}.\n\
                 Con xelatex una imagen que falta impide generar el PDF: \
                 comprueba la ruta y la carpeta de \\graphicspath.\n",
                missing.join(", ")
            ));
        }
    }

    let inputs = if stopped.is_none() {
        Some(recorded_inputs(&out_dir, &out_name, dir, &log))
    } else {
        Some(Vec::new())
    };
    // Get the NEXT compile's preamble out of the way now, while the user reads
    // this PDF. After everything above has read this run's .log and .fls: the
    // new engine starts by truncating them.
    if warm && stopped.is_none() {
        spawn_warm(&engine_cmd, dir, &out_dir, &out_name, src, search_dirs);
    }
    Ok(CompileResult {
        ok: clean && pdf_fresh,
        pdf_path: if pdf_fresh {
            Some(pdf.to_string_lossy().to_string())
        } else {
            None
        },
        log,
        engine: engine.to_string(),
        stopped,
        inputs,
        started_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Engine runs share the process-wide RUNNING slot (cancel() reaches
    /// "the compile in flight"): tests that run an engine take turns.
    static ENGINE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn engine_turn() -> std::sync::MutexGuard<'static, ()> {
        ENGINE.lock().unwrap_or_else(|e| e.into_inner())
    }

    const MAIN: &str = r"\documentclass{book}
\begin{document}
\tableofcontents
\chapter{Uno}\label{c:1}
Ver \ref{c:1}.
\include{cap/dos.build}
\end{document}
";
    const CHILD: &str = r"\chapter{Dos}
Texto del capitulo dos.
";

    /// Compile a small multi-file project and check the CONTRACT the whole
    /// working-directory design exists for: the user's folder keeps only the
    /// user's own files, and everything the engine produces lands elsewhere.
    ///
    /// Skipped when no TeX engine is installed, so the suite still runs on a
    /// machine (or a CI runner) without a LaTeX distribution.
    #[test]
    fn build_leaves_the_project_folder_untouched() {
        let _turn = engine_turn();
        let engine = match ["pdflatex", "xelatex"].iter().find(|e| engine_works(e)) {
            Some(e) => *e,
            None => return, // no LaTeX here; nothing to assert
        };

        let base = std::env::temp_dir().join(format!("pyx-latex-test-{}", std::process::id()));
        let proj = base.join("proj");
        let work = base.join("work");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(proj.join("cap")).unwrap();
        fs::create_dir_all(work.join("cap")).unwrap();

        fs::write(work.join("main.build.tex"), MAIN).unwrap();
        fs::write(work.join("cap/dos.build.tex"), CHILD).unwrap();
        // A source file the author owns: it must still be there afterwards.
        fs::write(proj.join("notas.sty"), "% paquete del usuario\n").unwrap();

        let res = compile(
            work.join("main.build.tex").to_str().unwrap(),
            proj.to_str().unwrap(),
            engine,
            2,
            Some("main".to_string()),
            &[],
            false,
            false,
        )
        .expect("la compilacion deberia ejecutarse");

        // The PDF exists and lives in the working directory, not the project.
        let pdf = res.pdf_path.expect("deberia haberse escrito un PDF");
        assert!(
            pdf.starts_with(work.to_str().unwrap()),
            "el PDF salio del area de trabajo: {pdf}"
        );
        assert!(work.join("main.aux").exists(), "el .aux deberia estar en el area de trabajo");
        assert!(work.join("main.toc").exists(), "el .toc deberia estar en el area de trabajo");
        // The child chapter's own .aux goes to the mirrored subfolder, which is
        // what TeX Live needs to exist up front.
        assert!(work.join("cap/dos.build.aux").exists());

        // THE POINT: the project folder still holds exactly what we put in it.
        let mut left: Vec<String> = fs::read_dir(&proj)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        left.sort();
        assert_eq!(
            left,
            vec!["cap".to_string(), "notas.sty".to_string()],
            "quedaron archivos sueltos en el proyecto: {left:?}"
        );
        assert_eq!(fs::read_dir(proj.join("cap")).unwrap().flatten().count(), 0);

        let _ = fs::remove_dir_all(&base);
    }

    /// A PDF cut off mid-write (xdvipdfmx died on a missing image) is not a
    /// result; a complete one is, trailing newline or not.
    #[test]
    fn a_truncated_pdf_is_not_a_result() {
        let dir = std::env::temp_dir().join(format!("pyx-pdfcut-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let (ok, cut, empty) = (dir.join("ok.pdf"), dir.join("cut.pdf"), dir.join("empty.pdf"));
        fs::write(&ok, b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n").unwrap();
        fs::write(&cut, b"%PDF-1.7\n1 0 obj\n<< /Length 900 >>\nstream\nG\xbf\xe6}").unwrap();
        fs::write(&empty, b"").unwrap();
        assert!(pdf_complete(&ok));
        assert!(!pdf_complete(&cut));
        assert!(!pdf_complete(&empty));
        assert!(!pdf_complete(&dir.join("missing.pdf")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_images_are_named_once_in_order() {
        let log = "LaTeX Warning: File `alt1.png' not found on input line 75.\n\
                   ! Unable to load picture or PDF file 'alt1.png'.\n\
                   LaTeX Warning: File `sub dir/alt2.png' not found on input line 85.\n\
                   LaTeX Warning: File `alt1.png' not found on input line 90.\n";
        assert_eq!(missing_images(log), vec!["alt1.png", "sub dir/alt2.png"]);
        assert!(missing_images("nada que ver\n").is_empty());
    }

    fn scratch(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("pyx-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let (proj, work) = (base.join("proj"), base.join("work"));
        fs::create_dir_all(&proj).unwrap();
        fs::create_dir_all(&work).unwrap();
        (base, proj, work)
    }

    fn some_engine() -> Option<&'static str> {
        ["pdflatex", "xelatex"].into_iter().find(|e| engine_works(e))
    }

    fn passes_run(log: &str) -> usize {
        log.matches("===== Pasada ").count()
    }

    /// Run only with a `tectonic` on PATH (`cargo test -- --ignored tectonic`).
    /// The output carries the input's name and must come out as the job's,
    /// with its SyncTeX index next to it.
    #[test]
    #[ignore]
    fn tectonic_output_is_renamed_to_the_job() {
        let _turn = engine_turn();
        if resolve_engine("tectonic").is_none() {
            return;
        }
        let (base, proj, work) = scratch("tectonic");
        let main = work.join("main.build.tex");
        fs::write(&main, "\\documentclass{article}\n\\begin{document}\nHola \\ref{a}\\label{a}.\n\\end{document}\n").unwrap();
        let res = compile(main.to_str().unwrap(), proj.to_str().unwrap(), "tectonic", 1, Some("main".into()), &[], false, true)
            .expect("tectonic deberia ejecutarse");
        let pdf = res.pdf_path.expect("PDF");
        assert!(pdf.ends_with("main.pdf"), "{pdf}");
        assert!(work.join("main.synctex.gz").exists());
        assert!(!work.join("main.build.pdf").exists());
        assert!(res.inputs.is_none(), "sin lista de lecturas: la app no debe saltarse compilaciones");
        assert!(res.log.contains("Pasada 1 (tectonic)"));
        let _ = fs::remove_dir_all(&base);
    }

    /// Tectonic finds what a normal run finds through TEXINPUTS, in the same
    /// order, and writes into the working directory.
    #[test]
    fn tectonic_gets_the_same_search_path_as_a_normal_run() {
        let a = tectonic_args(
            Path::new("/w/main.build.tex"),
            Path::new("/p"),
            Path::new("/w"),
            &["/p/cap".to_string(), String::new()],
        );
        let joined = a.join(" ");
        assert!(joined.starts_with("--outdir /w --synctex --keep-logs --keep-intermediates"), "{joined}");
        assert!(joined.contains("-Z search-path=/p -Z search-path=/w -Z search-path=/p/cap /w/main.build.tex"), "{joined}");
    }

    #[test]
    fn chktex_reports_line_column_and_message() {
        if resolve_engine("chktex").is_none() {
            return;
        }
        let hits = chktex("\\documentclass{article}\n\\begin{document}\nHola ,mundo...\n\\end{document}\n").unwrap();
        assert!(hits.iter().any(|h| h.line == 3 && h.code == 26), "{:?}", hits.iter().map(|h| (h.line, h.code)).collect::<Vec<_>>());
        assert!(hits.iter().all(|h| !h.message.is_empty() && h.column >= 1));
    }

    #[test]
    fn the_body_starts_at_the_first_real_begin_document() {
        let t = "\\documentclass{article}\n% \\begin{document} in a comment\n\\usepackage{x}\n\\begin {document}\nHola\n\\end{document}\n";
        let at = body_start(t).unwrap();
        assert!(t[at..].starts_with("\\begin {document}"));
        assert_eq!(t[..at].matches('\n').count(), 3);
        // `\%` is a percent sign, not a comment.
        let t = "\\documentclass{article}\n50\\% \\begin{document}x\\end{document}";
        assert!(t[body_start(t).unwrap()..].starts_with("\\begin{document}"));
        // No class of its own (it lives in an \input'ed file): nothing to keep warm.
        assert!(body_start("\\input{preambulo}\n\\begin{document}\n\\end{document}\n").is_none());
        assert!(body_start("\\documentclass{article}\nsin cuerpo\n").is_none());
    }

    /// The whole point, end to end: the second compile is run by the engine
    /// left paused after the first, the PDF is the NEW text, SyncTeX points at
    /// the build file and its real line, and the build file is put back
    /// exactly. A changed preamble, or a changed file the preamble reads, is
    /// never served by the paused engine.
    #[test]
    fn a_paused_engine_runs_the_next_compile_and_only_when_it_may() {
        let _turn = engine_turn();
        for engine in ["pdflatex", "xelatex", "lualatex"] {
            if engine_works(engine) {
                paused_engine_case(engine);
            }
        }
    }

    /// Timing, not a check: `cargo test -- --ignored warm_benchmark --nocapture`.
    #[test]
    #[ignore]
    fn warm_benchmark() {
        let _turn = engine_turn();
        if !engine_works("xelatex") {
            return;
        }
        let (base, proj, work) = scratch("bench");
        let main = work.join("main.build.tex");
        let doc = |n: usize| {
            let mut d = String::from("\\documentclass{article}\n\\usepackage{fontspec}\n\\usepackage{amsmath,amssymb,graphicx,booktabs,xcolor,tikz,hyperref}\n\\begin{document}\n");
            for i in 0..20 {
                d.push_str(&format!("\\section{{S{i}}} Texto {n} \\begin{{tikzpicture}}\\draw (0,0)--(1,1);\\end{{tikzpicture}}\n"));
            }
            d.push_str("\\end{document}\n");
            d
        };
        for warm in [false, true] {
            fs::write(&main, doc(0)).unwrap();
            let _ = compile(main.to_str().unwrap(), proj.to_str().unwrap(), "xelatex", 1, Some("main".into()), &[], false, warm);
            let mut total = 0.0;
            for k in 1..=5 {
                std::thread::sleep(std::time::Duration::from_millis(800)); // the user typing
                fs::write(&main, doc(k)).unwrap();
                let t = std::time::Instant::now();
                let r = compile(main.to_str().unwrap(), proj.to_str().unwrap(), "xelatex", 1, Some("main".into()), &[], false, warm).unwrap();
                assert!(r.pdf_path.is_some());
                total += t.elapsed().as_secs_f64();
            }
            println!("xelatex, motor precalentado={warm}: {:.3} s por compilación", total / 5.0);
        }
        drop_warm();
        let _ = fs::remove_dir_all(&base);
    }

    /// latexmk's rules: a citation is resolved without the user knowing BibTeX
    /// exists, an index is sorted by makeindex, and neither tool runs again
    /// when nothing it reads changed.
    #[test]
    fn citations_and_indexes_are_resolved_like_latexmk_does() {
        let _turn = engine_turn();
        let Some(engine) = some_engine() else { return };
        if resolve_engine("bibtex").is_none() || resolve_engine("makeindex").is_none() {
            return;
        }
        let (base, proj, work) = scratch("bib");
        fs::write(
            proj.join("refs.bib"),
            "@book{knuth,author={Donald Knuth},title={The TeXbook},year={1984},publisher={AW}}\n",
        )
        .unwrap();
        let main = work.join("main.build.tex");
        fs::write(
            &main,
            "\\documentclass{article}\n\\usepackage{makeidx}\\makeindex\n\\begin{document}\n\
             Ver \\cite{knuth}.\\index{TeX}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\printindex\n\\end{document}\n",
        )
        .unwrap();
        let run = || {
            compile(main.to_str().unwrap(), proj.to_str().unwrap(), engine, 1, Some("main".into()), &[], false, false)
                .expect("la compilacion deberia ejecutarse")
        };
        let first = run();
        assert!(first.log.contains("===== Pyx: bibtex ====="), "{}", first.log);
        assert!(first.log.contains("===== Pyx: makeindex ====="));
        let bbl = fs::read_to_string(work.join("main.bbl")).unwrap();
        assert!(bbl.contains("TeXbook"));
        assert!(work.join("main.ind").exists());
        // Resolved in the final pass: no "undefined citations" left.
        let last = first.log.rsplit("===== Pasada ").next().unwrap();
        assert!(!last.contains("Citation `knuth' on page 1 undefined"), "{last}");

        // Nothing the tools read changed: they do not run again.
        let again = run();
        assert!(!again.log.contains("===== Pyx: bibtex ====="), "{}", again.log);
        assert!(!again.log.contains("===== Pyx: makeindex ====="));
        let _ = fs::remove_dir_all(&base);
    }

    /// The safety net under the warm engine: if what reaches it is not Pyx's
    /// go-ahead — Pyx went away (end of file), or a TeX that does not block
    /// on \read — it ends before \begin{document}, touching neither the PDF
    /// nor the .aux that are on disk.
    #[test]
    fn a_paused_engine_not_told_to_go_writes_nothing() {
        use std::io::Write;
        let _turn = engine_turn();
        let Some(engine) = some_engine() else { return };
        let (base, proj, work) = scratch("warmquit");
        let main = work.join("main.build.tex");
        fs::write(&main, "\\documentclass{article}\n\\begin{document}\nHola\\label{a}\n\\end{document}\n").unwrap();
        for line in [None, Some("otra cosa\n")] {
            compile(main.to_str().unwrap(), proj.to_str().unwrap(), engine, 1, Some("main".into()), &[], false, true)
                .expect("la compilacion deberia ejecutarse");
            let pdf = fs::read(work.join("main.pdf")).unwrap();
            let aux = fs::read(work.join("main.aux")).unwrap();
            let mut w = WARM.lock().unwrap().take().expect("motor en espera");
            if let Some(l) = line {
                let _ = w.sp.stdin.as_mut().unwrap().write_all(l.as_bytes());
            }
            drop(w.sp.stdin.take());
            let st = w.sp.child.wait().unwrap();
            for r in w.sp.readers.drain(..) {
                let _ = r.join();
            }
            let _ = st;
            assert_eq!(fs::read(work.join("main.pdf")).unwrap(), pdf, "el PDF no se toca");
            assert_eq!(fs::read(work.join("main.aux")).unwrap(), aux, "el .aux no se toca");
            clear_busy(&work, "main");
        }
        let _ = fs::remove_dir_all(&base);
    }

    fn paused_engine_case(engine: &'static str) {
        let (base, proj, work) = scratch(&format!("warm-{engine}"));
        let main = work.join("main.build.tex");
        fs::write(proj.join("mio.sty"), "\\newcommand\\marca{A}\n").unwrap();
        let doc = |pre: &str, body: &str| {
            format!("\\documentclass{{article}}\n\\usepackage{{mio}}\n{pre}\\begin{{document}}\n{body}\n\\end{{document}}\n")
        };
        let run = || {
            compile(main.to_str().unwrap(), proj.to_str().unwrap(), engine, 1, Some("main".into()), &[], false, true)
                .expect("la compilacion deberia ejecutarse")
        };
        let warmed = |log: &str| log.contains("preámbulo ya cargado");

        fs::write(&main, doc("", "Primero \\marca.")).unwrap();
        let first = run();
        assert!(!warmed(&first.log), "la primera compilacion no tiene motor en espera");
        assert!(WARM.lock().unwrap().is_some(), "tras compilar queda un motor en espera");

        // Body only: served by the paused engine.
        let body2 = doc("", "Segundo texto \\marca.\n\nOtra linea.");
        fs::write(&main, &body2).unwrap();
        let before = fs::metadata(&main).unwrap().modified().unwrap();
        let second = run();
        assert!(warmed(&second.log), "{}", second.log);
        assert!(second.pdf_path.is_some(), "{}", second.log);
        assert!(!second.log.contains(WARM_READY), "la marca interna no llega al registro");
        assert_eq!(fs::read_to_string(&main).unwrap(), body2, "el archivo de compilacion vuelve a quedar igual");
        assert_eq!(fs::metadata(&main).unwrap().modified().unwrap(), before, "…con su fecha");
        // SyncTeX: line 6 of the build file ("Otra linea.") is on page 1, and
        // the index names the build file itself, not the stub.
        if let Ok(loc) = synctex_view(main.to_str().unwrap(), 6, second.pdf_path.as_deref().unwrap()) {
            assert_eq!(loc.page, 1);
        }

        // A different preamble: the paused engine typeset the old one.
        fs::write(&main, doc("\\usepackage{amsmath}\n", "Tercero.")).unwrap();
        let third = run();
        assert!(!warmed(&third.log), "un preambulo distinto no se sirve en caliente");
        assert!(third.pdf_path.is_some());

        // A file the preamble reads changed after the engine started.
        std::thread::sleep(std::time::Duration::from_millis(2500));
        fs::write(proj.join("mio.sty"), "\\newcommand\\marca{B}\n").unwrap();
        fs::write(&main, doc("\\usepackage{amsmath}\n", "Cuarto \\marca.")).unwrap();
        let fourth = run();
        assert!(!warmed(&fourth.log), "un .sty modificado obliga a cargar el preambulo de nuevo");

        // And after that, the paused engine is used again.
        fs::write(&main, doc("\\usepackage{amsmath}\n", "Quinto \\marca.")).unwrap();
        let fifth = run();
        assert!(warmed(&fifth.log), "{}", fifth.log);

        drop_warm();
        let _ = fs::remove_dir_all(&base);
    }

    /// The compiler asks for ONE pass. That must never leave a stale table of
    /// contents — LaTeX prints no warning when the .toc changes — and it must
    /// stay ONE pass when nothing moved, which is the entire point.
    #[test]
    fn one_pass_still_settles_a_changed_table_of_contents() {
        let _turn = engine_turn();
        let Some(engine) = some_engine() else { return };
        let (base, proj, work) = scratch("toc");
        let main = work.join("main.build.tex");
        let doc = |sections: &str| {
            format!("\\documentclass{{article}}\n\\begin{{document}}\n\\tableofcontents\n{sections}\n\\end{{document}}\n")
        };
        let run = || {
            compile(main.to_str().unwrap(), proj.to_str().unwrap(), engine, 1, Some("main".into()), &[], false, false)
                .expect("la compilacion deberia ejecutarse")
        };

        fs::write(&main, doc(r"\section{Alfa}")).unwrap();
        run();
        let steady = run();
        assert_eq!(passes_run(&steady.log), 1, "sin cambios tiene que bastar una pasada");
        assert!(steady.pdf_path.is_some(), "una recompilacion identica tambien es un PDF nuevo");

        fs::write(&main, doc("\\section{Alfa}\n\\section{Beta}")).unwrap();
        let changed = run();
        assert!(passes_run(&changed.log) >= 2, "un indice que cambia exige otra pasada");
        let toc = fs::read_to_string(work.join("main.toc")).unwrap();
        assert!(toc.contains("Beta"), "el indice tiene que recoger la seccion nueva");

        let _ = fs::remove_dir_all(&base);
    }

    /// The same for a list the TEMPLATE defines. The user's report template
    /// builds each document's index with tocloft's `\newlistof{tocA}`, which
    /// writes `main.tocA` — and only `.toc/.lof/.lot` were compared, so an
    /// edit that changed only that index got a single pass and the PDF showed
    /// the previous one until compile was pressed again.
    #[test]
    fn a_template_defined_index_is_settled_too() {
        let _turn = engine_turn();
        let Some(engine) = some_engine() else { return };
        let (base, proj, work) = scratch("tocA");
        let main = work.join("main.build.tex");
        let doc = |entry: &str| {
            format!(
                "\\documentclass{{article}}\n\\usepackage{{tocloft}}\n\
                 \\newlistof{{tocA}}{{tocA}}{{Indice A}}\n\\begin{{document}}\n\
                 \\listoftocA\n\\addcontentsline{{tocA}}{{tocA}}{{{entry}}}\n\\end{{document}}\n"
            )
        };
        let run = || {
            compile(main.to_str().unwrap(), proj.to_str().unwrap(), engine, 1, Some("main".into()), &[], false, false)
                .expect("la compilacion deberia ejecutarse")
        };

        fs::write(&main, doc("Alfa")).unwrap();
        run();
        let steady = run();
        assert_eq!(passes_run(&steady.log), 1, "sin cambios tiene que bastar una pasada");

        fs::write(&main, doc("Beta")).unwrap();
        let changed = run();
        assert!(passes_run(&changed.log) >= 2, "un indice de tocloft que cambia exige otra pasada");
        let list = fs::read_to_string(work.join("main.tocA")).unwrap();
        assert!(list.contains("Beta"), "la lista tiene que recoger la entrada nueva");

        let _ = fs::remove_dir_all(&base);
    }

    /// A file beside a chapter in a subfolder resolves, and a same-named file
    /// beside the main document still wins. Images go through the same lookup
    /// (verified with real PNGs under pdflatex and xelatex); `\input` pins the
    /// ORDER without binary fixtures.
    #[test]
    fn chapter_folders_resolve_without_shadowing_the_project() {
        let _turn = engine_turn();
        let Some(engine) = some_engine() else { return };
        let (base, proj, work) = scratch("inputs");
        let cap = proj.join("cap");
        fs::create_dir_all(&cap).unwrap();
        fs::write(proj.join("datos.tex"), r"\def\origen{RAIZ}").unwrap();
        fs::write(cap.join("datos.tex"), r"\def\origen{CAPITULO}").unwrap();
        fs::write(cap.join("solo.tex"), r"\def\solo{SOLOCAPITULO}").unwrap();
        let main = work.join("main.build.tex");
        fs::write(
            &main,
            "\\documentclass{article}\n\\begin{document}\n\\input{datos}\\input{solo}\n\\typeout{ORIGEN=\\origen}\\typeout{SOLO=\\solo}\nx\n\\end{document}\n",
        )
        .unwrap();

        let res = compile(
            main.to_str().unwrap(),
            proj.to_str().unwrap(),
            engine,
            1,
            Some("main".into()),
            &[cap.to_string_lossy().to_string()],
            false,
            false,
        )
        .expect("la compilacion deberia ejecutarse");
        assert!(res.log.contains("ORIGEN=RAIZ"), "un archivo del capitulo tapo al del proyecto");
        assert!(res.log.contains("SOLO=SOLOCAPITULO"), "no se encontro el archivo junto al capitulo");

        let _ = fs::remove_dir_all(&base);
    }

    // ---- the watchdog: a TeX run can never hang the app -----------------------

    fn xelatex() -> Option<String> {
        resolve_engine("xelatex")
    }

    fn watch_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pyx-watch-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn engine_cmd(exe: &str, dir: &Path, tex: &str) -> Command {
        let mut c = Command::new(exe);
        c.current_dir(dir)
            .arg("-interaction=nonstopmode")
            .arg(format!("-output-directory={}", dir.display()))
            .arg(tex);
        crate::quiet(&mut c);
        c
    }

    /// The same error at the same line, again and again, is a loop: TeX's own
    /// "100 errors" stop never comes, because each round is a new paragraph.
    ///
    /// The paragraph must have TEXT in it (`x`): TeX resets its error count
    /// only when a real paragraph ends. With an empty `\par`, TeX Live stops by
    /// itself at 100 errors, and whether the watchdog saw 50 repeats first was
    /// a race the test lost about half the time on Linux.
    #[test]
    fn a_looping_pass_is_stopped_and_explained() {
        let _turn = engine_turn();
        let Some(exe) = xelatex() else { return };
        let d = watch_dir("loop");
        fs::write(
            d.join("t.tex"),
            "\\documentclass{article}\\begin{document}\n\\loop x\\nosuchmacro\\par \\iftrue\\repeat\n\\end{document}\n",
        )
        .unwrap();
        let t = std::time::Instant::now();
        let limits = Limits { loop_repeats: 50, stall_secs: 60, pass_secs: 120 };
        let run = run_watched(engine_cmd(&exe, &d, "t.tex"), limits).unwrap();
        let (code, why) = run.stopped.expect("the loop must be stopped");
        assert_eq!(code, "bucle", "{why}");
        assert!(why.contains("nosuchmacro"), "the explanation shows the line: {why}");
        assert!(t.elapsed().as_secs() < 30, "took {:?}", t.elapsed());
        let _ = fs::remove_dir_all(&d);
    }

    /// A loop that prints nothing at all: only the silence gives it away.
    #[test]
    fn a_silent_loop_is_stopped() {
        let _turn = engine_turn();
        let Some(exe) = xelatex() else { return };
        let d = watch_dir("stall");
        fs::write(d.join("t.tex"), "\\def\\a{\\a}\\a\n").unwrap();
        let limits = Limits { loop_repeats: 400, stall_secs: 3, pass_secs: 120 };
        let t = std::time::Instant::now();
        let run = run_watched(engine_cmd(&exe, &d, "t.tex"), limits).unwrap();
        assert_eq!(run.stopped.map(|s| s.0).as_deref(), Some("sin-progreso"));
        assert!(t.elapsed().as_secs() < 30, "took {:?}", t.elapsed());
        let _ = fs::remove_dir_all(&d);
    }

    /// "Detener compilación": the engine and its PDF driver go at once.
    #[test]
    fn a_running_compile_can_be_cancelled() {
        let _turn = engine_turn();
        let Some(exe) = xelatex() else { return };
        let d = watch_dir("cancel");
        fs::write(d.join("t.tex"), "\\def\\a{\\a}\\a\n").unwrap();
        let cmd = engine_cmd(&exe, &d, "t.tex");
        let h = std::thread::spawn(move || run_watched(cmd, Limits::default()).unwrap());
        // until the engine is registered as running
        for _ in 0..100 {
            if RUNNING.lock().unwrap().is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(cancel(), "there was a compile to cancel");
        let run = h.join().unwrap();
        assert_eq!(run.stopped.map(|s| s.0).as_deref(), Some("cancelado"));
        assert!(RUNNING.lock().unwrap().is_none());
        let _ = fs::remove_dir_all(&d);
    }

    /// The whole tree goes: xelatex AND the dvipdfmx it started — the process
    /// that was left running for 40 minutes after Pyx closed.
    #[cfg(windows)]
    #[test]
    fn cancelling_leaves_no_engine_process_behind() {
        let _turn = engine_turn();
        let Some(exe) = xelatex() else { return };
        let d = watch_dir("tree");
        // A loop that SHIPS pages: the PDF driver is up and busy.
        fs::write(
            d.join("t.tex"),
            "\\documentclass{article}\\begin{document}\n\\loop x\\newpage \\iftrue\\repeat\n\\end{document}\n",
        )
        .unwrap();
        let cmd = engine_cmd(&exe, &d, "t.tex");
        let h = std::thread::spawn(move || run_watched(cmd, Limits::default()).unwrap());
        std::thread::sleep(std::time::Duration::from_secs(4));
        let alive = |d: &Path| -> usize {
            let marker = d.file_name().unwrap().to_string_lossy().to_string();
            let mut c = Command::new("powershell");
            c.args([
                "-NoProfile",
                "-Command",
                &format!(
                    "@(Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*{marker}*' -and $_.Name -notlike 'powershell*' }}).Count"
                ),
            ]);
            crate::quiet(&mut c);
            let out = c.output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
            out.parse().unwrap_or(0)
        };
        assert!(alive(&d) >= 2, "xelatex and its PDF driver should be running");
        assert!(cancel());
        let run = h.join().unwrap();
        assert_eq!(run.stopped.map(|s| s.0).as_deref(), Some("cancelado"));
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert_eq!(alive(&d), 0, "no engine process may survive a cancel");
        let _ = fs::remove_dir_all(&d);
    }

    /// A normal document is not touched by the watchdog, and the compile
    /// reports what it read from the project (not the TeX installation).
    #[test]
    fn a_normal_compile_reports_its_project_inputs() {
        let _turn = engine_turn();
        let Some(_) = xelatex() else { return };
        let base = watch_dir("inputs");
        let proj = base.join("proj");
        let work = base.join("work");
        fs::create_dir_all(proj.join("img")).unwrap();
        fs::create_dir_all(&work).unwrap();
        fs::write(proj.join("cap.tex"), "Capitulo desde el proyecto.\n").unwrap();
        fs::write(proj.join("mio.sty"), "\\ProvidesPackage{mio}\n").unwrap();
        fs::write(
            work.join("main.build.tex"),
            "\\documentclass{article}\\usepackage{mio}\\begin{document}\n\\input{cap}\n\\end{document}\n",
        )
        .unwrap();
        let res = compile(
            work.join("main.build.tex").to_str().unwrap(),
            proj.to_str().unwrap(),
            "xelatex",
            1,
            Some("main".into()),
            &[],
            false,
            false,
        )
        .unwrap();
        assert!(res.stopped.is_none());
        assert!(res.pdf_path.is_some(), "{}", res.log);
        let names: Vec<String> = res.inputs.as_deref().unwrap_or_default().iter().map(|p| p.replace('\\', "/").to_lowercase()).collect();
        assert!(names.iter().any(|p| p.ends_with("/cap.tex")), "{names:?}");
        assert!(names.iter().any(|p| p.ends_with("/mio.sty")), "{names:?}");
        assert!(!names.iter().any(|p| p.ends_with("article.cls")), "TeX's own files are not inputs: {names:?}");
        assert!(res.started_ms > 0);
        let _ = fs::remove_dir_all(&base);
    }

    /// After a pass that never finished, its half-written state is gone before
    /// the next one starts; the PDF and the build copies survive.
    #[test]
    fn interrupted_state_is_cleaned_before_the_next_pass() {
        let d = watch_dir("clean");
        for f in ["main.aux", "main.toc", "main.synctex(busy)", "main.tocA", "main.pdf", "main.log", "main.build.tex", "cap.aux", "cap.build.tex"] {
            fs::write(d.join(f), "x").unwrap();
        }
        assert!(interrupted_before(&d, "main"));
        clean_intermediates(&d, "main");
        for gone in ["main.aux", "main.toc", "main.synctex(busy)", "main.tocA", "cap.aux"] {
            assert!(!d.join(gone).exists(), "{gone} should be gone");
        }
        for kept in ["main.pdf", "main.log", "main.build.tex", "cap.build.tex"] {
            assert!(d.join(kept).exists(), "{kept} must stay");
        }
        assert!(!interrupted_before(&d, "main"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn an_error_from_a_stale_aux_is_recognised() {
        let log = "(./main.aux\n! Undefined control sequence.\nl.3 \\foo\n";
        assert!(aux_poisoned(log, "main"));
        let log = "(./main.aux) (./cap.tex\n! Undefined control sequence.\nl.3 \\foo\n";
        assert!(!aux_poisoned(log, "main"), "the aux was closed before the error");
    }
}
