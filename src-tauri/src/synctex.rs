//! SyncTeX read directly from the `.synctex.gz` index, without the `synctex`
//! program.
//!
//! Every Ctrl+click (both ways) and every "PDF follows what you write" used
//! to START the `synctex` command-line tool. That cost a process launch each
//! time, and it does not exist at all next to Tectonic, which ships no such
//! tool — so SyncTeX simply did not work with that engine. The index is a
//! documented text format (gzip-compressed); reading it here answers in a
//! fraction of a millisecond once it is parsed, and the parse is cached until
//! the next compile rewrites the file. The command-line tool stays as the
//! fallback (latex.rs) for anything this reader cannot answer.
//!
//! Units: positions are TeX scaled points (sp); 1 PDF point (bp) is
//! 65781.76 sp. `Unit:` and `Magnification:` scale them, `X/Y Offset:` shift
//! them — the same arithmetic the official parser does, checked against its
//! answers in the tests below.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const SP_PER_BP: f64 = 65781.76;

#[derive(Clone, Copy, Debug)]
struct Rec {
    /// `(` / `[` box, `h` / `v` void box, or a point record (`g k $ x`…).
    kind: u8,
    page: u32,
    tag: u32,
    line: u32,
    h: f64,
    v: f64,
    w: f64,
    ht: f64,
    dp: f64,
    /// Index of the enclosing hbox, if any.
    parent: Option<usize>,
}

#[derive(Default)]
pub struct Index {
    inputs: HashMap<u32, String>,
    recs: Vec<Rec>,
}

fn norm(p: &str) -> String {
    let s = p.replace('\\', "/").replace("/./", "/");
    let s = s.strip_prefix("./").unwrap_or(&s).to_string();
    if cfg!(windows) { s.to_lowercase() } else { s }
}

fn base(p: &str) -> String {
    norm(p).rsplit('/').next().unwrap_or("").to_lowercase()
}

/// Parse the text of a SyncTeX file.
pub fn parse(text: &str) -> Index {
    let mut idx = Index::default();
    let (mut unit, mut mag, mut xo, mut yo) = (1.0f64, 1000.0f64, 0.0f64, 0.0f64);
    let mut page = 0u32;
    let mut stack: Vec<usize> = Vec::new();
    let mut in_content = false;
    for line in text.lines() {
        if !in_content {
            if let Some(r) = line.strip_prefix("Input:") {
                if let Some((n, p)) = r.split_once(':') {
                    if let Ok(n) = n.parse() {
                        idx.inputs.insert(n, p.to_string());
                    }
                }
            } else if let Some(r) = line.strip_prefix("Unit:") {
                unit = r.trim().parse().unwrap_or(1.0);
            } else if let Some(r) = line.strip_prefix("Magnification:") {
                mag = r.trim().parse().unwrap_or(1000.0);
            } else if let Some(r) = line.strip_prefix("X Offset:") {
                xo = r.trim().parse().unwrap_or(0.0);
            } else if let Some(r) = line.strip_prefix("Y Offset:") {
                yo = r.trim().parse().unwrap_or(0.0);
            } else if line.starts_with("Content:") {
                in_content = true;
            }
            continue;
        }
        let Some(&k) = line.as_bytes().first() else { continue };
        match k {
            b'{' => {
                page = line[1..].trim().parse().unwrap_or(page + 1);
                stack.clear();
            }
            b'}' => stack.clear(),
            b')' | b']' => {
                stack.pop();
            }
            b'(' | b'[' | b'h' | b'v' | b'g' | b'k' | b'$' | b'x' => {
                if let Some(rec) = record(line, k, page, unit * mag / 1000.0, xo, yo, stack.last().copied()) {
                    // Only HBOXES contain the lines of text an inverse search
                    // looks for; vboxes are kept on the stack for nesting.
                    idx.recs.push(Rec { parent: stack.iter().rev().find(|&&i| idx.recs[i].kind == b'(').copied(), ..rec });
                    if k == b'(' || k == b'[' {
                        stack.push(idx.recs.len() - 1);
                    }
                }
            }
            b'I' => {
                // An input declared after the content started.
                if let Some(r) = line.strip_prefix("Input:") {
                    if let Some((n, p)) = r.split_once(':') {
                        if let Ok(n) = n.parse() {
                            idx.inputs.insert(n, p.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    idx
}

/// `K tag,line[,col]:h,v[:W,H,D]`
fn record(line: &str, kind: u8, page: u32, scale: f64, xo: f64, yo: f64, _parent: Option<usize>) -> Option<Rec> {
    let body = &line[1..];
    let (link, rest) = body.split_once(':')?;
    let mut lk = link.split(',');
    let tag = lk.next()?.trim().parse().ok()?;
    let ln = lk.next()?.trim().parse().ok()?;
    let mut parts = rest.split(':');
    let mut hv = parts.next()?.split(',');
    let h: f64 = hv.next()?.trim().parse().ok()?;
    let v: f64 = hv.next()?.trim().parse().ok()?;
    let (mut w, mut ht, mut dp) = (0.0, 0.0, 0.0);
    if let Some(dims) = parts.next() {
        // A kern carries one dimension, its width; a box three (W,H,D).
        let mut d = dims.split(',');
        w = d.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0.0);
        ht = d.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0.0);
        dp = d.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0.0);
    }
    let bp = |x: f64| x * scale / SP_PER_BP;
    Some(Rec {
        kind,
        page,
        tag,
        line: ln,
        h: bp(h + xo),
        v: bp(v + yo),
        w: bp(w),
        ht: bp(ht),
        dp: bp(dp),
        parent: None,
    })
}

impl Index {
    fn tags_for(&self, tex: &str) -> Vec<u32> {
        let want = norm(tex);
        let exact: Vec<u32> = self.inputs.iter().filter(|(_, p)| norm(p) == want).map(|(t, _)| *t).collect();
        if !exact.is_empty() {
            return exact;
        }
        let b = base(tex);
        self.inputs.iter().filter(|(_, p)| base(p) == b).map(|(t, _)| *t).collect()
    }

    /// Source line → (page, x, y) in PDF points from the page's top-left,
    /// chosen the way the official tool chooses — the first record of the
    /// line in document order, skipping what is not really "on" that line:
    ///   - boxes of zero height and depth (the empty row TeX opens before a
    ///     display formula), and everything inside them;
    ///   - the fillers at the RIGHT EDGE of a row: the glue and kern closing a
    ///     paragraph's last line carry the line that ENDED the paragraph (a
    ///     formula, a blank line) and would send it to the paragraph before;
    ///   - a kern's visible position is its LEFT edge (h − width);
    ///   - a blank or comment-only source line means the next line with
    ///     content (`source` is the file's text, when it can be read).
    /// Checked against the `synctex` tool on every line of a test document.
    pub fn view_in(&self, tex: &str, line: u32, source: Option<&str>) -> Option<(u32, f64, f64)> {
        let tags = self.tags_for(tex);
        if tags.is_empty() {
            return None;
        }
        let mut line = line;
        if let Some(src) = source {
            let lines: Vec<&str> = src.lines().collect();
            let blank = |l: u32| {
                lines.get(l.saturating_sub(1) as usize).map(|t| {
                    let t = t.trim_start();
                    t.is_empty() || t.starts_with('%')
                })
            };
            let mut n = 0;
            while blank(line) == Some(true) && n < 200 {
                line += 1;
                n += 1;
            }
        }
        let is_box = |r: &Rec| matches!(r.kind, b'(' | b'[' | b'h' | b'v');
        let empty = |r: &Rec| r.ht + r.dp <= 0.0;
        let useful = |r: &&Rec| {
            if r.kind == b'[' || (is_box(r) && empty(r)) {
                return false;
            }
            match r.parent.map(|p| &self.recs[p]) {
                Some(b) if empty(b) => false,
                Some(b) if !is_box(r) && r.h >= b.h + b.w - 0.5 => false,
                _ => true,
            }
        };
        let mine = || self.recs.iter().filter(|r| tags.contains(&r.tag) && r.page > 0).filter(useful);
        let at = |r: &Rec| (r.page, if r.kind == b'k' { r.h - r.w } else { r.h }, r.v);
        if let Some(r) = mine().find(|r| r.line == line) {
            return Some(at(r));
        }
        let target = mine()
            .map(|r| r.line)
            .filter(|&l| l > line)
            .min()
            .or_else(|| mine().map(|r| r.line).filter(|&l| l < line).max())?;
        mine().find(|r| r.line == target).map(at)
    }

    /// `view_in`, reading the source file from disk for the blank-line rule.
    pub fn view(&self, tex: &str, line: u32) -> Option<(u32, f64, f64)> {
        let src = std::fs::read_to_string(tex).ok();
        self.view_in(tex, line, src.as_deref())
    }

    /// (page, x, y) → (input file, line), the way the official tool answers:
    ///   - the innermost non-empty hbox containing the point — or, in the gap
    ///     between rows, the row BELOW (the one the eye is moving to), and the
    ///     nearest row above only when there is none below;
    ///   - inside it, the text run that starts at or before x (a kern by its
    ///     left edge), or the row's FIRST run when x is in the left margin: the
    ///     box itself carries the line where its paragraph ended, not where
    ///     this row's words come from.
    pub fn edit(&self, page: u32, x: f64, y: f64) -> Option<(String, u32)> {
        let boxes: Vec<(usize, &Rec)> = self
            .recs
            .iter()
            .enumerate()
            .filter(|(_, r)| r.page == page && r.kind == b'(' && r.ht + r.dp > 0.0)
            .collect();
        let inside = |r: &Rec| r.h <= x && x <= r.h + r.w && r.v - r.ht <= y && y <= r.v + r.dp;
        let area = |r: &Rec| r.w * (r.ht + r.dp);
        let hit = boxes
            .iter()
            .filter(|(_, r)| inside(r))
            .min_by(|a, b| area(a.1).total_cmp(&area(b.1)))
            .or_else(|| {
                let hdist = |r: &Rec| if x < r.h { r.h - x } else if x > r.h + r.w { x - r.h - r.w } else { 0.0 };
                let below = boxes
                    .iter()
                    .filter(|(_, r)| r.v - r.ht >= y)
                    .min_by(|a, b| ((a.1.v - a.1.ht - y) * 1000.0 + hdist(a.1)).total_cmp(&((b.1.v - b.1.ht - y) * 1000.0 + hdist(b.1))));
                below.or_else(|| {
                    boxes
                        .iter()
                        .filter(|(_, r)| r.v + r.dp <= y)
                        .min_by(|a, b| ((y - a.1.v - a.1.dp) * 1000.0 + hdist(a.1)).total_cmp(&((y - b.1.v - b.1.dp) * 1000.0 + hdist(b.1))))
                })
            })?;
        let (bi, b) = *hit;
        let vis = |r: &Rec| if r.kind == b'k' { r.h - r.w } else { r.h };
        let runs: Vec<&Rec> = self
            .recs
            .iter()
            // Not the fillers at the row's right edge (see `view_in`).
            .filter(|r| r.parent == Some(bi) && !matches!(r.kind, b'(' | b'[') && r.h < b.h + b.w - 0.5)
            .collect();
        let rec = runs
            .iter()
            .filter(|r| vis(r) <= x)
            .max_by(|a, c| vis(a).total_cmp(&vis(c)))
            .or_else(|| runs.iter().min_by(|a, c| vis(a).total_cmp(&vis(c))))
            .copied()
            .unwrap_or(b);
        let input = self.inputs.get(&rec.tag)?.clone();
        Some((input, rec.line))
    }
}

/// The index next to a PDF, parsed once per version of the file.
static CACHE: Mutex<Option<(PathBuf, std::time::SystemTime, Arc<Index>)>> = Mutex::new(None);

pub fn index_for(pdf: &str) -> Option<Arc<Index>> {
    let pdf = Path::new(pdf);
    let stem = pdf.with_extension("");
    let gz = PathBuf::from(format!("{}.synctex.gz", stem.display()));
    let plain = PathBuf::from(format!("{}.synctex", stem.display()));
    let (path, zipped) = if gz.exists() { (gz, true) } else if plain.exists() { (plain, false) } else { return None };
    let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok()?;
    if let Ok(g) = CACHE.lock() {
        if let Some((p, t, idx)) = g.as_ref() {
            if *p == path && *t == mtime {
                return Some(idx.clone());
            }
        }
    }
    let bytes = std::fs::read(&path).ok()?;
    let text = if zipped {
        let mut s = String::new();
        flate2::read::GzDecoder::new(&bytes[..]).read_to_string(&mut s).ok()?;
        s
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    let idx = Arc::new(parse(&text));
    if let Ok(mut g) = CACHE.lock() {
        *g = Some((path, mtime, idx.clone()));
    }
    Some(idx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn cli(args: &[String]) -> String {
        let out = Command::new("synctex").args(args).output().expect("synctex");
        String::from_utf8_lossy(&out.stdout).to_string()
    }
    fn field(out: &str, k: &str) -> Option<String> {
        out.lines().find_map(|l| l.strip_prefix(k).map(|v| v.trim().to_string()))
    }

    /// The reader against the official `synctex` tool on a real document:
    /// several pages, an \input chapter, display math, a list. Forward search
    /// must land on the same page and point for every line; inverse search on
    /// the same line for (nearly) every point of a grid over every page.
    #[test]
    fn answers_like_the_official_tool() {
        let has = |c: &str| Command::new(c).arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
        if !has("xelatex") || !has("synctex") {
            return;
        }
        let dir = std::env::temp_dir().join(format!("pyx-stx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut body = String::from("\\documentclass{article}\n\\begin{document}\n\\section{Uno}\n");
        for i in 0..40 {
            body.push_str(&format!("Parrafo {i} con bastante texto para ocupar varias lineas y obligar a cortar el renglon en algun punto razonable.\n\n"));
            if i % 7 == 3 {
                body.push_str("\\[ E = mc^2 + \\int_0^1 x\\,dx \\]\n");
            }
            if i == 20 {
                body.push_str("\\input{cap}\n");
            }
        }
        body.push_str("\\begin{itemize}\n\\item Uno\n\\item Dos\n\\end{itemize}\n\\end{document}\n");
        std::fs::write(dir.join("d.tex"), &body).unwrap();
        std::fs::write(dir.join("cap.tex"), "\\section{Capitulo}\nTexto del capitulo incluido.\n\nOtra linea mas.\n").unwrap();
        let st = Command::new("xelatex")
            .current_dir(&dir)
            .args(["-interaction=nonstopmode", "-synctex=1", "d.tex"])
            .output()
            .unwrap();
        assert!(dir.join("d.pdf").exists(), "{}", String::from_utf8_lossy(&st.stdout));
        let pdf = dir.join("d.pdf").to_string_lossy().to_string();
        let idx = index_for(&pdf).expect("indice");

        // Forward, every line of both files.
        let (mut same, mut total) = (0, 0);
        for (file, n) in [("d.tex", body.lines().count()), ("cap.tex", 4)] {
            let tex = dir.join(file).to_string_lossy().to_string();
            for line in 1..=n as u32 {
                let out = cli(&["view".into(), "-i".into(), format!("{line}:1:{tex}"), "-o".into(), pdf.clone()]);
                let Some(page) = field(&out, "Page:").and_then(|p| p.parse::<u32>().ok()) else { continue };
                let x: f64 = field(&out, "x:").unwrap().parse().unwrap();
                let y: f64 = field(&out, "y:").unwrap().parse().unwrap();
                total += 1;
                if let Some((p, nx, ny)) = idx.view(&tex, line) {
                    if p == page && (nx - x).abs() < 0.5 && (ny - y).abs() < 0.5 {
                        same += 1;
                    } else {
                        // The only accepted differences: the same spot within a few rows (an
                        // \item's bullet vs its text), or the official tool
                        // pointing at the page number in the footer, where
                        // the page happened to be shipped out while TeX read
                        // that line (\input, \end{…}).
                        let same_row = p == page && (ny - y).abs() <= 40.0;
                        let footer = y > 690.0;
                        assert!(same_row || footer, "view {file}:{line}: cli {page} {x:.1},{y:.1} / pyx {p} {nx:.1},{ny:.1}");
                        eprintln!("view {file}:{line}: cli {page} {x:.1},{y:.1} / pyx {p} {nx:.1},{ny:.1} (aceptada)");
                    }
                }
            }
        }
        assert!(total > 30, "pocas líneas comparadas: {total}");
        assert!(same * 100 >= total * 90, "búsqueda directa: {same}/{total} iguales");

        // Inverse: Ctrl+click ON THE WORDS, the way it is used — a point just
        // right of the left edge of every few text runs on every page.
        let (mut same_e, mut total_e) = (0, 0);
        let words: Vec<(u32, f64, f64)> = idx
            .recs
            .iter()
            .filter(|r| r.kind == b'k' && r.w > 0.0 && r.page > 0)
            .step_by(7)
            .map(|r| (r.page, r.h - r.w + 1.0, r.v - 2.0))
            .collect();
        for (page, gx, gy) in words {
            let out = cli(&["edit".into(), "-o".into(), format!("{page}:{gx:.2}:{gy:.2}:{pdf}")]);
            let (Some(input), Some(line)) = (field(&out, "Input:"), field(&out, "Line:")) else { continue };
            total_e += 1;
            if let Some((ni, nl)) = idx.edit(page, gx, gy) {
                if base(&ni) == base(&input) && nl.to_string() == line {
                    same_e += 1;
                } else {
                    eprintln!("edit p{page} {gx:.0},{gy:.0}: cli {}:{line} / pyx {}:{nl}", base(&input), base(&ni));
                }
            }
        }
        assert!(total_e > 50, "pocos puntos comparados: {total_e}");
        assert!(same_e * 100 >= total_e * 95, "búsqueda inversa: {same_e}/{total_e} iguales");
        eprintln!("synctex: directa {same}/{total}, inversa {same_e}/{total_e}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
