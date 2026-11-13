// Spanish word formation the Hunspell dictionary does not reach.
//
// The dictionary knows the words; what it marked as errors, measured on real
// reports, were correct words BUILT from them: a verb with its pronouns
// attached («definirlo», «pégalas», «calculándose»), a prefixed word
// («recalcular», «precalentado», «semiancho»), an adverb in -mente, a
// superlative. These rules accept such a word only when the word it is built
// from is itself in the dictionary, so a real typo stays a typo
// («desarollo» is still wrong: «arollo» is not a word).
//
// Pure: `known(word)` is the dictionary lookup, passed in.

const ACUTE = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u' };
const plain = (s) => s.replace(/[áéíóú]/g, (c) => ACUTE[c]);

const CLITICS = /(?:(?:me|te|se|nos|os)(?:lo|la|le|los|las|les)|me|te|se|nos|os|lo|la|le|los|las|les)$/;

const PREFIXES = [
  'anti', 'auto', 'bi', 'co', 'contra', 'cuasi', 'des', 'electro', 'entre', 'extra', 'geo', 'hidro', 'hiper',
  'hipo', 'infra', 'inter', 'intra', 'macro', 'micro', 'mini', 'mono', 'multi', 'pluri', 'poli', 'pos', 'post',
  'pre', 'pseudo', 're', 'semi', 'sobre', 'sub', 'super', 'supra', 'termo', 'tri', 'ultra',
];

/** Is `word` (lower case, not in the dictionary) a correct Spanish formation? */
export function esFormation(word, known) {
  const w = word.toLowerCase();
  if (w.length < 5) return false;

  // Verb + enclitic pronouns. Three shapes, each with its own spelling rule:
  //   infinitive  definir+lo, dár+se+lo      (accent only with two pronouns)
  //   gerund      calculándo+se              (always accented)
  //   imperative  pégal+as → pega+las        (accent where the stress stays)
  const m = CLITICS.exec(w);
  if (m && m.index >= 2) {
    const stem = w.slice(0, m.index);
    const base = plain(stem);
    const accented = stem !== base;
    if (/[aeií]r$/.test(base) && known(base)) return true;
    if (accented && /(?:ando|iendo|yendo)$/.test(base) && known(base)) return true;
    if (accented && /[aeiouns]$/.test(base) && known(base)) return true;
  }

  // -mente on an adjective («gráficamente», «fácilmente»).
  if (w.endsWith('mente') && w.length > 8 && known(w.slice(0, -5))) return true;

  // Superlatives and diminutives of a known word.
  const sup = /^(.{3,}?)(?:ísim|it|ill)([oa]s?)$/.exec(w);
  if (sup) {
    const root = plain(sup[1]);
    const v = sup[2][0];
    if (known(root + v) || known(root + 'e') || known(root) || known(sup[1])) return true;
  }

  // A prefix on a known word of some length (short remainders are where
  // false acceptances live: «reto», «subir»… are in the dictionary anyway).
  for (const p of PREFIXES) {
    if (!w.startsWith(p)) continue;
    let rest = w.slice(p.length);
    // «prerrequisito», «antirrobo»: the r doubles between vowels.
    if (rest.startsWith('rr')) rest = rest.slice(1);
    if (rest.length >= 5 && known(rest)) return true;
  }
  return false;
}
