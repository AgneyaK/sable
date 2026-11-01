// Built-in global functions and the method tables for each value type.
//
// Methods receive `(self, args, vm)`; globals receive `(args, vm)`. Any
// callback into user code goes through `vm.call`.

import { NativeFn, Range, typeName, display, repr, equals, truthy, isHashable, isCallable } from './values.js';
import { RuntimeError } from './errors.js';
import { normalizeIndex, rangeToList } from './vm.js';

// -- argument checking -----------------------------------------------------------

function expect(label, value, type) {
  if (typeName(value) !== type) {
    throw new RuntimeError(`${label} expects a ${type}, got ${typeName(value)} ${repr(value)}`);
  }
  return value;
}

function expectInt(label, value) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RuntimeError(`${label} expects a whole number, got ${repr(value)}`);
  }
  return value;
}

function expectFn(label, value) {
  if (!isCallable(value)) throw new RuntimeError(`${label} expects a function, got ${typeName(value)}`);
  return value;
}

function expectKey(label, value) {
  if (!isHashable(value)) throw new RuntimeError(`${label}: a ${typeName(value)} cannot be used as a map key`);
  return value;
}

/** Orders numbers, strings, and lists of those (lexicographically). */
export function compareValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compareValues(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  throw new RuntimeError(`cannot compare ${typeName(a)} and ${typeName(b)}`);
}

const now = () => (globalThis.performance ? globalThis.performance.now() : Date.now());

export function lengthOf(v) {
  if (typeof v === 'string' || Array.isArray(v)) return v.length;
  if (v instanceof Map) return v.size;
  if (v instanceof Range) return v.size;
  throw new RuntimeError(`len() expects a string, list, map or range, got ${typeName(v)}`);
}

export function toList(v) {
  if (Array.isArray(v)) return v.slice();
  if (typeof v === 'string') return v.split('');
  if (v instanceof Map) return [...v.keys()];
  if (v instanceof Range) return rangeToList(v);
  throw new RuntimeError(`list() expects a list, string, map or range, got ${typeName(v)}`);
}

const record = (obj) => new Map(Object.entries(obj));

function extreme(label, args, sign) {
  const items = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  if (items.length === 0) throw new RuntimeError(`${label} of an empty list`);
  return items.reduce((best, x) => (compareValues(x, best) * sign > 0 ? x : best));
}

// -- globals ---------------------------------------------------------------------

export function installGlobals(vm) {
  const def = (name, min, max, fn) => vm.globals.set(name, new NativeFn(name, fn, min, max));

  def('print', 0, -1, (args, vm) => {
    vm.print(args.map(display).join(' '));
    return null;
  });
  def('str', 1, 1, ([v]) => display(v));
  def('repr', 1, 1, ([v]) => repr(v));
  def('type', 1, 1, ([v]) => typeName(v));
  def('len', 1, 1, ([v]) => lengthOf(v));
  def('list', 1, 1, ([v]) => toList(v));

  def('num', 1, 1, ([v]) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v !== 'string') throw new RuntimeError(`num() cannot convert a ${typeName(v)}`);
    const text = v.trim().replace(/_/g, '');
    if (text === '') return null;
    const n = Number(text);
    return Number.isNaN(n) ? null : n;
  });
  def('int', 1, 1, ([v]) => {
    const n = typeof v === 'string' ? Number(v.trim()) : v;
    if (typeof n !== 'number' || Number.isNaN(n)) return null;
    return Math.trunc(n);
  });

  def('range', 1, 3, (args) => {
    args.forEach((a, i) => expect(`range() argument ${i + 1}`, a, 'number'));
    if (args.length === 1) return new Range(0, args[0]);
    const step = args[2] ?? 1;
    if (step === 0) throw new RuntimeError('range() step cannot be zero');
    return new Range(args[0], args[1], step);
  });

  def('assert', 1, 2, ([cond, message]) => {
    if (!truthy(cond)) {
      throw new RuntimeError(message === undefined ? 'assertion failed' : `assertion failed: ${display(message)}`);
    }
    return null;
  });
  def('assert_eq', 2, 3, ([a, b, message]) => {
    if (!equals(a, b)) {
      const detail = `${repr(a)} != ${repr(b)}`;
      throw new RuntimeError(`assertion failed: ${message === undefined ? detail : `${display(message)} (${detail})`}`);
    }
    return null;
  });
  def('error', 1, 1, ([message]) => {
    throw new RuntimeError(display(message));
  });
  def('try', 1, 1, ([fn], vm) => {
    expectFn('try()', fn);
    try {
      return record({ ok: true, value: vm.call(fn, []), error: null });
    } catch (e) {
      if (!(e instanceof RuntimeError)) throw e;
      return record({ ok: false, value: null, error: e.message });
    }
  });

  def('clock', 0, 0, () => now() / 1000);
  def('chr', 1, 1, ([n]) => String.fromCodePoint(expectInt('chr()', n)));
  def('ord', 1, 1, ([s]) => {
    expect('ord()', s, 'string');
    if (s.length === 0) throw new RuntimeError('ord() of an empty string');
    return s.codePointAt(0);
  });
  def('min', 1, -1, (args) => extreme('min()', args, -1));
  def('max', 1, -1, (args) => extreme('max()', args, 1));

  vm.globals.set('math', mathModule());
}

function mathModule() {
  // mulberry32: small, fast and seedable, so programs can be reproducible.
  let state = (Math.random() * 2 ** 32) >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const m = new Map();
  const unary = (name, f) =>
    m.set(name, new NativeFn(`math.${name}`, ([x]) => f(expect(`math.${name}()`, x, 'number')), 1, 1));

  for (const name of ['sqrt', 'floor', 'ceil', 'round', 'abs', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'exp', 'log', 'log2', 'log10', 'trunc', 'sign', 'cbrt']) {
    unary(name, Math[name]);
  }
  const fn = (name, min, max, f) => m.set(name, new NativeFn(`math.${name}`, f, min, max));
  fn('atan2', 2, 2, ([y, x]) => Math.atan2(expect('math.atan2()', y, 'number'), expect('math.atan2()', x, 'number')));
  fn('pow', 2, 2, ([a, b]) => expect('math.pow()', a, 'number') ** expect('math.pow()', b, 'number'));
  fn('hypot', 1, -1, (args) => Math.hypot(...args.map((a) => expect('math.hypot()', a, 'number'))));
  fn('min', 1, -1, (args) => extreme('math.min()', args, -1));
  fn('max', 1, -1, (args) => extreme('math.max()', args, 1));
  fn('clamp', 3, 3, ([x, lo, hi]) => Math.min(Math.max(x, lo), hi));
  fn('random', 0, 0, () => random());
  fn('random_int', 2, 2, ([lo, hi]) => {
    expectInt('math.random_int()', lo);
    expectInt('math.random_int()', hi);
    return lo + Math.floor(random() * (hi - lo + 1));
  });
  fn('seed', 1, 1, ([n]) => {
    state = expectInt('math.seed()', n) >>> 0;
    return null;
  });
  m.set('pi', Math.PI);
  m.set('e', Math.E);
  m.set('inf', Infinity);
  return m;
}

// -- methods ---------------------------------------------------------------------

const method = (min, max, fn) => ({ min, max, fn });
const table = (entries) => Object.assign(Object.create(null), entries);

const callBool = (vm, f, args) => truthy(vm.call(f, args));

const listMethods = table({
  len: method(0, 0, (l) => l.length),
  is_empty: method(0, 0, (l) => l.length === 0),
  push: method(1, -1, (l, args) => {
    l.push(...args);
    return l;
  }),
  pop: method(0, 0, (l) => {
    if (l.length === 0) throw new RuntimeError('pop() from an empty list');
    return l.pop();
  }),
  insert: method(2, 2, (l, [i, v]) => {
    expectInt('list.insert()', i);
    const at = i < 0 ? l.length + i + 1 : i;
    if (at < 0 || at > l.length) throw new RuntimeError(`insert index ${i} is out of bounds for a list of length ${l.length}`);
    l.splice(at, 0, v);
    return l;
  }),
  remove: method(1, 1, (l, [i]) => l.splice(normalizeIndex(i, l.length, 'list'), 1)[0]),
  extend: method(1, 1, (l, [other]) => {
    l.push(...expect('list.extend()', other, 'list'));
    return l;
  }),
  clear: method(0, 0, (l) => {
    l.length = 0;
    return l;
  }),
  copy: method(0, 0, (l) => l.slice()),
  first: method(0, 0, (l) => (l.length ? l[0] : null)),
  last: method(0, 0, (l) => (l.length ? l[l.length - 1] : null)),
  contains: method(1, 1, (l, [v]) => l.some((x) => equals(x, v))),
  index_of: method(1, 1, (l, [v]) => {
    const i = l.findIndex((x) => equals(x, v));
    return i === -1 ? null : i;
  }),
  slice: method(1, 2, (l, [start, end]) => l.slice(expectInt('list.slice()', start), end === undefined ? undefined : expectInt('list.slice()', end))),
  take: method(1, 1, (l, [n]) => l.slice(0, Math.max(0, expectInt('list.take()', n)))),
  skip: method(1, 1, (l, [n]) => l.slice(Math.max(0, expectInt('list.skip()', n)))),
  reverse: method(0, 0, (l) => l.slice().reverse()),
  join: method(0, 1, (l, [sep = '']) => l.map(display).join(expect('list.join()', sep, 'string'))),

  map: method(1, 1, (l, [f], vm) => l.map((x) => vm.call(f, [x]))),
  filter: method(1, 1, (l, [f], vm) => l.filter((x) => callBool(vm, f, [x]))),
  each: method(1, 1, (l, [f], vm) => {
    for (const x of l) vm.call(f, [x]);
    return null;
  }),
  reduce: method(1, 2, (l, args, vm) => {
    const f = args[0];
    let acc, start;
    if (args.length > 1) {
      acc = args[1];
      start = 0;
    } else {
      if (l.length === 0) throw new RuntimeError('reduce() of an empty list with no initial value');
      acc = l[0];
      start = 1;
    }
    for (let i = start; i < l.length; i++) acc = vm.call(f, [acc, l[i]]);
    return acc;
  }),
  find: method(1, 1, (l, [f], vm) => {
    for (const x of l) if (callBool(vm, f, [x])) return x;
    return null;
  }),
  find_index: method(1, 1, (l, [f], vm) => {
    for (let i = 0; i < l.length; i++) if (callBool(vm, f, [l[i]])) return i;
    return null;
  }),
  any: method(1, 1, (l, [f], vm) => l.some((x) => callBool(vm, f, [x]))),
  all: method(1, 1, (l, [f], vm) => l.every((x) => callBool(vm, f, [x]))),
  count: method(0, 1, (l, [f], vm) => (f === undefined ? l.length : l.filter((x) => callBool(vm, f, [x])).length)),
  flat_map: method(1, 1, (l, [f], vm) => l.flatMap((x) => {
    const r = vm.call(f, [x]);
    return Array.isArray(r) ? r : [r];
  })),
  flat: method(0, 0, (l) => l.flat(1)),

  sum: method(0, 0, (l) => l.reduce((acc, x) => acc + expect('list.sum()', x, 'number'), 0)),
  min: method(0, 0, (l) => extreme('min()', [l], -1)),
  max: method(0, 0, (l) => extreme('max()', [l], 1)),
  sort: method(0, 1, (l, [f], vm) => {
    if (f === undefined) return l.slice().sort(compareValues);
    return l.slice().sort((a, b) => {
      const r = vm.call(f, [a, b]);
      if (typeof r !== 'number') throw new RuntimeError('sort() comparator must return a number');
      return r;
    });
  }),
  sort_by: method(1, 1, (l, [f], vm) =>
    l.map((x) => [vm.call(f, [x]), x]).sort((a, b) => compareValues(a[0], b[0])).map((p) => p[1])),

  enumerate: method(0, 0, (l) => l.map((x, i) => [i, x])),
  zip: method(1, 1, (l, [other]) => {
    expect('list.zip()', other, 'list');
    const n = Math.min(l.length, other.length);
    const out = [];
    for (let i = 0; i < n; i++) out.push([l[i], other[i]]);
    return out;
  }),
  unique: method(0, 0, (l) => {
    const out = [];
    const seen = new Set();
    for (const x of l) {
      if (isHashable(x)) {
        if (seen.has(x)) continue;
        seen.add(x);
      } else if (out.some((y) => equals(x, y))) continue;
      out.push(x);
    }
    return out;
  }),
  chunk: method(1, 1, (l, [n]) => {
    expectInt('list.chunk()', n);
    if (n <= 0) throw new RuntimeError('chunk() size must be positive');
    const out = [];
    for (let i = 0; i < l.length; i += n) out.push(l.slice(i, i + n));
    return out;
  }),
  group_by: method(1, 1, (l, [f], vm) => {
    const groups = new Map();
    for (const x of l) {
      const k = expectKey('group_by()', vm.call(f, [x]));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(x);
    }
    return groups;
  }),
});

const allChars = (re) => (s) => s.length > 0 && re.test(s);

const stringMethods = table({
  len: method(0, 0, (s) => s.length),
  is_empty: method(0, 0, (s) => s.length === 0),
  upper: method(0, 0, (s) => s.toUpperCase()),
  lower: method(0, 0, (s) => s.toLowerCase()),
  trim: method(0, 0, (s) => s.trim()),
  trim_start: method(0, 0, (s) => s.trimStart()),
  trim_end: method(0, 0, (s) => s.trimEnd()),
  split: method(0, 1, (s, [sep]) => {
    if (sep === undefined) return s.split(/\s+/).filter(Boolean);
    return s.split(expect('string.split()', sep, 'string'));
  }),
  chars: method(0, 0, (s) => s.split('')),
  lines: method(0, 0, (s) => s.split(/\r?\n/)),
  contains: method(1, 1, (s, [sub]) => s.includes(expect('string.contains()', sub, 'string'))),
  starts_with: method(1, 1, (s, [p]) => s.startsWith(expect('string.starts_with()', p, 'string'))),
  ends_with: method(1, 1, (s, [p]) => s.endsWith(expect('string.ends_with()', p, 'string'))),
  index_of: method(1, 1, (s, [sub]) => {
    const i = s.indexOf(expect('string.index_of()', sub, 'string'));
    return i === -1 ? null : i;
  }),
  count: method(1, 1, (s, [sub]) => {
    expect('string.count()', sub, 'string');
    return sub === '' ? s.length + 1 : s.split(sub).length - 1;
  }),
  replace: method(2, 2, (s, [from, to]) =>
    s.split(expect('string.replace()', from, 'string')).join(expect('string.replace()', to, 'string'))),
  repeat: method(1, 1, (s, [n]) => {
    expectInt('string.repeat()', n);
    if (n < 0) throw new RuntimeError('repeat() count cannot be negative');
    return s.repeat(n);
  }),
  slice: method(1, 2, (s, [start, end]) => s.slice(expectInt('string.slice()', start), end === undefined ? undefined : expectInt('string.slice()', end))),
  pad_start: method(1, 2, (s, [n, ch = ' ']) => s.padStart(expectInt('string.pad_start()', n), expect('string.pad_start()', ch, 'string'))),
  pad_end: method(1, 2, (s, [n, ch = ' ']) => s.padEnd(expectInt('string.pad_end()', n), expect('string.pad_end()', ch, 'string'))),
  reverse: method(0, 0, (s) => s.split('').reverse().join('')),
  is_digit: method(0, 0, allChars(/^[0-9]+$/)),
  is_alpha: method(0, 0, allChars(/^[A-Za-z]+$/)),
  is_alnum: method(0, 0, allChars(/^[A-Za-z0-9]+$/)),
  is_space: method(0, 0, allChars(/^\s+$/)),
});

const mapMethods = table({
  len: method(0, 0, (m) => m.size),
  is_empty: method(0, 0, (m) => m.size === 0),
  keys: method(0, 0, (m) => [...m.keys()]),
  values: method(0, 0, (m) => [...m.values()]),
  entries: method(0, 0, (m) => [...m.entries()].map(([k, v]) => [k, v])),
  has: method(1, 1, (m, [k]) => m.has(k)),
  get: method(1, 2, (m, [k, fallback = null]) => (m.has(k) ? m.get(k) : fallback)),
  set: method(2, 2, (m, [k, v]) => {
    m.set(expectKey('map.set()', k), v);
    return m;
  }),
  remove: method(1, 1, (m, [k]) => {
    const v = m.has(k) ? m.get(k) : null;
    m.delete(k);
    return v;
  }),
  clear: method(0, 0, (m) => {
    m.clear();
    return m;
  }),
  copy: method(0, 0, (m) => new Map(m)),
  merge: method(1, 1, (m, [other]) => new Map([...m, ...expect('map.merge()', other, 'map')])),
  each: method(1, 1, (m, [f], vm) => {
    for (const [k, v] of [...m]) vm.call(f, [k, v]);
    return null;
  }),
  filter: method(1, 1, (m, [f], vm) => new Map([...m].filter(([k, v]) => callBool(vm, f, [k, v])))),
  map_values: method(1, 1, (m, [f], vm) => new Map([...m].map(([k, v]) => [k, vm.call(f, [v])]))),
});

const rangeMethods = table({
  len: method(0, 0, (r) => r.size),
  contains: method(1, 1, (r, [x]) => r.contains(x)),
  to_list: method(0, 0, (r) => rangeToList(r)),
  step: method(1, 1, (r, [n]) => {
    expect('range.step()', n, 'number');
    if (n === 0) throw new RuntimeError('step() cannot be zero');
    return new Range(r.start, r.end, n, r.inclusive);
  }),
  // A sum over a range doesn't need to materialise it.
  sum: method(0, 0, (r) => {
    const n = r.size;
    if (n === Infinity) throw new RuntimeError('sum() of an infinite range');
    return n === 0 ? 0 : (n * (r.start + r.at(n - 1))) / 2;
  }),
});

const numberMethods = table({
  abs: method(0, 0, (n) => Math.abs(n)),
  floor: method(0, 0, (n) => Math.floor(n)),
  ceil: method(0, 0, (n) => Math.ceil(n)),
  round: method(0, 1, (n, [digits = 0]) => {
    const f = 10 ** expectInt('number.round()', digits);
    return Math.round(n * f) / f;
  }),
  sqrt: method(0, 0, (n) => Math.sqrt(n)),
  pow: method(1, 1, (n, [e]) => n ** expect('number.pow()', e, 'number')),
  is_int: method(0, 0, (n) => Number.isInteger(n)),
  clamp: method(2, 2, (n, [lo, hi]) => Math.min(Math.max(n, lo), hi)),
  to_fixed: method(1, 1, (n, [d]) => n.toFixed(expectInt('number.to_fixed()', d))),
});

export const METHODS = {
  list: listMethods,
  string: stringMethods,
  map: mapMethods,
  range: rangeMethods,
  number: numberMethods,
};
