import { createSignal, onMount } from 'solid-js';
import { saveImageDialog, writeBinaryFile } from '../../../core/platform.js';

// Image viewer rendered as a document tab (NOT an auxiliary window): wheel
// zoom at the cursor, drag pan, pixel-coordinate readout, fit/100% controls.
export default function ImageViewerPane(props) {
  let viewport, stage, img;
  const [zoomPct, setZoomPct] = createSignal(100);
  const [coord, setCoord] = createSignal('—');

  let scale = 1, tx = 0, ty = 0, fitScale = 1;
  const apply = () => {
    stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    setZoomPct(Math.round((scale / fitScale) * 100));
  };
  const fit = () => {
    const vw = viewport.clientWidth, vh = viewport.clientHeight;
    const iw = img.naturalWidth || vw, ih = img.naturalHeight || vh;
    fitScale = Math.min(vw / iw, vh / ih) || 1;
    scale = fitScale;
    tx = (vw - iw * scale) / 2;
    ty = (vh - ih * scale) / 2;
    apply();
  };
  const zoomAt = (cx, cy, factor) => {
    const sx = (cx - tx) / scale, sy = (cy - ty) / scale;
    scale = Math.max(fitScale * 0.2, Math.min(scale * factor, fitScale * 60));
    tx = cx - sx * scale; ty = cy - sy * scale;
    apply();
  };
  const center = (factor) => zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, factor);

  onMount(() => {
    if (img.complete && img.naturalWidth) requestAnimationFrame(fit);
    else img.onload = () => fit();

    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = viewport.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });

    let dragging = false, lastX = 0, lastY = 0;
    viewport.addEventListener('pointerdown', (e) => {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      viewport.classList.add('grabbing');
      try { viewport.setPointerCapture(e.pointerId); } catch (_) {}
    });
    viewport.addEventListener('pointermove', (e) => {
      const r = viewport.getBoundingClientRect();
      const sx = (e.clientX - r.left - tx) / scale, sy = (e.clientY - r.top - ty) / scale;
      if (sx >= 0 && sy >= 0 && sx <= (img.naturalWidth || 0) && sy <= (img.naturalHeight || 0)) {
        setCoord(`x: ${Math.round(sx)}, y: ${Math.round(sy)} px`);
      } else setCoord('—');
      if (!dragging) return;
      tx += e.clientX - lastX; ty += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      apply();
    });
    const up = () => { dragging = false; viewport.classList.remove('grabbing'); };
    viewport.addEventListener('pointerup', up);
    viewport.addEventListener('pointercancel', up);
  });

  // Export the figure to disk (engineering workflow: reuse outputs elsewhere).
  const saveAs = async () => {
    const dest = await saveImageDialog('figura.png');
    if (!dest) return;
    try {
      const buf = await (await fetch(props.src)).arrayBuffer();
      await writeBinaryFile(dest, new Uint8Array(buf));
    } catch (e) { alert(String((e && e.message) || e)); }
  };

  return (
    <div class="viewer-tab">
      <div class="viewer-toolbar">
        <button class="pv-btn" title="Alejar" onClick={() => center(1 / 1.2)}>−</button>
        <span class="viewer-zoom">{zoomPct()}%</span>
        <button class="pv-btn" title="Acercar" onClick={() => center(1.2)}>+</button>
        <button class="viewer-btn" onClick={fit}>Ajustar</button>
        <button class="viewer-btn" title="Guardar la imagen como PNG" onClick={saveAs}>Guardar…</button>
        <span class="viewer-coord">{coord()}</span>
      </div>
      <div class="viewer-viewport" ref={viewport}>
        <div class="viewer-stage" ref={stage}>
          <img src={props.src} draggable={false} ref={img} alt="" />
        </div>
      </div>
    </div>
  );
}
