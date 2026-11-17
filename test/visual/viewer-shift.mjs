// The PDF must not move sideways when the document is recompiled.
// Run: npx vite (port 3042) in one terminal, then `node test/visual/viewer-shift.mjs`.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const A4 = [595, 842], A3L = [1191, 842];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1000, height: 800 } });
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto('http://localhost:3042/test/visual/viewer-lab.html');
await p.waitForFunction(() => window.labReady);
const wait = (ms) => p.waitForTimeout(ms);
const report = [];
for (const [name, first, second] of [
  ['todas A4, recompilar', [A4, A4, A4], [A4, A4, A4]],
  ['A4 + plano A3, recompilar', [A4, A3L, A4, A4], [A4, A3L, A4, A4]],
  ['cambio grande (más páginas)', [A4, A3L, A4], [A4, A3L, A4, A4, A4, A4]],
]) {
  await p.evaluate(([s]) => window.lab.load(s, 'v1'), [first]);
  await wait(150);
  const start = await p.evaluate(() => window.lab.firstPageLeft()); // where it first appears
  await wait(1350);
  // Scroll down a bit and let the background renderer learn every page size.
  await p.evaluate(() => { document.getElementById('pane').scrollTop = 200; });
  await wait(1500);
  const before = await p.evaluate(() => [window.lab.firstPageLeft(), window.lab.scrollLeft()]);
  await p.evaluate(([s]) => window.lab.load(s, 'v2'), [second]);
  const lefts = [];
  for (let i = 0; i < 12; i++) { await wait(150); lefts.push(await p.evaluate(() => window.lab.firstPageLeft())); }
  report.push({ name, before: before[0], after: lefts, // Fit to width: the page being read fills the pane from its left padding
  // (12 px + border), and must stay there through the whole recompile.
  moved: [start, before[0], ...lefts].some((l) => Math.abs(l - 13) > 1) });
}
for (const r of report) console.log(r.moved ? 'SE MUEVE' : 'quieto  ', r.name, 'antes', r.before, 'después', r.after.join(','));
await b.close();
process.exit(report.some((r) => r.moved) ? 1 : 0);
