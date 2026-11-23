import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsRoot = path.join(root, 'assets');
const jsRoot = path.join(assetsRoot, 'js');
const entryPoints = [
  path.join(jsRoot, 'app.js'),
  path.join(jsRoot, 'workers', 'trace-worker.js')
];
const importPattern = /(?:^|\n)\s*(?:import\s+(?:[^'";]*?\s+from\s+)?|export\s+[^'";]*?\s+from\s+)['"]([^'"]+)['"];?|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function collectFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(fullPath) : [fullPath];
  });
}

function resolveLocalImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const candidate = path.resolve(path.dirname(fromFile), specifier);
  const attempts = path.extname(candidate)
    ? [candidate]
    : [candidate, `${candidate}.js`, path.join(candidate, 'index.js')];
  return attempts.find((item) => fs.existsSync(item) && fs.statSync(item).isFile()) || null;
}

const reachable = new Set();
const pending = [...entryPoints];
const missing = [];

while (pending.length) {
  const current = pending.pop();
  if (reachable.has(current)) continue;
  assert.ok(fs.existsSync(current), `Runtime entry point is missing: ${path.relative(root, current)}`);
  reachable.add(current);
  const source = fs.readFileSync(current, 'utf8');
  importPattern.lastIndex = 0;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] || match[2];
    const resolved = resolveLocalImport(current, specifier);
    if (specifier.startsWith('.') && !resolved) {
      missing.push(`${path.relative(root, current)} → ${specifier}`);
    } else if (resolved) {
      pending.push(resolved);
    }
  }
}

assert.deepEqual(missing, [], `Unresolved runtime imports:\n${missing.join('\n')}`);
const runtimeJavaScript = collectFiles(jsRoot).filter((file) => file.endsWith('.js'));
const orphaned = runtimeJavaScript.filter((file) => !reachable.has(file));
assert.deepEqual(
  orphaned.map((file) => path.relative(root, file)).sort(),
  [],
  'Every shipped JavaScript module under assets/js must be reachable from app.js or the dedicated Worker entry point.'
);

const linkedStylesheets = [...fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/gi)]
  .map((match) => path.resolve(root, match[1]));
const shippedStylesheets = collectFiles(path.join(assetsRoot, 'css')).filter((file) => file.endsWith('.css'));
const orphanedStylesheets = shippedStylesheets.filter((file) => !linkedStylesheets.includes(file));
assert.deepEqual(
  orphanedStylesheets.map((file) => path.relative(root, file)).sort(),
  [],
  'Every shipped stylesheet must be linked from index.html.'
);

console.log(`PASS runtime import audit: ${reachable.size} JavaScript modules and ${linkedStylesheets.length} stylesheets resolved; no orphaned runtime assets.`);
