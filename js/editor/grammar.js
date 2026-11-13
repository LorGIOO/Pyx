// Grammar and style checks for the prose of a LaTeX document.
//
// Two layers, like the spell checker:
//   * LOCAL rules, always on and offline: repeated words, spaces around
//     punctuation, a missing capital after a full stop, and, in Spanish,
//     "a el"/"de el" and an opening ¿ ¡ that is missing. They run on the
//     masked line (spell-mask.js: commands, math and comments blanked out at
//     the same offsets), so `\ref{a} a` or `$a$ a` never trip them.
//   * LanguageTool (the engine LibreOffice uses; LGPL), optional: a server is
//     set in Configuración → Idioma — your own (`java -jar languagetool-
//     server.jar`, http://localhost:8081) or the public one, which receives
//     the text. Its findings arrive as lint diagnostics, with their fixes.

// Common abbreviations after which a lower-case word is fine.
const ABBR = /(?:\b(?:p|ej|etc|pág|págs|cf|vs|aprox|núm|art|fig|ec|cap|sr|sra|dr|dra|e\.g|i\.e|et al|approx|no|eq|figs|resp))\.\s+$/i;

// [pattern, what to say, replacement (optional)]. Whole expressions only,
// each one unambiguous: a style checker that is wrong half the time is one
// nobody reads.
const B = '(?<![\\p{L}])';
const E = '(?![\\p{L}])';
const es = (src, why, fix) => [new RegExp(B + src + E, 'giu'), why, fix];
const ES_STYLE = [
  es('en base a', 'Mejor «con base en», «a partir de» o «según»', 'con base en'),
  es('de acuerdo a', 'En español de España se prefiere «de acuerdo con»', 'de acuerdo con'),
  es('a nivel de', 'Si no hay niveles, mejor «en», «en cuanto a» o «respecto a»'),
  es('en relación a', 'Se dice «en relación con» o «con relación a»', 'en relación con'),
  es('con respecto de', 'Se dice «con respecto a» o «respecto de»', 'con respecto a'),
  es('bajo mi punto de vista', 'Se dice «desde mi punto de vista»', 'desde mi punto de vista'),
  es('es por eso que', 'Más directo: «por eso»', 'por eso'),
  es('es por ello que', 'Más directo: «por ello»', 'por ello'),
  es('subir arriba', 'Redundancia: «subir»', 'subir'),
  es('bajar abajo', 'Redundancia: «bajar»', 'bajar'),
  es('volver a repetir', 'Redundancia: «repetir» (o «volver a hacer»)', 'repetir'),
  es('prever con antelación', 'Redundancia: «prever»', 'prever'),
  es('a día de hoy', 'Más sencillo: «hoy» o «actualmente»', 'hoy'),
  es('habían (?:muchos|muchas|varios|varias|algunos|algunas|dos|tres)', '«Haber» impersonal va en singular: «había»'),
  es('hubieron (?:muchos|muchas|varios|varias|algunos|algunas|dos|tres)', '«Haber» impersonal va en singular: «hubo»'),
  es('han habido', '«Haber» impersonal va en singular: «ha habido»', 'ha habido'),
  es('detrás (?:mío|mía|tuyo|tuya|suyo|suya|nuestro|nuestra)', 'Se dice «detrás de mí», «detrás de él»…'),
  es('delante (?:mío|mía|tuyo|tuya|suyo|suya|nuestro|nuestra)', 'Se dice «delante de mí», «delante de él»…'),
  es('más mejor|más peor|más mayor que', 'Comparativo doble'),
  es('preveer', 'Se escribe «prever»', 'prever'),
  es('a parte de', 'Si significa «además de», se escribe «aparte de»'),
  es('sobretodo', 'Si significa «especialmente», se escribe «sobre todo»', 'sobre todo'),
  es('osea', 'Se escribe «o sea»', 'o sea'),
  es('aveces', 'Se escribe «a veces»', 'a veces'),
  es('apesar', 'Se escribe «a pesar»', 'a pesar'),
  es('atravez|a travez|através', 'Se escribe «a través»', 'a través'),
  es('enserio', 'Se escribe «en serio»', 'en serio'),
  es('porsupuesto', 'Se escribe «por supuesto»', 'por supuesto'),
];

/**
 * Local findings on one masked line. Each carries a `kind`: 'style' for
 * wording (shown in green), nothing for punctuation and spacing (blue).
 * @returns {{from:number, to:number, message:string, fix?:string}[]}
 */
export function grammarHits(masked, lang = 'es') {
  const out = [];
  let m;
  // Repeated word ("el el"), case-insensitive, whole words.
  const rep = /(?<![\p{L}\p{N}])(\p{L}{2,})(\s+)(\1)(?![\p{L}\p{N}])/giu;
  while ((m = rep.exec(masked))) {
    const from = m.index + m[1].length + m[2].length;
    out.push({ from, to: from + m[3].length, message: `Palabra repetida: «${m[3]}»`, fix: '', kind: 'style' });
  }
  // A space before , ; : ! ? ("hola ,", "pilares ,y") — and before a full
  // stop that ends a sentence ("fin ." but not "a .5").
  const before = /(?<=\p{L}|\p{N}|[)\]])( +)([,;:!?]|\.(?=\s|$))/gu;
  while ((m = before.exec(masked))) {
    out.push({ from: m.index, to: m.index + m[1].length, message: `Sobra el espacio antes de «${m[2]}»`, fix: '' });
  }
  // No space after , ; before a letter ("a,b", "pilares ,y" — but 1,5 is a number).
  const after = /(?<!\p{N})([,;])(?=\p{L})/gu;
  while ((m = after.exec(masked))) {
    out.push({ from: m.index, to: m.index + 1, message: `Falta un espacio después de «${m[1]}»`, fix: `${m[1]} ` });
  }
  // Lower case after a full stop that ends a sentence.
  const cap = /([.!?])(\s+)(\p{Ll})/gu;
  while ((m = cap.exec(masked))) {
    const head = masked.slice(0, m.index + 1 + m[2].length);
    if (ABBR.test(head) || /\.\.\.\s+$/.test(head) || /\d\.\s+$/.test(head)) continue;
    const from = m.index + 1 + m[2].length;
    out.push({ from, to: from + 1, message: 'Después de un punto, mayúscula', fix: m[3].toUpperCase() });
  }
  // Two or more spaces between words (not the indentation at the start).
  const multi = /(?<=\S)( {2,})(?=\S)/g;
  while ((m = multi.exec(masked))) {
    out.push({ from: m.index, to: m.index + m[1].length, message: 'Sobran espacios: basta con uno', fix: ' ' });
  }
  // A space just inside brackets: "( texto )".
  const inOpen = /([(\[¿¡])( +)(?=\S)/g;
  while ((m = inOpen.exec(masked))) {
    out.push({ from: m.index + 1, to: m.index + 1 + m[2].length, message: `Sobra el espacio después de «${m[1]}»`, fix: '' });
  }
  const inClose = /(?<=\S)( +)([)\]])/g;
  while ((m = inClose.exec(masked))) {
    out.push({ from: m.index, to: m.index + m[1].length, message: `Sobra el espacio antes de «${m[2]}»`, fix: '' });
  }
  // Doubled punctuation: ",,", ";;", ".." (but "..." is an ellipsis).
  const dbl = /(?<![.,;:])([,;:])\1+|(?<!\.)\.\.(?!\.)/g;
  while ((m = dbl.exec(masked))) {
    out.push({ from: m.index, to: m.index + m[0].length, message: 'Signo de puntuación repetido', fix: m[0][0] });
  }
  // No space after a full stop, colon, ! or ? before a capital ("fin.Inicio").
  const glued = /(?<=\p{Ll})([.:!?])(?=\p{Lu}\p{Ll})/gu;
  while ((m = glued.exec(masked))) {
    out.push({ from: m.index, to: m.index + 1, message: `Falta un espacio después de «${m[1]}»`, fix: `${m[1]} ` });
  }
  // A number glued to its unit: "25kN", "3m" → "25 kN" (SI: always a space).
  const unit = /(?<![\p{L}\p{N}.,])(\d+(?:[.,]\d+)?)(km|hm|dam|dm|cm|mm|µm|nm|kg|mg|kN|MN|GN|MPa|GPa|kPa|Pa|kW|MW|GW|kWh|Hz|kHz|MHz|kV|mA|ml|cl|dl|hl|m|g|N|W|V|A|s|h|l|L|t)(?![\p{L}\p{N}])/gu;
  while ((m = unit.exec(masked))) {
    out.push({ from: m.index, to: m.index + m[0].length, message: `Entre el número y la unidad va un espacio: «${m[1]} ${m[2]}»`, fix: `${m[1]} ${m[2]}` });
  }
  if (lang === 'es') {
    // Wording the academies advise against, and plain redundancies — green.
    for (const [re, why, fix] of ES_STYLE) {
      re.lastIndex = 0;
      while ((m = re.exec(masked))) {
        out.push({ from: m.index, to: m.index + m[0].length, message: why, fix: fix || undefined, kind: 'style' });
      }
    }
    // "etc..." — the abbreviation already says it.
    const etc = /(?<![\p{L}])etc\.{2,}/giu;
    while ((m = etc.exec(masked))) {
      out.push({ from: m.index, to: m.index + m[0].length, message: 'Tras «etc.» no van puntos suspensivos', fix: 'etc.' });
    }
    // "a el" → "al", "de el" → "del" ("de él" with an accent is correct).
    const contr = /(?<![\p{L}])(a|de)(\s+)(el)(?![\p{L}])/gu;
    while ((m = contr.exec(masked))) {
      const fix = m[1] === 'a' ? 'al' : 'del';
      out.push({ from: m.index, to: m.index + m[0].length, message: `Se escribe «${fix}»`, fix });
    }
    // A question or exclamation that closes without opening (¿…? ¡…!).
    for (const [open, close] of [['¿', '?'], ['¡', '!']]) {
      let start = 0;
      for (let i = 0; i < masked.length; i++) {
        const ch = masked[i];
        if ('.;:'.includes(ch) || (ch === close && i > start)) {
          if (ch === close) {
            const sentence = masked.slice(start, i);
            if (!sentence.includes(open) && /\p{L}/u.test(sentence)) {
              out.push({ from: i, to: i + 1, message: `Falta el signo de apertura «${open}»` });
            }
          }
          start = i + 1;
        }
      }
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

/* ---------------- LanguageTool ---------------- */

/** The prose LanguageTool should read: `lines` masked, at the same offsets
 *  (lines inside cells, math or the preamble are given as null → blanked). */
export function proseForLanguageTool(lines) {
  return lines.map((l) => (l == null ? '' : l)).join('\n');
}

const LT_LANG = { es: 'es', en: 'en-US' };
// What LaTeX's own spacing and our masking make noisy.
export const LT_DISABLED = ['WHITESPACE_RULE', 'COMMA_PARENTHESIS_WHITESPACE', 'UPPERCASE_SENTENCE_START',
  'MORFOLOGIK_RULE_EN_US', 'MORFOLOGIK_RULE_ES', 'ES_UNPAIRED_BRACKETS', 'EN_UNPAIRED_BRACKETS',
  'DOUBLE_PUNCTUATION', 'PUNCTUATION_PARAGRAPH_END'];

/** LanguageTool's matches → lint diagnostics at document offsets. */
export function ltDiagnostics(matches, base) {
  return (matches || []).filter((m) => m && m.length > 0).map((m) => ({
    from: base + m.offset,
    to: base + m.offset + m.length,
    severity: 'info',
    source: 'LanguageTool',
    message: m.message + (m.rule && m.rule.id ? ` (${m.rule.id})` : ''),
    actions: (m.replacements || []).slice(0, 4).map((r) => ({
      name: r.value === '' ? '(quitar)' : `«${r.value}»`,
      apply: (view, from, to) => view.dispatch({ changes: { from, to, insert: r.value } }),
    })),
  }));
}

export const ltLanguage = (spellLang) => LT_LANG[spellLang] || spellLang || 'es';
