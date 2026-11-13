//! LaTeX compilation and toolchain detection.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Serialize)]
pub struct CompileResult {
    pub ok: bool,
    /// The engine's own PDF (`<job>.pdf` in the working directory), set only
    /// when THIS run wrote it. Its SyncTeX index sits beside it, and it is the
    /// viewer's identity for the document (annotations are keyed by it). The
    /// bytes the viewer shows come from `pdf.path`, an immutable copy.
    pub pdf_path: Option<String>,
    pub log: String,
    pub engine: String,
    /// Why the engine was stopped before it finished, if it was: "cancelado"
    /// (the user), "bucle", "sin-progreso", "tiempo", "sustituida" (a newer
    /// request for the same document arrived while this one waited). None for
    /// a run that ended on its own.
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
    /// The request's number, as the app gave it (0 when it gave none).
    pub gen: u64,
    /// "pdf" (a new PDF was written), "sin-pdf" (the engine ran and wrote
    /// none), "detenido" (stopped by the user, the watchdog or a newer
    /// request) or "error" (the engine could not be run at all).
    pub outcome: String,
    /// Why there is no new PDF, in words the user can act on. NEVER empty
    /// unless `outcome` is "pdf": a compile ends in a PDF or in a reason.
    pub reason: String,
    /// The immutable copy of the PDF this run wrote: what the viewer reads.
    pub pdf: Option<PdfInfo>,
    /// Where the time went.
    pub timings: Timings,
}

/// The copy of a compiled PDF kept for the viewers (see "A PDF nobody is
/// writing" below).
#[derive(Serialize, Clone)]
pub struct PdfInfo {
    pub path: String,
    pub size: u64,
    pub mtime: u64,
}

/// Where a compile's time went, in milliseconds.
#[derive(Serialize, Default, Clone)]
pub struct Timings {
    /// Waiting for another compile to finish.
    pub wait_ms: u64,
    /// Before the first pass: folders, stale copies, the paused engine.
    pub prep_ms: u64,
    /// Each engine pass.
    pub passes_ms: Vec<u64>,
    /// BibTeX, Biber, makeindex.
    pub tools_ms: u64,
    /// After the last pass: checking the PDF, copying it, listing the inputs.
    pub finish_ms: u64,
    pub total_ms: u64,
    /// The first pass was run by the engine left paused after its preamble.
    pub warm: bool,
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

// ---------------------------------------------------------------------------
// One compile at a time, numbered
// ---------------------------------------------------------------------------
//
// The app already runs one compile at a time and folds the requests that
// arrive meanwhile into a single follow-up. This is the same rule enforced
// HERE, where it cannot be got wrong: the engine, the paused engine and the
// working directory are shared state, and two runs writing the same `.aux`
// produce a damaged one.
//
// Every request takes a number. A request that waited behind another and
// finds that a NEWER one for the same working directory arrived meanwhile
// does not run: the newer one reads the same files and its PDF is the one
// anybody wants.
//
// The numbers are also what makes "Detener" reliable. Stopping used to mean
// killing whatever engine process was registered at that instant — and
// between two passes, or while BibTeX ran, none was: the stop was lost and
// the compile went on. Now a stop marks every request up to the current
// number, and the compile checks the mark before each pass and each tool.

/// Held for the whole of a compile.
static COMPILE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
/// The number of the last request that arrived.
static COMPILE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Every request numbered up to this was asked to stop.
static CANCEL_UPTO: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// The request in flight (0: none).
static IN_FLIGHT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Working directory -> number of the newest request for it.
static NEWEST: std::sync::Mutex<Option<std::collections::HashMap<String, u64>>> = std::sync::Mutex::new(None);

thread_local! {
    /// The request this thread is running (0 outside a compile): how the
    /// watchdog of a pass or a tool knows which stop requests are for it.
    static THIS_SEQ: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn stop_asked(seq: u64) -> bool {
    seq != 0 && CANCEL_UPTO.load(std::sync::atomic::Ordering::SeqCst) >= seq
}

/// Stop the compile in flight (the engine and everything it started) and any
/// request waiting behind it. True when there was something to stop.
pub fn cancel() -> bool {
    use std::sync::atomic::Ordering;
    CANCEL_UPTO.store(COMPILE_SEQ.load(Ordering::SeqCst), Ordering::SeqCst);
    let cur = RUNNING.lock().ok().and_then(|g| g.clone());
    if let Some(r) = cur.as_ref() {
        r.cancel.store(true, Ordering::SeqCst);
        kill_tree(r);
    }
    cur.is_some() || IN_FLIGHT.load(Ordering::SeqCst) != 0
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
    join_readers(&mut sp.readers, &sp.running);
}

/// Wait for the threads draining the engine's output — but never forever.
///
/// They end when the pipes close, and the pipes close when the LAST process
/// holding them exits. That is normally the engine itself. But anything the
/// engine started inherits them: a shell-escape command left running, MiKTeX's
/// package installer, a PDF driver that outlived its parent. A bare `join`
/// then waited on a process nobody was watching, with the compile already
/// over — "Compilando…" for ever, every later compile queued behind it.
///
/// So: a moment for the pipes to close on their own, then the whole tree is
/// killed (the engine has exited; whatever is left is a leftover), and a
/// reader that STILL has not ended is left to finish by itself.
fn join_readers(readers: &mut Vec<std::thread::JoinHandle<()>>, running: &Running) {
    use std::time::{Duration, Instant};
    let wait_until = |deadline: Instant, readers: &Vec<std::thread::JoinHandle<()>>| {
        while Instant::now() < deadline {
            if readers.iter().all(|r| r.is_finished()) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        readers.iter().all(|r| r.is_finished())
    };
    if !wait_until(Instant::now() + Duration::from_millis(500), readers) {
        kill_tree(running);
        wait_until(Instant::now() + Duration::from_secs(2), readers);
    }
    for r in readers.drain(..) {
        if r.is_finished() {
            let _ = r.join();
        }
        // else: detached — it ends when its pipe finally closes.
    }
}

/// Wait for a spawned engine to finish; never longer than the watchdog allows.
///
/// `track` registers the run as "the compile in flight", the one `cancel()`
/// kills. A helper run that is not part of a compile (ChkTeX, on every typing
/// pause) must not: it used to overwrite the slot while an engine was running,
/// and "Detener" then killed the linter and left the engine alone.
fn wait_watched(mut sp: Spawned, limits: Limits, track: bool) -> Result<Watched, std::io::Error> {
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    drop(sp.stdin.take());
    let running = sp.running.clone();
    let seq = if track { THIS_SEQ.with(|c| c.get()) } else { 0 };
    if track {
        if let Ok(mut g) = RUNNING.lock() {
            *g = Some(running.clone());
        }
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
            if running.cancel.load(Ordering::SeqCst) || stop_asked(seq) {
                stopped = Some(("cancelado".into(), "Compilación detenida por el usuario.".into()));
            }
            break Some(st);
        }
        if running.cancel.load(Ordering::SeqCst) || stop_asked(seq) {
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
                         infinito (una macro que se llama a sí misma, un paquete atascado) \
                         o el instalador de paquetes de MiKTeX esperando una respuesta. \
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
        // The time between the engine exiting and the PDF being shown includes
        // this sleep, on every pass: 5 ms (a check costs microseconds).
        std::thread::sleep(Duration::from_millis(5));
    };
    // The readers end when the pipes close — see join_readers for when they
    // do not.
    join_readers(&mut sp.readers, &running);
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
    wait_watched(spawn_watched(cmd, false)?, limits, true)
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
    // nomencl and the glossaries' symbol list: makeindex inputs and outputs
    // like the ones above. Left out, each compile of a document with a
    // nomenclature ran a second full pass for nothing.
    "nlo", "nls", "nlg", "slo", "sls", "slg",
    "bcf", "run.xml", "bbl", "blg", "pyxtools",
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
                || ext.ends_with(".pdf")
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
            let name = e.file_name().to_string_lossy().to_string();
            if ft.is_dir() {
                // Pyx's own folders (the paused engine's stub, the viewers'
                // copies of the PDF) are not the engine's state.
                if depth > 0 && !name.starts_with("_pyx") {
                    walk(&p, job_prefix, depth - 1);
                }
                continue;
            }
            let lower = name.to_lowercase();
            let doomed = if let Some(ext) = name.strip_prefix(job_prefix) {
                let ext = ext.to_lowercase();
                !(ext.ends_with("pdf") || ext == "log" || ext.ends_with("tex"))
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

// ---------------------------------------------------------------------------
// Writing the PDF faster (xelatex)
// ---------------------------------------------------------------------------
//
// xelatex hands its pages to xdvipdfmx, which by default recompresses every
// stream at zlib's level 9. Measured on a real 18-page report with eight PDF
// figures (three runs each, quiet machine): 17.3 s per pass at the default,
// 13.5 s at level 1 — against 12.9 s with no PDF at all — for a file 3 %
// larger (12.3 MB instead of 11.9). Nearly all of what level 9 buys is spent
// recompressing figures that are already compressed.
//
// The driver is named in full, with the two options xelatex itself gives it
// (`-q`: quiet; `-E`: embed fonts whatever their licence flags say), so the
// only thing that changes is the level. Configuración → Compilación can ask
// for the smallest file instead.
static FAST_PDF: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Choose between a faster pass (true, the default) and the smallest PDF.
pub fn set_fast_pdf(on: bool) {
    FAST_PDF.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// The `-output-driver` argument for this engine, if it takes one.
fn pdf_driver_arg(engine_cmd: &str) -> Option<&'static str> {
    let name = Path::new(engine_cmd).file_stem().and_then(|s| s.to_str()).unwrap_or(engine_cmd).to_ascii_lowercase();
    (name == "xelatex" && FAST_PDF.load(std::sync::atomic::Ordering::Relaxed))
        .then_some("-output-driver=xdvipdfmx -q -E -z 1")
}

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
    /// The job's list files as the last pass left them, read BEFORE this
    /// engine started. A preamble that opens one for writing (`\makeindex`,
    /// nomencl, glossaries) empties it at once; comparing "before the pass"
    /// against that emptied file made every warm compile of such a document
    /// look like its lists had changed, and run a second pass.
    listings: Vec<(String, Vec<u8>)>,
    sp: Spawned,
}

/// Documents whose paused engine gave a different result than a fresh one
/// (by `warm_key`): they compile the ordinary way for the rest of the session.
static WARM_OFF: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn warm_off(key: &str) -> bool {
    WARM_OFF.lock().map(|v| v.iter().any(|k| k == key)).unwrap_or(false)
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
/// the body from the build file itself (`body_ref`, see `warm_body_ref`).
///
/// Anything else (end of file because Pyx went away, an empty line, a TeX
/// that does not block on `\read` at all) ends the job right there, before
/// `\begin{document}`: no page, no .aux, and the PDF on disk is not touched.
fn warm_tail(body_ref: &str) -> String {
    format!(
        "\n\\def\\pyxwarmok{{{WARM_GO} }}\
         \\def\\pyxwarmbody{{\\csname @@input\\endcsname\"{body_ref}\"\\relax}}\
         \\def\\pyxwarmquit{{\\csname @@end\\endcsname}}\n\
         \\immediate\\write16{{{WARM_READY}}}\\scrollmode\\read-1 to\\pyxwarmgo\\nonstopmode\
         \\ifx\\pyxwarmgo\\pyxwarmok\\expandafter\\pyxwarmbody\\else\\expandafter\\pyxwarmquit\\fi\n"
    )
}

/// How the stub names the build file whose body it reads.
///
/// By its FULL path whenever TeX can take it verbatim. The bare name is looked
/// up through TEXINPUTS, where the project folder comes first — and versions
/// of Pyx before the working directory existed wrote their build copies right
/// there. With one of those left behind, the paused engine read THAT file:
/// the first compile after starting Pyx (which is handed the full path) showed
/// the new text and every later one went back to the old, whatever was typed.
/// "Restarting fixes it, once."
///
/// A path with characters TeX would expand or read as a comment falls back to
/// the name; `remove_shadowing_copies` is what keeps that case right.
fn warm_body_ref(build: &Path) -> Option<String> {
    let name = build.file_name()?.to_string_lossy().to_string();
    if name.contains('"') {
        return None; // would end the file name; such a file never warms
    }
    let abs = build.to_string_lossy().replace('\\', "/");
    let plain = |c: char| c.is_ascii_alphanumeric() || " /:._-()+,=@!".contains(c);
    Some(if build.is_absolute() && abs.chars().all(plain) { abs } else { name })
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
/// `\begin{document}`). Distribution files are left out, like in
/// `recorded_inputs` — and so is the engine's own scratch in the working
/// directory, but NOT the build copies there: a preamble kept in a file of its
/// own that Pyx processes (it has a `\py{}`) is read from its `.build.tex`,
/// and leaving the whole directory out meant an edit to it never retired the
/// paused engine. The PDF came out with the old preamble, and the next
/// background compile then saw nothing left to do.
fn preamble_inputs(out_dir: &Path, job: &str, run_dir: &Path, build: &Path) -> Vec<PathBuf> {
    let Ok(fls) = std::fs::read_to_string(out_dir.join(format!("{job}.fls"))) else {
        return Vec::new();
    };
    let aux = format!("{job}.aux").to_lowercase();
    let out_norm = out_dir.to_string_lossy().replace('/', "\\").to_lowercase();
    let warm_norm = format!("{}\\{}\\", out_norm.trim_end_matches('\\'), WARM_DIR.to_lowercase());
    let build_norm = build.to_string_lossy().replace('/', "\\").to_lowercase();
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
        // In the working directory only the build copies count; the root one
        // (and its stub) is compared by its text, not by its stamp.
        let scratch = k.starts_with(&out_norm)
            && (!k.ends_with(".tex") || k == build_norm || k.starts_with(&warm_norm));
        if installed_file(&k) || scratch || out.contains(&abs) {
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
    let key = warm_key(engine_cmd, dir, out_dir, job, search_dirs);
    if warm_off(&key) {
        return;
    }
    let Ok(text) = std::fs::read_to_string(build) else { return };
    let Some(at) = body_start(&text) else { return };
    let Some(name) = build.file_name().map(|n| n.to_string_lossy().to_string()) else { return };
    let Some(body_ref) = warm_body_ref(build) else { return };
    let preamble = text[..at].to_string();
    let stub_dir = out_dir.join(WARM_DIR);
    if std::fs::create_dir_all(&stub_dir).is_err() {
        return;
    }
    // Same NAME as the build file (in its own folder): an error in the
    // preamble is reported against the file the log parser already knows.
    let stub = stub_dir.join(&name);
    if std::fs::write(&stub, format!("{preamble}{}", warm_tail(&body_ref))).is_err() {
        return;
    }
    // Read before the engine starts: its preamble may empty some of them.
    let listings = listings_stamp(out_dir, job);
    // Stamped BEFORE the engine reads them: a change at any moment after this
    // shows up as a different stamp.
    let deps = preamble_inputs(out_dir, job, dir, build)
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
        .env("TEXINPUTS", texinputs(out_dir, search_dirs));
    // The same PDF driver a normal pass uses: this engine writes the PDF too.
    if let Some(driver) = pdf_driver_arg(engine_cmd) {
        cmd.arg(driver);
    }
    cmd.arg(&stub);
    crate::quiet(&mut cmd);
    let Ok(sp) = spawn_watched(cmd, true) else { return };
    let id = WARM_IDS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let w = Warm {
        id,
        key,
        preamble,
        born: std::time::SystemTime::now(),
        deps,
        listings,
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
    wait_watched(w.sp, limits, true).map_err(|_| ())
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

/// After a pass: run BibTeX / Biber / makeindex / the glossaries when their input changed.
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

    // glossaries: each list LaTeX wrote (.glo main, .acn acronyms, .slo
    // symbols…) is sorted with makeindex and the style the package wrote
    // (<job>.ist) — what makeglossaries does, without needing Perl. A
    // document set up for xindy (no .ist) goes to makeglossaries itself.
    let ist = out_dir.join(format!("{job}.ist"));
    for (input, output, logx) in [("glo", "gls", "glg"), ("acn", "acr", "alg"), ("slo", "sls", "slg"), ("nlo", "nls", "nlg")] {
        let path = out_dir.join(format!("{job}.{input}"));
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let key = format!("glossary-{input}");
        let fp = fingerprint(&text);
        if fp != old_of(&key) || out_of(output).is_none() {
            let before = out_of(output);
            let ran = if ist.exists() {
                let args = vec![
                    "-s".to_string(), format!("{job}.ist"),
                    "-t".to_string(), format!("{job}.{logx}"),
                    "-o".to_string(), format!("{job}.{output}"),
                    format!("{job}.{input}"),
                ];
                run_tool("makeindex", &args, out_dir, &[], log)
            } else {
                run_tool("makeglossaries", &[job.to_string()], out_dir, &[], log)
            };
            if ran.is_some() {
                rerun |= out_of(output) != before;
            }
        }
        new_lines.push(format!("{key}={fp}"));
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
    // Not "the compile in flight": see wait_watched.
    let run = spawn_watched(c, false)
        .and_then(|sp| wait_watched(sp, Limits { loop_repeats: u32::MAX, stall_secs: 10, pass_secs: 20 }, false));
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

#[allow(clippy::too_many_arguments)]
fn compile_tectonic(
    exe: &str,
    src: &Path,
    dir: &Path,
    out_dir: &Path,
    job: &str,
    search_dirs: &[String],
    clean_first: bool,
    mut park: ParkedPdf,
    mut log: String,
    mut timings: Timings,
    t_prep: std::time::Instant,
) -> Result<CompileResult, String> {
    drop_warm();
    if clean_first || interrupted_before(out_dir, job) {
        clean_intermediates(out_dir, job);
    }
    let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| job.to_string());
    let pdf = out_dir.join(format!("{job}.pdf"));
    let started_ms = now_ms();
    timings.prep_ms = t_prep.elapsed().as_millis() as u64;

    let mut cmd = Command::new(exe);
    cmd.current_dir(dir).args(tectonic_args(src, dir, out_dir, search_dirs));
    crate::quiet(&mut cmd);
    // The first compile may download packages for a while, quietly.
    let limits = Limits { loop_repeats: 400, stall_secs: 600, pass_secs: 20 * 60 };
    let t_pass = std::time::Instant::now();
    let run = run_watched(cmd, limits).map_err(|e| {
        forget_engine("tectonic");
        crate::spawn_error("tectonic", Some(dir), &e)
    })?;
    timings.passes_ms.push(t_pass.elapsed().as_millis() as u64);
    let t_fin = std::time::Instant::now();

    // Its outputs carry the INPUT's name: give them the job's.
    if stem != job {
        for ext in ["pdf", "synctex.gz", "log", "aux", "toc", "out"] {
            let from = out_dir.join(format!("{stem}.{ext}"));
            if from.exists() {
                let _ = std::fs::rename(&from, out_dir.join(format!("{job}.{ext}")));
            }
        }
    }
    log.push_str("===== Pasada 1 (tectonic) =====\n");
    // The TeX log is what the Problems view reads; Tectonic's own notes go
    // after it.
    let mut pass_out = String::new();
    if let Ok(tex_log) = std::fs::read_to_string(out_dir.join(format!("{job}.log"))) {
        pass_out.push_str(&tex_log);
        pass_out.push('\n');
    }
    pass_out.push_str(&run.stdout);
    pass_out.push_str(&run.stderr);
    pass_out.push('\n');
    log.push_str(&pass_out);
    let mut stopped = None;
    let mut stop_why = String::new();
    if let Some((code, why)) = run.stopped {
        clean_intermediates(out_dir, job);
        log.push_str("===== Pyx: compilación detenida =====\n");
        log.push_str(&why);
        log.push('\n');
        stop_why = why;
        stopped = Some(code);
    }
    let (pdf_fresh, info) = settle_pdf(&mut park, out_dir, job, "tectonic", &mut log);
    let (outcome, reason) = outcome_of(pdf_fresh, stopped.as_deref(), &stop_why, &pass_out, &log, "tectonic");
    timings.finish_ms = t_fin.elapsed().as_millis() as u64;
    Ok(CompileResult {
        ok: run.success && stopped.is_none() && pdf_fresh,
        pdf_path: pdf_fresh.then(|| pdf.to_string_lossy().to_string()),
        log,
        engine: "tectonic".into(),
        stopped,
        inputs: None,
        started_ms,
        gen: 0,
        outcome,
        reason,
        pdf: info,
        timings,
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

/// When each project's layout was last mirrored (by "project\nworking dir").
static MIRRORED: std::sync::Mutex<Option<std::collections::HashMap<String, std::time::Instant>>> =
    std::sync::Mutex::new(None);

/// `mirror_subdirs`, without walking three levels of the project on EVERY
/// compile — which is what it cost, including the compiles a typing pause
/// fires, and on a project with a few thousand folders that walk was longer
/// than the engine's own pass.
///
/// The folders of the files the document actually pulls in (`search_dirs`)
/// are created every time: they are few and they are the ones `\include`
/// needs. The rest of the layout (a folder a package writes into) is walked
/// once a minute at most, and always for a compile from scratch.
fn mirror_project_dirs(dir: &Path, out_dir: &Path, search_dirs: &[String], force: bool) {
    for d in search_dirs.iter().filter(|d| !d.is_empty()) {
        if let Ok(rel) = Path::new(d).strip_prefix(dir) {
            if !rel.as_os_str().is_empty() {
                let _ = std::fs::create_dir_all(out_dir.join(rel));
            }
        }
    }
    let key = format!("{}\n{}", dir.display(), out_dir.display());
    let recent = MIRRORED
        .lock()
        .ok()
        .and_then(|g| g.as_ref().and_then(|m| m.get(&key).copied()))
        .map(|t| t.elapsed() < std::time::Duration::from_secs(60))
        .unwrap_or(false);
    if recent && !force {
        return;
    }
    mirror_subdirs(dir, out_dir, 3);
    if let Ok(mut g) = MIRRORED.lock() {
        g.get_or_insert_with(Default::default).insert(key, std::time::Instant::now());
    }
}

// ---------------------------------------------------------------------------
// Build copies in the project folder: never what gets compiled
// ---------------------------------------------------------------------------

/// Delete every file of the PROJECT that would be read instead of a build copy
/// of the working directory.
///
/// A parent pulls its processed chapters in by their path inside the working
/// directory (`\input{cap/uno.build.tex}`), which the engine resolves through
/// TEXINPUTS — and the project folder is searched first there, on purpose, so
/// the author's own files always win. Versions of Pyx from before the working
/// directory existed wrote those very copies INTO the project. One left
/// behind is found first, and the engine typesets its old text on every
/// compile, whatever is typed: "nothing I change reaches the PDF".
///
/// Only names that exist as a build copy in the working directory right now
/// are touched, and such a name (`*.build.tex`) is one Pyx generates.
/// Returns (removed, could not be removed).
fn remove_shadowing_copies(dir: &Path, out_dir: &Path) -> (Vec<String>, Vec<String>) {
    let (mut removed, mut stuck) = (Vec::new(), Vec::new());
    let canon = |p: &Path| std::fs::canonicalize(p).ok();
    // A project that IS its working directory (a bare engine run on a folder):
    // the "shadow" would be the build copy itself.
    if canon(dir).is_some() && canon(dir) == canon(out_dir) {
        return (removed, stuck);
    }
    for (rel, abs) in crate::workspace::walk(out_dir) {
        if !rel.to_ascii_lowercase().ends_with(".build.tex") || rel.starts_with("_pyx") {
            continue;
        }
        let shadow = dir.join(&rel);
        if !shadow.is_file() || canon(&shadow) == canon(&abs) {
            continue;
        }
        match std::fs::remove_file(&shadow) {
            Ok(()) => removed.push(shadow.to_string_lossy().to_string()),
            Err(_) => stuck.push(shadow.to_string_lossy().to_string()),
        }
    }
    (removed, stuck)
}

/// Build copies the engine read from OUTSIDE the working directory, from its
/// recorder list: the check that the rule above held, whatever the search
/// path was (a `TEXINPUTS` of the user's own comes even before the project).
fn foreign_build_copies(out_dir: &Path, job: &str, run_dir: &Path) -> Vec<String> {
    let Ok(fls) = std::fs::read_to_string(out_dir.join(format!("{job}.fls"))) else {
        return Vec::new();
    };
    let out_norm = out_dir.to_string_lossy().replace('/', "\\").to_lowercase();
    let mut pwd = run_dir.to_path_buf();
    let mut out: Vec<String> = Vec::new();
    for l in fls.lines() {
        if let Some(d) = l.strip_prefix("PWD ") {
            pwd = PathBuf::from(d.trim());
        } else if let Some(f) = l.strip_prefix("INPUT ") {
            let f = f.trim().trim_matches('"');
            if !f.to_ascii_lowercase().ends_with(".build.tex") {
                continue;
            }
            let p = Path::new(f);
            let abs = if p.is_absolute() { p.to_path_buf() } else { pwd.join(p) };
            let s = abs.to_string_lossy().to_string();
            if !s.replace('/', "\\").to_lowercase().starts_with(&out_norm) && !out.contains(&s) {
                out.push(s);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// A PDF nobody is writing
// ---------------------------------------------------------------------------
//
// TeXstudio's rule, and the reason it never says "done" over an old PDF: the
// compile produced a PDF, or it says why not.
//
// Two things broke that here.
//
// The engine writes `<job>.pdf` in place. If another program holds that file
// open — and Pyx's own "open in the external application" handed exactly that
// file to Acrobat, which locks what it shows — the engine cannot write it,
// says so in a line of a log nobody reads, and the compile ended as "done"
// with the PDF of an hour ago. So the previous PDF is MOVED out of the way
// before the engine starts: a move that fails is a locked file, known and
// reported before any time is spent compiling, and a PDF that exists
// afterwards was written by this run, whatever its timestamp says.
//
// And the viewer read `<job>.pdf` while the NEXT compile could already be
// writing it. So every good PDF is copied, once, to a file that is never
// written again; the viewers (the pane, the detached window, the external
// application) read the copy.

/// Folder of the working directory that holds the viewers' copies.
pub(crate) const VIEW_DIR: &str = "_pyxview";

/// Job PDF (normalised path) -> its newest copy.
static VIEW_COPY: std::sync::Mutex<Option<std::collections::HashMap<String, PathBuf>>> = std::sync::Mutex::new(None);
/// Job PDF (normalised path) -> the copy an external application was given.
static EXTERNAL_COPY: std::sync::Mutex<Option<std::collections::HashMap<String, PathBuf>>> =
    std::sync::Mutex::new(None);
static COPY_IDS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn pdf_key(pdf: &Path) -> String {
    pdf.to_string_lossy().replace('/', "\\").to_lowercase()
}

fn parked_path(pdf: &Path) -> Option<PathBuf> {
    let stem = pdf.file_stem()?.to_string_lossy().to_string();
    Some(pdf.parent()?.join(VIEW_DIR).join(format!("{stem}.anterior.pdf")))
}

/// The previous PDF, moved aside for the length of a compile. Dropped without
/// `keep_new`, it goes back where it was: on every way out of a compile the
/// document still has the last PDF that was good.
struct ParkedPdf {
    pdf: PathBuf,
    parked: PathBuf,
    settled: bool,
}

impl ParkedPdf {
    /// Err: the PDF could not be moved — some other program has it open.
    fn park(pdf: &Path) -> Result<ParkedPdf, String> {
        let parked = parked_path(pdf).ok_or("El PDF no tiene carpeta contenedora")?;
        if let Some(d) = parked.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        // A compile that died after parking (Pyx was killed mid-compile): the
        // last good PDF is still the parked one.
        if !pdf.exists() && parked.exists() {
            let _ = std::fs::rename(&parked, pdf);
        }
        if pdf.exists() {
            let _ = std::fs::remove_file(&parked);
            if let Err(e) = std::fs::rename(pdf, &parked) {
                return Err(format!(
                    "El PDF anterior no se puede sustituir ({e}): lo tiene abierto otro programa \
                     (un lector de PDF, un antivirus, una copia en la nube). Ciérralo y vuelve a \
                     compilar.\n{}",
                    pdf.display()
                ));
            }
        }
        Ok(ParkedPdf { pdf: pdf.to_path_buf(), parked, settled: false })
    }
    /// This run wrote a good PDF: the previous one is no longer needed.
    fn keep_new(&mut self) {
        let _ = std::fs::remove_file(&self.parked);
        self.settled = true;
    }
}

impl Drop for ParkedPdf {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        // Whatever this run left (nothing, or a file cut short) goes; the
        // previous PDF comes back.
        if self.parked.exists() {
            let _ = std::fs::remove_file(&self.pdf);
            let _ = std::fs::rename(&self.parked, &self.pdf);
        }
    }
}

/// Copy a finished PDF to a file that is never written again, and forget the
/// older copies. None when it could not be copied (the viewer then reads the
/// job's PDF itself, as it always did).
fn snapshot_pdf(pdf: &Path, out_dir: &Path, job: &str) -> Option<PdfInfo> {
    let dir = out_dir.join(VIEW_DIR);
    std::fs::create_dir_all(&dir).ok()?;
    let id = COPY_IDS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let name = format!("{job}.{:013}-{id}.pdf", now_ms());
    let dest = dir.join(&name);
    let tmp = dir.join(format!("{name}.tmp"));
    if std::fs::copy(pdf, &tmp).is_err() || std::fs::rename(&tmp, &dest).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return None;
    }
    let meta = std::fs::metadata(&dest).ok()?;
    if let Ok(mut g) = VIEW_COPY.lock() {
        g.get_or_insert_with(Default::default).insert(pdf_key(pdf), dest.clone());
    }
    // Keep this one and the one before it (a viewer may still be reading it);
    // a copy that cannot be deleted is one somebody has open — next time.
    let prefix = format!("{job}.");
    let mut old: Vec<String> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| {
            n.strip_prefix(&prefix)
                .and_then(|r| r.strip_suffix(".pdf"))
                .map(|mid| mid.len() > 13 && mid.as_bytes()[..13].iter().all(|b| b.is_ascii_digit()))
                .unwrap_or(false)
        })
        .collect();
    old.sort();
    for n in old.iter().rev().skip(2) {
        let _ = std::fs::remove_file(dir.join(n));
    }
    // An external application was given a copy of this PDF: bring it up to
    // date (a reader that reloads by itself then follows the compiles).
    let ext = EXTERNAL_COPY.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(&pdf_key(pdf)).cloned()));
    if let Some(ext) = ext {
        let _ = std::fs::copy(&dest, &ext);
    }
    Some(PdfInfo {
        path: dest.to_string_lossy().to_string(),
        size: meta.len(),
        mtime: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    })
}

/// The file a viewer should READ for `pdf` (a job's PDF): its newest copy when
/// there is one, else the PDF itself — and, while a compile has it moved
/// aside, the moved file.
pub fn pdf_source(pdf: &str) -> PathBuf {
    let p = Path::new(pdf);
    let copy = VIEW_COPY.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(&pdf_key(p)).cloned()));
    if let Some(c) = copy.filter(|c| c.exists()) {
        return c;
    }
    if !p.exists() {
        if let Some(parked) = parked_path(p).filter(|q| q.exists()) {
            return parked;
        }
    }
    p.to_path_buf()
}

/// A copy of `pdf` for an external application to open — never the engine's
/// own file, which a reader that locks what it shows (Acrobat) would make
/// impossible to compile again. The copy is refreshed after every compile.
pub fn external_pdf(pdf: &str) -> Result<String, String> {
    let p = Path::new(pdf);
    let src = pdf_source(pdf);
    // Only a job's PDF (one inside a working directory) is copied; any other
    // PDF — one opened from the file tree — is the user's own file.
    let Some(parent) = p.parent().filter(|d| crate::workspace::in_cache(d)) else {
        return Ok(pdf.to_string());
    };
    let dir = parent.join(VIEW_DIR).join("ext");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "documento.pdf".into());
    let stem = name.strip_suffix(".pdf").unwrap_or(&name).to_string();
    // The usual name; if a reader has THAT one locked from an earlier time, a
    // numbered one.
    for k in 0..20 {
        let dest = dir.join(if k == 0 { format!("{stem}.pdf") } else { format!("{stem} ({k}).pdf") });
        if std::fs::copy(&src, &dest).is_ok() {
            if let Ok(mut g) = EXTERNAL_COPY.lock() {
                g.get_or_insert_with(Default::default).insert(pdf_key(p), dest.clone());
            }
            return Ok(dest.to_string_lossy().to_string());
        }
    }
    Err("No se pudo preparar una copia del PDF para la aplicación externa.".into())
}

/// After the last pass: is there a new, complete PDF? If so the previous one
/// goes and the viewers get their copy; if not, the previous one comes back.
fn settle_pdf(
    park: &mut ParkedPdf,
    out_dir: &Path,
    job: &str,
    engine: &str,
    log: &mut String,
) -> (bool, Option<PdfInfo>) {
    let pdf = park.pdf.clone();
    let written = pdf.exists();
    // …and COMPLETE. A truncated file is not this run's PDF: it is removed, so
    // it can neither be shown nor packed into the .pltx on the next save, and
    // the viewer keeps the last good one. The log says why, in words.
    let fresh = written && pdf_complete(&pdf);
    if written && !fresh {
        let _ = std::fs::remove_file(&pdf);
        log.push_str("===== Pyx: el PDF no se completó =====\n");
        log.push_str(&format!(
            "El motor ({engine}) se detuvo mientras escribía el PDF; se mantiene el anterior.\n"
        ));
        let missing = missing_images(log);
        if !missing.is_empty() {
            log.push_str(&format!(
                "Imágenes que no se encuentran: {}.\n\
                 Con xelatex una imagen que falta impide generar el PDF: \
                 comprueba la ruta y la carpeta de \\graphicspath.\n",
                missing.join(", ")
            ));
        }
    }
    if !fresh {
        return (false, None); // `park` puts the previous PDF back when dropped
    }
    park.keep_new();
    (true, snapshot_pdf(&pdf, out_dir, job))
}

/// The first error TeX reported in `log`, with its line: "Undefined control
/// sequence (línea 42)".
fn first_tex_error(log: &str) -> Option<String> {
    let mut lines = log.lines();
    while let Some(l) = lines.next() {
        let Some(msg) = l.strip_prefix("! ") else { continue };
        let msg = msg.trim().trim_end_matches('.').to_string();
        let at = lines
            .by_ref()
            .take(12)
            .find_map(|c| c.strip_prefix("l.").and_then(|r| r.split_whitespace().next().map(str::to_string)))
            .filter(|n| n.chars().all(|c| c.is_ascii_digit()) && !n.is_empty());
        return Some(match at {
            Some(n) => format!("{msg} (línea {n})"),
            None => msg,
        });
    }
    None
}

/// Why a run that ended on its own left no PDF, from what its last pass said.
fn no_pdf_reason(pass_out: &str, engine: &str) -> String {
    let err = first_tex_error(pass_out);
    let with_err = |head: &str| match err.as_ref() {
        Some(e) => format!("{head} Primer error: {e}."),
        None => head.to_string(),
    };
    if pass_out.contains("el PDF no se completó") {
        return with_err("El motor se detuvo mientras escribía el PDF (suele ser una imagen que falta).");
    }
    if pass_out.contains("No pages of output") {
        return with_err("LaTeX terminó sin producir ninguna página: el cuerpo del documento está vacío o nada de él llegó a componerse.");
    }
    if let Some(l) = pass_out.lines().find(|l| l.contains("I can't write on file")) {
        return format!("LaTeX no pudo escribir en la carpeta de trabajo: {}", l.trim().trim_start_matches("! "));
    }
    if pass_out.contains("Emergency stop") || pass_out.contains("Fatal error occurred") {
        return with_err("LaTeX se detuvo por un error del que no pudo recuperarse.");
    }
    with_err(&format!("El motor ({engine}) terminó sin escribir un PDF."))
}

/// (outcome, reason) of a compile: a PDF, or why not.
fn outcome_of(
    pdf_fresh: bool,
    stopped: Option<&str>,
    stop_why: &str,
    last_pass: &str,
    log: &str,
    engine: &str,
) -> (String, String) {
    if stopped.is_some() {
        let why = stop_why.split("\n\n").next().unwrap_or(stop_why).trim();
        return ("detenido".into(), if why.is_empty() { "La compilación se detuvo.".into() } else { why.to_string() });
    }
    if pdf_fresh {
        return ("pdf".into(), String::new());
    }
    // The note about a PDF cut short is written to the whole log, after the
    // pass; everything else is in what the last pass printed.
    let said = if log.contains("el PDF no se completó") { log } else { last_pass };
    ("sin-pdf".into(), no_pdf_reason(said, engine))
}

/// `.bib` (and project-local `.bst`) files of a document that has a
/// bibliography. TeX never opens them — BibTeX and Biber do — so the recorder
/// list does not name them, and an edit to nothing but the `.bib` then looked
/// like "nothing the PDF depends on changed": the background compile skipped
/// the engine and the new reference never appeared.
fn bibliography_inputs(dir: &Path, out_dir: &Path, job: &str, search_dirs: &[String]) -> Vec<String> {
    let uses_bib = out_dir.join(format!("{job}.bcf")).exists() || bibtex_inputs(out_dir, job).is_some();
    if !uses_bib {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut dirs: Vec<PathBuf> = vec![dir.to_path_buf()];
    dirs.extend(search_dirs.iter().filter(|d| !d.is_empty()).map(PathBuf::from));
    for d in dirs {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            let is = |x: &str| p.extension().map(|e| e.eq_ignore_ascii_case(x)).unwrap_or(false);
            if is("bib") || is("bst") {
                out.push(p.to_string_lossy().to_string());
            }
        }
    }
    out
}

/// What to do about the NEXT compile's preamble once this one is done.
#[derive(Clone, Copy, PartialEq)]
pub enum Prewarm {
    No,
    /// Before returning (the tests: they look at the paused engine at once).
    #[allow(dead_code)]
    Now,
    /// After the result has been handed over — see `PrewarmJob`.
    Later,
}

pub struct CompileOpts {
    /// The TeX `-jobname`, so `doc.build.tex` produces `doc.pdf`.
    pub jobname: Option<String>,
    pub search_dirs: Vec<String>,
    /// Start from nothing: no .aux, lists or SyncTeX index of earlier runs.
    pub clean_first: bool,
    /// The engine left paused after the last compile may run the first pass.
    /// A compile the user asked for by hand does not take it: that one is the
    /// ground truth, run the way TeXstudio would.
    pub use_warm: bool,
    pub prewarm: Prewarm,
    /// The app's own number for this request; it comes back in the result.
    pub gen: u64,
}

/// Starting the next compile's engine, put off until this compile's result has
/// reached the window.
///
/// It used to start BEFORE the result was returned: a second engine loading
/// fonts and packages at the very moment the viewer was parsing and painting
/// the new PDF, on the same cores. It also must not start if another compile
/// has begun meanwhile — that one owns the working directory now.
pub struct PrewarmJob {
    seq: u64,
    engine_cmd: String,
    dir: PathBuf,
    out_dir: PathBuf,
    job: String,
    build: PathBuf,
    search_dirs: Vec<String>,
}

impl PrewarmJob {
    pub fn start_later(self) {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(250));
            self.start();
        });
    }
    fn start(self) {
        use std::sync::atomic::Ordering;
        let _lock = match COMPILE_LOCK.try_lock() {
            Ok(g) => g,
            Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return, // a compile is running
        };
        if COMPILE_SEQ.load(Ordering::SeqCst) != self.seq {
            return; // a newer compile came and went: it left its own
        }
        spawn_warm(&self.engine_cmd, &self.dir, &self.out_dir, &self.job, &self.build, &self.search_dirs);
    }
}

/// Marks a request as the one in flight, for `cancel()` and the watchdogs.
struct InFlight;
impl InFlight {
    fn enter(seq: u64) -> InFlight {
        IN_FLIGHT.store(seq, std::sync::atomic::Ordering::SeqCst);
        THIS_SEQ.with(|c| c.set(seq));
        InFlight
    }
}
impl Drop for InFlight {
    fn drop(&mut self) {
        IN_FLIGHT.store(0, std::sync::atomic::Ordering::SeqCst);
        THIS_SEQ.with(|c| c.set(0));
    }
}

/// A result for a request that did not run the engine.
fn not_run(engine: &str, stopped: Option<&str>, outcome: &str, reason: String, log: String) -> CompileResult {
    CompileResult {
        ok: false,
        pdf_path: None,
        log,
        engine: engine.to_string(),
        stopped: stopped.map(str::to_string),
        inputs: Some(Vec::new()),
        started_ms: now_ms(),
        gen: 0,
        outcome: outcome.to_string(),
        reason,
        pdf: None,
        timings: Timings::default(),
    }
}

/// One line per compile in `%LOCALAPPDATA%\com.pyx.studio\logs\compile.jsonl`: what was
/// asked, how it ended and where the time went. "It said done and nothing
/// changed" can then be answered from a file instead of from memory.
fn log_compile(path: &str, res: &Result<(CompileResult, Option<PrewarmJob>), String>, seq: u64, gen: u64) {
    if cfg!(test) {
        return;
    }
    let line = match res {
        Ok((r, _)) => serde_json::json!({
            "t": now_ms(), "seq": seq, "gen": gen, "doc": path, "engine": r.engine,
            "outcome": r.outcome, "reason": r.reason, "stopped": r.stopped,
            "ok": r.ok, "pdf": r.pdf.as_ref().map(|p| p.size), "timings": r.timings,
        }),
        Err(e) => serde_json::json!({
            "t": now_ms(), "seq": seq, "gen": gen, "doc": path, "outcome": "error", "reason": e,
        }),
    };
    crate::workspace::append_log("compile.jsonl", &line.to_string());
}

/// Compile a `.tex` file with the chosen engine. Runs `passes` times so table
/// of contents / cross references can settle (1 is fastest, 2 resolves refs).
///
/// The output PDF is `<jobname>.pdf` (or `<stem>.pdf` when no jobname is
/// given). One compile runs at a time: a request that arrives while another
/// runs waits, and does not run at all if a newer one for the same working
/// directory arrived meanwhile (see "One compile at a time, numbered").
pub fn compile_with(
    path: &str,
    project_dir: &str,
    engine: &str,
    passes: u32,
    opts: CompileOpts,
) -> Result<(CompileResult, Option<PrewarmJob>), String> {
    use std::sync::atomic::Ordering;
    let t_all = std::time::Instant::now();
    let seq = COMPILE_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let dir_key = Path::new(path)
        .parent()
        .map(|d| d.to_string_lossy().replace('/', "\\").to_lowercase())
        .unwrap_or_default();
    if let Ok(mut g) = NEWEST.lock() {
        g.get_or_insert_with(Default::default).insert(dir_key.clone(), seq);
    }
    let _lock = COMPILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let wait_ms = t_all.elapsed().as_millis() as u64;
    let _flight = InFlight::enter(seq);
    let newest = NEWEST.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(&dir_key).copied())).unwrap_or(seq);
    let mut res = if newest != seq {
        Ok((
            not_run(engine, Some("sustituida"), "detenido", "Sustituida por una compilación más reciente del mismo documento.".into(), String::new()),
            None,
        ))
    } else if stop_asked(seq) {
        Ok((
            not_run(
                engine,
                Some("cancelado"),
                "detenido",
                "Compilación detenida por el usuario.".into(),
                "===== Pyx: compilación detenida =====\nCompilación detenida por el usuario.\n".into(),
            ),
            None,
        ))
    } else {
        compile_locked(seq, path, project_dir, engine, passes, &opts)
    };
    if let Ok((r, _)) = res.as_mut() {
        r.gen = opts.gen;
        r.timings.wait_ms = wait_ms;
        r.timings.total_ms = t_all.elapsed().as_millis() as u64;
    }
    log_compile(path, &res, seq, opts.gen);
    res
}

/// `compile_with` the way the tests call it: `warm` both uses the paused
/// engine and leaves the next one paused before returning.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
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
    let opts = CompileOpts {
        jobname,
        search_dirs: search_dirs.to_vec(),
        clean_first,
        use_warm: warm,
        prewarm: if warm { Prewarm::Now } else { Prewarm::No },
        gen: 0,
    };
    compile_with(path, project_dir, engine, passes, opts).map(|(r, _)| r)
}

fn compile_locked(
    seq: u64,
    path: &str,
    project_dir: &str,
    engine: &str,
    passes: u32,
    opts: &CompileOpts,
) -> Result<(CompileResult, Option<PrewarmJob>), String> {
    let t_prep = std::time::Instant::now();
    let search_dirs: &[String] = &opts.search_dirs;
    let clean_first = opts.clean_first;
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

    let jobname = opts.jobname.clone().filter(|s| !s.trim().is_empty());
    let out_name = jobname
        .clone()
        .unwrap_or_else(|| src.file_stem().unwrap_or_default().to_string_lossy().to_string());

    // ---- one folder for every scratch file the engine produces ----
    //
    // A LaTeX run litters the document's folder with .aux, .log, .fls, .toc,
    // .out, .lof, .lot, .maf, .mtc*, .nav, .snm … On a document with chapters
    // that is dozens of files the author never asked for and cannot tell apart
    // from their own. `-output-directory` sends all of it into ONE place.
    //
    // The engine still RUNS from the document's folder, so relative paths in
    // the source (\includegraphics{xref/…}, \input{cap/…}) resolve exactly as
    // they did before. And keeping the .aux files between runs is what lets
    // cross-references settle in two passes instead of three.
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("No se pudo crear la carpeta de compilación: {e}"))?;
    // Until this returns, a save must not pack this directory (workspace.rs).
    let _busy = crate::workspace::mark_busy(&out_dir);
    mirror_project_dirs(dir, &out_dir, search_dirs, clean_first);

    let mut log = String::new();
    let mut timings = Timings::default();

    // No file of the project may stand in for a build copy (see
    // remove_shadowing_copies). One that cannot be deleted stops the compile:
    // going on would typeset its old text and call that a result.
    let (removed, stuck) = remove_shadowing_copies(dir, &out_dir);
    if !removed.is_empty() {
        log.push_str("===== Pyx: copias de compilación antiguas =====\n");
        log.push_str(
            "En la carpeta del proyecto había copias de compilación de una versión anterior de Pyx; \
             el motor las habría leído en lugar del texto actual. Se han borrado:\n",
        );
        for r in &removed {
            log.push_str(&format!("  {r}\n"));
        }
        log.push('\n');
    }
    if !stuck.is_empty() {
        let reason = format!(
            "En la carpeta del proyecto hay copias de compilación antiguas que no se pueden borrar \
             y que el motor leería en lugar del texto actual. Bórralas a mano: {}",
            stuck.join(", ")
        );
        log.push_str(&format!("===== Pyx: no se ha compilado =====\n{reason}\n"));
        return Ok((not_run(engine, None, "error", reason, log), None));
    }

    // The previous PDF steps aside: from here on, a `<job>.pdf` that exists
    // was written by this run. If it cannot be moved, another program has it
    // open, and no engine could write it either — say so now.
    let pdf = out_dir.join(format!("{out_name}.pdf"));
    let mut park = match ParkedPdf::park(&pdf) {
        Ok(p) => p,
        Err(reason) => {
            log.push_str(&format!("===== Pyx: no se ha compilado =====\n{reason}\n"));
            return Ok((not_run(engine, None, "sin-pdf", reason, log), None));
        }
    };

    if engine == "tectonic" {
        // Its own reruns and BibTeX; none of the pass logic below applies.
        return compile_tectonic(
            &engine_cmd, src, dir, &out_dir, &out_name, search_dirs, clean_first, park, log, timings, t_prep,
        )
        .map(|r| (r, None));
    }

    let passes = passes.clamp(1, 3);
    const MAX_PASSES: u32 = 3;
    let mut clean = false;
    let mut stopped: Option<String> = None;
    let mut stop_why = String::new();
    let started_ms = now_ms();
    let warm_id = warm_key(&engine_cmd, dir, &out_dir, &out_name, search_dirs);

    // The engine left paused after the last compile, if it can run this one
    // (see "Warm engine"). Taken BEFORE the check below: while it waits, the
    // SyncTeX index it has open is marked busy, and that is not a dead pass.
    let mut warm_engine = if opts.use_warm && !clean_first && passes == 1 {
        std::fs::read_to_string(src)
            .ok()
            .and_then(|t| body_start(&t).map(|at| t[..at].to_string()))
            .and_then(|pre| take_warm(&warm_id, &pre, &out_dir, &out_name))
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
    // The pass the paused engine ran did not end clean and is being repeated
    // by a fresh engine: if THAT one is clean, the paused engine was wrong.
    let mut recheck_cold = false;
    let mut last_pass = String::new();
    timings.prep_ms = t_prep.elapsed().as_millis() as u64;

    let stop_note = |log: &mut String| {
        log.push_str("===== Pyx: compilación detenida =====\nCompilación detenida por el usuario.\n");
    };

    let mut i = 0;
    while i < MAX_PASSES {
        // "Detener" between two passes, or while a tool ran: no engine was
        // there to kill, so the request is honoured here.
        if stop_asked(seq) {
            clean_intermediates(&out_dir, &out_name);
            stop_note(&mut log);
            stopped = Some("cancelado".into());
            stop_why = "Compilación detenida por el usuario.".into();
            clean = false;
            break;
        }
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
        if let Some(j) = jobname.as_ref() {
            cmd.arg(format!("-jobname={j}"));
        }
        // The pass that writes the PDF writes it fast (see FAST_PDF).
        if final_pass {
            if let Some(driver) = pdf_driver_arg(&engine_cmd) {
                cmd.arg(driver);
            }
        }
        // Every file the engine opens, for the app's "did anything change?"
        cmd.arg("-recorder");
        crate::quiet(&mut cmd);
        cmd.arg(&file);
        // The list files as the previous pass left them. For a pass the paused
        // engine runs, as they were BEFORE it started: its preamble may have
        // emptied some since (see Warm::listings).
        let listings_before = match warm_engine.as_ref() {
            Some(w) => w.listings.clone(),
            None => listings_stamp(&out_dir, &out_name),
        };
        let t_pass = std::time::Instant::now();
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
        timings.passes_ms.push(t_pass.elapsed().as_millis() as u64);
        timings.warm |= warmed;

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
        last_pass = format!("{pass_out}\n{}", run.stderr);
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
            stop_why = why;
            stopped = Some(code);
            clean = false;
            break;
        }
        // Exit status 0 = no TeX errors at all ("clean"). A nonzero status just
        // means errors were recovered — the pass still ran to completion, so
        // reference-settling reruns are still meaningful.
        clean = run.success;
        // A pass run by the paused engine is trusted only when it is beyond
        // doubt: no error and a complete PDF. Anything else is repeated right
        // here by a fresh engine, the way a normal compile would have run —
        // an error must be the DOCUMENT's, never an artefact of how the pass
        // was started. (It used to be taken as it came, and the next engine
        // was left paused on top of it.)
        if warmed && !(clean && pdf.exists() && pdf_complete(&pdf)) {
            let _ = std::fs::remove_file(&pdf);
            log.push_str(
                "===== Pyx: la pasada con el preámbulo ya cargado no terminó limpia; \
                 se repite con un motor nuevo =====\n",
            );
            recheck_cold = true;
            continue;
        }
        if recheck_cold {
            recheck_cold = false;
            if clean && pdf.exists() && pdf_complete(&pdf) {
                // Same text, a clean result this time: the paused engine does
                // not reproduce a normal compile of this document. No more of
                // it for this document in this session.
                if let Ok(mut off) = WARM_OFF.lock() {
                    off.push(warm_id.clone());
                }
                log.push_str(
                    "===== Pyx: este documento se compilará sin precargar el preámbulo \
                     (el motor en espera dio un resultado distinto) =====\n",
                );
            }
        }
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
        let t_tools = std::time::Instant::now();
        let tools_changed = run_aux_tools(dir, &out_dir, &out_name, search_dirs, &mut log);
        timings.tools_ms += t_tools.elapsed().as_millis() as u64;
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
    // Stopped while a tool ran (the tool was killed; no pass followed).
    if stopped.is_none() && stop_asked(seq) {
        stop_note(&mut log);
        stopped = Some("cancelado".into());
        stop_why = "Compilación detenida por el usuario.".into();
        clean = false;
    }

    // Nothing is moved back: the PDF and its SyncTeX index stay in the working
    // directory, side by side, which is exactly where the `synctex` CLI expects
    // to find the index for a given PDF. The user's folder keeps only what the
    // user put in it.
    let t_fin = std::time::Instant::now();
    let (pdf_fresh, info) = settle_pdf(&mut park, &out_dir, &out_name, engine, &mut log);

    let inputs = if stopped.is_none() {
        let mut v = recorded_inputs(&out_dir, &out_name, dir, &log);
        for b in bibliography_inputs(dir, &out_dir, &out_name, search_dirs) {
            if !v.iter().any(|x| x.eq_ignore_ascii_case(&b)) {
                v.push(b);
            }
        }
        // The check that no stale build copy was what the engine read.
        let foreign = foreign_build_copies(&out_dir, &out_name, dir);
        if !foreign.is_empty() {
            log.push_str("===== Pyx: copia de compilación fuera de la carpeta de trabajo =====\n");
            log.push_str(
                "El motor ha leído estas copias de compilación, que no son las que Pyx acaba de \
                 escribir: el PDF puede mostrar texto antiguo. Bórralas:\n",
            );
            for f in &foreign {
                log.push_str(&format!("  {f}\n"));
            }
        }
        Some(v)
    } else {
        Some(Vec::new())
    };
    let (outcome, reason) = outcome_of(pdf_fresh, stopped.as_deref(), &stop_why, &last_pass, &log, engine);
    if outcome != "pdf" && !log.contains(&reason) {
        log.push_str(&format!("===== Pyx: sin PDF nuevo =====\n{reason}\n"));
    }

    // Get the NEXT compile's preamble out of the way, while the user reads
    // this PDF — only from a compile that ended clean (an engine paused on top
    // of a document with errors would have to be repeated cold anyway), and
    // after everything above has read this run's .log and .fls: the new engine
    // starts by truncating them.
    let prewarm = (opts.prewarm != Prewarm::No && stopped.is_none() && clean && pdf_fresh).then(|| PrewarmJob {
        seq,
        engine_cmd: engine_cmd.clone(),
        dir: dir.to_path_buf(),
        out_dir: out_dir.clone(),
        job: out_name.clone(),
        build: src.to_path_buf(),
        search_dirs: search_dirs.to_vec(),
    });
    let prewarm = match (opts.prewarm, prewarm) {
        (Prewarm::Now, Some(job)) => {
            spawn_warm(&job.engine_cmd, &job.dir, &job.out_dir, &job.job, &job.build, &job.search_dirs);
            None
        }
        (_, job) => job,
    };
    timings.finish_ms = t_fin.elapsed().as_millis() as u64;
    Ok((
        CompileResult {
            ok: clean && pdf_fresh && stopped.is_none(),
            pdf_path: pdf_fresh.then(|| pdf.to_string_lossy().to_string()),
            log,
            engine: engine.to_string(),
            stopped,
            inputs,
            started_ms,
            gen: 0,
            outcome,
            reason,
            pdf: info,
            timings,
        },
        prewarm,
    ))
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
        // TeX never opens the .bib, but an edit to it must count as a change.
        let inputs = first.inputs.clone().unwrap_or_default();
        assert!(inputs.iter().any(|p| p.to_lowercase().ends_with("refs.bib")), "{inputs:?}");
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

    /// The glossaries package: its lists are sorted between passes (what
    /// makeglossaries does), so \\gls resolves and \\printglossaries prints.
    #[test]
    fn glossaries_are_sorted_between_passes() {
        let _turn = engine_turn();
        let Some(engine) = some_engine() else { return };
        if resolve_engine("makeindex").is_none() {
            return;
        }
        let (base, proj, work) = scratch("glo");
        let main = work.join("main.build.tex");
        fs::write(
            &main,
            "\\documentclass{article}\n\\usepackage[acronym]{glossaries}\\makeglossaries\n\
             \\newglossaryentry{viga}{name={viga},description={elemento lineal que trabaja a flexión}}\n\
             \\newacronym{elu}{ELU}{estado límite último}\n\
             \\begin{document}\nUna \\gls{viga} en \\gls{elu}.\n\\printglossaries\n\\end{document}\n",
        )
        .unwrap();
        let run = || {
            compile(main.to_str().unwrap(), proj.to_str().unwrap(), engine, 1, Some("main".into()), &[], false, false)
                .expect("la compilacion deberia ejecutarse")
        };
        let first = run();
        assert!(first.log.contains("===== Pyx: makeindex ====="), "{}", first.log);
        let gls = fs::read_to_string(work.join("main.gls")).unwrap();
        assert!(gls.contains("viga"), "{gls}");
        assert!(work.join("main.acr").exists());
        let again = run();
        assert!(!again.log.contains("===== Pyx: makeindex ====="), "{}", again.log);
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

    /// "Compile 10 000 times and all 10 000 must compile and show."
    ///
    /// Every round changes the body (`\typeout{PYXGEN=n}` and the text
    /// "GEN n"), alternates between the paused engine and a cold pass, and
    /// checks that THIS round's text is what the engine typeset: the log names
    /// this generation, the PDF's bytes changed, no engine process is left
    /// over and the app's handle count is not creeping up.
    ///
    /// The project folder holds a stale `main.build.tex` on purpose: older
    /// versions of Pyx wrote the build copies there, and a leftover one must
    /// never be what gets compiled.
    ///
    /// `cargo test --release -- --ignored stress --nocapture`, with
    /// `PYX_STRESS_N` rounds (default 1000) and `PYX_STRESS_ENGINE`.
    #[test]
    #[ignore]
    fn stress_every_compile_typesets_its_own_text() {
        let _turn = engine_turn();
        let wanted = std::env::var("PYX_STRESS_ENGINE").ok();
        let Some(engine) = ["pdflatex", "xelatex", "lualatex"]
            .into_iter()
            .find(|e| wanted.as_deref().map(|w| w == *e).unwrap_or(true) && engine_works(e))
        else {
            return;
        };
        let rounds: u32 = std::env::var("PYX_STRESS_N").ok().and_then(|v| v.parse().ok()).unwrap_or(1000);
        let (base, proj, work) = scratch("stress");
        let main = work.join("main.build.tex");
        fs::write(
            proj.join("main.build.tex"),
            "\\documentclass{article}\n\\begin{document}\n\\typeout{PYXGEN=STALE}VIEJO\n\\end{document}\n",
        )
        .unwrap();
        let doc = |n: u32| {
            // Every 25 rounds the preamble changes too: the paused engine
            // must then be thrown away, not used.
            let pre = if n % 25 == 0 { format!("\\newcommand\\ronda{{{n}}}\n") } else { String::new() };
            format!(
                "\\documentclass{{article}}\n{pre}\\begin{{document}}\n\\typeout{{PYXGEN={n}}}\nGEN {n}\\label{{g}} \\ref{{g}}\n\\end{{document}}\n"
            )
        };
        let handles0 = handle_count();
        let t0 = std::time::Instant::now();
        let mut last_pdf: Vec<u8> = Vec::new();
        let mut warmed = 0u32;
        for n in 1..=rounds {
            fs::write(&main, doc(n)).unwrap();
            // Two warm compiles, then one that must run cold, and so on.
            let warm = n % 3 != 0;
            let res = compile(main.to_str().unwrap(), proj.to_str().unwrap(), engine, 1, Some("main".into()), &[], false, warm)
                .unwrap_or_else(|e| panic!("ronda {n}: {e}"));
            let pdf = res.pdf_path.unwrap_or_else(|| panic!("ronda {n}: sin PDF\n{}", res.log));
            assert!(res.log.contains(&format!("PYXGEN={n}\n")) || res.log.contains(&format!("PYXGEN={n}\r")),
                "ronda {n}: el motor compuso otro texto\n{}", res.log);
            assert!(!res.log.contains("PYXGEN=STALE"), "ronda {n}: se compiló la copia vieja del proyecto");
            let bytes = fs::read(&pdf).unwrap();
            assert!(bytes != last_pdf, "ronda {n}: el PDF no cambió");
            last_pdf = bytes;
            if res.log.contains("preámbulo ya cargado") {
                warmed += 1;
            }
            assert_eq!(res.outcome, "pdf", "ronda {n}: {}", res.reason);
            if n % 100 == 0 || n == rounds {
                let grew = handle_count().saturating_sub(handles0);
                assert!(grew < 200, "ronda {n}: {grew} handles más que al empezar");
                println!("ronda {n}/{rounds}: {:.0} ms por compilación, {warmed} en caliente, +{grew} handles",
                    t0.elapsed().as_millis() as f64 / n as f64);
            }
        }
        drop_warm();
        assert!(warmed > rounds / 4, "el motor en espera casi no se usó: {warmed} de {rounds}");
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert_eq!(engines_alive(&base), 0, "quedaron motores vivos");
        let _ = fs::remove_dir_all(&base);
    }

    /// Engine processes whose command line names this scratch folder.
    fn engines_alive(dir: &Path) -> usize {
        #[cfg(windows)]
        {
            let marker = dir.file_name().unwrap().to_string_lossy().to_string();
            let mut c = Command::new("powershell");
            c.args([
                "-NoProfile",
                "-Command",
                &format!(
                    "@(Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*{marker}*' -and $_.Name -notlike 'powershell*' }}).Count"
                ),
            ]);
            crate::quiet(&mut c);
            c.output().ok().and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok()).unwrap_or(0)
        }
        #[cfg(not(windows))]
        {
            let _ = dir;
            0
        }
    }

    /// Open handles of this process: a leak of one per compile shows here.
    fn handle_count() -> u32 {
        #[cfg(windows)]
        {
            #[link(name = "kernel32")]
            extern "system" {
                fn GetCurrentProcess() -> *mut core::ffi::c_void;
                fn GetProcessHandleCount(process: *mut core::ffi::c_void, count: *mut u32) -> i32;
            }
            let mut n = 0u32;
            unsafe {
                GetProcessHandleCount(GetCurrentProcess(), &mut n);
            }
            n
        }
        #[cfg(not(windows))]
        {
            0
        }
    }

    // ---- every compile ends in a new PDF or in a reason -----------------------

    fn simple_doc(body: &str) -> String {
        format!("\\documentclass{{article}}\n\\begin{{document}}\n{body}\n\\end{{document}}\n")
    }

    /// Build copies left in the PROJECT by an old version of Pyx used to be
    /// what the engine read: the root's by the paused engine, a chapter's by
    /// every pass. They are deleted, the log says so, and the text typeset is
    /// the working directory's.
    #[test]
    fn a_stale_build_copy_in_the_project_is_never_compiled() {
        let _turn = engine_turn();
        let Some(engine) = some_engine() else { return };
        let (base, proj, work) = scratch("stale");
        fs::create_dir_all(proj.join("cap")).unwrap();
        fs::create_dir_all(work.join("cap")).unwrap();
        fs::write(proj.join("main.build.tex"), simple_doc("\\typeout{RAIZ=VIEJA}x")).unwrap();
        fs::write(proj.join("cap/uno.build.tex"), "\\typeout{CAP=VIEJO}viejo\n").unwrap();
        // The author's own files are not touched, whatever they are called.
        fs::write(proj.join("cap/uno.tex"), "fuente del capitulo\n").unwrap();
        fs::write(proj.join("otro.build.tex"), "no es una copia de este proyecto\n").unwrap();
        let main = work.join("main.build.tex");
        fs::write(work.join("cap/uno.build.tex"), "\\typeout{CAP=NUEVO}nuevo\n").unwrap();
        let run = |n: u32| {
            fs::write(&main, simple_doc(&format!("\\typeout{{RAIZ={n}}}\\input{{cap/uno.build.tex}}"))).unwrap();
            compile(main.to_str().unwrap(), proj.to_str().unwrap(), engine, 1, Some("main".into()), &[], false, true)
                .expect("la compilacion deberia ejecutarse")
        };
        let first = run(1);
        assert!(first.log.contains("copias de compilación antiguas"), "{}", first.log);
        assert!(first.log.contains("CAP=NUEVO") && !first.log.contains("CAP=VIEJO"), "{}", first.log);
        assert!(!proj.join("main.build.tex").exists() && !proj.join("cap/uno.build.tex").exists());
        assert!(proj.join("cap/uno.tex").exists() && proj.join("otro.build.tex").exists());
        // The second one is run by the paused engine: still the new text.
        let second = run(2);
        assert!(second.log.contains("preámbulo ya cargado"), "{}", second.log);
        assert!(second.log.contains("RAIZ=2") && !second.log.contains("RAIZ=VIEJA"), "{}", second.log);
        assert_eq!(second.outcome, "pdf");
        assert!(second.reason.is_empty());
        drop_warm();
        let _ = fs::remove_dir_all(&base);
    }

    /// A PDF another program holds open cannot be rewritten by any engine.
    /// That is said before compiling, the PDF is left as it was, and the next
    /// compile works once the file is released.
    #[cfg(windows)]
    #[test]
    fn a_locked_pdf_is_reported_and_left_alone() {
        use std::os::windows::fs::OpenOptionsExt;
        let _turn = engine_turn();
        let Some(engine) = some_engine() else { return };
        let (base, proj, work) = scratch("locked");
        let main = work.join("main.build.tex");
        let run = |text: &str| {
            fs::write(&main, simple_doc(text)).unwrap();
            compile(main.to_str().unwrap(), proj.to_str().unwrap(), engine, 1, Some("main".into()), &[], false, false)
                .expect("la compilacion deberia ejecutarse")
        };
        let first = run("Uno");
        assert_eq!(first.outcome, "pdf", "{}", first.log);
        let before = fs::read(work.join("main.pdf")).unwrap();
        // The way Acrobat opens what it shows: nobody else may write or move it.
        let held = fs::OpenOptions::new().read(true).share_mode(1).open(work.join("main.pdf")).unwrap();
        let blocked = run("Dos");
        assert_eq!(blocked.outcome, "sin-pdf");
        assert!(blocked.pdf_path.is_none() && !blocked.ok);
        assert!(blocked.reason.contains("otro programa"), "{}", blocked.reason);
        assert!(blocked.log.contains(&blocked.reason));
        assert_eq!(fs::read(work.join("main.pdf")).unwrap(), before, "el PDF bloqueado no se toca");
        drop(held);
        let after = run("Tres");
        assert_eq!(after.outcome, "pdf", "{}", after.log);
        assert_ne!(fs::read(work.join("main.pdf")).unwrap(), before);
        let _ = fs::remove_dir_all(&base);
    }

    /// The engine ran and wrote nothing: the result says why, and the PDF of
    /// the last good compile is still there.
    #[test]
    fn a_compile_without_a_pdf_says_why_and_keeps_the_last_one() {
        let _turn = engine_turn();
        let Some(engine) = some_engine() else { return };
        let (base, proj, work) = scratch("nopdf");
        let main = work.join("main.build.tex");
        let run = |text: String| {
            fs::write(&main, text).unwrap();
            compile(main.to_str().unwrap(), proj.to_str().unwrap(), engine, 1, Some("main".into()), &[], false, false)
                .expect("la compilacion deberia ejecutarse")
        };
        let good = run(simple_doc("Bien"));
        assert_eq!(good.outcome, "pdf");
        let kept = fs::read(work.join("main.pdf")).unwrap();
        // No page at all.
        let empty = run(simple_doc(""));
        assert_eq!(empty.outcome, "sin-pdf", "{}", empty.log);
        assert!(empty.pdf_path.is_none() && empty.pdf.is_none());
        assert!(empty.reason.contains("ninguna página"), "{}", empty.reason);
        assert_eq!(fs::read(work.join("main.pdf")).unwrap(), kept, "se conserva el último PDF bueno");
        // A fatal error before any page.
        let fatal = run("\\documentclass{article}\n\\begin{document}\n\\nosuchmacro\n\\end{nada}\n\\csname @@end\\endcsname\n".into());
        assert_eq!(fatal.outcome, "sin-pdf", "{}", fatal.log);
        assert!(fatal.reason.contains("Undefined control sequence"), "{}", fatal.reason);
        assert!(fatal.reason.contains("línea 3"), "{}", fatal.reason);
        assert_eq!(fs::read(work.join("main.pdf")).unwrap(), kept);
        let _ = fs::remove_dir_all(&base);
    }

    /// The viewers read a copy that no later compile writes; old copies go.
    #[test]
    fn the_viewers_get_a_copy_nobody_writes() {
        let _turn = engine_turn();
        let Some(engine) = some_engine() else { return };
        let (base, proj, work) = scratch("copy");
        let main = work.join("main.build.tex");
        let mut paths = Vec::new();
        for n in 1..=4 {
            fs::write(&main, simple_doc(&format!("Version {n}"))).unwrap();
            let res = compile(main.to_str().unwrap(), proj.to_str().unwrap(), engine, 1, Some("main".into()), &[], false, false)
                .expect("la compilacion deberia ejecutarse");
            let job = res.pdf_path.clone().expect("PDF");
            let info = res.pdf.expect("copia para el visor");
            assert_ne!(info.path, job);
            assert_eq!(fs::read(&info.path).unwrap(), fs::read(&job).unwrap());
            assert_eq!(info.size, fs::metadata(&job).unwrap().len());
            assert_eq!(pdf_source(&job), PathBuf::from(&info.path));
            assert!(res.timings.total_ms > 0 && res.timings.passes_ms.len() == 1);
            paths.push(info.path);
        }
        let copies = fs::read_dir(work.join(VIEW_DIR)).unwrap().flatten().count();
        assert_eq!(copies, 2, "solo quedan las dos últimas copias");
        assert!(!Path::new(&paths[0]).exists() && Path::new(&paths[3]).exists());
        // The copies are not part of the engine's state: a clean start keeps them.
        clean_intermediates(&work, "main");
        assert!(Path::new(&paths[3]).exists());
        let _ = fs::remove_dir_all(&base);
    }

    /// A request that waited behind another does not run when a newer one for
    /// the same document arrived meanwhile; the newest always does.
    #[test]
    fn a_request_overtaken_while_waiting_does_not_run() {
        let _turn = engine_turn();
        let Some(engine) = some_engine() else { return };
        let (base, proj, work) = scratch("overtaken");
        let main = work.join("main.build.tex");
        fs::write(&main, simple_doc("Texto")).unwrap();
        let go = |gen: u64| {
            let (m, p) = (main.to_string_lossy().to_string(), proj.to_string_lossy().to_string());
            std::thread::spawn(move || {
                let opts = CompileOpts {
                    jobname: Some("main".into()),
                    search_dirs: Vec::new(),
                    clean_first: false,
                    use_warm: false,
                    prewarm: Prewarm::No,
                    gen,
                };
                compile_with(&m, &p, engine, 1, opts).unwrap().0
            })
        };
        let a = go(1);
        // Until A holds the lock…
        for _ in 0..200 {
            if IN_FLIGHT.load(std::sync::atomic::Ordering::SeqCst) != 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        // …then B, and after it C, both waiting behind A.
        let b = go(2);
        std::thread::sleep(std::time::Duration::from_millis(60));
        let c = go(3);
        let (a, b, c) = (a.join().unwrap(), b.join().unwrap(), c.join().unwrap());
        assert_eq!((a.gen, a.outcome.as_str()), (1, "pdf"), "{}", a.log);
        assert_eq!((b.gen, b.outcome.as_str()), (2, "detenido"));
        assert_eq!(b.stopped.as_deref(), Some("sustituida"));
        assert!(!b.reason.is_empty());
        assert_eq!((c.gen, c.outcome.as_str()), (3, "pdf"), "{}", c.log);
        let _ = fs::remove_dir_all(&base);
    }

    /// "Detener" reaches a compile that has no engine process at that instant
    /// (between passes, waiting its turn): it is marked by number, not by
    /// whatever process happened to be registered.
    #[test]
    fn a_stop_reaches_a_compile_with_no_engine_running() {
        use std::sync::atomic::Ordering;
        let _turn = engine_turn();
        let Some(engine) = some_engine() else { return };
        let (base, proj, work) = scratch("stopmark");
        let main = work.join("main.build.tex");
        fs::write(&main, simple_doc("Texto")).unwrap();
        let before = CANCEL_UPTO.load(Ordering::SeqCst);
        // As if the stop had landed just before this request's first pass.
        CANCEL_UPTO.store(COMPILE_SEQ.load(Ordering::SeqCst) + 1, Ordering::SeqCst);
        let res = compile(main.to_str().unwrap(), proj.to_str().unwrap(), engine, 1, Some("main".into()), &[], false, false).unwrap();
        CANCEL_UPTO.store(before, Ordering::SeqCst);
        assert_eq!(res.stopped.as_deref(), Some("cancelado"));
        assert_eq!(res.outcome, "detenido");
        assert!(res.reason.contains("detenida"));
        // …and only that one: the next compiles.
        let next = compile(main.to_str().unwrap(), proj.to_str().unwrap(), engine, 1, Some("main".into()), &[], false, false).unwrap();
        assert_eq!(next.outcome, "pdf", "{}", next.log);
        let _ = fs::remove_dir_all(&base);
    }

    /// A build copy the PREAMBLE reads (a preamble kept in its own processed
    /// file) retires the paused engine when it changes.
    #[test]
    fn a_build_copy_read_by_the_preamble_retires_the_paused_engine() {
        let _turn = engine_turn();
        let Some(engine) = some_engine() else { return };
        let (base, proj, work) = scratch("predep");
        let main = work.join("main.build.tex");
        let pre = work.join("pre.build.tex");
        fs::write(&pre, "\\newcommand\\marca{A}\n").unwrap();
        let run = |body: &str| {
            fs::write(&main, format!("\\documentclass{{article}}\n\\input{{pre.build.tex}}\n\\begin{{document}}\n{body}\\typeout{{MARCA=\\marca}}\n\\end{{document}}\n")).unwrap();
            compile(main.to_str().unwrap(), proj.to_str().unwrap(), engine, 1, Some("main".into()), &[], false, true)
                .expect("la compilacion deberia ejecutarse")
        };
        run("uno");
        let warm = run("dos");
        assert!(warm.log.contains("preámbulo ya cargado"), "{}", warm.log);
        std::thread::sleep(std::time::Duration::from_millis(1200));
        fs::write(&pre, "\\newcommand\\marca{BB}\n").unwrap();
        let after = run("tres");
        assert!(!after.log.contains("preámbulo ya cargado"), "el preámbulo cambió: {}", after.log);
        assert!(after.log.contains("MARCA=BB"), "{}", after.log);
        drop_warm();
        let _ = fs::remove_dir_all(&base);
    }

    /// A preamble that opens a list for writing (`\makeindex`) empties it when
    /// the paused engine starts. That must not read as "the list changed": an
    /// unchanged document still compiles in one pass.
    #[test]
    fn a_paused_engine_does_not_cost_an_index_a_second_pass() {
        let _turn = engine_turn();
        let Some(engine) = some_engine() else { return };
        if resolve_engine("makeindex").is_none() {
            return;
        }
        let (base, proj, work) = scratch("warmidx");
        let main = work.join("main.build.tex");
        let run = |n: u32| {
            fs::write(&main, format!("\\documentclass{{article}}\n\\usepackage{{makeidx}}\\makeindex\n\\begin{{document}}\n\\tableofcontents\\section{{S}}Texto {n}\\index{{palabra}}\n\\printindex\n\\end{{document}}\n")).unwrap();
            compile(main.to_str().unwrap(), proj.to_str().unwrap(), engine, 1, Some("main".into()), &[], false, true)
                .expect("la compilacion deberia ejecutarse")
        };
        run(1);
        run(2);
        let steady = run(3);
        assert!(steady.log.contains("preámbulo ya cargado"), "{}", steady.log);
        assert_eq!(passes_run(&steady.log), 1, "{}", steady.log);
        assert!(steady.timings.warm);
        drop_warm();
        let _ = fs::remove_dir_all(&base);
    }

    /// A pass run by the paused engine that ends with an error is repeated by
    /// a fresh engine in the same compile, and no engine is left paused on top
    /// of a document with errors.
    #[test]
    fn a_warm_pass_with_errors_is_repeated_cold() {
        let _turn = engine_turn();
        let Some(engine) = some_engine() else { return };
        let (base, proj, work) = scratch("warmerr");
        let main = work.join("main.build.tex");
        let run = |body: &str| {
            fs::write(&main, simple_doc(body)).unwrap();
            compile(main.to_str().unwrap(), proj.to_str().unwrap(), engine, 1, Some("main".into()), &[], false, true)
                .expect("la compilacion deberia ejecutarse")
        };
        run("Bien");
        assert!(WARM.lock().unwrap().is_some());
        let bad = run("Mal \\nosuchmacro fin");
        assert!(bad.log.contains("se repite con un motor nuevo"), "{}", bad.log);
        assert_eq!(passes_run(&bad.log), 2);
        assert!(bad.pdf_path.is_some() && !bad.ok, "TeX se recupera del error: hay PDF, con avisos");
        assert!(WARM.lock().unwrap().is_none(), "no se deja un motor en espera sobre un documento con errores");
        // The error is the document's: the paused engine is not blamed for it.
        assert!(!warm_off(&warm_key(&resolve_engine(engine).unwrap(), &proj, &work, "main", &[])));
        let good = run("Bien otra vez");
        assert!(good.ok && WARM.lock().unwrap().is_some());
        drop_warm();
        let _ = fs::remove_dir_all(&base);
    }

    /// Something the engine started that outlives it and keeps its output pipe
    /// open must not keep the compile waiting.
    #[cfg(windows)]
    #[test]
    fn a_leftover_child_holding_the_pipes_does_not_hang_the_run() {
        let _turn = engine_turn();
        let mut c = Command::new("cmd");
        // `start /b` leaves ping running with cmd's own stdout; cmd exits at once.
        c.args(["/c", "start", "/b", "ping", "-n", "30", "127.0.0.1"]);
        crate::quiet(&mut c);
        let t = std::time::Instant::now();
        let run = run_watched(c, Limits::default()).unwrap();
        assert!(run.stopped.is_none());
        assert!(t.elapsed().as_secs() < 10, "esperó {:?} a un proceso que nadie vigilaba", t.elapsed());
    }

    /// ChkTeX runs on typing pauses, also during a compile: it must not take
    /// the place of "the compile in flight".
    #[test]
    fn a_linter_run_is_not_the_compile_in_flight() {
        let _turn = engine_turn();
        let exe = if cfg!(windows) { "cmd" } else { "sh" };
        let mut c = Command::new(exe);
        if cfg!(windows) {
            c.args(["/c", "ping", "-n", "3", "127.0.0.1"]);
        } else {
            c.args(["-c", "sleep 2"]);
        }
        crate::quiet(&mut c);
        let sp = spawn_watched(c, false).unwrap();
        let h = std::thread::spawn(move || wait_watched(sp, Limits::default(), false).unwrap());
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(RUNNING.lock().unwrap().is_none(), "una ejecución auxiliar no ocupa el sitio del motor");
        let _ = h.join();
    }

    /// "Abrir en la aplicación externa" hands over a copy, never the file the
    /// engine writes; a PDF that is not a compiled one is opened as it is.
    #[test]
    fn an_external_application_gets_a_copy_of_a_compiled_pdf() {
        let work = crate::workspace::build_dir(&format!("C:/pyx-prueba-externa-{}/doc.tex", std::process::id()));
        let _ = fs::remove_dir_all(&work);
        fs::create_dir_all(&work).unwrap();
        let pdf = work.join("doc.pdf");
        fs::write(&pdf, b"%PDF-1.7 uno %%EOF").unwrap();
        let given = external_pdf(pdf.to_str().unwrap()).unwrap();
        assert_ne!(PathBuf::from(&given), pdf);
        assert!(given.replace('\\', "/").contains(&format!("{VIEW_DIR}/ext/")), "{given}");
        assert_eq!(fs::read(&given).unwrap(), fs::read(&pdf).unwrap());
        // The next compile's copy reaches it too.
        fs::write(&pdf, b"%PDF-1.7 dos %%EOF").unwrap();
        snapshot_pdf(&pdf, &work, "doc").expect("copia para el visor");
        assert_eq!(fs::read(&given).unwrap(), fs::read(&pdf).unwrap());
        let _ = fs::remove_dir_all(&work);

        let (base, proj, _work) = scratch("externo");
        let own = proj.join("plano.pdf");
        fs::write(&own, b"%PDF-1.7 %%EOF").unwrap();
        assert_eq!(external_pdf(own.to_str().unwrap()).unwrap(), own.to_str().unwrap());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn the_first_tex_error_is_quoted_with_its_line() {
        let log = "(./main.tex\n! Undefined control sequence.\n<recently read> \\foo \n\nl.42 \\foo\n       bar\n! Missing $ inserted.\nl.50 x\n";
        assert_eq!(first_tex_error(log).as_deref(), Some("Undefined control sequence (línea 42)"));
        assert_eq!(first_tex_error("! Emergency stop.\n").as_deref(), Some("Emergency stop"));
        assert!(first_tex_error("todo bien\n").is_none());
        assert!(no_pdf_reason("No pages of output.\n", "xelatex").contains("ninguna página"));
        assert!(!no_pdf_reason("", "xelatex").is_empty(), "sin PDF siempre hay un motivo");
    }

    /// The stub names the build file by its full path when TeX can read it
    /// verbatim, and by its bare name otherwise.
    #[test]
    fn the_paused_engine_names_its_body_by_full_path_when_it_can() {
        let p = if cfg!(windows) { r"C:\Users\ana\AppData\Local\Pyx\build\mi_doc-0f\main.build.tex" } else { "/home/ana/.cache/Pyx/build/mi_doc-0f/main.build.tex" };
        let r = warm_body_ref(Path::new(p)).unwrap();
        assert!(r.ends_with("/Pyx/build/mi_doc-0f/main.build.tex") && !r.contains('\\'), "{r}");
        // A character TeX would expand (~), read as a comment (%) or as an
        // active character under pdflatex (ñ): the name alone.
        for odd in ["Pyx~1", "100%", "año"] {
            let q = p.replace("ana", odd);
            assert_eq!(warm_body_ref(Path::new(&q)).as_deref(), Some("main.build.tex"), "{q}");
        }
        assert!(warm_body_ref(Path::new("a\"b.build.tex")).is_none());
    }

    #[test]
    fn an_error_from_a_stale_aux_is_recognised() {
        let log = "(./main.aux\n! Undefined control sequence.\nl.3 \\foo\n";
        assert!(aux_poisoned(log, "main"));
        let log = "(./main.aux) (./cap.tex\n! Undefined control sequence.\nl.3 \\foo\n";
        assert!(!aux_poisoned(log, "main"), "the aux was closed before the error");
    }
}
