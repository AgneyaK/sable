import { describe, test, assert, output } from './harness.js';
import { EXAMPLES } from '../examples/index.js';

// Runners provide `globalThis.readTextFile(pathFromRepoRoot)`.
const expected = {
  'brainfuck.sb': 'Hello World!',
  'closures.sb': 'a = 3, b = 1',
  'calc.sb': '2 ^ 3 ^ 2 = 512',
  'primes.sb': '46 primes up to 200:',
  'quicksort.sb': 'matches the built-in sort.',
};

describe('examples', () => {
  for (const { file } of EXAMPLES) {
    test(`${file} runs`, async () => {
      const source = await globalThis.readTextFile(`examples/${file}`);
      const out = output(source);
      if (expected[file]) assert.ok(out.includes(expected[file]), `output should include ${JSON.stringify(expected[file])}`);
    });
  }
});
