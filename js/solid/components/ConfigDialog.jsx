import { Show, For, createSignal, createEffect, onCleanup, onMount } from 'solid-js';
import {
  showConfig, setShowConfig, TOKENS, settings, setToken, resetAll, defaultColor,
  general, gv, setGeneral, resetGeneralSection, resetGeneralAll, GENERAL_SECTIONS,
} from '../stores/settingsStore.js';
import {
  KEY_ACTIONS, comboOf, setCombo, resetCombo, resetAllCombos, comboFromEvent, conflictsOf,
  actionLabel, groupLabel,
} from '../stores/keysStore.js';
import { THEMES, setTheme, DEFAULT_THEME } from '../stores/themeStore.js';
import { listFonts } from '../../core/platform.js';
import {
  broadcastSpellRefresh, setMinimapEnabled, applyEditorSettings,
} from '../../editor/setup.js';
import { spellLang, setSpellLang } from '../../editor/spellcheck.js';
import { setKernelPython } from '../../editor/cell-runner.js';
import { setFit, setZoom, setLoupeZoom } from '../../pdf/preview.js';
import { setInvert } from '../stores/previewStore.js';
import { state, activeDoc } from '../../core/state.js';
// i18n `t` is imported as `tr` here: this file already uses `t` for token rows.
import { t as tr, lang, setLang } from '../../core/i18n.js';
import { icons } from './ribbon/icons.js';

const CATEGORIES = () => [
  { id: 'general', label: 'General' },
  { id: 'editor', label: tr('Editor', 'Editor') },
  { id: 'complete', label: tr('Autocompletado', 'Completion') },
  { id: 'syntax', label: tr('Resaltado de sintaxis', 'Syntax highlighting') },
  { id: 'cells', label: tr('Celdas Python', 'Python cells') },
  { id: 'compile', label: tr('Compilación', 'Compilation') },
  { id: 'pdf', label: tr('Visor PDF', 'PDF viewer') },
  { id: 'lang', label: tr('Comprobación del lenguaje', 'Language checking') },
  { id: 'keys', label: tr('Atajos de teclado', 'Keyboard shortcuts') },
];

// Categories whose contents are hand-built (token table, shortcut table): they
// have no searchable option rows.
const CUSTOM_CATS = ['syntax', 'keys'];

// Fallback list until the OS font enumeration resolves.
const FALLBACK_FONTS = ['Cascadia Code', 'Consolas', 'Courier New', 'Fira Code', 'JetBrains Mono', 'Lucida Console'];

// File encodings (UTF-8 is the modern default and what xelatex expects). The
// values are stable identifiers, not translated.
const ENCODINGS = ['UTF-8', 'UTF-8 con BOM', 'ISO-8859-1 (Latin-1)', 'Windows-1252', 'US-ASCII'];

const KEY_GROUPS = [...new Set(KEY_ACTIONS.map((a) => a.group))];

/* Every plain option, as data.
 *
 * Declaring the rows instead of writing them by hand is what makes the search
 * box at the top possible: one list to filter, and a hit can be shown with its
 * own control no matter which category it lives in.
 *
 *   cat    — category id (the left rail)
 *   sec    — [es, en] section heading inside the category
 *   key    — general-settings key (default get/set); omit with custom get/set
 *   type   — check | select | range | number | text | custom
 *   after  — extra work once the value changed (reconfigure CodeMirror, …)
 */
const EDIT = () => applyEditorSettings();

const FIELDS = () => [
  /* ---------------- General ---------------- */
  {
    cat: 'general', sec: ['Idioma', 'Language'], type: 'select',
    label: 'Idioma de la interfaz', en: 'Interface language',
    get: () => lang(), set: (v) => setLang(v),
    opts: [['es', 'Español'], ['en', 'English']],
  },
  {
    cat: 'general', sec: ['Tema', 'Theme'], type: 'custom', custom: 'theme',
    label: 'Tema de la aplicación', en: 'Application theme',
  },
  {
    cat: 'general', sec: ['Sesión', 'Session'], key: 'restoreSession', type: 'check',
    label: 'Restaurar la sesión al abrir', en: 'Restore the session on launch',
    hint: ['Al arrancar sin abrir ningún archivo concreto, Pyx vuelve a abrir los documentos que estaban abiertos la última vez.',
      'When starting without a specific file, Pyx reopens the documents that were open last time.'],
  },
  {
    cat: 'general', sec: ['Sesión', 'Session'], key: 'autosave', type: 'check',
    label: 'Autoguardado del documento activo', en: 'Autosave the active document',
  },
  {
    cat: 'general', sec: ['Sesión', 'Session'], key: 'autosaveMin', type: 'range',
    label: 'Intervalo de autoguardado', en: 'Autosave interval',
    // Dead while autosave is off: the slider moved and the number changed, but
    // nothing was ever going to use it.
    when: () => gv('autosave') === true,
    min: 1, max: 30, step: 1, unit: (v) => `${v} min`,
    hint: ['Solo se guardan los documentos que ya tienen archivo en el disco: el autoguardado nunca abre el diálogo «Guardar como».',
      'Only documents that already have a file on disk are saved: autosave never opens a "Save as" dialog.'],
  },

  /* ---------------- Editor ---------------- */
  // The font picker is a searchable list, not a plain control: the dialog
  // renders it itself (see `custom`), but it is declared here so it keeps its
  // place in the section and turns up in the option search like the rest.
  {
    cat: 'editor', sec: ['Tipografía', 'Typography'], type: 'custom', custom: 'font',
    label: 'Familia de tipo de letra', en: 'Font family',
  },
  {
    cat: 'editor', sec: ['Tipografía', 'Typography'], key: 'fontSize', type: 'range',
    label: 'Tamaño de fuente', en: 'Font size',
    min: 8, max: 28, step: 0.5, unit: (v) => `${v} px`,
  },
  {
    cat: 'editor', sec: ['Tipografía', 'Typography'], key: 'lineHeight', type: 'range',
    label: 'Interlineado', en: 'Line spacing',
    min: 1, max: 2.4, step: 0.05, unit: (v) => `${Math.round(v * 100)} %`,
  },
  {
    cat: 'editor', sec: ['Tipografía', 'Typography'], key: 'boldCursor', type: 'check',
    label: 'Cursor grueso', en: 'Bold cursor',
  },
  {
    cat: 'editor', sec: ['Presentación', 'Appearance'], key: 'lineNumbers', type: 'check',
    label: 'Números de línea', en: 'Line numbers',
  },
  {
    cat: 'editor', sec: ['Presentación', 'Appearance'], key: 'folding', type: 'check',
    label: 'Plegado de bloques (\\begin/\\end, secciones)', en: 'Block folding (\\begin/\\end, sections)',
  },
  {
    cat: 'editor', sec: ['Presentación', 'Appearance'], key: 'minimap', type: 'check',
    label: 'Minimapa (estilo VSCode)', en: 'Minimap (VSCode-style)',
    after: (v) => setMinimapEnabled(v),
  },
  {
    cat: 'editor', sec: ['Presentación', 'Appearance'], key: 'indentGuidesOn', type: 'check',
    label: 'Guías de indentación', en: 'Indent guides', after: EDIT,
  },
  {
    cat: 'editor', sec: ['Presentación', 'Appearance'], key: 'activeLine', type: 'check',
    label: 'Resaltar la línea actual', en: 'Highlight the current line', after: EDIT,
  },
  {
    cat: 'editor', sec: ['Presentación', 'Appearance'], key: 'selectionMatches', type: 'check',
    label: 'Resaltar las demás apariciones de lo seleccionado', en: 'Highlight other occurrences of the selection',
    after: EDIT,
  },
  {
    cat: 'editor', sec: ['Presentación', 'Appearance'], key: 'wrapColumn', type: 'range',
    label: 'Regla de margen en la columna', en: 'Margin ruler at column',
    min: 0, max: 200, step: 5,
    unit: (v) => (+v ? String(v) : tr('sin regla', 'off')), after: EDIT,
  },
  {
    cat: 'editor', sec: ['Escritura', 'Typing'], key: 'tabSize', type: 'range',
    label: 'Ancho de tabulación', en: 'Tab width',
    min: 1, max: 12, step: 1, unit: (v) => tr(`${v} espacios`, `${v} spaces`), after: EDIT,
  },
  {
    cat: 'editor', sec: ['Escritura', 'Typing'], key: 'indentWithSpaces', type: 'check',
    label: 'Indentar con espacios (en vez de tabuladores)', en: 'Indent with spaces (instead of tabs)',
    after: EDIT,
  },
  {
    cat: 'editor', sec: ['Escritura', 'Typing'], key: 'autoIndent', type: 'check',
    label: 'Indentación automática', en: 'Automatic indentation', after: EDIT,
  },
  {
    cat: 'editor', sec: ['Escritura', 'Typing'], key: 'lineWrap', type: 'check',
    label: 'Ajuste de línea', en: 'Line wrapping', after: EDIT,
    hint: ['Sin ajuste, las líneas largas se salen a la derecha y el editor se desplaza en horizontal, como en TeXstudio.',
      'Without wrapping, long lines run off to the right and the editor scrolls horizontally, as in TeXstudio.'],
  },
  {
    cat: 'editor', sec: ['Escritura', 'Typing'], key: 'matchBrackets', type: 'check',
    label: 'Emparejar paréntesis y llaves', en: 'Parentheses matching', after: EDIT,
  },
  {
    cat: 'editor', sec: ['Escritura', 'Typing'], key: 'closeBrackets', type: 'check',
    label: 'Cerrar paréntesis y llaves automáticamente', en: 'Parentheses completion', after: EDIT,
  },
  {
    cat: 'editor', sec: ['Espacios en blanco', 'Whitespace'], key: 'showWhitespace', type: 'check',
    label: 'Mostrar los espacios en blanco', en: 'Show whitespace', after: EDIT,
  },
  {
    cat: 'editor', sec: ['Espacios en blanco', 'Whitespace'], key: 'showTrailingWs', type: 'check',
    label: 'Marcar los espacios al final de la línea', en: 'Mark trailing whitespace', after: EDIT,
  },
  {
    cat: 'editor', sec: ['Espacios en blanco', 'Whitespace'], key: 'trimOnSave', type: 'check',
    label: 'Eliminar los espacios finales al guardar', en: 'Remove trailing whitespace on save',
  },
  {
    cat: 'editor', sec: ['Desplazamiento', 'Scrolling'], key: 'cursorMargin', type: 'range',
    label: 'Líneas visibles por encima y por debajo del cursor', en: 'Cursor surrounding lines',
    min: 0, max: 20, step: 1, unit: (v) => (+v ? tr(`${v} líneas`, `${v} lines`) : '0'), after: EDIT,
  },
  {
    cat: 'editor', sec: ['Desplazamiento', 'Scrolling'], key: 'wheelZoom', type: 'check',
    label: 'Zoom con Ctrl + rueda del ratón', en: 'Ctrl + mouse wheel zoom',
  },
  {
    cat: 'editor', sec: ['Desplazamiento', 'Scrolling'], key: 'smoothScroll', type: 'check',
    label: 'Desplazamiento suave', en: 'Smooth scrolling',
  },

  /* ---------------- Autocompletado ---------------- */
  {
    cat: 'complete', sec: ['Autocompletado', 'Completion'], key: 'completion', type: 'check',
    label: 'Activar el autocompletado', en: 'Enable completion', after: EDIT,
    hint: ['Comandos LaTeX, entornos, etiquetas de \\ref, claves de \\cite y nombres de Python dentro de las celdas.',
      'LaTeX commands, environments, \\ref labels, \\cite keys and Python names inside the cells.'],
  },
  {
    cat: 'complete', sec: ['Autocompletado', 'Completion'], key: 'completionOnTyping', type: 'check',
    label: 'Sugerir mientras se escribe', en: 'Suggest while typing', after: EDIT,
    hint: ['Desactivado, las sugerencias solo aparecen al pulsar Ctrl+Espacio.',
      'When off, suggestions only appear on Ctrl+Space.'],
  },
  {
    cat: 'complete', sec: ['Autocompletado', 'Completion'], key: 'completionCaseSensitive', type: 'check',
    label: 'Distinguir mayúsculas y minúsculas', en: 'Case sensitive', after: EDIT,
  },
  {
    cat: 'complete', sec: ['Autocompletado', 'Completion'], key: 'completionSelectFirst', type: 'check',
    label: 'Seleccionar la primera sugerencia', en: 'Select the first suggestion', after: EDIT,
  },
  {
    cat: 'complete', sec: ['Autocompletado', 'Completion'], key: 'completionIcons', type: 'check',
    label: 'Mostrar el icono del tipo de cada sugerencia', en: 'Show the type icon of each suggestion',
    after: EDIT,
  },

  /* ---------------- Resaltado de sintaxis ---------------- */
  {
    cat: 'syntax', sec: ['Paleta', 'Palette'], key: 'pyPalette', type: 'select',
    label: 'Paleta de Python', en: 'Python palette',
    opts: [
      ['classic', tr('VS Code clásico (Dark+ / Light+)', 'Classic VS Code (Dark+ / Light+)')],
      ['2026', tr('VS Code 2026 (el de fábrica actual)', 'VS Code 2026 (the current factory theme)')],
    ],
    hint: ['VS Code 1.138 cambió su tema de fábrica; la clásica es la que lleva estable desde 2015. Los colores que ajustes abajo se aplican encima de la paleta elegida.',
      'VS Code 1.138 changed its factory theme; the classic one has been stable since 2015. The colors you tune below apply on top of the chosen palette.'],
  },

  /* ---------------- Celdas Python ---------------- */
  {
    cat: 'cells', sec: ['Ejecución', 'Execution'], key: 'pyGhost', type: 'check',
    label: 'Mostrar el valor en vivo después de cada \\py{}', en: 'Show the live value after each \\py{}',
    after: EDIT,
    hint: ['Estilo Mathcad: el resultado aparece atenuado junto a la expresión, sin tocar el documento.',
      'Mathcad-style: the result appears greyed next to the expression, without touching the document.'],
  },
  {
    cat: 'cells', sec: ['Resultados', 'Results'], key: 'saveOutputs', type: 'check',
    label: 'Guardar los resultados dentro del documento', en: 'Store results inside the document',
    hint: ['Los resultados viajan dentro del .pltx: al reabrir el informe se ven los números, las tablas y las figuras sin volver a ejecutar nada (ni hace falta Python). Un resultado cuya celda haya cambiado se descarta y la celda se marca como desactualizada.',
      'Results travel inside the .pltx: reopening the report shows its numbers, tables and figures without re-running anything (Python is not even needed). A result whose cell has changed is discarded and the cell is marked out of date.'],
  },

  /* ---------------- Compilación ---------------- */
  {
    cat: 'compile', sec: ['Compilación en vivo', 'Live compilation'], type: 'check',
    label: 'Compilar al escribir', en: 'Compile on type',
    get: () => state.liveCompile,
    set: (v) => { state.liveCompile = v; setGeneral({ liveCompile: v }); },
  },
  {
    cat: 'compile', sec: ['Compilación en vivo', 'Live compilation'], key: 'liveDelay', type: 'range',
    label: 'Retardo del compilado en vivo', en: 'Live-compile delay',
    min: 400, max: 3000, step: 100, unit: (v) => `${(v / 1000).toFixed(1)} s`,
    hint: ['Pyx espera además, como mínimo, el triple de lo que tardó la última compilación: un proyecto muy pesado deja de rehacerse en cada pausa.',
      'Pyx also waits at least three times what the last compile took: a very heavy project stops rebuilding on every pause.'],
  },
  {
    cat: 'compile', sec: ['Archivos', 'Files'], key: 'encoding', type: 'select',
    label: 'Codificación de los archivos', en: 'File encoding',
    opts: ENCODINGS.map((e) => [e, e]),
    hint: ['UTF-8 es la recomendada (y la que espera XeLaTeX). Al abrir, Pyx detecta UTF-8 y, si no, recurre a Windows-1252 para que los acentos de archivos antiguos se lean bien.',
      'UTF-8 is recommended (and what XeLaTeX expects). On open, Pyx detects UTF-8 and, failing that, falls back to Windows-1252 so accents in older files read correctly.'],
  },

  /* ---------------- Visor PDF ---------------- */
  {
    cat: 'pdf', sec: ['Vista', 'View'], type: 'select',
    label: 'Zoom al abrir un PDF', en: 'Zoom when a PDF opens',
    get: () => (gv('pdfFit') === 'none' ? String(gv('pdfZoom') || 1) : gv('pdfFit')),
    set: (v) => {
      const n = parseFloat(v);
      if (Number.isFinite(n)) { setGeneral({ pdfFit: 'none', pdfZoom: n }); setZoom(n); }
      else { setGeneral({ pdfFit: v }); setFit(v); }
    },
    opts: () => [
      ['width', tr('Ajustar al ancho', 'Fit width')],
      ['height', tr('Ajustar al alto', 'Fit height')],
      ['page', tr('Página completa', 'Whole page')],
      ['text', tr('Ajustar al texto', 'Fit text')],
      ['1', '100 %'], ['1.25', '125 %'], ['1.5', '150 %'],
    ],
  },
  {
    cat: 'pdf', sec: ['Vista', 'View'], key: 'pdfInvert', type: 'check',
    label: 'Invertir los colores (modo noche)', en: 'Invert colors (night mode)',
    after: (v) => setInvert(v),
  },
  {
    cat: 'pdf', sec: ['Lupa', 'Magnifier'], key: 'loupeZoom', type: 'range',
    label: 'Aumento de la lupa', en: 'Magnifier zoom',
    min: 1.5, max: 16, step: 0.5, unit: (v) => `${(+v).toFixed(1)}×`,
    after: (v) => setLoupeZoom(+v),
  },
  {
    cat: 'pdf', sec: ['Sincronización', 'Synchronization'], key: 'selSyncPdfToCode', type: 'check',
    label: 'Seleccionar en el PDF marca lo mismo en el código', en: 'Selecting in the PDF marks the same in the code',
    hint: ['Al seleccionar una palabra, texto o fórmula en el visor, se selecciona lo equivalente en el editor (usa SyncTeX).',
      'When you select a word, text or formula in the viewer, the equivalent is selected in the editor (uses SyncTeX).'],
  },

  /* ---------------- Comprobación del lenguaje ---------------- */
  {
    cat: 'lang', sec: ['Corrector ortográfico', 'Spell checker'], key: 'spellCheck', type: 'check',
    label: 'Subrayar errores de ortografía (rojo)', en: 'Underline spelling errors (red)',
    after: () => broadcastSpellRefresh(),
  },
  {
    cat: 'lang', sec: ['Corrector ortográfico', 'Spell checker'], type: 'select',
    label: 'Idioma de revisión', en: 'Proofing language',
    get: () => spellLang(),
    set: (v) => {
      broadcastSpellRefresh(); // clear the old language's marks now
      setSpellLang(v).then(broadcastSpellRefresh);
    },
    opts: [['es', 'Español'], ['en', 'English']],
    hint: ['Hunspell, el mismo motor de Word/LibreOffice. Clic derecho sobre una palabra subrayada para ver sugerencias o agregarla a tu diccionario. Solo revisa el texto: los comandos LaTeX, las matemáticas y las celdas Python se ignoran.',
      'Hunspell, the same engine as Word/LibreOffice. Right-click an underlined word to see suggestions or add it to your dictionary. It only checks text: LaTeX commands, math and Python cells are ignored.'],
  },
  {
    cat: 'lang', sec: ['Gramática y estructura', 'Grammar and structure'], key: 'grammarCheck', type: 'check',
    label: 'Subrayar problemas de estructura (azul)', en: 'Underline structure problems (blue)',
    after: () => broadcastSpellRefresh(),
    hint: ['Detecta palabras repetidas seguidas («el el»), al estilo de Word.',
      'Detects consecutive repeated words ("the the"), Word-style.'],
  },
];

export default function ConfigDialog() {
  const [pos, setPos] = createSignal(null);
  const [cat, setCat] = createSignal('general');
  const [query, setQuery] = createSignal('');
  const [confirmReset, setConfirmReset] = createSignal(false);
  const [capturing, setCapturing] = createSignal(null); // action id being rebound
  const [fonts, setFonts] = createSignal(FALLBACK_FONTS);
  const [fontQuery, setFontQuery] = createSignal('');
  const [fontOpen, setFontOpen] = createSignal(false);
  const [pyPath, setPyPath] = createSignal(gv('pythonPath') || '');
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
        const cur = gv('fontFamily');
        const all = cur && !list.includes(cur) ? [cur, ...list] : list;
        setFonts(all);
      }
    }).catch(() => {});
    // The magnifier keeps its zoom in a module variable, so the saved value is
    // pushed once at startup (the viewer itself has no access to settings).
    try { setLoupeZoom(+gv('loupeZoom') || 3); } catch (_) {}
  });

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

  /* ---------- generic option rows ---------- */
  const fLabel = (f) => tr(f.label, f.en || f.label);
  const fValue = (f) => (f.get ? f.get() : gv(f.key));
  const fSet = (f, v) => {
    if (f.set) f.set(v);
    else setGeneral({ [f.key]: v });
    if (f.after) f.after(v);
  };

  // The search box looks across EVERY category, so an option is findable even
  // when you do not remember which page it lives on.
  const searching = () => query().trim().length > 0;
  const matches = () => {
    const q = query().trim().toLowerCase();
    return FIELDS().filter((f) => fLabel(f).toLowerCase().includes(q)
      || (f.hint ? tr(f.hint[0], f.hint[1]).toLowerCase().includes(q) : false));
  };
  const rows = () => (searching() ? matches() : FIELDS().filter((f) => f.cat === cat()));

  // Rows grouped under their section heading, in declaration order.
  const groups = () => {
    const out = [];
    for (const f of rows()) {
      const head = searching()
        ? `${CATEGORIES().find((c) => c.id === f.cat)?.label} › ${tr(f.sec[0], f.sec[1])}`
        : tr(f.sec[0], f.sec[1]);
      const last = out[out.length - 1];
      if (last && last.head === head) last.items.push(f);
      else out.push({ head, items: [f] });
    }
    return out;
  };

  // Word-style searchable font list: type to filter, each family in its face.
  const FontPicker = () => (
    <div class="cfg-fontpick">
      <input class="cfg-select" type="text" spellcheck={false}
        style={{ 'font-family': `"${gv('fontFamily')}"` }}
        value={fontOpen() ? fontQuery() : gv('fontFamily')}
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
  );

  const Field = (props) => {
    const f = props.f;
    // An option that depends on another one (`when`) is shown greyed and inert
    // while its condition is false, the way VSCode greys a setting its parent
    // switch has turned off — never hidden, so you can still see it is there.
    const off = () => (f.when ? !f.when() : false);
    return (
      <>
        <div class={`cfg-row${off() ? ' disabled' : ''}`}>
          <span class="cfg-label">{fLabel(f)}</span>
          <Show when={f.type === 'check'}>
            <input type="checkbox" checked={!!fValue(f)} disabled={off()}
              onChange={(e) => fSet(f, e.target.checked)} />
          </Show>
          <Show when={f.type === 'select'}>
            <select class="cfg-select" value={fValue(f)} disabled={off()} onChange={(e) => fSet(f, e.target.value)}>
              <For each={typeof f.opts === 'function' ? f.opts() : f.opts}>
                {(o) => <option value={o[0]}>{o[1]}</option>}
              </For>
            </select>
          </Show>
          <Show when={f.type === 'range'}>
            <input type="range" min={f.min} max={f.max} step={f.step} value={fValue(f)} disabled={off()}
              onInput={(e) => fSet(f, parseFloat(e.target.value))} />
            <span class="cfg-val">{f.unit ? f.unit(fValue(f)) : fValue(f)}</span>
          </Show>
          <Show when={f.custom === 'font'}>{FontPicker()}</Show>
          <Show when={f.custom === 'theme'}>
            <div class="cfg-theme-row">
              <For each={THEMES}>
                {(th) => (
                  <button
                    class={`cfg-theme ink-${th.ink}${state.theme === th.id ? ' active' : ''}`}
                    onClick={() => setTheme(th.id)}
                    style={{ background: `linear-gradient(135deg, ${th.swatches[0]} 0 50%, ${th.swatches[1]} 50% 100%)` }}
                    title={th.label}
                  ><span class="cfg-theme-name">{th.label}</span></button>
                )}
              </For>
            </div>
          </Show>
        </div>
        <Show when={f.hint}>
          <p class="cfg-hint">{tr(f.hint[0], f.hint[1])}</p>
        </Show>
      </>
    );
  };

  /* ---------- reset ---------- */
  // What "Restablecer esta sección" means depends on the page: colors and
  // shortcuts have their own stores.
  const resetSection = () => {
    const c = cat();
    // Colors and shortcuts live in their own stores; the palette choice is a
    // general setting, so the syntax page resets both.
    if (c === 'syntax') { resetAll(); resetGeneralSection('syntax'); return; }
    if (c === 'keys') { resetAllCombos(); return; }
    resetGeneralSection(c);
    // The theme is NOT in the general store — it lives in `state.theme` and in
    // localStorage — so resetting the page it is on left the chips exactly as
    // they were while everything around them went back to default.
    if (c === 'general') setTheme(DEFAULT_THEME);
    afterBulkReset();
  };
  const resetEverything = () => {
    resetGeneralAll();
    resetAll();
    resetAllCombos();
    setTheme(DEFAULT_THEME);
    afterBulkReset();
  };
  // Re-push the values that live outside the CSS layer.
  const afterBulkReset = () => {
    applyEditorSettings();
    setMinimapEnabled(gv('minimap') === true);
    setInvert(gv('pdfInvert') === true);
    try { setLoupeZoom(+gv('loupeZoom') || 3); } catch (_) {}
    setPyPath(gv('pythonPath') || '');
    broadcastSpellRefresh();
    state.liveCompile = gv('liveCompile') !== false;
  };

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
        {/* "No background" is the normal state for almost every token, but an
            <input type="color"> has no way to say so: with `bg` unset it fell
            back to #000000 and drew a solid black chip, indistinguishable from
            a token whose background really IS black. The wrapper puts a slash
            over the chip while it is unset, and the title says which it is. */}
        <span class={`cfg-bg-wrap${s().bg ? '' : ' empty'}`}>
          <input type="color" class="cfg-bg" value={s().bg || '#000000'}
            title={s().bg
              ? tr(`Color de fondo: ${s().bg}`, `Background color: ${s().bg}`)
              : tr('Sin fondo — pulsa para poner uno', 'No background — click to set one')}
            onInput={(e) => setToken(t.key, { bg: e.target.value })} />
        </span>
        <button class="cfg-clear pyx-ico" disabled={!s().bg}
          title={tr('Quitar fondo', 'Remove background')}
          innerHTML={icons.circleSlash}
          onClick={() => setToken(t.key, { bg: null })}></button>
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
              <input class="cfg-search" type="search" spellcheck={false}
                placeholder={tr('Buscar una opción…', 'Search an option…')}
                value={query()} onInput={(e) => setQuery(e.target.value)} />
              <For each={CATEGORIES()}>
                {(c) => (
                  <div class={`cfg-cat${cat() === c.id && !searching() ? ' active' : ''}`}
                    onClick={() => { setQuery(''); setCat(c.id); }}>{c.label}</div>
                )}
              </For>
            </div>

            <div class="cfg-body">
              {/* Search results: every matching option, wherever it lives. */}
              <Show when={searching() && !groups().length}>
                <p class="cfg-hint">{tr('Ninguna opción coincide con la búsqueda.', 'No option matches the search.')}</p>
              </Show>

              {/* Hand-built blocks that belong to a category, not to the list. */}
              <Show when={!searching() && cat() === 'cells'}>
                <div class="cfg-section">{tr('Intérprete', 'Interpreter')}</div>
                <div class="cfg-row">
                  <span class="cfg-label">{tr('Ruta de Python', 'Python path')}</span>
                  <input class="cfg-select cfg-wide" type="text" spellcheck={false}
                    placeholder={tr('vacío = detección automática', 'empty = automatic detection')}
                    value={pyPath()} onInput={(e) => setPyPath(e.target.value)} />
                  <button class="cfg-btn" onClick={() => setKernelPython(pyPath().trim())}>
                    {tr('Aplicar', 'Apply')}
                  </button>
                </div>
                <p class="cfg-hint">
                  {tr('Intérprete en uso', 'Interpreter in use')}: {state.env.python || tr('sin detectar', 'not detected')}
                  {' · '}{tr('Estado del kernel', 'Kernel status')}: {state.kernelStatus}
                </p>
              </Show>

              <Show when={!searching() && cat() === 'compile'}>
                <div class="cfg-section">{tr('Motor', 'Engine')}</div>
                <div class="cfg-row">
                  <span class="cfg-label">{tr('Motor LaTeX', 'LaTeX engine')}</span>
                  <select class="cfg-select" disabled={!activeDoc()}
                    value={activeDoc()?.engine || state.env.latex || 'xelatex'} onChange={setEngine}>
                    <For each={engines()}>{(e) => <option value={e}>{e}</option>}</For>
                  </select>
                </div>
                <p class="cfg-hint">
                  {state.env.latex
                    ? `${tr('Motores detectados', 'Detected engines')}: ${engines().join(', ')}.`
                    : tr('No se detectó LaTeX en el sistema.', 'No LaTeX found on the system.')}
                  {' '}{tr('El motor se aplica al documento activo.', 'The engine applies to the active document.')}
                </p>
              </Show>

              {/* The declarative option rows. */}
              <For each={groups()}>
                {(g) => (
                  <>
                    <div class="cfg-section">{g.head}</div>
                    <For each={g.items}>{(f) => <Field f={f} />}</For>
                  </>
                )}
              </For>

              <Show when={!searching() && cat() === 'keys'}>
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

              <Show when={!searching() && cat() === 'syntax'}>
                <p class="cfg-hint">{tr('Personaliza color y estilo de cada elemento, como en TeXstudio. Se aplica y guarda al instante.', 'Customize the color and style of each element, like in TeXstudio. Applied and saved instantly.')}</p>
                <div class="cfg-section">LaTeX</div>
                <For each={TOKENS.filter((t) => t.group === 'LaTeX')}>{(t) => <Row t={t} />}</For>
                <div class="cfg-section">Python</div>
                <For each={TOKENS.filter((t) => t.group === 'Python')}>{(t) => <Row t={t} />}</For>
              </Show>
            </div>
          </div>

          <div class="cfg-footer">
            <Show when={!searching() && (CUSTOM_CATS.includes(cat()) || GENERAL_SECTIONS[cat()])}>
              <button onClick={resetSection}>{tr('Restablecer esta sección', 'Reset this section')}</button>
            </Show>
            <button class={confirmReset() ? 'danger' : ''}
              onClick={() => {
                if (!confirmReset()) {
                  setConfirmReset(true);
                  setTimeout(() => setConfirmReset(false), 4000);
                  return;
                }
                setConfirmReset(false);
                resetEverything();
              }}>
              {confirmReset()
                ? tr('¿Seguro? Pulsa otra vez', 'Sure? Click again')
                : tr('Restablecer todo', 'Reset everything')}
            </button>
            <button class="primary" onClick={() => setShowConfig(false)}>{tr('Cerrar', 'Close')}</button>
          </div>
        </div>
      </div>
    </Show>
  );
}
