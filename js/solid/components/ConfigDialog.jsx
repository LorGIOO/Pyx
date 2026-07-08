import { Show, For, createSignal, createEffect, onCleanup, onMount } from 'solid-js';
import {
  showConfig, setShowConfig, TOKENS, settings, setToken, resetAll, defaultColor,
  general, setGeneral,
} from '../stores/settingsStore.js';
import {
  KEY_ACTIONS, comboOf, setCombo, resetCombo, resetAllCombos, comboFromEvent, conflictsOf,
} from '../stores/keysStore.js';
import { THEMES, setTheme } from '../stores/themeStore.js';
import { listFonts } from '../../core/platform.js';
import { broadcastSpellRefresh } from '../../editor/setup.js';
import { state, activeDoc } from '../../core/state.js';

const CATEGORIES = [
  { id: 'general', label: 'General' },
  { id: 'lang', label: 'Comprobación del lenguaje' },
  { id: 'syntax', label: 'Resaltado de sintaxis' },
  { id: 'keys', label: 'Atajos de teclado' },
];

// Fallback list until the OS font enumeration resolves.
const FALLBACK_FONTS = ['Cascadia Code', 'Consolas', 'Courier New', 'Fira Code', 'JetBrains Mono', 'Lucida Console'];

// File encodings (UTF-8 is the modern default and what xelatex expects).
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

  // TeXstudio-style format row: color de letra, fondo, N(egrita), C(ursiva),
  // S(ubrayado), T(achado) y O(ndulado).
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
        <span class="cfg-label">{t.label}</span>
        <input type="color" title="Color de letra" value={colorVal(t)}
          onInput={(e) => setToken(t.key, { color: e.target.value })} />
        <input type="color" title="Color de fondo" class="cfg-bg" value={s().bg || '#000000'}
          onInput={(e) => setToken(t.key, { bg: e.target.value })} />
        <button class="cfg-clear" title="Quitar fondo" onClick={() => setToken(t.key, { bg: null })}>⌀</button>
        <Chk k="bold" title="Negrita">N</Chk>
        <Chk k="italic" title="Cursiva"><i>C</i></Chk>
        <Chk k="underline" title="Subrayado"><u>S</u></Chk>
        <Chk k="strike" title="Tachado"><s>T</s></Chk>
        <Chk k="wavy" title="Subrayado ondulado">∿</Chk>
      </div>
    );
  };

  return (
    <Show when={showConfig()}>
      <div class="cfg-overlay">
        <div class="cfg-modal" style={pos() ? { left: pos().x + 'px', top: pos().y + 'px', transform: 'none' } : undefined}>
          <div class="cfg-titlebar" onPointerDown={startDrag}>
            <span>Configuración</span>
            <button class="cfg-close" title="Cerrar" onClick={() => setShowConfig(false)}>✕</button>
          </div>

          <div class="cfg-main">
            <div class="cfg-sidebar">
              <For each={CATEGORIES}>
                {(c) => (
                  <div class={`cfg-cat${cat() === c.id ? ' active' : ''}`} onClick={() => setCat(c.id)}>{c.label}</div>
                )}
              </For>
            </div>

            <div class="cfg-body">
              <Show when={cat() === 'general'}>
                <div class="cfg-section">Tema</div>
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
                <div class="cfg-section">Editor</div>
                <div class="cfg-row">
                  <span class="cfg-label">Tamaño de fuente</span>
                  <input type="range" min="10" max="22" step="0.5" value={general.fontSize || 13.5}
                    onInput={(e) => setGeneral({ fontSize: parseFloat(e.target.value) })} />
                  <span style={{ width: '46px', 'text-align': 'right' }}>{(general.fontSize || 13.5)}px</span>
                </div>
                <div class="cfg-row">
                  <span class="cfg-label">Familia de tipo de letra</span>
                  <div class="cfg-fontpick">
                    <input class="cfg-select" type="text" spellcheck={false}
                      style={{ 'font-family': `"${general.fontFamily || 'Cascadia Code'}"` }}
                      value={fontOpen() ? fontQuery() : (general.fontFamily || 'Cascadia Code')}
                      placeholder="Escribe para buscar una tipografía…"
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
                  <span class="cfg-label">Números de línea</span>
                  <input type="checkbox" checked={general.lineNumbers !== false}
                    onChange={(e) => setGeneral({ lineNumbers: e.target.checked })} />
                </div>
                <div class="cfg-row">
                  <span class="cfg-label">Plegado de bloques (\begin/\end, secciones)</span>
                  <input type="checkbox" checked={general.folding !== false}
                    onChange={(e) => setGeneral({ folding: e.target.checked })} />
                </div>
                <div class="cfg-row">
                  <span class="cfg-label">Eliminar espacios finales al guardar</span>
                  <input type="checkbox" checked={general.trimOnSave === true}
                    onChange={(e) => setGeneral({ trimOnSave: e.target.checked })} />
                </div>

                <div class="cfg-section">Codificación</div>
                <div class="cfg-row">
                  <span class="cfg-label">Codificación de los archivos</span>
                  <select class="cfg-select" value={general.encoding || 'UTF-8'}
                    onChange={(e) => setGeneral({ encoding: e.target.value })}>
                    <For each={ENCODINGS}>{(enc) => <option value={enc}>{enc}</option>}</For>
                  </select>
                </div>
                <p class="cfg-hint">
                  UTF-8 es la recomendada (y la que espera XeLaTeX). Al abrir, Pyx detecta UTF-8 y, si no,
                  recurre a Windows-1252 para que los acentos de archivos antiguos se lean bien.
                </p>

                <div class="cfg-section">Compilación</div>
                <div class="cfg-row">
                  <span class="cfg-label">Motor LaTeX</span>
                  <select class="cfg-select" disabled={!activeDoc()}
                    value={activeDoc()?.engine || state.env.latex || 'xelatex'} onChange={setEngine}>
                    <For each={engines()}>{(e) => <option value={e}>{e}</option>}</For>
                  </select>
                </div>
                <div class="cfg-row">
                  <span class="cfg-label">Compilar al escribir</span>
                  <input type="checkbox" checked={state.liveCompile}
                    onChange={(e) => { state.liveCompile = e.target.checked; setGeneral({ liveCompile: e.target.checked }); }} />
                </div>
                <div class="cfg-row">
                  <span class="cfg-label">Retardo del compilado en vivo</span>
                  <input type="range" min="400" max="3000" step="100" value={general.liveDelay || 1100}
                    onInput={(e) => setGeneral({ liveDelay: parseInt(e.target.value, 10) })} />
                  <span style={{ width: '56px', 'text-align': 'right' }}>{((general.liveDelay || 1100) / 1000).toFixed(1)} s</span>
                </div>
                <p class="cfg-hint">
                  {state.env.latex ? `Motores detectados: ${engines().join(', ')}.` : 'No se detectó LaTeX en el sistema.'}
                  {' '}El motor se aplica al documento activo.
                </p>

                <div class="cfg-section">Visor PDF</div>
                <div class="cfg-row">
                  <span class="cfg-label">Seleccionar en el PDF marca lo mismo en el código</span>
                  <input type="checkbox" checked={general.selSyncPdfToCode === true}
                    onChange={(e) => setGeneral({ selSyncPdfToCode: e.target.checked })} />
                </div>
                <p class="cfg-hint">Al seleccionar una palabra, texto o fórmula en el visor, se selecciona lo
                  equivalente en el editor (usa SyncTeX).</p>
              </Show>

              <Show when={cat() === 'lang'}>
                <div class="cfg-section">Corrector ortográfico</div>
                <div class="cfg-row">
                  <span class="cfg-label">Subrayar errores de ortografía (rojo)</span>
                  <input type="checkbox" checked={general.spellCheck !== false}
                    onChange={(e) => toggleLang('spellCheck', e.target.checked)} />
                </div>
                <p class="cfg-hint">
                  Diccionario español (Hunspell, el mismo motor de Word/LibreOffice). Clic derecho sobre una
                  palabra subrayada para ver sugerencias o agregarla a tu diccionario. Solo revisa el texto:
                  los comandos LaTeX, las matemáticas y las celdas Python se ignoran.
                </p>
                <div class="cfg-section">Gramática y estructura</div>
                <div class="cfg-row">
                  <span class="cfg-label">Subrayar problemas de estructura (azul)</span>
                  <input type="checkbox" checked={general.grammarCheck !== false}
                    onChange={(e) => toggleLang('grammarCheck', e.target.checked)} />
                </div>
                <p class="cfg-hint">Detecta palabras repetidas seguidas («el el»), al estilo de Word.</p>
              </Show>

              <Show when={cat() === 'keys'}>
                <p class="cfg-hint">
                  Atajos de las herramientas de la aplicación (los comandos LaTeX no van aquí: son comandos en sí mismos).
                  Pulsa «Cambiar» y teclea la combinación nueva; Esc cancela. Los conflictos se marcan en rojo.
                </p>
                <div class="cfg-keys-head">
                  <span>Acción</span>
                  <span>Predeterminado</span>
                  <span>Actual</span>
                  <span></span>
                </div>
                <For each={KEY_GROUPS}>
                  {(g) => (
                    <>
                      <div class="cfg-section">{g}</div>
                      <For each={KEY_ACTIONS.filter((a) => a.group === g)}>
                        {(a) => (
                          <div class="cfg-keys-row">
                            <span class="cfg-label">{a.label}</span>
                            <span class="cfg-kbd-default">{a.def || '—'}</span>
                            <span
                              class={`cfg-kbd${capturing() === a.id ? ' capturing' : ''}${conflictsOf(a.id).length ? ' conflict' : ''}`}
                              title={conflictsOf(a.id).length
                                ? `En conflicto con: ${conflictsOf(a.id).map((c) => c.label).join(', ')}`
                                : undefined}
                            >
                              {capturing() === a.id ? 'Pulsa la combinación…' : (comboOf(a.id) || '—')}
                            </span>
                            <span class="cfg-actions">
                              <button class="cfg-btn" onClick={() => setCapturing(a.id)}>Cambiar</button>
                              <button class="cfg-btn icon" title="Quitar el atajo" onClick={() => setCombo(a.id, '')}>⌀</button>
                              <button class="cfg-btn icon" title="Restablecer el atajo por defecto" onClick={() => resetCombo(a.id)}>↺</button>
                            </span>
                          </div>
                        )}
                      </For>
                    </>
                  )}
                </For>
              </Show>

              <Show when={cat() === 'syntax'}>
                <p class="cfg-hint">Personaliza color y estilo de cada elemento, como en TeXstudio. Se aplica y guarda al instante.</p>
                <div class="cfg-section">LaTeX</div>
                <For each={TOKENS.filter((t) => t.group === 'LaTeX')}>{(t) => <Row t={t} />}</For>
                <div class="cfg-section">Python</div>
                <For each={TOKENS.filter((t) => t.group === 'Python')}>{(t) => <Row t={t} />}</For>
              </Show>
            </div>
          </div>

          <div class="cfg-footer">
            <Show when={cat() === 'syntax'}><button onClick={() => resetAll()}>Restablecer colores</button></Show>
            <Show when={cat() === 'keys'}><button onClick={() => resetAllCombos()}>Restablecer atajos</button></Show>
            <button class="primary" onClick={() => setShowConfig(false)}>Cerrar</button>
          </div>
        </div>
      </div>
    </Show>
  );
}
