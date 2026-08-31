import { onMount } from 'solid-js';
import { createRichFrame } from '../../../editor/rich-frame.js';

// Interactive HTML output (plotly, bokeh, video, big tables…) as a document
// tab. Rendered in a SANDBOXED iframe so its scripts execute — hover
// coordinates, zoom/pan/3D rotation, video controls — while staying unable to
// reach the application: cell output is untrusted input, and without the
// sandbox a `srcdoc` frame is same-origin and could call the Tauri commands
// through `parent`. See editor/rich-frame.js for the full contract.
export default function HtmlViewerPane(props) {
  let hostRef;

  const themedCss = () => {
    const css = getComputedStyle(document.documentElement);
    const v = (name, fb) => (css.getPropertyValue(name) || fb).trim();
    const surface = v('--theme-surface', '#fff');
    const text = v('--theme-text', '#111');
    const border = v('--theme-border', '#d0d0d0');
    const header = v('--theme-panel-bg', '#f0f0f0');
    return `
      body { margin: 12px; background: ${surface}; color: ${text};
             font: 13px system-ui, sans-serif; overflow: auto; }
      table { border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
      th, td { border: 1px solid ${border}; padding: 4px 12px; text-align: right; }
      th { background: ${header}; position: sticky; top: 0; }
      tr:nth-child(even) td { background: color-mix(in srgb, ${surface} 92%, ${text} 8%); }
      video, img, audio { max-width: 100%; }
    `;
  };

  onMount(() => {
    // A full-tab viewer fills its host instead of growing to fit the content.
    const frame = createRichFrame(props.html, null, themedCss(), false);
    frame.className = 'viewer-frame';
    frame.setAttribute('scrolling', 'auto');
    hostRef.replaceChildren(frame);
  });

  return <div class="viewer-tab" ref={hostRef}></div>;
}
