import { Show, For, createSignal, createEffect, onCleanup, onMount } from 'solid-js';
import {
  showConfig, setShowConfig, TOKENS, settings, setToken, resetAll, defaultColor,
  general, setGeneral,
} from '../stores/settingsStore.js';
import {
  KEY_ACTIONS, comboOf, setCombo, resetCombo, resetAllCombos, comboFromEvent, conflictsOf,
  actionLabel, groupLabel,
} from '../stores/keysStore.js';
import { THEMES, setTheme } from '../stores/themeStore.js';
import { listFonts } from '../../core/platform.js';
import { broadcastSpellRefresh } from '../../editor/setup.js';
import { state, activeDoc } from '../../core/state.js';
// i18n `t` is imported as `tr` here: this file already uses `t` for token rows.
import { t as tr, lang, setLang } from '../../core/i18n.js';

const CATEGORIES = () => [
  { id: 'general', label: 'General' },
  { id: 'lang', label: tr('Comprobación del lenguaje', 'Language checking') },
  { id: 'syntax', label: tr('Resaltado de sintaxis', 'Syntax highlighting') },
  { id: 'keys', label: tr('Atajos de teclado', 'Keyboard shortcuts') },
];

// Fallback list until the OS font enumeration resolves.
const FALLBACK_FONTS = ['Cascadia Code', 'Consolas', 'Courier New', 'Fira Code', 'JetBrains Mono', 'Lucida Console'];

// File encodings (UTF-8 is the modern default and what xelatex expects). The
// values are stable identifiers, not translated.
const ENCODINGS = ['UTF-8', 'UTF-8 con BOM', 'ISO-8859-1 (Latin-1)', 'Windows-1252', 'US-ASCII'];

const KEY_GROUPS = [...new Set(KEY_ACTIONS.map((a) => a.group))];

export default function ConfigDialog() {
  const [pos, setPos] = createSignal(null);
  const [cat, setCat] = createSignal('syntax');
  const [capturing, setCapturing] = createSignal(null); // action id being rebound
  const [fonts, setFonts] = createSignal(FALLBACK_FONTS);
  const [fontQuery, setFontQuery] = createSignal('');
  const [fontOpen, setFontOpen] = createSignal(false);
  // Type-to-filter, Word-style: shows matching families, each in its own face.
  const filteredFonts = () => {
    const q = fontQuery().trim().toLowerCase();
    const list = fonts();
    return (q ? list.filter((f) => f.toLowerCase().includes(q)) : list).slice(0, 80);
  };

  // Enumerate the installed system fonts once (so the picker shows them all,
  // like Word) — keeping the current selection available even if absent.
  onMount(() => {
    listFonts().then((list) => {
      if (Array.isArray(list) && list.length) {
        const cur = general.fontFamily;
        const all = cur && !list.includes(cur) ? [cur, ...list] : list;
        setFonts(all);
      }
    }).catch(() => {});
  });

  const toggleLang = (key, val) => { setGeneral({ [key]: val }); broadcastSpellRefresh(); };

  // While capturing, the NEXT key combination becomes the binding (Esc
  // cancels). Capture-phase + stopImmediatePropagation so the pressed combo
  // never triggers the action itself mid-capture.
  createEffect(() => {
    const id = capturing();
    if (!id) return;
    const onKey = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Escape') { setCapturing(null); return; }
      const combo = comboFromEvent(e);
      if (!combo) return; // bare modifier — keep waiting
      setCombo(id, combo);
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    onCleanup(() => window.removeEventListener('keydown', onKey, { capture: true }));
  });

  const startDrag = (e) => {
    if (e.target.closest('.cfg-close')) return;
    e.preventDefault();
    const rect = e.currentTarget.parentElement.getBoundingClientRect();
    const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
    const move = (ev) => setPos({ x: ev.clientX - offX, y: ev.clientY - offY });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const colorVal = (t) => (settings[t.key] && settings[t.key].color) || defaultColor(t);
  const engines = () => (state.env.engines && state.env.engines.length ? state.env.engines : ['xelatex', 'pdflatex', 'lualatex']);
  const setEngine = (e) => { const d = activeDoc(); if (d) d.engine = e.target.value; };

  // TeXstudio-style format row: text color, background, B(old), I(talic),
  // U(nderline), S(trike) and wavy.
  const Row = (props) => {
    const t = props.t;
    const s = () => settings[t.key] || {};
    const Chk = (p) => (
      <label class="cfg-chk" title={p.title}>
        <input type="checkbox" checked={!!s()[p.k]} onChange={(e) => setToken(t.key, { [p.k]: e.target.checked })} />
        {' '}{p.children}
      </label>
    );
    return (
      <div class="cfg-row">
        <span class="cfg-label">{tr(t.label, t.en || t.label)}</span>
        <input type="color" title={tr('Color de letra', 'Text color')} value={colorVal(t)}
          onInput={(e) => setToken(t.key, { color: e.target.value })} />
        <input type="color" title={tr('Color de fondo', 'Background color')} class="cfg-bg" value={s().bg || '#000000'}
          onInput={(e) => setToken(t.key, { bg: e.target.value })} />
        <button class="cfg-clear" title={tr('Quitar fondo', 'Remove background')} onClick={() => setToken(t.key, { bg: null })}>⌀</button>
        <Chk k="bold" title={tr('Negrita', 'Bold')}>N</Chk>
        <Chk k="italic" title={tr('Cursiva', 'Italic')}><i>C</i></Chk>
        <Chk k="underline" title={tr('Subrayado', 'Underline')}><u>S</u></Chk>
        <Chk k="strike" title={tr('Tachado', 'Strikethrough')}><s>T</s></Chk>
        <Chk k="wavy" title={tr('Subrayado ondulado', 'Wavy underline')}>∿</Chk>
      </div>
    );
  };

  return (
    <Show when={showConfig()}>
      <div class="cfg-overlay">
        <div class="cfg-modal" style={pos() ? { left: pos().x + 'px', top: pos().y + 'px', transform: 'none' } : undefined}>
          <div class="cfg-titlebar" onPointerDown={startDrag}>
            <span>{tr('Configuración', 'Settings')}</span>
            <button class="cfg-close" title={tr('Cerrar', 'Close')} onClick={() => setShowConfig(false)}>✕</button>
          </div>

          <div class="cfg-main">
            <div class="cfg-sidebar">
              <For each={CATEGORIES()}>
                {(c) => (
                  <div class={`cfg-cat${cat() === c.id ? ' active' : ''}`} onClick={() => setCat(c.id)}>{c.label}</div>
                )}
              </For>
            </div>

            <div class="cfg-body">
              <Show when={cat() === 'general'}>
                <div class="cfg-section">{tr('Idioma', 'Language')}</div>
                <div class="cfg-row">
                  <span class="cfg-label">{tr('Idioma de la interfaz', 'Interface language')}</span>
                  <select class="cfg-select" value={lang()} onChange={(e) => setLang(e.target.value)}>
                    <option value="es">Español</option>
                    <option value="en">English</option>
                  </select>
                </div>

                <div class="cfg-section">{tr('Tema', 'Theme')}</div>
                <div class="cfg-theme-row">
                  <For each={THEMES}>
                    {(th) => (
                      <button
                        class={`cfg-theme${state.theme === th.id ? ' active' : ''}`}
                        onClick={() => setTheme(th.id)}
                        style={{ background: `linear-gradient(135deg, ${th.swatches[0]} 0 50%, ${th.swatches[1]} 50% 100%)` }}
                        title={th.label}
                      >{th.label}</button>
                    )}
                  </For>
                </div>
                <div class="cfg-section">{tr('Editor', 'Editor')}</div>
                <div class="cfg-row">
                  <span class="cfg-label">{tr('Tamaño de fuente', 'Font size')}</span>
                  <input type="range" min="10" max="22" step="0.5" value={general.fontSize || 13.5}
                    onInput={(e) => setGeneral({ fontSize: parseFloat(e.target.value) })} />
                  <span style={{ width: '46px', 'text-align': 'right' }}>{(general.fontSize || 13.5)}px</span>
                </div>
                <div class="cfg-row">
                  <span class="cfg-label">{tr('Familia de tipo de letra', 'Font family')}</span>
                  <div class="cfg-fontpick">
                    <input class="cfg-select" type="text" spellcheck={false}
                      style={{ 'font-family': `"${general.fontFamily || 'Cascadia Code'}"` }}
                      value={fontOpen() ? fontQuery() : (general.fontFamily || 'Cascadia Code')}
                      placeholder={tr('Escribe para buscar una tipografía…', 'Type to search a font…')}
                      onFocus={() => { setFontQuery(''); setFontOpen(true); }}
                      onInput={(e) => { setFontQuery(e.target.value); setFontOpen(true); }}
                      onBlur={() => setTimeout(() => setFontOpen(false), 160)} />
                    <Show when={fontOpen()}>
                      <div class="cfg-font-list">
                        <For each={filteredFonts()}>
                          {(f) => (
                            <div class="cfg-font-item" style={{ 'font-family': `"${f}"` }}
                              onMouseDown={() => { setGeneral({ fontFamily: f }); setFontQuery(f); setFontOpen(false); }}>
                              {f}
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </div>
                <div class="cfg-row">
                  <span class="cfg-label">{tr('Números de línea', 'Line numbers')}</span>
                  <input type="checkbox" checked={general.lineNumbers !== false}
                    onChange={(e) => setGeneral({ lineNumbers: e.target.checked })} />
                </div>
                <div class="cfg-row">
                  <span class="cfg-label">{tr('Plegado de bloques (\\begin/\\end, secciones)', 'Block folding (\\begin/\\end, sections)')}</span>
                  <input type="checkbox" checked={general.folding !== false}
                    onChange={(e) => setGeneral({ folding: e.target.checked })} />
                </div>
                <div class="cfg-row">
                  <span class="cfg-label">{tr('Eliminar espacios finales al guardar', 'Trim trailing spaces on save')}</span>
                  <input type="checkbox" checked={general.trimOnSave === true}
                    onChange={(e) => setGeneral({ trimOnSave: e.target.checked })} />
                </div>

                <div class="cfg-section">{tr('Codificación', 'Encoding')}</div>
                <div class="cfg-row">
                  <span class="cfg-label">{tr('Codificación de los archivos', 'File encoding')}</span>
                  <select class="cfg-select" value={general.encoding || 'UTF-8'}
                    onChange={(e) => setGeneral({ encoding: e.target.value })}>
                    <For each={ENCODINGS}>{(enc) => <option value={enc}>{enc}</option>}</For>
                  </select>
                </div>
                <p class="cfg-hint">
                  {tr(
                    'UTF-8 es la recomendada (y la que espera XeLaTeX). Al abrir, Pyx detecta UTF-8 y, si no, recurre a Windows-1252 para que los acentos de archivos antiguos se lean bien.',
                    'UTF-8 is recommended (and what XeLaTeX expects). On open, Pyx detects UTF-8 and, failing that, falls back to Windows-1252 so accents in older files read correctly.',
                  )}
                </p>

                <div class="cfg-section">{tr('Compilación', 'Compilation')}</div>
                <div class="cfg-row">
                  <span class="cfg-label">{tr('Motor LaTeX', 'LaTeX engine')}</span>
                  <select class="cfg-select" disabled={!activeDoc()}
                    value={activeDoc()?.engine || state.env.latex || 'xelatex'} onChange={setEngine}>
                    <For each={engines()}>{(e) => <option value={e}>{e}</option>}</For>
                  </select>
                </div>
                <div class="cfg-row">
                  <span class="cfg-label">{tr('Compilar al escribir', 'Compile on type')}</span>
                  <input type="checkbox" checked={state.liveCompile}
                    onChange={(e) => { state.liveCompile = e.target.checked; setGeneral({ liveCompile: e.target.checked }); }} />
                </div>
                <div class="cfg-row">
                  <span class="cfg-label">{tr('Retardo del compilado en vivo', 'Live-compile delay')}</span>
                  <input type="range" min="400" max="3000" step="100" value={general.liveDelay || 1100}
                    onInput={(e) => setGeneral({ liveDelay: parseInt(e.target.value, 10) })} />
                  <span style={{ width: '56px', 'text-align': 'right' }}>{((general.liveDelay || 1100) / 1000).toFixed(1)} s</span>
                </div>
                <p class="cfg-hint">
                  {state.env.latex
                    ? `${tr('Motores detectados', 'Detected engines')}: ${engines().join(', ')}.`
                    : tr('No se detectó LaTeX en el sistema.', 'No LaTeX found on the system.')}
                  {' '}{tr('El motor se aplica al documento activo.', 'The engine applies to the active document.')}
                </p>

                <div class="cfg-section">{tr('Visor PDF', 'PDF viewer')}</div>
                <div class="cfg-row">
                  <span class="cfg-label">{tr('Seleccionar en el PDF marca lo mismo en el código', 'Selecting in the PDF marks the same in the code')}</span>
                  <input type="checkbox" checked={general.selSyncPdfToCode === true}
                    onChange={(e) => setGeneral({ selSyncPdfToCode: e.target.checked })} />
                </div>
                <p class="cfg-hint">{tr(
                  'Al seleccionar una palabra, texto o fórmula en el visor, se selecciona lo equivalente en el editor (usa SyncTeX).',
                  'When you select a word, text or formula in the viewer, the equivalent is selected in the editor (uses SyncTeX).',
                )}</p>
              </Show>

              <Show when={cat() === 'lang'}>
                <div class="cfg-section">{tr('Corrector ortográfico', 'Spell checker')}</div>
                <div class="cfg-row">
                  <span class="cfg-label">{tr('Subrayar errores de ortografía (rojo)', 'Underline spelling errors (red)')}</span>
                  <input type="checkbox" checked={general.spellCheck !== false}
                    onChange={(e) => toggleLang('spellCheck', e.target.checked)} />
                </div>
                <p class="cfg-hint">
                  {tr(
                    'Diccionario español (Hunspell, el mismo motor de Word/LibreOffice). Clic derecho sobre una palabra subrayada para ver sugerencias o agregarla a tu diccionario. Solo revisa el texto: los comandos LaTeX, las matemáticas y las celdas Python se ignoran.',
                    'Spanish dictionary (Hunspell, the same engine as Word/LibreOffice). Right-click an underlined word to see suggestions or add it to your dictionary. It only checks text: LaTeX commands, math and Python cells are ignored.',
                  )}
                </p>
                <div class="cfg-section">{tr('Gramática y estructura', 'Grammar and structure')}</div>
                <div class="cfg-row">
                  <span class="cfg-label">{tr('Subrayar problemas de estructura (azul)', 'Underline structure problems (blue)')}</span>
                  <input type="checkbox" checked={general.grammarCheck !== false}
                    onChange={(e) => toggleLang('grammarCheck', e.target.checked)} />
                </div>
                <p class="cfg-hint">{tr('Detecta palabras repetidas seguidas («el el»), al estilo de Word.', 'Detects consecutive repeated words ("the the"), Word-style.')}</p>
              </Show>

              <Show when={cat() === 'keys'}>
                <p class="cfg-hint">
                  {tr(
                    'Atajos de las herramientas de la aplicación (los comandos LaTeX no van aquí: son comandos en sí mismos). Pulsa «Cambiar» y teclea la combinación nueva; Esc cancela. Los conflictos se marcan en rojo.',
                    'Shortcuts for the app tools (LaTeX commands do not go here: they are commands in themselves). Press "Change" and type the new combination; Esc cancels. Conflicts are marked in red.',
                  )}
                </p>
                <div class="cfg-keys-head">
                  <span>{tr('Acción', 'Action')}</span>
                  <span>{tr('Predeterminado', 'Default')}</span>
                  <span>{tr('Actual', 'Current')}</span>
                  <span></span>
                </div>
                <For each={KEY_GROUPS}>
                  {(g) => (
                    <>
                      <div class="cfg-section">{groupLabel(g)}</div>
                      <For each={KEY_ACTIONS.filter((a) => a.group === g)}>
                        {(a) => (
                          <div class="cfg-keys-row">
                            <span class="cfg-label">{actionLabel(a)}</span>
                            <span class="cfg-kbd-default">{a.def || '—'}</span>
                            <span
                              class={`cfg-kbd${capturing() === a.id ? ' capturing' : ''}${conflictsOf(a.id).length ? ' conflict' : ''}`}
                              title={conflictsOf(a.id).length
                                ? `${tr('En conflicto con', 'Conflicts with')}: ${conflictsOf(a.id).map((c) => actionLabel(c)).join(', ')}`
                                : undefined}
                            >
                              {capturing() === a.id ? tr('Pulsa la combinación…', 'Press the combination…') : (comboOf(a.id) || '—')}
                            </span>
                            <span class="cfg-actions">
                              <button class="cfg-btn" onClick={() => setCapturing(a.id)}>{tr('Cambiar', 'Change')}</button>
                              <button class="cfg-btn icon" title={tr('Quitar el atajo', 'Remove the shortcut')} onClick={() => setCombo(a.id, '')}>⌀</button>
                              <button class="cfg-btn icon" title={tr('Restablecer el atajo por defecto', 'Reset to default shortcut')} onClick={() => resetCombo(a.id)}>↺</button>
                            </span>
                          </div>
                        )}
                      </For>
                    </>
                  )}
                </For>
              </Show>

              <Show when={cat() === 'syntax'}>
                <p class="cfg-hint">{tr('Personaliza color y estilo de cada elemento, como en TeXstudio. Se aplica y guarda al instante.', 'Customize the color and style of each element, like in TeXstudio. Applied and saved instantly.')}</p>
                <div class="cfg-section">LaTeX</div>
                <For each={TOKENS.filter((t) => t.group === 'LaTeX')}>{(t) => <Row t={t} />}</For>
                <div class="cfg-section">Python</div>
                <For each={TOKENS.filter((t) => t.group === 'Python')}>{(t) => <Row t={t} />}</For>
              </Show>
            </div>
          </div>

          <div class="cfg-footer">
            <Show when={cat() === 'syntax'}><button onClick={() => resetAll()}>{tr('Restablecer colores', 'Reset colors')}</button></Show>
            <Show when={cat() === 'keys'}><button onClick={() => resetAllCombos()}>{tr('Restablecer atajos', 'Reset shortcuts')}</button></Show>
            <button class="primary" onClick={() => setShowConfig(false)}>{tr('Cerrar', 'Close')}</button>
          </div>
        </div>
      </div>
    </Show>
  );
}
