import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../assets/js/app.js', import.meta.url), 'utf8');

assert.match(html, /name="mode" value="photo" checked/, 'Pure Vector Photo should be the default output mode.');
assert.doesNotMatch(html, /name="mode" value="hybrid" checked/, 'Hybrid must not be selected by default.');
assert.match(html, /BEST FOR ZOOM/, 'The UI should identify the bitmap-free mode for zooming.');
assert.match(html, /id="formatPill"/, 'The output format label should have a stable UI target.');
assert.match(app, /elements\.formatPill\.textContent = `SVG · \$\{exact \? 'PIXEL-EXACT' : purePhoto \? 'PURE VECTOR' : 'HYBRID'\}`/, 'The format label should follow the selected output mode.');
assert.match(app, /raster portion can look soft when enlarged/, 'Hybrid mode should disclose that its embedded raster can soften when enlarged.');
console.log('PASS UI mode regression: Pure Vector is default, mode badge is dynamic, and Hybrid raster scaling is explained.');
