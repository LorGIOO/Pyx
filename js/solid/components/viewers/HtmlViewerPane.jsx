import { onMount } from 'solid-js';
import { createRichFrame, tableCss } from '../../../editor/rich-frame.js';

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
    // The same table look as in the cell (rich-frame.js), with the header
    // pinned while a long table scrolls in the tab.
    return `
      body { margin: 12px; background: ${surface}; color: ${text};
             font: 13px system-ui, sans-serif; overflow: auto; }
      ${tableCss(text, border)}
      thead th { position: sticky; top: 0; background: ${surface}; box-shadow: inset 0 -1px ${border}; }
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
