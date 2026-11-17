// Dragging the PDF with the mouse button chosen in Configuración.
// Run: npx vite (port 3042), then `node test/visual/viewer-pan.mjs`.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1000, height: 800 } });
await p.goto('http://localhost:3042/test/visual/viewer-lab.html');
await p.waitForFunction(() => window.labReady);
await p.evaluate(() => window.lab.load(Array(6).fill([595, 842]), 'pan'));
await p.waitForTimeout(800);
const top = () => p.evaluate(() => document.getElementById('pane').scrollTop);
async function drag(button) {
  await p.evaluate(() => { document.getElementById('pane').scrollTop = 600; });
  const before = await top();
  await p.mouse.move(450, 500);
  await p.mouse.down({ button });
  await p.mouse.move(450, 300, { steps: 6 });
  await p.mouse.up({ button });
  return (await top()) !== before;
}
let bad = 0;
for (const [mode, right, middle] of [['right', true, true], ['right-only', true, false], ['middle', false, true]]) {
  await p.evaluate((m) => { window.lab.general.pdfPanButton = m; }, mode);
  const r = await drag('right'), m = await drag('middle');
  const ok = r === right && m === middle;
  if (!ok) bad++;
  console.log(ok ? 'bien' : 'MAL ', mode.padEnd(11), 'derecho mueve:', r, ' rueda mueve:', m);
}
await b.close();
process.exit(bad ? 1 : 0);
