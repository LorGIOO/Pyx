// Regenerate public/dict/ from the Hunspell dictionaries in node_modules.
//
//   node tools/build-dicts.mjs
//
// Two things happen here that are worth knowing about:
//
//  * ENGLISH IS MERGED. `dictionary-en` is US-only, so a document written in
//    British English had `behaviour`, `modelling`, `optimisation`, `centre`
//    and `analysed` underlined — every one of them correct. `dictionary-en`
//    and `dictionary-en-gb` ship the SAME affix table (verified below, the
//    script refuses to merge if that ever stops being true), so their word
//    lists can simply be unioned: the result accepts both spellings and keeps
//    rejecting actual misspellings.
//
//  * THE TECHNICAL SUPPLEMENTS ARE COPIED VERBATIM. `*.extra.txt` are word
//    lists maintained by hand (see their headers); the spell checker loads
//    them on top of the Hunspell dictionary. No general-purpose dictionary
//    contains `flector`, `hiperestático` or `subgrade`, and those are exactly
//    the words an engineering document is full of.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'dict');
const mod = (p) => join(root, 'node_modules', p);

/** The affix table is what gives every stem its inflections; two dictionaries
 *  can only share a word list if they share it exactly. */
function sameAffixTable(a, b) {
  const rules = (s) => s.split('\n').filter((l) => /^(SFX|PFX)\s/.test(l)).join('\n');
  return rules(readFileSync(a, 'utf8')) === rules(readFileSync(b, 'utf8'));
}

/** Hunspell .dic: first line is the entry count, the rest are `word/FLAGS`. */
function entries(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  return lines.slice(1).map((l) => l.trim()).filter(Boolean);
}

function writeDic(file, list) {
  writeFileSync(file, `${list.length}\n${list.join('\n')}\n`, 'utf8');
}

/* ---------- Spanish: RLA, the reference free Spanish dictionary ---------- */
copyFileSync(mod('dictionary-es/index.aff'), join(out, 'es.aff'));
copyFileSync(mod('dictionary-es/index.dic'), join(out, 'es.dic'));
copyFileSync(mod('dictionary-es/license'), join(out, 'es.LICENSE.txt'));
console.log('es: copiado tal cual desde dictionary-es');

/* ---------- English: US ∪ GB ---------- */
const affUs = mod('dictionary-en/index.aff');
const affGb = mod('dictionary-en-gb/index.aff');
if (!existsSync(affGb)) throw new Error('falta dictionary-en-gb: npm install dictionary-en-gb');
if (!sameAffixTable(affUs, affGb)) {
  throw new Error('en y en-gb ya no comparten tabla de afijos: no se pueden fusionar sin revisarlo');
}
copyFileSync(affUs, join(out, 'en.aff'));

const us = entries(mod('dictionary-en/index.dic'));
const gb = entries(mod('dictionary-en-gb/index.dic'));
const merged = [...new Set([...us, ...gb])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
writeDic(join(out, 'en.dic'), merged);
copyFileSync(mod('dictionary-en/license'), join(out, 'en.LICENSE.txt'));
console.log(`en: ${us.length} (US) ∪ ${gb.length} (GB) = ${merged.length} entradas`);
