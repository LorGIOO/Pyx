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

/**
 * Local findings on one masked line.
 * @returns {{from:number, to:number, message:string, fix?:string}[]}
 */
export function grammarHits(masked, lang = 'es') {
  const out = [];
  let m;
  // Repeated word ("el el"), case-insensitive, whole words.
  const rep = /(?<![\p{L}\p{N}])(\p{L}{2,})(\s+)(\1)(?![\p{L}\p{N}])/giu;
  while ((m = rep.exec(masked))) {
    const from = m.index + m[1].length + m[2].length;
    out.push({ from, to: from + m[3].length, message: `Palabra repetida: «${m[3]}»`, fix: '' });
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
  if (lang === 'es') {
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
