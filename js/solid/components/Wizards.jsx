import { createSignal, Show, For } from 'solid-js';
import { activeDoc } from '../../core/state.js';
import { insertSnippet } from '../../editor/commands.js';
import { openImageDialog } from '../../core/platform.js';
import { dirOf } from '../../core/paths.js';

// Table & figure assistants: friendly auxiliary dialogs (movable, themed,
// Windows-style — reusing the Configuración modal chrome) that generate clean
// LaTeX, instead of TeXstudio's painful wizards.

const [tableOpen, setTableOpen] = createSignal(false);
const [figureOpen, setFigureOpen] = createSignal(false);
export const openTableWizard = () => setTableOpen(true);
export const openFigureWizard = () => setFigureOpen(true);

function useDrag() {
  const [pos, setPos] = createSignal(null);
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
  return [pos, startDrag];
}

const Field = (props) => (
  <div class="wz-row">
    <span class="wz-label">{props.label}</span>
    {props.children}
  </div>
);

/* ---------------- Tabla ---------------- */
function TableWizard() {
  const [pos, startDrag] = useDrag();
  const [rows, setRows] = createSignal(3);
  const [cols, setCols] = createSignal(3);
  const [align, setAlign] = createSignal('c');
  const [header, setHeader] = createSignal(true);
  const [booktabs, setBooktabs] = createSignal(true);
  const [caption, setCaption] = createSignal('');
  const [label, setLabel] = createSignal('');

  const generate = () => {
    const c = Math.max(1, cols() | 0), r = Math.max(1, rows() | 0);
    const colSpec = align().repeat(c);
    const emptyRow = Array(c).fill(' ').join(' & ') + ' \\\\';
    const head = Array.from({ length: c }, (_, i) => `Columna ${i + 1}`).join(' & ') + ' \\\\';
    const lines = [];
    lines.push('\\begin{table}[htbp]');
    lines.push('  \\centering');
    if (caption()) lines.push(`  \\caption{${caption()}}`);
    if (label()) lines.push(`  \\label{tab:${label()}}`);
    lines.push(`  \\begin{tabular}{${colSpec}}`);
    lines.push(booktabs() ? '    \\toprule' : '    \\hline');
    if (header()) {
      lines.push('    ' + head);
      lines.push(booktabs() ? '    \\midrule' : '    \\hline');
    }
    for (let i = 0; i < r; i++) lines.push('    ' + emptyRow);
    lines.push(booktabs() ? '    \\bottomrule' : '    \\hline');
    lines.push('  \\end{tabular}');
    lines.push('\\end{table}');
    insertSnippet(lines.join('\n') + '\n');
    setTableOpen(false);
  };

  return (
    <div class="cfg-overlay">
      <div class="cfg-modal wz-modal" style={pos() ? { left: pos().x + 'px', top: pos().y + 'px', transform: 'none' } : undefined}>
        <div class="cfg-titlebar" onPointerDown={startDrag}>
          <span>Asistente de tabla</span>
          <button class="cfg-close" onClick={() => setTableOpen(false)}>✕</button>
        </div>
        <div class="wz-body">
          <Field label="Filas">
            <input type="number" min="1" max="50" value={rows()} onInput={(e) => setRows(+e.target.value)} />
          </Field>
          <Field label="Columnas">
            <input type="number" min="1" max="20" value={cols()} onInput={(e) => setCols(+e.target.value)} />
          </Field>
          <Field label="Alineación">
            <select value={align()} onChange={(e) => setAlign(e.target.value)}>
              <option value="l">Izquierda (l)</option>
              <option value="c">Centrada (c)</option>
              <option value="r">Derecha (r)</option>
            </select>
          </Field>
          <Field label="Fila de cabecera">
            <input type="checkbox" checked={header()} onChange={(e) => setHeader(e.target.checked)} />
          </Field>
          <Field label="Estilo booktabs">
            <input type="checkbox" checked={booktabs()} onChange={(e) => setBooktabs(e.target.checked)} />
            <span class="wz-hint">(requiere \usepackage{'{'}booktabs{'}'})</span>
          </Field>
          <Field label="Pie (caption)">
            <input type="text" value={caption()} onInput={(e) => setCaption(e.target.value)} placeholder="Descripción de la tabla" />
          </Field>
          <Field label="Etiqueta">
            <input type="text" value={label()} onInput={(e) => setLabel(e.target.value)} placeholder="mi-tabla → \ref{tab:mi-tabla}" />
          </Field>
        </div>
        <div class="cfg-footer">
          <button onClick={() => setTableOpen(false)}>Cancelar</button>
          <button class="primary" onClick={generate}>Insertar tabla</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Figura ---------------- */
// Prefer a path relative to the document folder (portable \includegraphics).
function relativize(imgPath) {
  const base = dirOf(activeDoc()?.path);
  if (!base) return imgPath;
  const norm = (s) => s.replace(/\\/g, '/');
  const img = norm(imgPath), dir = norm(base);
  return img.toLowerCase().startsWith(dir.toLowerCase() + '/')
    ? img.slice(dir.length + 1)
    : img;
}

function FigureWizard() {
  const [pos, startDrag] = useDrag();
  const [path, setPath] = createSignal('');
  const [width, setWidth] = createSignal(0.8);
  const [angle, setAngle] = createSignal(0);
  const [caption, setCaption] = createSignal('');
  const [label, setLabel] = createSignal('');
  const [centered, setCentered] = createSignal(true);

  const browse = async () => {
    const p = await openImageDialog();
    if (p) setPath(relativize(p));
  };

  const generate = () => {
    const opts = [`width=${width()}\\textwidth`];
    if (angle()) opts.push(`angle=${angle()}`);
    const lines = [];
    lines.push('\\begin{figure}[htbp]');
    if (centered()) lines.push('  \\centering');
    lines.push(`  \\includegraphics[${opts.join(', ')}]{${path() || 'imagen.png'}}`);
    if (caption()) lines.push(`  \\caption{${caption()}}`);
    if (label()) lines.push(`  \\label{fig:${label()}}`);
    lines.push('\\end{figure}');
    insertSnippet(lines.join('\n') + '\n');
    setFigureOpen(false);
  };

  return (
    <div class="cfg-overlay">
      <div class="cfg-modal wz-modal" style={pos() ? { left: pos().x + 'px', top: pos().y + 'px', transform: 'none' } : undefined}>
        <div class="cfg-titlebar" onPointerDown={startDrag}>
          <span>Asistente de figura</span>
          <button class="cfg-close" onClick={() => setFigureOpen(false)}>✕</button>
        </div>
        <div class="wz-body">
          <Field label="Imagen">
            <input type="text" value={path()} onInput={(e) => setPath(e.target.value)} placeholder="ruta/imagen.png" />
            <button class="wz-browse" onClick={browse}>Examinar…</button>
          </Field>
          <Field label="Ancho">
            <input type="range" min="0.1" max="1" step="0.05" value={width()} onInput={(e) => setWidth(+e.target.value)} />
            <span class="wz-val">{Math.round(width() * 100)}% del texto</span>
          </Field>
          <Field label="Rotación">
            <input type="number" min="-180" max="180" step="90" value={angle()} onInput={(e) => setAngle(+e.target.value)} />
            <span class="wz-hint">grados</span>
          </Field>
          <Field label="Centrada">
            <input type="checkbox" checked={centered()} onChange={(e) => setCentered(e.target.checked)} />
          </Field>
          <Field label="Pie (caption)">
            <input type="text" value={caption()} onInput={(e) => setCaption(e.target.value)} placeholder="Descripción de la figura" />
          </Field>
          <Field label="Etiqueta">
            <input type="text" value={label()} onInput={(e) => setLabel(e.target.value)} placeholder="mi-figura → \ref{fig:mi-figura}" />
          </Field>
        </div>
        <div class="cfg-footer">
          <button onClick={() => setFigureOpen(false)}>Cancelar</button>
          <button class="primary" onClick={generate}>Insertar figura</button>
        </div>
      </div>
    </div>
  );
}

export default function Wizards() {
  return (
    <>
      <Show when={tableOpen()}><TableWizard /></Show>
      <Show when={figureOpen()}><FigureWizard /></Show>
    </>
  );
}
