import { createSignal, createMemo, For, Show, onMount } from 'solid-js';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { t as tr, lang } from '../../core/i18n.js';
import { SYMBOL_CATEGORIES, insertText, previewSource } from '../../data/symbols.js';
import { insertSnippet } from '../../editor/commands.js';
import { readUserFile, writeUserFile, userDir } from '../../core/userfiles.js';
import { mySymbols as mine, setMySymbols as setMine, svgToTikz, commandFromName } from '../../data/svg-symbols.js';
import { openSvgDialog, readTextFile, messageDialog } from '../../core/platform.js';

// The symbol palette of the side panel. Every symbol is drawn by KaTeX — the
// same typography as the formulas in the PDF, not a system font guessing at
// a Unicode glyph — in a cell that grows with it (\arcsin, \frac{a}{b} used to
// overflow a fixed square and overlap their neighbours).
//
// «Mis símbolos» (symbols.json, in Pyx's folder next to config.json) holds the
// user's own: any command, with or without arguments. Add them here or edit
// the file.

export const SYMBOLS_FILE = 'symbols.json';

const cache = new Map();
/** The drawing of an SVG symbol, as an image (its own colours dropped: it
 *  takes the text's, as in the PDF). */
export function svgImg(svg, cls = 'sym-svg') {
  const mono = String(svg || '').replace(/(fill|stroke)="(?!none)[^"]*"/g, '$1="currentColor"');
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(mono);
  return `<span class="${cls}" style="-webkit-mask-image:url('${url}');mask-image:url('${url}')"></span>`;
}

function render(cmd, glyph, extra) {
  if (extra && extra.svg) return svgImg(extra.svg);
  const key = cmd + '\u0000' + glyph;
  if (cache.has(key)) return cache.get(key);
  let html;
  try {
    html = katex.renderToString(previewSource(cmd), { throwOnError: true, displayMode: false, output: 'html', strict: false });
  } catch (_) {
    // KaTeX does not know it (\nsubset…): the glyph, in KaTeX's own face.
    const esc = String(glyph || cmd).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    html = `<span class="katex"><span class="mord">${esc}</span></span>`;
  }
  cache.set(key, html);
  return html;
}

let loaded = false;

const SAMPLE = () => ({
  about: tr(
    'Tus símbolos para el panel de Pyx. Cada uno: [texto que se ve si KaTeX no sabe dibujarlo, comando LaTeX, descripción opcional].',
    'Your symbols for Pyx\'s panel. Each one: [text shown if KaTeX cannot draw it, LaTeX command, optional description].',
  ),
  symbols: [
    ['⊛', '\\circledast', tr('Producto estrella', 'Star product')],
    ['∡', '\\measuredangle', tr('Ángulo medido', 'Measured angle')],
    ['kN', '\\mathrm{kN}', tr('Kilonewton', 'Kilonewton')],
  ],
});

export async function loadMySymbols() {
  let text = await readUserFile(SYMBOLS_FILE);
  if (text == null) {
    text = JSON.stringify(SAMPLE(), null, 2);
    await writeUserFile(SYMBOLS_FILE, text).catch(() => {});
  }
  try {
    const o = JSON.parse(text);
    const list = Array.isArray(o) ? o : (o && Array.isArray(o.symbols) ? o.symbols : []);
    setMine(list.filter((it) => Array.isArray(it) && typeof it[1] === 'string' && it[1].trim())
      .map((it) => {
        const row = [String(it[0] || ''), it[1], it[2] ? String(it[2]) : ''];
        // a symbol drawn from an SVG: { svg, tikz }
        if (it[3] && typeof it[3] === 'object' && it[3].tikz) row.push({ svg: String(it[3].svg || ''), tikz: String(it[3].tikz) });
        return row;
      }));
  } catch (_) {
    setMine([]);
  }
  loaded = true;
}

async function saveMySymbols(list) {
  setMine(list);
  let about = SAMPLE().about;
  try { const o = JSON.parse((await readUserFile(SYMBOLS_FILE)) || '{}'); if (o && typeof o.about === 'string') about = o.about; } catch (_) { /* keep */ }
  await writeUserFile(SYMBOLS_FILE, JSON.stringify({ about, symbols: list }, null, 2));
}

export default function SymbolPanel() {
  const [query, setQuery] = createSignal('');
  const [folded, setFolded] = createSignal(new Set());
  const [adding, setAdding] = createSignal(false);
  const [newCmd, setNewCmd] = createSignal('');
  const [newName, setNewName] = createSignal('');
  onMount(() => { if (!loaded) loadMySymbols(); else loadMySymbols(); });
  // Back from editing symbols.json in another program: read it again.
  onMount(() => {
    const again = () => loadMySymbols();
    window.addEventListener('focus', again);
    window.addEventListener('pyx:file-saved', (e) => {
      if (String((e.detail && e.detail.path) || '').replace(/\\/g, '/').toLowerCase().endsWith('/' + SYMBOLS_FILE)) again();
    });
  });

  const cats = createMemo(() => {
    void lang();
    const all = [
      { id: 'mine', name: tr('Mis símbolos', 'My symbols'), items: mine(), mine: true },
      ...SYMBOL_CATEGORIES.map((c, i) => ({ id: 'c' + i, name: lang() === 'en' ? (c.en || c.name) : c.name, items: c.items })),
    ];
    const q = query().trim().toLowerCase().replace(/^\\/, '');
    if (!q) return all;
    return all
      .map((c) => ({ ...c, items: c.items.filter((it) => it[1].toLowerCase().includes(q) || (it[2] || '').toLowerCase().includes(q) || it[0] === query().trim()) }))
      .filter((c) => c.items.length);
  });
  const toggle = (id) => setFolded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const wide = (cmd) => /\{\}|\[|^\\(arc|sinh|cosh|tanh|lim|max|min|sup|inf|det|dim|ker|gcd|deg|arg|log|exp|sin|cos|tan|cot|sec|csc|ln|bmod|mathrm)/.test(cmd);

  const addSymbol = async () => {
    const cmd = newCmd().trim();
    if (!cmd) return;
    await saveMySymbols([...mine(), ['', cmd, newName().trim()]]);
    setNewCmd(''); setNewName(''); setAdding(false);
  };
  // «SVG…»: a drawing becomes a command (\nombreDelArchivo), drawn with TikZ.
  const addSvg = async () => {
    const path = await openSvgDialog();
    if (typeof path !== 'string' || !path) return;
    try {
      const svg = await readTextFile(path);
      const { tikz } = svgToTikz(svg);
      let cmd = newCmd().trim() && /^\\[A-Za-z]+$/.test(newCmd().trim()) ? newCmd().trim() : commandFromName(path);
      const taken = new Set(mine().map((it) => it[1]));
      // commands take letters only: \\flecha, \\flechaB, \\flechaC…
      for (let k = 1, base = cmd; taken.has(cmd) && k < 26; k++) cmd = base + String.fromCharCode(65 + k);
      await saveMySymbols([...mine(), ['', cmd, newName().trim() || path.replace(/^.*[\\/]/, ''), { svg, tikz }]]);
      setNewCmd(''); setNewName(''); setAdding(false);
    } catch (e) {
      messageDialog(String((e && e.message) || e), { title: tr('Símbolo desde SVG', 'Symbol from SVG'), kind: 'warning' });
    }
  };
  const removeSymbol = (i) => saveMySymbols(mine().filter((_, k) => k !== i));
  const editFile = async () => {
    const dir = await userDir();
    if (!dir) return;
    const sep = dir.includes('\\') ? '\\' : '/';
    const { openPath } = await import('../stores/docStore.js');
    openPath(dir + sep + SYMBOLS_FILE);
  };

  return (
    <div class="sym-panel">
      <div class="sym-search">
        <input type="text" placeholder={tr('Buscar símbolo (\\alpha, flecha…)', 'Find a symbol (\\alpha, arrow…)')}
          value={query()} onInput={(e) => setQuery(e.target.value)} spellcheck={false} />
      </div>
      <For each={cats()}>
        {(cat) => (
          <div class="sym-cat">
            <div class="sym-cat-name" onClick={() => toggle(cat.id)}>
              <span class={`sym-chev${folded().has(cat.id) && !query() ? ' folded' : ''}`}>▾</span>
              <span class="sym-cat-title">{cat.name}</span>
              <Show when={cat.mine}>
                <span class="sym-cat-actions" onClick={(e) => e.stopPropagation()}>
                  <button class="sym-mini" title={tr('Añadir un símbolo', 'Add a symbol')} onClick={() => setAdding(!adding())}>+</button>
                  <button class="sym-mini" title={tr('Añadir un símbolo desde un dibujo .svg', 'Add a symbol from an .svg drawing')} onClick={() => { setAdding(true); addSvg(); }}>SVG</button>
                  <button class="sym-mini" title={tr('Editar symbols.json', 'Edit symbols.json')} onClick={editFile}>✎</button>
                </span>
              </Show>
            </div>
            <Show when={!folded().has(cat.id) || query()}>
              <Show when={cat.mine && adding()}>
                <div class="sym-add">
                  <input type="text" placeholder={tr('Comando: \\circledast', 'Command: \\circledast')} value={newCmd()}
                    onInput={(e) => setNewCmd(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addSymbol(); }} spellcheck={false} />
                  <input type="text" placeholder={tr('Descripción (opcional)', 'Description (optional)')} value={newName()}
                    onInput={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addSymbol(); }} />
                  <Show when={newCmd().trim()}>
                    <span class="sym-add-preview" innerHTML={render(newCmd().trim(), newCmd().trim())} />
                  </Show>
                  <button class="ctl-btn" onClick={addSymbol}>{tr('Añadir', 'Add')}</button>
                  <button class="ctl-btn" onClick={addSvg}
                    title={tr('Crear el símbolo a partir de un dibujo .svg: se convierte en un comando (el nombre de arriba o el del archivo) que se dibuja con TikZ, del tamaño y el color del texto', 'Make the symbol from an .svg drawing: it becomes a command (the name above or the file\'s) drawn with TikZ, the size and colour of the text')}>
                    {tr('Desde SVG…', 'From SVG…')}</button>
                </div>
              </Show>
              <Show when={cat.items.length} fallback={<div class="side-empty">{tr('Todavía no tienes símbolos propios: pulsa + para añadir uno.', 'No symbols of your own yet: press + to add one.')}</div>}>
                <div class="sym-grid">
                  <For each={cat.items}>
                    {(it, i) => (
                      <button class={`sym-btn${wide(it[1]) ? ' wide' : ''}`}
                        title={it[2] ? `${it[1]} — ${it[2]}` : it[1]}
                        onClick={() => insertSnippet(insertText(it[1]))}
                        onContextMenu={(e) => { if (cat.mine) { e.preventDefault(); removeSymbol(i()); } }}
                        innerHTML={render(it[1], it[0], it[3])} />
                    )}
                  </For>
                </div>
              </Show>
              <Show when={cat.mine && cat.items.length}>
                <div class="sym-hint">{tr('Clic derecho en uno de los tuyos lo quita.', 'Right-click one of yours to remove it.')}</div>
              </Show>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
