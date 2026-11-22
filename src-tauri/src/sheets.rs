//! Cells of an Excel workbook or a CSV, for the document's \hoja and \celda.
//!
//! No Python involved: the compiler asks for the cells a document places and
//! this reads them straight from the file — the values Excel SAVED, formulas
//! included (a workbook keeps each formula's last result). A file is parsed
//! once and kept while its date and size do not change, so a compile after an
//! edit in Excel (and Ctrl+S there) reads the new values, and one without
//! changes costs nothing.
//!
//! .xlsx / .xlsm are zips of XML (the zip crate and quick-xml, both already
//! in Pyx). A CSV is read as Excel shows it: row 1 is the first line, and the
//! Spanish Excel's `;` separator and decimal comma are understood.

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};

type Grid = HashMap<(u32, u32), Value>; // (row, col) -> value, 1-based

struct Book {
    names: Vec<String>,
    sheets: HashMap<String, Grid>,
    /// Names defined in Excel (Formulas -> Name Manager), lowercase -> "Hoja1!$B$2".
    defined: HashMap<String, String>,
    /// Why a cell has no value (a formula Excel never computed and Pyx could
    /// not either): (sheet, (row, col)) -> message.
    why_empty: HashMap<(String, (u32, u32)), String>,
    /// Formulas without a saved result, until they are worked out.
    pending: HashMap<(String, (u32, u32)), String>,
}

/// What a worksheet holds besides its values.
#[derive(Default)]
struct SheetExtra {
    /// Merged areas: (top row, left col, bottom row, right col).
    merges: Vec<(u32, u32, u32, u32)>,
    /// Formulas with no saved result: position -> formula text (no '=').
    formulas: Vec<((u32, u32), String)>,
}

/// The UI language, for the messages that end up in the problems panel.
static EN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub fn set_english(en: bool) {
    EN.store(en, std::sync::atomic::Ordering::Relaxed);
}
fn tr(es: String, en: String) -> String {
    if EN.load(std::sync::atomic::Ordering::Relaxed) { en } else { es }
}

type Stamp = (u128, u64);
static CACHE: Mutex<Option<HashMap<String, (Stamp, Arc<Book>)>>> = Mutex::new(None);

fn stamp(p: &Path) -> Result<Stamp, String> {
    let m = std::fs::metadata(p).map_err(|_| tr(format!("No existe {}.", p.display()), format!("{} does not exist.", p.display())))?;
    let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
    Ok((t, m.len()))
}

fn load(path: &str) -> Result<Arc<Book>, String> {
    let p = Path::new(path);
    let st = stamp(p)?;
    if let Some((s, b)) = CACHE.lock().ok().and_then(|c| c.as_ref().and_then(|m| m.get(path).cloned())) {
        if s == st {
            return Ok(b);
        }
    }
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let book = match ext.as_str() {
        "xlsx" | "xlsm" => read_xlsx(p)?,
        "csv" | "txt" | "tsv" => read_csv(p)?,
        "xls" => return Err(tr("El formato .xls antiguo no se puede leer: guárdalo como .xlsx desde Excel.".into(), "The old .xls format cannot be read: save it as .xlsx from Excel.".into())),
        "ods" => return Err(tr("Las hojas .ods no se pueden leer: guárdala como .xlsx.".into(), ".ods sheets cannot be read: save it as .xlsx.".into())),
        _ => return Err(tr(format!("{} no es un libro de Excel (.xlsx) ni un .csv.", p.display()), format!("{} is neither an Excel workbook (.xlsx) nor a .csv.", p.display()))),
    };
    let book = Arc::new(book);
    if let Ok(mut c) = CACHE.lock() {
        c.get_or_insert_with(HashMap::new).insert(path.to_string(), (st, book.clone()));
    }
    Ok(book)
}

/* ---------------- .xlsx ---------------- */

fn zip_text(z: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    let mut f = z.by_name(name).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

fn entity(name: &[u8]) -> String {
    match name {
        b"amp" => "&".into(),
        b"lt" => "<".into(),
        b"gt" => ">".into(),
        b"quot" => "\"".into(),
        b"apos" => "'".into(),
        n if n.first() == Some(&b'#') => {
            let s = String::from_utf8_lossy(&n[1..]).to_string();
            let code = if let Some(h) = s.strip_prefix('x').or_else(|| s.strip_prefix('X')) {
                u32::from_str_radix(h, 16).ok()
            } else {
                s.parse::<u32>().ok()
            };
            code.and_then(char::from_u32).map(|c| c.to_string()).unwrap_or_default()
        }
        _ => String::new(),
    }
}

fn attr(e: &quick_xml::events::BytesStart, key: &[u8]) -> Option<String> {
    e.attributes().flatten().find(|a| a.key.as_ref() == key || a.key.local_name().as_ref() == key).map(|a| {
        let raw = String::from_utf8_lossy(&a.value).to_string();
        raw.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
    })
}

fn shared_strings(xml: &str) -> Vec<String> {
    let mut r = Reader::from_str(xml);
    let mut out = Vec::new();
    let (mut cur, mut in_t, mut in_si, mut in_ph) = (String::new(), false, false, false);
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                b"si" => { in_si = true; cur.clear(); }
                b"t" if in_si && !in_ph => in_t = true,
                b"rPh" => in_ph = true, // phonetic guide: not part of the text
                _ => {}
            },
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"si" => { in_si = false; out.push(std::mem::take(&mut cur)); }
                b"t" => in_t = false,
                b"rPh" => in_ph = false,
                _ => {}
            },
            Ok(Event::Empty(e)) if e.local_name().as_ref() == b"si" => out.push(String::new()),
            Ok(Event::Text(t)) if in_t => cur.push_str(&String::from_utf8_lossy(&t)),
            Ok(Event::GeneralRef(g)) if in_t => cur.push_str(&entity(&g)),
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

fn cell_pos(r: &str) -> Option<(u32, u32)> {
    let letters: String = r.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    let digits = &r[letters.len()..];
    if letters.is_empty() || digits.is_empty() {
        return None;
    }
    let mut col = 0u32;
    for ch in letters.to_ascii_uppercase().chars() {
        col = col * 26 + (ch as u32 - 64);
    }
    Some((digits.parse().ok()?, col))
}

fn number(s: &str) -> Value {
    s.trim().parse::<f64>().ok().and_then(serde_json::Number::from_f64).map(Value::Number).unwrap_or_else(|| Value::String(s.to_string()))
}

fn sheet_cells(xml: &str, strings: &[String]) -> (Grid, SheetExtra) {
    let mut r = Reader::from_str(xml);
    let mut g = Grid::new();
    let mut extra = SheetExtra::default();
    let (mut pos, mut kind, mut text, mut formula) = (None::<(u32, u32)>, String::new(), String::new(), String::new());
    let (mut in_v, mut in_t, mut in_f) = (false, false, false);
    // A <row> or <c> without its r="…" (some programs leave them out): the
    // next row / the next column, as Excel reads them.
    let (mut row_no, mut col_no) = (0u32, 0u32);
    let open_cell = |e: &quick_xml::events::BytesStart, row_no: u32, col_no: &mut u32| -> Option<(u32, u32)> {
        let p = attr(e, b"r").and_then(|s| cell_pos(&s)).unwrap_or((row_no.max(1), *col_no + 1));
        *col_no = p.1;
        Some(p)
    };
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                b"row" => {
                    row_no = attr(&e, b"r").and_then(|s| s.parse().ok()).unwrap_or(row_no + 1);
                    col_no = 0;
                }
                b"c" => {
                    pos = open_cell(&e, row_no, &mut col_no);
                    kind = attr(&e, b"t").unwrap_or_default();
                    text.clear();
                    formula.clear();
                }
                b"v" => in_v = true,
                b"t" => in_t = true,
                b"f" => in_f = true,
                _ => {}
            },
            Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                b"row" => {
                    row_no = attr(&e, b"r").and_then(|s| s.parse().ok()).unwrap_or(row_no + 1);
                    col_no = 0;
                }
                b"c" => {
                    let _ = open_cell(&e, row_no, &mut col_no);
                }
                b"mergeCell" => {
                    if let Some(rf) = attr(&e, b"ref") {
                        let mut it = rf.split(':');
                        if let (Some(a), Some(b)) = (it.next().and_then(cell_pos), it.next().and_then(cell_pos)) {
                            extra.merges.push((a.0.min(b.0), a.1.min(b.1), a.0.max(b.0), a.1.max(b.1)));
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"v" => in_v = false,
                b"t" => in_t = false,
                b"f" => in_f = false,
                b"c" => {
                    if let Some(p) = pos.take() {
                        let v = match kind.as_str() {
                            "s" => text.trim().parse::<usize>().ok().and_then(|i| strings.get(i)).map(|s| Value::String(s.clone())),
                            "b" => Some(Value::Bool(text.trim() == "1")),
                            "str" | "inlineStr" | "e" => Some(Value::String(text.clone())),
                            _ if text.trim().is_empty() => None,
                            _ => Some(number(&text)),
                        };
                        match v {
                            Some(v) if v != Value::String(String::new()) => {
                                g.insert(p, v);
                            }
                            // A formula whose result was never saved.
                            _ if !formula.trim().is_empty() => extra.formulas.push((p, formula.trim().to_string())),
                            _ => {}
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::Text(t)) if in_f => formula.push_str(&String::from_utf8_lossy(&t)),
            Ok(Event::GeneralRef(gr)) if in_f => formula.push_str(&entity(&gr)),
            Ok(Event::Text(t)) if in_v || in_t => text.push_str(&String::from_utf8_lossy(&t)),
            Ok(Event::GeneralRef(gr)) if in_v || in_t => text.push_str(&entity(&gr)),
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    (g, extra)
}

/// A merged area shows the value of its top-left cell in every cell of it:
/// `\celda{D18}` on a cell merged with C18 reads C18.
fn spread_merges(g: &mut Grid, merges: &[(u32, u32, u32, u32)]) {
    for &(r1, c1, r2, c2) in merges {
        let Some(v) = g.get(&(r1, c1)).cloned() else { continue };
        if (r2 - r1 + 1) as u64 * (c2 - c1 + 1) as u64 > 100_000 {
            continue;
        }
        for r in r1..=r2 {
            for c in c1..=c2 {
                g.entry((r, c)).or_insert_with(|| v.clone());
            }
        }
    }
}

/* ---------------- formulas without a saved result ----------------
 * Excel saves each formula's last result next to it, and that is what Pyx
 * reads. A workbook written by another program may carry the formula alone;
 * then the usual ones are worked out here: + - * / ^ & and %, parentheses,
 * references and ranges (of any sheet) and SUM, AVERAGE, MIN, MAX, COUNT,
 * PRODUCT, ROUND, ROUNDUP, ROUNDDOWN, ABS, SQRT, POWER, PI, EXP, LN, LOG10,
 * INT, IF. Anything else says so instead of leaving the cell blank. */
#[derive(Clone, Debug)]
enum Fv {
    N(f64),
    S(String),
    B(bool),
    L(Vec<Fv>),
}

fn fv_num(v: &Fv) -> Result<f64, String> {
    match v {
        Fv::N(n) => Ok(*n),
        Fv::B(b) => Ok(if *b { 1.0 } else { 0.0 }),
        Fv::S(s) if s.trim().is_empty() => Ok(0.0),
        Fv::S(s) => s.trim().replace(',', ".").parse().map_err(|_| format!("«{s}» no es un número")),
        Fv::L(l) => l.first().map(fv_num).unwrap_or(Ok(0.0)),
    }
}

fn flat(v: &Fv, out: &mut Vec<f64>) {
    match v {
        Fv::L(l) => l.iter().for_each(|x| flat(x, out)),
        Fv::N(n) => out.push(*n),
        Fv::B(b) => out.push(if *b { 1.0 } else { 0.0 }),
        Fv::S(_) => {}
    }
}

struct Eval<'a> {
    book: &'a Book,
    sheet: String,
    t: Vec<char>,
    i: usize,
    depth: u32,
}

impl<'a> Eval<'a> {
    fn ws(&mut self) {
        while self.i < self.t.len() && self.t[self.i].is_whitespace() {
            self.i += 1;
        }
    }
    fn peek(&mut self) -> Option<char> {
        self.ws();
        self.t.get(self.i).copied()
    }
    fn eat(&mut self, c: char) -> bool {
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn cell(&self, sheet: &str, p: (u32, u32)) -> Result<Fv, String> {
        if let Some(v) = self.book.sheets.get(sheet).and_then(|g| g.get(&p)) {
            return Ok(match v {
                Value::Number(n) => Fv::N(n.as_f64().unwrap_or(0.0)),
                Value::Bool(b) => Fv::B(*b),
                Value::String(s) => Fv::S(s.clone()),
                _ => Fv::S(String::new()),
            });
        }
        // Another formula without a result: work it out too.
        if self.depth < 40 {
            if let Some(f) = self.book.pending.get(&(sheet.to_string(), p)) {
                return eval_formula(self.book, sheet, f, self.depth + 1);
            }
        }
        Ok(Fv::S(String::new()))
    }
    fn expr(&mut self) -> Result<Fv, String> {
        let a = self.concat()?;
        for op in ["<>", ">=", "<=", "=", "<", ">"] {
            self.ws();
            let s: String = self.t[self.i..].iter().take(op.len()).collect();
            if s == op {
                self.i += op.len();
                let b = self.concat()?;
                let (x, y) = (fv_num(&a).unwrap_or(f64::NAN), fv_num(&b).unwrap_or(f64::NAN));
                return Ok(Fv::B(match op {
                    "<>" => x != y,
                    ">=" => x >= y,
                    "<=" => x <= y,
                    "=" => x == y,
                    "<" => x < y,
                    _ => x > y,
                }));
            }
        }
        Ok(a)
    }
    fn concat(&mut self) -> Result<Fv, String> {
        let mut a = self.add()?;
        while self.eat('&') {
            let b = self.add()?;
            let s = |v: &Fv| match v {
                Fv::S(s) => s.clone(),
                Fv::N(n) => if n.fract() == 0.0 { format!("{}", *n as i64) } else { format!("{n}") },
                Fv::B(b) => if *b { "TRUE".into() } else { "FALSE".into() },
                Fv::L(_) => String::new(),
            };
            a = Fv::S(s(&a) + &s(&b));
        }
        Ok(a)
    }
    fn add(&mut self) -> Result<Fv, String> {
        let mut a = self.mul()?;
        loop {
            if self.eat('+') {
                a = Fv::N(fv_num(&a)? + fv_num(&self.mul()?)?);
            } else if self.eat('-') {
                a = Fv::N(fv_num(&a)? - fv_num(&self.mul()?)?);
            } else {
                return Ok(a);
            }
        }
    }
    fn mul(&mut self) -> Result<Fv, String> {
        let mut a = self.pow()?;
        loop {
            if self.eat('*') {
                a = Fv::N(fv_num(&a)? * fv_num(&self.pow()?)?);
            } else if self.eat('/') {
                let d = fv_num(&self.pow()?)?;
                if d == 0.0 {
                    return Err("#¡DIV/0!".into());
                }
                a = Fv::N(fv_num(&a)? / d);
            } else {
                return Ok(a);
            }
        }
    }
    fn pow(&mut self) -> Result<Fv, String> {
        let a = self.unary()?;
        if self.eat('^') {
            let b = self.unary()?;
            return Ok(Fv::N(fv_num(&a)?.powf(fv_num(&b)?)));
        }
        Ok(a)
    }
    fn unary(&mut self) -> Result<Fv, String> {
        if self.eat('-') {
            return Ok(Fv::N(-fv_num(&self.unary()?)?));
        }
        if self.eat('+') {
            return self.unary();
        }
        let v = self.primary()?;
        if self.eat('%') {
            return Ok(Fv::N(fv_num(&v)? / 100.0));
        }
        Ok(v)
    }
    fn primary(&mut self) -> Result<Fv, String> {
        match self.peek() {
            Some('(') => {
                self.i += 1;
                let v = self.expr()?;
                if !self.eat(')') {
                    return Err("falta «)»".into());
                }
                Ok(v)
            }
            Some('"') => {
                self.i += 1;
                let mut s = String::new();
                while self.i < self.t.len() {
                    let c = self.t[self.i];
                    self.i += 1;
                    if c == '"' {
                        if self.t.get(self.i) == Some(&'"') {
                            s.push('"');
                            self.i += 1;
                            continue;
                        }
                        return Ok(Fv::S(s));
                    }
                    s.push(c);
                }
                Err("texto sin cerrar".into())
            }
            Some(c) if c.is_ascii_digit() || c == '.' => {
                let st = self.i;
                while self.i < self.t.len() && (self.t[self.i].is_ascii_digit() || self.t[self.i] == '.' || ((self.t[self.i] == 'E' || self.t[self.i] == 'e') && self.i + 1 < self.t.len()) || ((self.t[self.i] == '+' || self.t[self.i] == '-') && matches!(self.t.get(self.i.wrapping_sub(1)), Some('E') | Some('e')))) {
                    self.i += 1;
                }
                let s: String = self.t[st..self.i].iter().collect();
                s.parse().map(Fv::N).map_err(|_| format!("número «{s}»"))
            }
            Some(_) => self.name_or_ref(),
            None => Err("fórmula incompleta".into()),
        }
    }
    fn name_or_ref(&mut self) -> Result<Fv, String> {
        self.ws();
        // 'Sheet name'!A1  or  Sheet!A1
        let mut sheet = None;
        if self.t.get(self.i) == Some(&'\'') {
            let st = self.i + 1;
            let mut j = st;
            while j < self.t.len() && !(self.t[j] == '\'' && self.t.get(j + 1) != Some(&'\'')) {
                j += if self.t[j] == '\'' { 2 } else { 1 };
            }
            let name: String = self.t[st..j.min(self.t.len())].iter().collect::<String>().replace("''", "'");
            self.i = j + 1;
            if !self.eat('!') {
                return Err("referencia de hoja".into());
            }
            sheet = Some(name);
        }
        let st = self.i;
        while self.i < self.t.len() && (self.t[self.i].is_alphanumeric() || matches!(self.t[self.i], '_' | '.' | '$')) {
            self.i += 1;
        }
        let mut word: String = self.t[st..self.i].iter().collect();
        if sheet.is_none() && self.t.get(self.i) == Some(&'!') {
            self.i += 1;
            sheet = Some(word.clone());
            let st = self.i;
            while self.i < self.t.len() && (self.t[self.i].is_alphanumeric() || self.t[self.i] == '$') {
                self.i += 1;
            }
            word = self.t[st..self.i].iter().collect();
        }
        let upper = word.to_uppercase();
        let fname = upper.trim_start_matches("_XLFN.").to_string();
        if sheet.is_none() && self.peek() == Some('(') {
            self.i += 1;
            let mut args = Vec::new();
            if !self.eat(')') {
                loop {
                    args.push(self.expr()?);
                    if self.eat(')') {
                        break;
                    }
                    if !self.eat(',') && !self.eat(';') {
                        return Err("falta «,» o «)»".into());
                    }
                }
            }
            return call(&fname, args);
        }
        match fname.as_str() {
            "TRUE" if sheet.is_none() => return Ok(Fv::B(true)),
            "FALSE" if sheet.is_none() => return Ok(Fv::B(false)),
            _ => {}
        }
        let sh = sheet.unwrap_or_else(|| self.sheet.clone());
        let a = cell_pos(&word.replace('$', "")).ok_or_else(|| format!("«{word}» no se puede calcular"))?;
        if self.eat(':') {
            let st = self.i;
            while self.i < self.t.len() && (self.t[self.i].is_alphanumeric() || self.t[self.i] == '$') {
                self.i += 1;
            }
            let w2: String = self.t[st..self.i].iter().collect();
            let b = cell_pos(&w2.replace('$', "")).ok_or_else(|| format!("rango «{word}:{w2}»"))?;
            if (b.0.abs_diff(a.0) + 1) as u64 * (b.1.abs_diff(a.1) + 1) as u64 > 200_000 {
                return Err("rango demasiado grande".into());
            }
            let mut l = Vec::new();
            for r in a.0.min(b.0)..=a.0.max(b.0) {
                for c in a.1.min(b.1)..=a.1.max(b.1) {
                    l.push(self.cell(&sh, (r, c))?);
                }
            }
            return Ok(Fv::L(l));
        }
        self.cell(&sh, a)
    }
}

fn call(f: &str, args: Vec<Fv>) -> Result<Fv, String> {
    let nums = |args: &[Fv]| {
        let mut v = Vec::new();
        args.iter().for_each(|a| flat(a, &mut v));
        v
    };
    let arg = |i: usize| args.get(i).map(fv_num).unwrap_or(Ok(0.0));
    let round = |x: f64, d: f64, mode: i8| {
        let k = 10f64.powi(d as i32);
        let y = x * k;
        let r = match mode { 0 => y.abs().round().copysign(y), 1 => y.abs().ceil().copysign(y), _ => y.abs().floor().copysign(y) };
        r / k
    };
    Ok(Fv::N(match f {
        "SUM" => nums(&args).iter().sum(),
        "AVERAGE" => { let v = nums(&args); if v.is_empty() { return Err("#¡DIV/0!".into()) } v.iter().sum::<f64>() / v.len() as f64 }
        "MIN" => nums(&args).into_iter().fold(f64::INFINITY, f64::min),
        "MAX" => nums(&args).into_iter().fold(f64::NEG_INFINITY, f64::max),
        "COUNT" => nums(&args).len() as f64,
        "PRODUCT" => nums(&args).iter().product(),
        "ROUND" => round(arg(0)?, arg(1)?, 0),
        "ROUNDUP" => round(arg(0)?, arg(1)?, 1),
        "ROUNDDOWN" => round(arg(0)?, arg(1)?, 2),
        "ABS" => arg(0)?.abs(),
        "SQRT" => arg(0)?.sqrt(),
        "POWER" => arg(0)?.powf(arg(1)?),
        "PI" => std::f64::consts::PI,
        "EXP" => arg(0)?.exp(),
        "LN" => arg(0)?.ln(),
        "LOG10" => arg(0)?.log10(),
        "INT" => arg(0)?.floor(),
        "IF" => {
            let c = args.first().map(fv_num).unwrap_or(Ok(0.0))? != 0.0;
            return Ok(args.get(if c { 1 } else { 2 }).cloned().unwrap_or(Fv::B(c)));
        }
        _ => return Err(format!("la función {f} no se puede calcular")),
    }))
}

fn eval_formula(book: &Book, sheet: &str, f: &str, depth: u32) -> Result<Fv, String> {
    let mut e = Eval { book, sheet: sheet.to_string(), t: f.trim_start_matches('=').chars().collect(), i: 0, depth };
    let v = e.expr()?;
    if e.peek().is_some() {
        return Err("no se entiende la fórmula".into());
    }
    Ok(v)
}

/// Work out every formula that came without its result.
fn resolve_formulas(book: &mut Book) {
    let pending: Vec<((String, (u32, u32)), String)> = book.pending.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let mut done = Vec::new();
    for ((sheet, p), f) in pending {
        match eval_formula(book, &sheet, &f, 0) {
            Ok(v) => {
                let v = match v {
                    Fv::N(n) if n.is_finite() => serde_json::Number::from_f64(n).map(Value::Number).unwrap_or(Value::Null),
                    Fv::S(s) => Value::String(s),
                    Fv::B(b) => Value::Bool(b),
                    Fv::L(l) => l.first().map(|x| match x { Fv::N(n) => serde_json::Number::from_f64(*n).map(Value::Number).unwrap_or(Value::Null), Fv::S(s) => Value::String(s.clone()), Fv::B(b) => Value::Bool(*b), _ => Value::Null }).unwrap_or(Value::Null),
                    _ => Value::Null,
                };
                done.push((sheet, p, Ok(v)));
            }
            Err(e) => done.push((sheet, p, Err(format!("={f}: {e}")))),
        }
    }
    for (sheet, p, r) in done {
        match r {
            Ok(v) => {
                if let Some(g) = book.sheets.get_mut(&sheet) {
                    g.insert(p, v);
                }
            }
            Err(e) => {
                book.why_empty.insert((sheet, p), tr(
                    format!("la fórmula no tiene resultado guardado y Pyx no la sabe calcular ({e}). Ábrelo en Excel y guárdalo."),
                    format!("the formula has no saved result and Pyx cannot work it out ({e}). Open it in Excel and save it."),
                ));
            }
        }
    }
}

fn read_xlsx(p: &Path) -> Result<Book, String> {
    let f = std::fs::File::open(p).map_err(|e| tr(format!("No se pudo abrir {}: {e}", p.display()), format!("Could not open {}: {e}", p.display())))?;
    let mut z = zip::ZipArchive::new(f).map_err(|_| tr(format!("{} no es un .xlsx válido.", p.display()), format!("{} is not a valid .xlsx.", p.display())))?;
    let wb = zip_text(&mut z, "xl/workbook.xml").ok_or_else(|| tr("El libro no tiene xl/workbook.xml.".into(), "The workbook has no xl/workbook.xml.".into()))?;
    let rels = zip_text(&mut z, "xl/_rels/workbook.xml.rels").unwrap_or_default();
    let strings = zip_text(&mut z, "xl/sharedStrings.xml").map(|s| shared_strings(&s)).unwrap_or_default();
    // rId -> target part
    let mut targets = HashMap::new();
    let mut rr = Reader::from_str(&rels);
    loop {
        match rr.read_event() {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) if e.local_name().as_ref() == b"Relationship" => {
                if let (Some(id), Some(t)) = (attr(&e, b"Id"), attr(&e, b"Target")) {
                    let t = t.trim_start_matches('/');
                    let t = if t.starts_with("xl/") { t.to_string() } else { format!("xl/{t}") };
                    targets.insert(id, t);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    let mut names = Vec::new();
    let mut sheets = HashMap::new();
    let mut wr = Reader::from_str(&wb);
    let mut order = Vec::new();
    let mut defined = HashMap::new();
    let mut in_name: Option<(String, String)> = None; // (name, text so far)
    loop {
        match wr.read_event() {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) if e.local_name().as_ref() == b"sheet" => {
                if let (Some(n), Some(id)) = (attr(&e, b"name"), attr(&e, b"id")) {
                    order.push((n, id));
                }
            }
            // <definedName name="Caudal">Datos!$B$4</definedName> (built-in
            // ones like _xlnm.Print_Area are skipped)
            Ok(Event::Start(e)) if e.local_name().as_ref() == b"definedName" => {
                in_name = attr(&e, b"name").filter(|n| !n.starts_with("_xlnm.")).map(|n| (n, String::new()));
            }
            Ok(Event::Text(t)) if in_name.is_some() => {
                if let Some((_, buf)) = in_name.as_mut() {
                    buf.push_str(&String::from_utf8_lossy(t.as_ref()));
                }
            }
            Ok(Event::GeneralRef(r)) if in_name.is_some() => {
                if let Some((_, buf)) = in_name.as_mut() {
                    buf.push_str(&entity(r.as_ref()));
                }
            }
            Ok(Event::End(e)) if e.local_name().as_ref() == b"definedName" => {
                if let Some((n, txt)) = in_name.take() {
                    defined.insert(n.to_lowercase(), txt.trim().to_string());
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    let mut pending = HashMap::new();
    let mut merges = Vec::new();
    for (n, id) in order {
        let part = targets.get(&id).cloned().unwrap_or_default();
        let (grid, extra) = zip_text(&mut z, &part).map(|x| sheet_cells(&x, &strings)).unwrap_or_default();
        for (p, f) in extra.formulas {
            pending.insert((n.clone(), p), f);
        }
        merges.push((n.clone(), extra.merges));
        names.push(n.clone());
        sheets.insert(n, grid);
    }
    let mut book = Book { names, sheets, defined, why_empty: HashMap::new(), pending };
    resolve_formulas(&mut book);
    book.pending.clear();
    // Merged areas last: a merged formula cell spreads its computed value too.
    for (n, m) in merges {
        if let Some(g) = book.sheets.get_mut(&n) {
            spread_merges(g, &m);
        }
    }
    Ok(book)
}

/* ---------------- .csv ---------------- */

fn decode(bytes: &[u8]) -> String {
    let b = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    match std::str::from_utf8(b) {
        Ok(s) => s.to_string(),
        Err(_) => b.iter().map(|&c| c as char).collect(), // Latin-1 / Windows-1252
    }
}

fn csv_value(field: &str, decimal_comma: bool) -> Option<Value> {
    let t = field.trim();
    if t.is_empty() {
        return None;
    }
    let s: String = t.chars().filter(|c| *c != '\u{a0}' && *c != ' ').collect();
    let s = if decimal_comma && s.contains(',') { s.replace('.', "").replace(',', ".") } else { s };
    let numeric = !s.is_empty() && s.chars().all(|c| c.is_ascii_digit() || "+-.eE".contains(c)) && s.chars().any(|c| c.is_ascii_digit());
    if numeric {
        if let Some(n) = s.parse::<f64>().ok().and_then(serde_json::Number::from_f64) {
            return Some(Value::Number(n));
        }
    }
    Some(Value::String(t.to_string()))
}

fn read_csv(p: &Path) -> Result<Book, String> {
    let text = decode(&std::fs::read(p).map_err(|e| tr(format!("No se pudo leer {}: {e}", p.display()), format!("Could not read {}: {e}", p.display())))?);
    let sample: String = text.lines().take(20).collect::<Vec<_>>().join("\n");
    let count = |c: char| sample.matches(c).count();
    let delim = [';', '\t', '|', ',']
        .into_iter()
        .max_by_key(|&c| (count(c), if c == ';' { 1 } else { 0 }))
        .filter(|&c| count(c) > 0)
        .unwrap_or(',');
    let decimal_comma = delim != ',';
    let mut g = Grid::new();
    let (mut row, mut col) = (1u32, 1u32);
    let (mut field, mut quoted) = (String::new(), false);
    let mut chars = text.chars().peekable();
    let mut push = |row: u32, col: u32, f: &mut String, g: &mut Grid| {
        if let Some(v) = csv_value(f, decimal_comma) {
            g.insert((row, col), v);
        }
        f.clear();
    };
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') { field.push('"'); chars.next(); } else { quoted = false; }
            } else {
                field.push(c);
            }
        } else if c == '"' && field.trim().is_empty() {
            field.clear();
            quoted = true;
        } else if c == delim {
            push(row, col, &mut field, &mut g);
            col += 1;
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.peek() == Some(&'\n') { chars.next(); }
            push(row, col, &mut field, &mut g);
            row += 1;
            col = 1;
        } else {
            field.push(c);
        }
    }
    push(row, col, &mut field, &mut g);
    Ok(Book { names: vec![String::new()], sheets: HashMap::from([(String::new(), g)]), defined: HashMap::new(), why_empty: HashMap::new(), pending: HashMap::new() })
}

/* ---------------- addresses ---------------- */

/// "Hoja 2!B2:D5" -> (Some("Hoja 2"), (2,2), (5,4)); "E4" -> (None, (4,5), (4,5)).
fn parse_ref(r: &str) -> Result<(Option<String>, (u32, u32), (u32, u32)), String> {
    let r = r.trim();
    let (sheet, cells) = match r.rfind('!') {
        Some(i) => (Some(r[..i].trim().trim_matches('\'').to_string()), &r[i + 1..]),
        None => (None, r),
    };
    let cells = cells.replace('$', "");
    let bad = || tr(format!("«{r}» no es una dirección de Excel (E4, E4:F8, Hoja2!B2:D5) ni un nombre definido en el libro."), format!("“{r}” is not an Excel address (E4, E4:F8, Sheet2!B2:D5) nor a name defined in the workbook."));
    let mut parts = cells.split(':');
    let a = cell_pos(parts.next().unwrap_or("").trim()).ok_or_else(bad)?;
    let b = match parts.next() {
        Some(x) => cell_pos(x.trim()).ok_or_else(bad)?,
        None => a,
    };
    if parts.next().is_some() {
        return Err(bad());
    }
    Ok((sheet, (a.0.min(b.0), a.1.min(b.1)), (a.0.max(b.0), a.1.max(b.1))))
}

#[derive(Serialize)]
pub struct Cells {
    pub ok: bool,
    /// Rows of values (one row for a single cell or a row range).
    pub grid: Vec<Vec<Value>>,
    pub error: String,
}

/// The values at `refs` of `path`, sheet `sheet` by default (the first one
/// when empty). An error that concerns the whole file (missing, unreadable)
/// is the Err; one that concerns one address is that address's `error`.
pub fn values(path: &str, sheet: Option<String>, refs: &[String]) -> Result<Vec<Cells>, String> {
    let book = load(path)?;
    let default = sheet.filter(|s| !s.is_empty());
    Ok(refs
        .iter()
        .map(|r| {
            let fail = |e: String| Cells { ok: false, grid: vec![], error: e };
            // An address, or else a name defined in the workbook.
            let parsed = parse_ref(r).or_else(|e| match book.defined.get(&r.trim().to_lowercase()) {
                Some(target) => parse_ref(target),
                None => Err(e),
            });
            let (s, (r1, c1), (r2, c2)) = match parsed {
                Ok(x) => x,
                Err(e) => return fail(e),
            };
            let name = s.or_else(|| default.clone()).unwrap_or_else(|| book.names.first().cloned().unwrap_or_default());
            let Some(grid) = book.sheets.get(&name) else {
                return fail(tr(format!("No hay ninguna hoja «{name}». Hojas: {}.", book.names.join(", ")), format!("There is no sheet “{name}”. Sheets: {}.", book.names.join(", "))));
            };
            if (r2 - r1 + 1) as u64 * (c2 - c1 + 1) as u64 > 200_000 {
                return fail(tr(format!("El rango {r} es demasiado grande."), format!("The range {r} is too large.")));
            }
            // One cell that has no value because of its formula: say why.
            if r1 == r2 && c1 == c2 && !grid.contains_key(&(r1, c1)) {
                if let Some(why) = book.why_empty.get(&(name.clone(), (r1, c1))) {
                    return fail(why.clone());
                }
            }
            let rows = (r1..=r2).map(|row| (c1..=c2).map(|col| grid.get(&(row, col)).cloned().unwrap_or(Value::Null)).collect()).collect();
            Cells { ok: true, grid: rows, error: String::new() }
        })
        .collect())
}

/// The sheet names of a workbook, in order (a CSV has one, unnamed).
pub fn sheet_names(path: &str) -> Result<Vec<String>, String> {
    Ok(load(path)?.names.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("pyx-sheets-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d.join(name)
    }

    fn xlsx(path: &Path) {
        let f = std::fs::File::create(path).unwrap();
        let mut z = zip::ZipWriter::new(f);
        let o = zip::write::SimpleFileOptions::default();
        let put = |z: &mut zip::ZipWriter<std::fs::File>, n: &str, s: &str| { z.start_file(n, o).unwrap(); z.write_all(s.as_bytes()).unwrap(); };
        put(&mut z, "xl/workbook.xml", r#"<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Datos" sheetId="1" r:id="rId1"/><sheet name="Cargas &amp; usos" sheetId="2" r:id="rId2"/></sheets><definedNames><definedName name="Caudal">Datos!$E$4</definedName><definedName name="Usos">'Cargas &amp; usos'!$B$2:$C$2</definedName><definedName name="_xlnm.Print_Area" localSheetId="0">Datos!$A$1:$F$9</definedName></definedNames></workbook>"#);
        put(&mut z, "xl/_rels/workbook.xml.rels", r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>"#);
        put(&mut z, "xl/sharedStrings.xml", r#"<sst><si><t>S275</t></si><si><r><t>I+D </t></r><r><t>&amp; Co</t></r></si></sst>"#);
        put(&mut z, "xl/worksheets/sheet1.xml", r#"<worksheet><sheetData><row r="4"><c r="E4"><v>12.5</v></c><c r="F4" t="s"><v>0</v></c></row><row r="5"><c r="E5"><f>E4*2</f><v>25</v></c><c r="F5" t="s"><v>1</v></c></row></sheetData></worksheet>"#);
        put(&mut z, "xl/worksheets/sheet2.xml", r#"<worksheet><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>sobrecarga</t></is></c><c r="C2"><v>3.75</v></c></row></sheetData></worksheet>"#);
        z.finish().unwrap();
    }

    #[test]
    fn reads_cells_ranges_formulas_and_sheets_of_an_xlsx() {
        let p = tmp("libro.xlsx");
        xlsx(&p);
        let refs: Vec<String> = ["E4", "E4:E5", "E4:F5", "F5", "'Cargas & usos'!B2:C2", "Nada!A1", "ZZ"].iter().map(|s| s.to_string()).collect();
        let v = values(p.to_str().unwrap(), Some("Datos".into()), &refs).unwrap();
        assert_eq!(v[0].grid, vec![vec![serde_json::json!(12.5)]]);
        assert_eq!(v[1].grid, vec![vec![serde_json::json!(12.5)], vec![serde_json::json!(25.0)]]); // a formula's saved result
        assert_eq!(v[2].grid[0][1], serde_json::json!("S275"));
        assert_eq!(v[3].grid, vec![vec![serde_json::json!("I+D & Co")]]);
        assert_eq!(v[4].grid, vec![vec![serde_json::json!("sobrecarga"), serde_json::json!(3.75)]]);
        assert!(!v[5].ok && v[5].error.contains("Datos"));
        assert!(!v[6].ok);
    }

    #[test]
    fn resolves_names_defined_in_the_workbook_and_lists_sheets() {
        let p = tmp("nombres.xlsx");
        xlsx(&p);
        let ps = p.to_string_lossy().to_string();
        let v = values(&ps, None, &["Caudal".into(), "usos".into(), "Nada".into()]).unwrap();
        assert_eq!(v[0].grid, vec![vec![serde_json::json!(12.5)]]);
        assert_eq!(v[1].grid, vec![vec![serde_json::json!("sobrecarga"), serde_json::json!(3.75)]]);
        assert!(!v[2].ok);
        assert_eq!(sheet_names(&ps).unwrap(), vec!["Datos".to_string(), "Cargas & usos".to_string()]);
    }

    #[test]
    fn merged_cells_missing_addresses_and_formulas_without_results() {
        let p = tmp("raro.xlsx");
        {
            let f = std::fs::File::create(&p).unwrap();
            let mut z = zip::ZipWriter::new(f);
            let o = zip::write::SimpleFileOptions::default();
            let put = |z: &mut zip::ZipWriter<std::fs::File>, n: &str, s: &str| { z.start_file(n, o).unwrap(); z.write_all(s.as_bytes()).unwrap(); };
            put(&mut z, "xl/workbook.xml", r#"<workbook xmlns:r="r"><sheets><sheet name="Sedimentos" sheetId="1" r:id="rId1"/></sheets></workbook>"#);
            put(&mut z, "xl/_rels/workbook.xml.rels", r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#);
            put(&mut z, "xl/sharedStrings.xml", r#"<sst><si><t>arena</t></si></sst>"#);
            // C18:E18 merged (value in C18); row 2 has cells without r="…";
            // B4/B5 are formulas with no saved result.
            put(&mut z, "xl/worksheets/sheet1.xml", r#"<worksheet><sheetData>
              <row r="2"><c><v>1.5</v></c><c t="s"><v>0</v></c></row>
              <row r="3"><c r="A3"><v>2</v></c><c r="B3"><v>3</v></c></row>
              <row r="4"><c r="B4"><f>A3*B3+SUM(A3:B3)</f></c></row>
              <row r="5"><c r="B5"><f>ROUND(B4/7,2)&amp;" kg"</f></c><c r="C5"><f>VLOOKUP(A3,A3:B3,2)</f></c></row>
              <row r="18"><c r="C18"><v>42.7</v></c><c r="D18"/><c r="E18"/></row>
            </sheetData><mergeCells><mergeCell ref="C18:E18"/></mergeCells></worksheet>"#);
            z.finish().unwrap();
        }
        let ps = p.to_string_lossy().to_string();
        let v = values(&ps, Some("Sedimentos".into()), &["D18".into(), "A2".into(), "B2".into(), "B4".into(), "B5".into(), "C5".into()]).unwrap();
        assert_eq!(v[0].grid, vec![vec![serde_json::json!(42.7)]]);
        assert_eq!(v[1].grid, vec![vec![serde_json::json!(1.5)]]);
        assert_eq!(v[2].grid, vec![vec![serde_json::json!("arena")]]);
        assert_eq!(v[3].grid, vec![vec![serde_json::json!(11.0)]]);
        assert_eq!(v[4].grid, vec![vec![serde_json::json!("1.57 kg")]]);
        assert!(!v[5].ok && v[5].error.contains("VLOOKUP"));
    }

    #[test]
    fn reads_a_spanish_csv_and_rereads_it_when_it_changes() {
        let p = tmp("cargas.csv");
        std::fs::write(&p, "carga;valor\nPeso propio;0,49\n\"Tablero; madera\";1.234,5\n").unwrap();
        let refs: Vec<String> = ["B2", "A3", "B3", "A1:B1"].iter().map(|s| s.to_string()).collect();
        let v = values(p.to_str().unwrap(), None, &refs).unwrap();
        assert_eq!(v[0].grid[0][0], serde_json::json!(0.49));
        assert_eq!(v[1].grid[0][0], serde_json::json!("Tablero; madera"));
        assert_eq!(v[2].grid[0][0], serde_json::json!(1234.5));
        assert_eq!(v[3].grid[0], vec![serde_json::json!("carga"), serde_json::json!("valor")]);
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&p, "carga;valor\nPeso propio;7\n").unwrap();
        let v = values(p.to_str().unwrap(), None, &["B2".to_string()]).unwrap();
        assert_eq!(v[0].grid[0][0], serde_json::json!(7.0));
    }
}
