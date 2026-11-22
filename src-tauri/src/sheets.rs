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

fn sheet_cells(xml: &str, strings: &[String]) -> Grid {
    let mut r = Reader::from_str(xml);
    let mut g = Grid::new();
    let (mut pos, mut kind, mut text) = (None::<(u32, u32)>, String::new(), String::new());
    let (mut in_v, mut in_t) = (false, false);
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                b"c" => {
                    pos = attr(&e, b"r").and_then(|s| cell_pos(&s));
                    kind = attr(&e, b"t").unwrap_or_default();
                    text.clear();
                }
                b"v" => in_v = true,
                b"t" => in_t = true,
                _ => {}
            },
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"v" => in_v = false,
                b"t" => in_t = false,
                b"c" => {
                    if let Some(p) = pos.take() {
                        let v = match kind.as_str() {
                            "s" => text.trim().parse::<usize>().ok().and_then(|i| strings.get(i)).map(|s| Value::String(s.clone())),
                            "b" => Some(Value::Bool(text.trim() == "1")),
                            "str" | "inlineStr" | "e" => Some(Value::String(text.clone())),
                            _ if text.trim().is_empty() => None,
                            _ => Some(number(&text)),
                        };
                        if let Some(v) = v {
                            if v != Value::String(String::new()) {
                                g.insert(p, v);
                            }
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::Text(t)) if in_v || in_t => text.push_str(&String::from_utf8_lossy(&t)),
            Ok(Event::GeneralRef(gr)) if in_v || in_t => text.push_str(&entity(&gr)),
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    g
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
    for (n, id) in order {
        let part = targets.get(&id).cloned().unwrap_or_default();
        let grid = zip_text(&mut z, &part).map(|x| sheet_cells(&x, &strings)).unwrap_or_default();
        names.push(n.clone());
        sheets.insert(n, grid);
    }
    Ok(Book { names, sheets, defined })
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
    Ok(Book { names: vec![String::new()], sheets: HashMap::from([(String::new(), g)]), defined: HashMap::new() })
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
