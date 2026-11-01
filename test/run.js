// Node test runner: `npm test` or `node test/run.js [filter]`.

import { readFile } from 'node:fs/promises';

globalThis.readTextFile = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const { runTests } = await import('./harness.js');
await import('./suites.js');

const filter = process.argv[2];
const color = process.stdout.isTTY;
const green = (s) => (color ? `\x1b[32m${s}\x1b[39m` : s);
const red = (s) => (color ? `\x1b[31m${s}\x1b[39m` : s);

const started = performance.now();
const { passed, failed, failures } = await runTests(({ name, ok }) => {
  if (filter && !name.includes(filter)) return;
  if (!ok) console.log(`${red('FAIL')} ${name}`);
});

for (const { name, error } of failures) {
  if (filter && !name.includes(filter)) continue;
  console.log(`\n${red('●')} ${name}\n  ${error?.stack ?? error}`);
}

const ms = Math.round(performance.now() - started);
console.log(`\n${failed ? red(`${failed} failed`) : green('all passed')}, ${passed} passed (${ms} ms)`);
process.exitCode = failed ? 1 : 0;
