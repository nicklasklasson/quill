// Checks that a built Quill.app contains every file the app loads, so a file left out of
// "files" in package.json fails the build instead of quietly breaking the installed app.
//
//   node build/check-packaged.js dist/mac-universal/Quill.app

const fs = require('fs');
const path = require('path');

const appBundle = process.argv[2];
if (!appBundle) { console.error('Usage: node build/check-packaged.js <path to Quill.app>'); process.exit(2); }
const appDir = path.join(appBundle, 'Contents', 'Resources', 'app');
const resources = path.join(appBundle, 'Contents', 'Resources');
const root = path.join(__dirname, '..');

const needed = new Set(['package.json', 'main.js']);
const visit = (rel) => {
  const file = path.join(root, rel);
  if (!fs.existsSync(file) || !/\.(js|html)$/.test(rel)) return;
  const src = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(rel);
  // path.join(__dirname, 'a', 'b') in JS files
  for (const m of src.matchAll(/path\.join\(__dirname,\s*((?:'[^']+'\s*,?\s*)+)\)/g)) {
    const parts = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    const target = path.normalize(path.join(dir, ...parts));
    if (!target.startsWith('..') && !target.startsWith('native') && !target.startsWith('vendor')) add(target);
  }
  // require('./x') and require('../x')
  for (const m of src.matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)) {
    let target = path.normalize(path.join(dir, m[1]));
    if (!target.endsWith('.js')) target += '.js';
    add(target);
  }
  // <script src="x"> and <link href="x"> in HTML
  for (const m of src.matchAll(/(?:src|href)="([^":]+\.(?:js|css))"/g)) add(path.normalize(path.join(dir, m[1])));
};
const add = (rel) => { if (!needed.has(rel)) { needed.add(rel); visit(rel); } };
visit('main.js');

let missing = 0;
for (const rel of [...needed].sort()) {
  const ok = fs.existsSync(path.join(appDir, rel));
  if (!ok) missing++;
  console.log(`${ok ? '  ok      ' : '  MISSING '} ${rel}`);
}
for (const rel of ['bin/quill-ax', 'bin/llama/arm64/llama-server', 'bin/llama/x64/llama-server']) {
  const ok = fs.existsSync(path.join(resources, rel));
  if (!ok) missing++;
  console.log(`${ok ? '  ok      ' : '  MISSING '} Resources/${rel}`);
}
if (missing) {
  console.error(`\n✗ ${missing} file(s) missing from the app. Add them to "files" (or "extraResources") in package.json.`);
  process.exit(1);
}
console.log(`\n✓ The app contains all ${needed.size + 3} files it needs`);
