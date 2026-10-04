// Run every test, stop on the first failure (CLAUDE.md rule 10).   Usage: node n8n/tests/run-all.js
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = [
  ...fs.readdirSync(path.join(root, 'snippets')).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(root, 'snippets', f)),
  ...fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(__dirname, f)),
];

for (const file of files) {
  const rel = path.relative(path.join(root, '..'), file);
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  const last = (r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  if (r.status !== 0) {
    console.error(`FAIL  ${rel}\n${r.stdout}\n${r.stderr}`);
    process.exit(1);
  }
  console.log(`pass  ${rel}  (${last.trim()})`);
}
console.log(`\nAll ${files.length} test files pass.`);
