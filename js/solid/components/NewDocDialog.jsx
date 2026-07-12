import { createSignal, Show } from 'solid-js';
import { t } from '../../core/i18n.js';
import { newDocument } from '../stores/docStore.js';

// "New document" chooser (Windows-style modal, movable, stays open on outside
// click — like the Configuración dialog). Offers a Pyx document (.pltx, with
// Python cells) or a plain LaTeX document (.tex).

const [open, setOpen] = createSignal(false);
export const openNewDoc = () => setOpen(true);

const pltxTemplate = () =>
  '\\documentclass{article}\n' +
  '\\begin{document}\n\n' +
  '%#python\n' +
  'import math\n' +
  'r = 2.0\n' +
  'area = math.pi * r**2\n' +
  '%#end\n\n' +
  t(
    'El área del círculo de radio \\py{r} es \\py{round(area, 2)}.\n',
    'The area of the circle of radius \\py{r} is \\py{round(area, 2)}.\n',
  ) +
  '\n\\end{document}\n';

const texTemplate = () =>
  '\\documentclass{article}\n' +
  '\\begin{document}\n\n' +
  t('Escribe aquí tu documento.\n', 'Write your document here.\n') +
  '\n\\end{document}\n';

function create(kind) {
  setOpen(false);
  if (kind === 'pltx') newDocument(pltxTemplate(), t('sin-título.pltx', 'untitled.pltx'));
  else newDocument(texTemplate(), t('sin-título.tex', 'untitled.tex'));
}

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

export default function NewDocDialog() {
  const [pos, startDrag] = useDrag();
  return (
    <Show when={open()}>
      <div class="cfg-overlay">
        <div class="cfg-modal newdoc-modal" style={pos() ? { left: pos().x + 'px', top: pos().y + 'px', transform: 'none' } : undefined}>
          <div class="cfg-titlebar" onPointerDown={startDrag}>
            <span>{t('Nuevo documento', 'New document')}</span>
            <button class="cfg-close" title={t('Cerrar', 'Close')} onClick={() => setOpen(false)}>✕</button>
          </div>
          <div class="newdoc-body">
            <button class="newdoc-choice" onClick={() => create('pltx')}>
              <span class="newdoc-ext">.pltx</span>
              <span class="newdoc-title">{t('Documento Pyx', 'Pyx document')}</span>
              <span class="newdoc-desc">{t('LaTeX con celdas de Python y \\py{}. Se guarda como contenedor.', 'LaTeX with Python cells and \\py{}. Saved as a container.')}</span>
            </button>
            <button class="newdoc-choice" onClick={() => create('tex')}>
              <span class="newdoc-ext">.tex</span>
              <span class="newdoc-title">{t('Documento LaTeX', 'LaTeX document')}</span>
              <span class="newdoc-desc">{t('LaTeX puro, texto plano compatible con cualquier editor.', 'Pure LaTeX, plain text compatible with any editor.')}</span>
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
