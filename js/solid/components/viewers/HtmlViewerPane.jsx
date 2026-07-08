import { openExternal } from '../../../core/platform.js';

// Interactive HTML output (plotly, bokeh, video, big tables…) as a document
// tab. Rendered in an iframe so its <script> tags execute: hover coordinates,
// zoom/pan/3D-rotation, video controls. Theme-aware: the iframe body follows
// the app theme instead of forcing a white page.
export default function HtmlViewerPane(props) {
  const css = getComputedStyle(document.documentElement);
  const v = (name, fb) => (css.getPropertyValue(name) || fb).trim();
  const surface = v('--theme-surface', '#fff');
  const text = v('--theme-text', '#111');
  const border = v('--theme-border', '#d0d0d0');
  const header = v('--theme-panel-bg', '#f0f0f0');

  const srcdoc = `<!doctype html><html><head><meta charset="utf-8">
<style>
  body { margin: 12px; background: ${surface}; color: ${text}; font: 13px system-ui, sans-serif; }
  table { border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
  th, td { border: 1px solid ${border}; padding: 4px 12px; text-align: right; }
  th { background: ${header}; position: sticky; top: 0; }
  tr:nth-child(even) td { background: color-mix(in srgb, ${surface} 92%, ${text} 8%); }
  video, img, audio { max-width: 100%; }
</style></head><body>${props.html}</body></html>`;

  // Any link inside the output opens in the SYSTEM browser, never in-app.
  const hookLinks = (frame) => {
    frame.addEventListener('load', () => {
      try {
        frame.contentDocument.addEventListener('click', (e) => {
          const a = e.target.closest && e.target.closest('a[href]');
          if (!a) return;
          const href = a.getAttribute('href') || '';
          if (/^https?:\/\//i.test(href)) {
            e.preventDefault();
            openExternal(href);
          }
        }, true);
      } catch (_) { /* cross-origin guard */ }
    });
  };

  return (
    <div class="viewer-tab">
      <iframe class="viewer-frame" srcdoc={srcdoc} ref={hookLinks}></iframe>
    </div>
  );
}
