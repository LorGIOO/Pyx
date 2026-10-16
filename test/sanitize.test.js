// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sanitizeFragment, guardLinks } from '../js/editor/rich-frame.js';

// What the inline path of a cell output turns into. It runs in the app's own
// origin, so each of these would otherwise be code running next to the Tauri
// commands — and a .pltx from someone else carries its outputs.
const html = (s) => {
  const d = document.createElement('div');
  d.appendChild(sanitizeFragment(s));
  return d.innerHTML;
};

describe('sanitizeFragment (DOMPurify + reglas de Pyx)', () => {
  it('quita todo lo que se ejecuta', () => {
    expect(html('<script>alert(1)</script><b>ok</b>')).toBe('<b>ok</b>');
    expect(html('<img src="x.png" onerror="alert(1)">')).not.toContain('onerror');
    expect(html('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript');
    expect(html('<a href="java&#x09;script:alert(1)">x</a>')).not.toMatch(/script:/i);
    expect(html('<a href="  JaVaScRiPt:alert(1)">x</a>')).not.toMatch(/script:/i);
    expect(html('<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>'))
      .not.toContain('animate');
    expect(html('<svg><set attributeName="onmouseover" to="alert(1)"/></svg>')).not.toContain('<set');
    expect(html('<iframe srcdoc="<script>alert(1)</script>"></iframe>')).toBe('');
    expect(html('<form action="https://x"><button formaction="javascript:1">b</button></form>')).not.toContain('form');
  });

  it('no deja que una salida cambie el aspecto de la app ni abra ventanas', () => {
    expect(html('<style>body{display:none}</style><p>x</p>')).toBe('<p>x</p>');
    expect(html('<a href="https://example.com" target="_top">x</a>')).not.toContain('target');
  });

  it('conserva lo que una salida normal necesita', () => {
    const table = '<table class="dataframe"><thead><tr><th>a</th></tr></thead><tbody><tr><td style="color: red">1</td></tr></tbody></table>';
    const out = html(table);
    expect(out).toContain('class="dataframe"');
    expect(out).toContain('<td style="color: red">1</td>');
    expect(html('<img src="data:image/png;base64,iVBORw0KGgo=">')).toContain('data:image/png');
    expect(html('<svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>')).toContain('<path');
    expect(html('<a href="https://example.com">web</a>')).toContain('href="https://example.com"');
  });
});

describe('guardLinks', () => {
  it('abre los enlaces web fuera de la app y nunca navega la ventana', () => {
    const el = document.createElement('div');
    el.appendChild(sanitizeFragment('<a href="https://example.com/x">web</a><a href="informe.html">rel</a>'));
    const opened = [];
    guardLinks(el, (u) => opened.push(u));
    const [web, rel] = el.querySelectorAll('a');
    const click = (a) => {
      const e = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      a.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(click(web)).toBe(true);
    expect(click(rel)).toBe(true);
    expect(opened).toEqual(['https://example.com/x']);
  });
});
