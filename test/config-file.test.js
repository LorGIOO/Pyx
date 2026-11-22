// @vitest-environment jsdom
// Settings mirrored to config.json: what goes in, how it reads, and the
// restore when the WebView's storage comes back empty.
import { describe, it, expect, beforeEach } from 'vitest';
import { exportConfigText, importConfigText, parseConfig } from '../js/core/config-file.js';

beforeEach(() => localStorage.clear());

describe('archivo de configuración', () => {
  it('exporta los ajustes como JSON legible y sin datos de cada documento', () => {
    localStorage.setItem('calc-general', JSON.stringify({ fontSize: 15, pdfPanButton: 'middle' }));
    localStorage.setItem('calc-theme', 'dark');
    localStorage.setItem('pyx-annot:C:/x/informe.pdf', JSON.stringify({ 1: [] }));
    const o = JSON.parse(exportConfigText());
    expect(o.app).toBe('Pyx');
    expect(o.settings['calc-general'].json.fontSize).toBe(15);
    expect(o.settings['calc-theme'].text).toBe('dark');
    expect(o.settings['pyx-annot:C:/x/informe.pdf']).toBeUndefined();
  });
  it('importar devuelve exactamente lo exportado', () => {
    localStorage.setItem('calc-general', JSON.stringify({ fontSize: 15 }));
    localStorage.setItem('pyx-keys', JSON.stringify({ 'compile.run': 'F5' }));
    const text = exportConfigText();
    localStorage.clear();
    expect(importConfigText(text)).toBe(true);
    expect(JSON.parse(localStorage.getItem('calc-general')).fontSize).toBe(15);
    expect(JSON.parse(localStorage.getItem('pyx-keys'))['compile.run']).toBe('F5');
  });
  it('un archivo que no es de Pyx no se importa', () => {
    expect(parseConfig('{"a": 1}')).toBe(null);
    expect(parseConfig('no es json')).toBe(null);
    expect(importConfigText('{"app": "Otra", "settings": {}}')).toBe(false);
  });
});
