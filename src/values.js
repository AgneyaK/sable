// Runtime value representation.
//
// Sable values map onto JavaScript values wherever that's free:
//
//   nil -> null      bool -> boolean    number -> number    string -> string
//   list -> Array    map -> Map
//
// and onto small classes for the rest (ranges, closures, native functions).

export class Closure {
  constructor(proto, upvalues) {
    this.proto = proto;
    this.upvalues = upvalues;
  }
}

export class NativeFn {
  /**
   * @param {string} name
   * @param {(args: any[], vm: import('./vm.js').VM) => any} fn
   * @param {number} min minimum argument count
   * @param {number} max maximum argument count, or -1 for variadic
   */
  constructor(name, fn, min = 0, max = min) {
    this.name = name;
    this.fn = fn;
    this.min = min;
    this.max = max;
  }
}

/** A captured variable. Points at a stack slot until that slot goes away. */
export class Upvalue {
  constructor(loc) {
    this.loc = loc;
    this.value = null;
    this.open = true;
    this.next = null;
  }
}

export class Range {
  constructor(start, end, step = 1, inclusive = false) {
    this.start = start;
    this.end = end;
    this.step = step;
    this.inclusive = inclusive;
  }

  get size() {
    const span = (this.end - this.start) / this.step;
    if (span < 0 || Number.isNaN(span)) return 0;
    if (span === Infinity) return Infinity;
    return this.inclusive ? Math.floor(span) + 1 : Math.ceil(span);
  }

  at(i) {
    return this.start + i * this.step;
  }

  contains(x) {
    if (typeof x !== 'number') return false;
    const k = (x - this.start) / this.step;
    return Number.isInteger(k) && k >= 0 && k < this.size;
  }
}

export function typeName(v) {
  if (v === null || v === undefined) return 'nil';
  switch (typeof v) {
    case 'boolean': return 'bool';
    case 'number': return 'number';
    case 'string': return 'string';
  }
  if (Array.isArray(v)) return 'list';
  if (v instanceof Map) return 'map';
  if (v instanceof Range) return 'range';
  if (v instanceof Closure || v instanceof NativeFn) return 'function';
  return 'unknown';
}

export const truthy = (v) => v !== null && v !== false && v !== undefined;

export const isCallable = (v) => v instanceof Closure || v instanceof NativeFn;

export const isHashable = (v) =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** Modulo that takes the sign of the divisor, so `-1 % 3 == 2`. */
export function floorMod(a, b) {
  const r = a % b;
  return r !== 0 && (r < 0) !== (b < 0) ? r + b : r;
}

export function equals(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equals(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !equals(v, b.get(k))) return false;
    return true;
  }
  if (a instanceof Range && b instanceof Range) {
    return a.start === b.start && a.end === b.end && a.step === b.step && a.inclusive === b.inclusive;
  }
  return false;
}

export function formatNumber(n) {
  if (Number.isNaN(n)) return 'nan';
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  if (Object.is(n, -0)) return '0';
  return String(n);
}

/** How a value looks when printed: strings appear without quotes. */
export function display(v) {
  return show(v, false, new Set());
}

/** How a value looks inside a collection or the REPL: strings are quoted. */
export function repr(v) {
  return show(v, true, new Set());
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function show(v, quote, seen) {
  if (v === null || v === undefined) return 'nil';
  switch (typeof v) {
    case 'boolean': return String(v);
    case 'number': return formatNumber(v);
    case 'string': return quote ? JSON.stringify(v) : v;
  }
  if (Array.isArray(v)) {
    if (seen.has(v)) return '[...]';
    seen.add(v);
    const s = '[' + v.map((x) => show(x, true, seen)).join(', ') + ']';
    seen.delete(v);
    return s;
  }
  if (v instanceof Map) {
    if (seen.has(v)) return '{...}';
    seen.add(v);
    const parts = [];
    for (const [k, x] of v) {
      const key = typeof k === 'string' && IDENT.test(k) ? k : show(k, true, seen);
      parts.push(`${key}: ${show(x, true, seen)}`);
    }
    seen.delete(v);
    return '{' + parts.join(', ') + '}';
  }
  if (v instanceof Range) {
    if (v.step === 1) return `${formatNumber(v.start)}${v.inclusive ? '..=' : '..'}${formatNumber(v.end)}`;
    return `range(${formatNumber(v.start)}, ${formatNumber(v.end)}, ${formatNumber(v.step)})`;
  }
  if (v instanceof Closure) return `<fn ${v.proto.name ?? 'anonymous'}>`;
  if (v instanceof NativeFn) return `<native fn ${v.name}>`;
  return String(v);
}
