// A minimal test harness that runs unchanged in Node and in the browser.

import { run, compile, CompileError, RuntimeError } from '../src/index.js';

const registry = [];
const prefix = [];

export function describe(name, fn) {
  prefix.push(name);
  try {
    fn();
  } finally {
    prefix.pop();
  }
}

export function test(name, fn) {
  registry.push({ name: [...prefix, name].join(' > '), fn });
}

export async function runTests(onResult = () => {}) {
  let passed = 0;
  const failures = [];
  for (const t of registry) {
    try {
      await t.fn();
      passed++;
      onResult({ name: t.name, ok: true });
    } catch (error) {
      failures.push({ name: t.name, error });
      onResult({ name: t.name, ok: false, error });
    }
  }
  return { passed, failed: failures.length, failures };
}

export class AssertionError extends Error {}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (a instanceof Map && b instanceof Map) {
    return a.size === b.size && [...a].every(([k, v]) => b.has(k) && deepEqual(v, b.get(k)));
  }
  return false;
}

function show(v) {
  if (v instanceof Map) return `Map(${JSON.stringify([...v])})`;
  return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
}

export const assert = {
  ok(value, message) {
    if (!value) throw new AssertionError(message ?? `expected a truthy value, got ${show(value)}`);
  },
  equal(actual, expected, message) {
    if (!deepEqual(actual, expected)) {
      throw new AssertionError(`${message ? message + ': ' : ''}expected ${show(expected)}, got ${show(actual)}`);
    }
  },
  match(actual, pattern, message) {
    if (!pattern.test(actual)) throw new AssertionError(`${message ? message + ': ' : ''}${show(actual)} does not match ${pattern}`);
  },
  throws(fn, type, pattern) {
    try {
      fn();
    } catch (e) {
      if (type && !(e instanceof type)) throw new AssertionError(`expected ${type.name}, got ${e?.name}: ${e?.message}`);
      if (pattern && !pattern.test(e.message)) {
        throw new AssertionError(`error message ${show(e.message)} does not match ${pattern}`);
      }
      return e;
    }
    throw new AssertionError('expected the code to throw');
  },
};

// -- helpers for running Sable code -------------------------------------------

/** Runs a program and returns the value of its last expression. */
export function evaluate(source) {
  return run(source, { print: () => {} });
}

/** Runs a program and returns everything it printed, one line per print. */
export function output(source) {
  const lines = [];
  run(source, { print: (line) => lines.push(line) });
  return lines.join('\n');
}

export function runtimeError(source, pattern) {
  return assert.throws(() => evaluate(source), RuntimeError, pattern);
}

export function compileError(source, pattern) {
  return assert.throws(() => compile(source), CompileError, pattern);
}
