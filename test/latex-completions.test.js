import { describe, it, expect } from 'vitest';
import DATA from '../js/data/latex-completions.json';

// The completion data is hand-edited: these are the mistakes that would break
// a snippet silently in the editor.
describe('latex-completions.json', () => {
  const all = [...DATA.commands.map((c) => ['cmd', ...c]), ...DATA.environments.map((e) => ['env', ...e])];

  it('every row has a name, arguments, package and description', () => {
    for (const [, name, args, pkg, detail] of all) {
      expect(typeof name).toBe('string');
      expect(name).toMatch(/^[A-Za-z*@[\]]+$/);
      expect(typeof args).toBe('string');
      expect(typeof pkg).toBe('string');
      expect(detail.length).toBeGreaterThan(0);
    }
  });

  it('placeholders never contain braces (CodeMirror cannot parse them)', () => {
    for (const row of all) {
      const text = row.slice(2).filter((x) => typeof x === 'string').join(' ');
      for (const m of text.matchAll(/\$\{\d+:([^}]*)/g)) expect(m[1]).not.toMatch(/[{]/);
    }
  });

  it('no duplicate command for the same package', () => {
    const seen = new Set();
    for (const [name, , pkg] of DATA.commands) {
      const k = `${name}@${pkg}`;
      expect(seen.has(k), k).toBe(false);
      seen.add(k);
    }
  });

  it('braces in arguments are balanced', () => {
    for (const [name, args] of DATA.commands) {
      let d = 0;
      for (const ch of args.replace(/\$\{\d+(:[^}]*)?\}|\$\{\}/g, '')) { if (ch === '{') d++; if (ch === '}') d--; }
      expect(d, name).toBe(0);
    }
  });
});
