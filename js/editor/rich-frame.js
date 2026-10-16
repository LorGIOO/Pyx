// Sandboxed host for HTML that a Python cell produced.
//
// SECURITY CONTRACT — read before changing anything here.
//
// Cell output is UNTRUSTED. It comes from a library's `_repr_html_`, from a
// table pasted off the web, or from a `.pltx` someone else authored. The old
// code mounted it in `<iframe srcdoc>` with no `sandbox` attribute: a srcdoc
// frame without a sandbox is SAME-ORIGIN with the app, so anything inside it
// could reach `parent.__TAURI__` and invoke the Rust commands — `run_command`,
// `remove_path`, `create_file`. Opening someone's document was enough to run
// arbitrary code on the machine.
//
// The frame is now sandboxed with `allow-scripts` ONLY. That gives it an
// opaque origin: plotly and friends still run, but `parent` is unreachable and
// so is every Tauri command.
//
// An opaque origin also means WE can no longer read `contentDocument`, which is
// how the frame used to be measured and how link clicks were intercepted. Both
// now happen INSIDE the frame, through a small bootstrap script that talks back
// over `postMessage` — the only channel a sandboxed frame has.

import DOMPurify from 'dompurify';
import { openExternal } from '../core/platform.js';

let seq = 0;
// token -> { frame, onHeight }. Insertion-ordered, so the oldest entry is the
// first one out when the map is trimmed.
const frames = new Map();
const FRAMES_MAX = 200;

/** Forget frames that have left the DOM (a cell re-rendered, a tab closed).
 *  Done lazily on message traffic rather than with a MutationObserver: an
 *  observer on the document would be woken by every keystroke CodeMirror
 *  applies, once per live frame. */
function sweep() {
  for (const [token, entry] of frames) {
    if (!entry.frame.isConnected) frames.delete(token);
  }
}

// One listener for every frame in the app.
if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || d.__pyx !== 1) return;
    const entry = frames.get(d.token);
    if (!entry) return;
    if (!entry.frame.isConnected) { frames.delete(d.token); return; }
    if (d.type === 'height' && typeof d.value === 'number') {
      entry.onHeight(d.value);
    } else if (d.type === 'open' && typeof d.href === 'string') {
      // Links inside an output open in the SYSTEM browser, never in-app.
      if (/^https?:\/\//i.test(d.href)) openExternal(d.href);
    }
  });
}

/** The bootstrap that runs inside the sandboxed frame: reports its content
 *  height whenever it changes and forwards link clicks to the host.
 *
 *  MEASURING IS A RACE, and losing it looks like a permanently 24px-tall
 *  output. A freshly inserted frame is not laid out yet — `document.body`
 *  measures 0, and `window.innerHeight` is 0 with it — and the browser may
 *  defer that layout well past `load`. Reporting on a fixed set of timers
 *  therefore sampled nothing but zeros. The frame polls until it has a real
 *  size instead, and only then hands over to the observers. */
function bootstrap(token) {
  return `<script>(function(){
  var T=${JSON.stringify(token)};
  function send(m){try{parent.postMessage(Object.assign({__pyx:1,token:T},m),'*')}catch(e){}}
  var last=-1;
  function report(){
    var b=document.body; if(!b) return;
    // BODY, never documentElement: documentElement.scrollHeight is clamped to
    // the frame's own viewport, so measuring it would let the frame grow and
    // never shrink — the tall blank gap under handcalcs output that the
    // shrink-then-measure dance in the old code existed to work around.
    var h=Math.max(b.scrollHeight,b.offsetHeight);
    // Ignore the zeros of a not-yet-laid-out frame, but DO report a genuine
    // shrink back to nothing once we have had a real size.
    if(h===last||(h<=0&&last<=0))return;
    last=h;send({type:'height',value:h});
  }
  var tries=0;
  function poll(){
    report();
    if(last<=0&&++tries<200)setTimeout(poll,25);
  }
  document.addEventListener('click',function(e){
    var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;
    if(!a)return; var h=a.getAttribute('href')||'';
    if(/^https?:\\/\\//i.test(h)){e.preventDefault();send({type:'open',href:h})}
  },true);
  poll();
  window.addEventListener('load',report);
  // Later changes: plotly, KaTeX and images all draw after load.
  if(window.ResizeObserver){try{new ResizeObserver(report).observe(document.body)}catch(e){}}
  [400,900,1600,3000].forEach(function(t){setTimeout(report,t)});
})()<\/script>`;
}

/** Theme-aware document wrapper, so output follows the app's light/dark theme. */
function srcdocFor(inner, token, extraCss = '', autoSize = true) {
  const css = getComputedStyle(document.documentElement);
  const v = (n, fb) => (css.getPropertyValue(n) || fb).trim();
  const fg = v('--theme-cell-output-text', '#dddddd');
  const accent = v('--theme-cell-accent', '#3794ff');
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:transparent;color:${fg};
    font:13px "Segoe UI",system-ui,sans-serif;overflow:auto}
  body{padding:2px}
  a{color:${accent}}
  ${extraCss}
</style></head><body>${inner}${bootstrap(token)}</body></html>`;
}

/**
 * Create a sandboxed iframe showing `html`, auto-sized to its content.
 *
 * @param {string} html      untrusted markup from a cell
 * @param {(h:number)=>void} onResize  called after the frame reports a new height
 * @param {string} extraCss  optional extra stylesheet for the frame
 * @param {boolean} autoSize false for a frame that fills its host (a viewer
 *                           tab) instead of growing to fit its content
 * @returns {HTMLIFrameElement}
 */
export function createRichFrame(html, onResize, extraCss = '', autoSize = true) {
  const token = 'f' + (++seq) + '-' + Math.random().toString(36).slice(2, 8);
  const frame = document.createElement('iframe');
  frame.className = 'out-iframe';
  // allow-scripts WITHOUT allow-same-origin: scripts run, `parent` does not.
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  // A readable DEFAULT, not a sliver. The frame reports its real height as
  // soon as it is laid out and this is replaced with an exact fit — but if
  // that report never arrives (a frame the browser declines to lay out, an
  // output whose scripts fail), the user still sees the content in a
  // scrollable box instead of a 24px slit with everything hidden inside it.
  if (autoSize) frame.style.height = '180px';
  if (frames.size >= FRAMES_MAX) {
    sweep();
    while (frames.size >= FRAMES_MAX) frames.delete(frames.keys().next().value);
  }
  frames.set(token, {
    frame,
    onHeight: (h) => {
      if (autoSize && h > 0) frame.style.height = (h + 4) + 'px';
      if (onResize) onResize(h);
    },
  });
  frame.srcdoc = srcdocFor(html, token, extraCss, autoSize);
  return frame;
}

/* ---------------- static markup sanitizer ----------------
   Rich output that carries no <script> is rendered inline (no frame) because
   it is cheaper and it can be selected/copied like the rest of the document.
   Inline means it lives in the APP's DOM — next to the Tauri commands — so it
   is sanitized first. And since a .pltx carries its outputs, that markup can
   come from someone else's report.

   The sanitizer is DOMPurify (github.com/cure53/DOMPurify), the one browsers'
   own security teams test against, instead of the hand-written walker this
   used to be: that one missed `href="java&#x09;script:…"` (the tab is dropped
   by the URL parser) and SVG `<animate>` rewriting a link after the check.
   Pyx's own rules stay on top of it as hooks: no stylesheets (they would
   restyle the whole app — markup with one goes to the frame instead), no
   forms, no `target`, and the stricter URL test below. */

// STYLE too: markup that reaches this inline path should carry none (see
// needsIsolation), and one that slipped through must not restyle the app.
// SVG animation elements can REWRITE another element's href after the
// sanitizer has looked at it: static output never needs them.
const FORBID_TAGS = [
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal',
  'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'noscript',
  'animate', 'set', 'animatemotion', 'animatetransform', 'handler', 'listener',
];
const FORBID_ATTR = ['srcdoc', 'formaction', 'action', 'target', 'ping'];

/** Does this attribute value name a URL that would RUN something?
 *
 *  Compared the way the browser's URL parser reads it, not as written: the
 *  parser drops ASCII tab and newline anywhere in a URL and trims leading
 *  control characters and spaces, and the HTML parser has already decoded
 *  entities. So `href="java&#x09;script:…"` reaches the DOM as
 *  "java\tscript:…" — and runs as `javascript:`. */
export function isDangerousUrl(value) {
  const v = String(value || '').replace(/[\u0000-\u0020\u007f]+/g, '').toLowerCase();
  return /^(javascript|vbscript|livescript):/.test(v)
    || /^data:(text\/html|application\/xhtml|image\/svg\+xml|text\/xml|application\/xml)/.test(v);
}

let purifier = null;
function getPurifier(win) {
  if (purifier && purifier.__win === win) return purifier;
  purifier = DOMPurify(win);
  purifier.__win = win;
  // A second opinion on every attribute, whatever DOMPurify decided: a list
  // of "URL attributes" is how the next bypass gets in.
  purifier.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName !== 'style' && isDangerousUrl(data.attrValue)) data.keepAttr = false;
    if (data.attrName === 'style'
      && /expression\s*\(|url\s*\(\s*['"]?\s*(javascript|vbscript)/i.test(data.attrValue || '')) {
      data.keepAttr = false;
    }
  });
  return purifier;
}

/** Sanitize `html` into a DocumentFragment that is safe to insert in the app. */
export function sanitizeFragment(html, win = (typeof window !== 'undefined' ? window : null)) {
  return getPurifier(win).sanitize(String(html || ''), {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    FORBID_TAGS,
    FORBID_ATTR,
  });
}

/** Clicks on links inside inline output open in the system browser.
 *
 *  Without this, a plain `<a href="https://…">` in a pandas table or a
 *  Markdown output navigated the WHOLE APP to that page: the editor, the
 *  unsaved text and the kernel's session were replaced by a website, with no
 *  back button. Only web and mail links are handed to the OS; anything else
 *  does nothing. */
export function guardLinks(el, open) {
  el.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || !el.contains(a)) return;
    e.preventDefault();
    e.stopPropagation();
    const href = a.getAttribute('href') || '';
    if (/^(https?:|mailto:)/i.test(href.trim())) open(href.trim());
  });
  return el;
}

/** True when the markup must go in a frame rather than inline.
 *
 *  Scripts are the obvious case (plotly, bokeh, widgets). `<style>` is the
 *  non-obvious one: a stylesheet inlined into the app's own DOM is not scoped
 *  to the output — a pandas Styler, or a table pasted off the web, could
 *  restyle or hide the whole editor. In the frame it styles only itself, which
 *  is what the author meant anyway. */
export function needsIsolation(html) {
  // `<script/src=…>` is a script too; an <iframe> (folium maps,
  // IPython.display.IFrame) is kept working inside the sandboxed frame
  // instead of being stripped to nothing.
  return /<(script|style|iframe)[\s>/]/i.test(String(html || ''));
}
