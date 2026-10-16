import { describe, it, expect } from 'vitest';
import { isDangerousUrl } from '../js/editor/rich-frame.js';

// Inline cell output lives in the APP's origin, next to the Tauri commands, and
// a .pltx carries its outputs: opening someone else's report renders them.
// The URL check must read a value the way the browser's URL parser will.
describe('isDangerousUrl', () => {
  it('catches script URLs however they are spelled', () => {
    for (const v of [
      'javascript:alert(1)',
      '  JavaScript:alert(1)',
      'java\tscript:alert(1)',          // href="java&#x09;script:…" after decoding
      'java\nscript:alert(1)',
      '\u0001javascript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:image/svg+xml,<svg onload=alert(1)>',
    ]) expect(isDangerousUrl(v), JSON.stringify(v)).toBe(true);
  });

  it('leaves ordinary links and images alone', () => {
    for (const v of [
      'https://example.com/a?b=javascript:1',
      'mailto:a@b.c',
      'figura.png',
      'data:image/png;base64,iVBORw0KGgo=',
      '#seccion',
      '',
    ]) expect(isDangerousUrl(v), JSON.stringify(v)).toBe(false);
  });
});
