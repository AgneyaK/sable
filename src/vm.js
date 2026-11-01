// The bytecode interpreter: a stack machine with call frames and
// clox-style upvalues for closures.
//
// `run` is re-entrant. Native functions such as `list.map` call back into
// Sable through `vm.call`, which pushes a frame and runs the dispatch loop
// until that frame returns.

import { Op } from './chunk.js';
import {
  Closure, NativeFn, Upvalue, Range, typeName, display, repr, equals, floorMod, isHashable,
} from './values.js';
import { RuntimeError } from './errors.js';
import { installGlobals, METHODS } from './stdlib.js';

const MAX_FRAMES = 4096;

export class VM {
  constructor({ print = (line) => console.log(line) } = {}) {
    this.stack = [];
    this.sp = 0;
    this.frames = [];
    this.openUpvalues = null;
    this.globals = new Map();
    this.print = print;
    installGlobals(this);
    this.builtins = new Set(this.globals.keys());
  }

  /** Runs a compiled script and returns the value of its final expression. */
  interpret(proto) {
    const closure = new Closure(proto, []);
    this.stack[this.sp++] = closure;
    try {
      this.pushFrame(closure, 0);
      return this.run(0);
    } catch (e) {
      this.closeUpvalues(0);
      this.frames.length = 0;
      this.sp = 0;
      throw e;
    }
  }

  /** Calls a Sable function from native code. */
  call(callee, args) {
    if (callee instanceof NativeFn) {
      checkArity(callee.name + '()', callee.min, callee.max, args.length);
      const result = callee.fn(args, this);
      return result === undefined ? null : result;
    }
    if (!(callee instanceof Closure)) {
      throw new RuntimeError(`cannot call a value of type ${typeName(callee)}`);
    }
    const savedSp = this.sp, savedFrames = this.frames.length;
    this.stack[this.sp++] = callee;
    for (const a of args) this.stack[this.sp++] = a;
    try {
      this.pushFrame(callee, args.length);
      return this.run(savedFrames);
    } catch (e) {
      this.closeUpvalues(savedSp);
      this.frames.length = savedFrames;
      this.sp = savedSp;
      throw e;
    }
  }

  pushFrame(closure, argc) {
    const proto = closure.proto;
    if (argc !== proto.arity) {
      const who = proto.name ? `function '${proto.name}'` : 'anonymous function';
      throw new RuntimeError(`${who} expects ${plural(proto.arity, 'argument')} but got ${argc}`);
    }
    if (this.frames.length >= MAX_FRAMES) {
      throw new RuntimeError('stack overflow', { hint: 'is there a recursive call without a base case?' });
    }
    this.frames.push({
      closure,
      proto,
      code: proto.chunk.code,
      constants: proto.chunk.constants,
      ip: 0,
      base: this.sp - argc - 1,
    });
  }

  callNative(fn, argc) {
    checkArity(fn.name + '()', fn.min, fn.max, argc);
    const args = this.stack.slice(this.sp - argc, this.sp);
    const result = fn.fn(args, this);
    this.sp -= argc + 1;
    this.stack[this.sp++] = result === undefined ? null : result;
  }

  // -- upvalues ----------------------------------------------------------------

  captureUpvalue(loc) {
    let prev = null;
    let uv = this.openUpvalues;
    while (uv !== null && uv.loc > loc) {
      prev = uv;
      uv = uv.next;
    }
    if (uv !== null && uv.loc === loc) return uv;
    const created = new Upvalue(loc);
    created.next = uv;
    if (prev === null) this.openUpvalues = created;
    else prev.next = created;
    return created;
  }

  closeUpvalues(from) {
    while (this.openUpvalues !== null && this.openUpvalues.loc >= from) {
      const uv = this.openUpvalues;
      uv.value = this.stack[uv.loc];
      uv.open = false;
      this.openUpvalues = uv.next;
    }
  }

  // -- the dispatch loop -------------------------------------------------------

  run(stopAt) {
    const stack = this.stack;
    let frame = this.frames[this.frames.length - 1];
    let code = frame.code;
    let consts = frame.constants;
    let base = frame.base;
    let ip = frame.ip;

    try {
      for (;;) {
        switch (code[ip++]) {
          case Op.CONST:
            stack[this.sp++] = consts[code[ip++]];
            break;
          case Op.NIL:
            stack[this.sp++] = null;
            break;
          case Op.TRUE:
            stack[this.sp++] = true;
            break;
          case Op.FALSE:
            stack[this.sp++] = false;
            break;
          case Op.POP:
            this.sp--;
            break;
          case Op.POPN:
            this.sp -= code[ip++];
            this.closeUpvalues(this.sp);
            break;
          case Op.DUP:
            stack[this.sp] = stack[this.sp - 1];
            this.sp++;
            break;
          case Op.DUP2:
            stack[this.sp] = stack[this.sp - 2];
            stack[this.sp + 1] = stack[this.sp - 1];
            this.sp += 2;
            break;

          case Op.GET_LOCAL:
            stack[this.sp++] = stack[base + code[ip++]];
            break;
          case Op.SET_LOCAL:
            stack[base + code[ip++]] = stack[this.sp - 1];
            break;
          case Op.GET_UPVALUE: {
            const uv = frame.closure.upvalues[code[ip++]];
            stack[this.sp++] = uv.open ? stack[uv.loc] : uv.value;
            break;
          }
          case Op.SET_UPVALUE: {
            const uv = frame.closure.upvalues[code[ip++]];
            if (uv.open) stack[uv.loc] = stack[this.sp - 1];
            else uv.value = stack[this.sp - 1];
            break;
          }
          case Op.GET_GLOBAL: {
            const name = consts[code[ip++]];
            const v = this.globals.get(name);
            if (v === undefined) throw this.undefinedVariable(name);
            stack[this.sp++] = v;
            break;
          }
          case Op.SET_GLOBAL: {
            const name = consts[code[ip++]];
            if (!this.globals.has(name)) throw this.undefinedVariable(name, true);
            this.globals.set(name, stack[this.sp - 1]);
            break;
          }
          case Op.DEFINE_GLOBAL:
            this.globals.set(consts[code[ip++]], stack[--this.sp]);
            break;

          case Op.ADD: {
            const b = stack[--this.sp], a = stack[this.sp - 1];
            if (typeof a === 'number' && typeof b === 'number') stack[this.sp - 1] = a + b;
            else stack[this.sp - 1] = add(a, b);
            break;
          }
          case Op.SUB: {
            const b = stack[--this.sp], a = stack[this.sp - 1];
            if (typeof a !== 'number' || typeof b !== 'number') throw operandError('-', a, b);
            stack[this.sp - 1] = a - b;
            break;
          }
          case Op.MUL: {
            const b = stack[--this.sp], a = stack[this.sp - 1];
            if (typeof a === 'number' && typeof b === 'number') stack[this.sp - 1] = a * b;
            else stack[this.sp - 1] = multiply(a, b);
            break;
          }
          case Op.DIV: {
            const b = stack[--this.sp], a = stack[this.sp - 1];
            if (typeof a !== 'number' || typeof b !== 'number') throw operandError('/', a, b);
            if (b === 0) throw new RuntimeError('division by zero');
            stack[this.sp - 1] = a / b;
            break;
          }
          case Op.MOD: {
            const b = stack[--this.sp], a = stack[this.sp - 1];
            if (typeof a !== 'number' || typeof b !== 'number') throw operandError('%', a, b);
            if (b === 0) throw new RuntimeError('modulo by zero');
            stack[this.sp - 1] = floorMod(a, b);
            break;
          }
          case Op.POW: {
            const b = stack[--this.sp], a = stack[this.sp - 1];
            if (typeof a !== 'number' || typeof b !== 'number') throw operandError('**', a, b);
            stack[this.sp - 1] = a ** b;
            break;
          }
          case Op.NEG: {
            const a = stack[this.sp - 1];
            if (typeof a !== 'number') throw new RuntimeError(`cannot negate a ${typeName(a)}`);
            stack[this.sp - 1] = -a;
            break;
          }
          case Op.NOT: {
            const a = stack[this.sp - 1];
            stack[this.sp - 1] = a === null || a === false;
            break;
          }
          case Op.EQ: {
            const b = stack[--this.sp];
            stack[this.sp - 1] = equals(stack[this.sp - 1], b);
            break;
          }
          case Op.NEQ: {
            const b = stack[--this.sp];
            stack[this.sp - 1] = !equals(stack[this.sp - 1], b);
            break;
          }
          case Op.LT: {
            const b = stack[--this.sp], a = stack[this.sp - 1];
            if (!comparable(a, b)) throw compareError('<', a, b);
            stack[this.sp - 1] = a < b;
            break;
          }
          case Op.LE: {
            const b = stack[--this.sp], a = stack[this.sp - 1];
            if (!comparable(a, b)) throw compareError('<=', a, b);
            stack[this.sp - 1] = a <= b;
            break;
          }
          case Op.GT: {
            const b = stack[--this.sp], a = stack[this.sp - 1];
            if (!comparable(a, b)) throw compareError('>', a, b);
            stack[this.sp - 1] = a > b;
            break;
          }
          case Op.GE: {
            const b = stack[--this.sp], a = stack[this.sp - 1];
            if (!comparable(a, b)) throw compareError('>=', a, b);
            stack[this.sp - 1] = a >= b;
            break;
          }
          case Op.IN: {
            const container = stack[--this.sp];
            stack[this.sp - 1] = contains(container, stack[this.sp - 1]);
            break;
          }
          case Op.RANGE: {
            const inclusive = code[ip++] === 1;
            const end = stack[--this.sp], start = stack[this.sp - 1];
            if (typeof start !== 'number' || typeof end !== 'number') {
              throw new RuntimeError(`range bounds must be numbers, got ${typeName(start)} and ${typeName(end)}`);
            }
            stack[this.sp - 1] = new Range(start, end, 1, inclusive);
            break;
          }

          case Op.JUMP:
            ip = code[ip];
            break;
          case Op.JUMP_IF_FALSE: {
            const target = code[ip++];
            const v = stack[this.sp - 1];
            if (v === null || v === false) ip = target;
            break;
          }
          case Op.JUMP_IF_TRUE: {
            const target = code[ip++];
            const v = stack[this.sp - 1];
            if (v !== null && v !== false) ip = target;
            break;
          }
          case Op.POP_JUMP_IF_FALSE: {
            const target = code[ip++];
            const v = stack[--this.sp];
            if (v === null || v === false) ip = target;
            break;
          }

          case Op.CALL: {
            const argc = code[ip++];
            const callee = stack[this.sp - 1 - argc];
            frame.ip = ip;
            if (callee instanceof Closure) {
              this.pushFrame(callee, argc);
              frame = this.frames[this.frames.length - 1];
              code = frame.code;
              consts = frame.constants;
              base = frame.base;
              ip = 0;
            } else if (callee instanceof NativeFn) {
              this.callNative(callee, argc);
            } else {
              throw new RuntimeError(`cannot call a value of type ${typeName(callee)}`);
            }
            break;
          }
          case Op.INVOKE: {
            const name = consts[code[ip++]];
            const argc = code[ip++];
            const at = this.sp - 1 - argc;
            const receiver = stack[at];
            frame.ip = ip;
            const member = receiver instanceof Map ? receiver.get(name) : undefined;
            if (member instanceof Closure) {
              stack[at] = member;
              this.pushFrame(member, argc);
              frame = this.frames[this.frames.length - 1];
              code = frame.code;
              consts = frame.constants;
              base = frame.base;
              ip = 0;
            } else if (member instanceof NativeFn) {
              stack[at] = member;
              this.callNative(member, argc);
            } else {
              this.invokeMethod(receiver, name, argc);
            }
            break;
          }
          case Op.CLOSURE: {
            const proto = consts[code[ip++]];
            const upvalues = new Array(proto.upvalueCount);
            for (let i = 0; i < proto.upvalueCount; i++) {
              const isLocal = code[ip++];
              const index = code[ip++];
              upvalues[i] = isLocal ? this.captureUpvalue(base + index) : frame.closure.upvalues[index];
            }
            stack[this.sp++] = new Closure(proto, upvalues);
            break;
          }
          case Op.RETURN: {
            const result = stack[--this.sp];
            this.closeUpvalues(base);
            this.frames.pop();
            this.sp = base;
            if (this.frames.length === stopAt) return result;
            stack[this.sp++] = result;
            frame = this.frames[this.frames.length - 1];
            code = frame.code;
            consts = frame.constants;
            base = frame.base;
            ip = frame.ip;
            break;
          }
          case Op.CLOSE_SCOPE: {
            const n = code[ip++];
            const value = stack[this.sp - 1];
            const top = this.sp - 1 - n;
            this.closeUpvalues(top);
            stack[top] = value;
            this.sp = top + 1;
            break;
          }

          case Op.LIST: {
            const n = code[ip++];
            const list = stack.slice(this.sp - n, this.sp);
            this.sp -= n;
            stack[this.sp++] = list;
            break;
          }
          case Op.MAP: {
            const n = code[ip++];
            const map = new Map();
            for (let i = this.sp - 2 * n; i < this.sp; i += 2) map.set(stack[i], stack[i + 1]);
            this.sp -= 2 * n;
            stack[this.sp++] = map;
            break;
          }
          case Op.INDEX_GET: {
            const index = stack[--this.sp];
            stack[this.sp - 1] = indexGet(stack[this.sp - 1], index);
            break;
          }
          case Op.INDEX_SET: {
            const value = stack[--this.sp];
            const index = stack[--this.sp];
            indexSet(stack[this.sp - 1], index, value);
            stack[this.sp - 1] = value;
            break;
          }
          case Op.FIELD_GET: {
            const name = consts[code[ip++]];
            const obj = stack[this.sp - 1];
            if (!(obj instanceof Map)) throw fieldError(obj, name);
            const v = obj.get(name);
            stack[this.sp - 1] = v === undefined ? null : v;
            break;
          }
          case Op.FIELD_SET: {
            const name = consts[code[ip++]];
            const value = stack[--this.sp];
            const obj = stack[this.sp - 1];
            if (!(obj instanceof Map)) throw new RuntimeError(`cannot set field '${name}' on a ${typeName(obj)}`);
            obj.set(name, value);
            stack[this.sp - 1] = value;
            break;
          }

          case Op.ITER_PREP:
            stack[this.sp - 1] = makeIterator(stack[this.sp - 1]);
            break;
          case Op.ITER_NEXT: {
            const exit = code[ip++];
            const nvars = code[ip++];
            const it = stack[this.sp - 1];
            if (!it.next()) {
              ip = exit;
            } else if (nvars === 1) {
              stack[this.sp++] = it.single;
            } else {
              stack[this.sp++] = it.key;
              stack[this.sp++] = it.value;
            }
            break;
          }
          case Op.INTERP: {
            const n = code[ip++];
            let s = '';
            for (let i = this.sp - n; i < this.sp; i++) s += display(stack[i]);
            this.sp -= n;
            stack[this.sp++] = s;
            break;
          }

          default:
            throw new Error(`vm: bad opcode ${code[ip - 1]} at ${ip - 1}`);
        }
      }
    } catch (e) {
      frame.ip = ip;
      let err = e;
      if (!(err instanceof RuntimeError)) {
        // Deep recursion through native callbacks can exhaust the JS stack.
        if (err instanceof RangeError && /call stack/i.test(err.message)) err = new RuntimeError('stack overflow');
        else throw err;
      }
      if (!err.trace) this.attachTrace(err);
      throw err;
    }
  }

  invokeMethod(receiver, name, argc) {
    const type = typeName(receiver);
    let method = METHODS[type]?.[name];
    let self = receiver;
    if (!method && type === 'range' && METHODS.list[name]) {
      method = METHODS.list[name];
      self = rangeToList(receiver);
    }
    if (!method) throw this.noMethod(type, name);
    checkArity(`${type}.${name}()`, method.min, method.max, argc);
    const args = this.stack.slice(this.sp - argc, this.sp);
    const result = method.fn(self, args, this);
    this.sp -= argc + 1;
    this.stack[this.sp++] = result === undefined ? null : result;
  }

  attachTrace(err) {
    const trace = [];
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i];
      const span = f.proto.chunk.spans[Math.max(0, f.ip - 1)] ?? null;
      const name = f.proto.kind === 'script' ? '<script>' : f.proto.name ?? '<anonymous>';
      trace.push({ name, span, source: f.proto.chunk.source });
    }
    err.trace = trace;
    if (!err.span && trace.length) {
      err.span = trace[0].span;
      err.source = trace[0].source;
    }
  }

  undefinedVariable(name, assigning = false) {
    const guess = closest(name, this.globals.keys());
    const hint = guess
      ? `did you mean '${guess}'?`
      : assigning
        ? `declare it first with 'let ${name} = ...;'`
        : null;
    return new RuntimeError(`undefined variable '${name}'`, { hint });
  }

  noMethod(type, name) {
    const names = Object.keys(METHODS[type] ?? {});
    if (type === 'range') names.push(...Object.keys(METHODS.list));
    const guess = closest(name, names);
    return new RuntimeError(`${type} has no method '${name}'`, { hint: guess ? `did you mean '${guess}'?` : null });
  }

  /** Global names defined by user code rather than the standard library. */
  userGlobals() {
    return [...this.globals.keys()].filter((k) => !this.builtins.has(k));
  }
}

// -- helpers ---------------------------------------------------------------------

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function checkArity(label, min, max, argc) {
  if (argc >= min && (max < 0 || argc <= max)) return;
  let expected;
  if (max < 0) expected = `at least ${plural(min, 'argument')}`;
  else if (min === max) expected = plural(min, 'argument');
  else expected = `${min} to ${max} arguments`;
  throw new RuntimeError(`${label} expects ${expected} but got ${argc}`);
}

function add(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return a + b;
  if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
  if (typeof a === 'string' || typeof b === 'string') {
    return operandError('+', a, b, 'convert with str(), or use interpolation: "{a}{b}"', true);
  }
  return operandError('+', a, b, null, true);
}

function multiply(a, b) {
  if (typeof a === 'string' && typeof b === 'number') return repeat(a, b);
  if (typeof a === 'number' && typeof b === 'string') return repeat(b, a);
  return operandError('*', a, b, null, true);
}

function repeat(s, n) {
  if (!Number.isInteger(n) || n < 0) throw new RuntimeError('a string can only be repeated a non-negative whole number of times');
  return s.repeat(n);
}

function operandError(op, a, b, hint = null, doThrow = false) {
  const err = new RuntimeError(`cannot apply '${op}' to ${typeName(a)} and ${typeName(b)}`, { hint });
  if (doThrow) throw err;
  return err;
}

const comparable = (a, b) =>
  (typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string');

function compareError(op, a, b) {
  return new RuntimeError(`cannot compare ${typeName(a)} and ${typeName(b)} with '${op}'`);
}

function contains(container, item) {
  if (Array.isArray(container)) return container.some((x) => equals(x, item));
  if (typeof container === 'string') {
    if (typeof item !== 'string') throw new RuntimeError(`cannot search for a ${typeName(item)} in a string`);
    return container.includes(item);
  }
  if (container instanceof Map) return container.has(item);
  if (container instanceof Range) return container.contains(item);
  throw new RuntimeError(`'in' needs a list, string, map or range, not a ${typeName(container)}`);
}

export function normalizeIndex(index, length, what) {
  if (typeof index !== 'number' || !Number.isInteger(index)) {
    throw new RuntimeError(`${what} index must be a whole number, got ${repr(index)}`);
  }
  const i = index < 0 ? length + index : index;
  if (i < 0 || i >= length) {
    throw new RuntimeError(`index ${index} is out of bounds for a ${what} of length ${length}`);
  }
  return i;
}

function indexGet(obj, index) {
  if (Array.isArray(obj)) return obj[normalizeIndex(index, obj.length, 'list')];
  if (typeof obj === 'string') return obj[normalizeIndex(index, obj.length, 'string')];
  if (obj instanceof Map) {
    if (!isHashable(index)) throw new RuntimeError(`a ${typeName(index)} cannot be used as a map key`);
    const v = obj.get(index);
    return v === undefined ? null : v;
  }
  if (obj instanceof Range) return obj.at(normalizeIndex(index, obj.size, 'range'));
  throw new RuntimeError(`cannot index into a ${typeName(obj)}`);
}

function indexSet(obj, index, value) {
  if (Array.isArray(obj)) {
    obj[normalizeIndex(index, obj.length, 'list')] = value;
  } else if (obj instanceof Map) {
    if (!isHashable(index)) throw new RuntimeError(`a ${typeName(index)} cannot be used as a map key`);
    obj.set(index, value);
  } else if (typeof obj === 'string') {
    throw new RuntimeError('strings are immutable', { hint: 'build a new string instead' });
  } else {
    throw new RuntimeError(`cannot assign to an index of a ${typeName(obj)}`);
  }
}

function fieldError(obj, name) {
  const type = typeName(obj);
  const hasMethod = METHODS[type]?.[name] || (type === 'range' && METHODS.list[name]);
  return new RuntimeError(`a ${type} has no field '${name}'`, {
    hint: hasMethod ? `'${name}' is a method; call it with .${name}()` : null,
  });
}

export function rangeToList(r) {
  const n = r.size;
  if (n > 10_000_000) throw new RuntimeError(`range ${display(r)} is too large to turn into a list`);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = r.at(i);
  return out;
}

// Iterators expose `key`/`value` for two-variable loops and `single` for
// one-variable loops (a map's single value is its key).
class SeqIter {
  constructor(items) {
    this.items = items;
    this.i = -1;
  }
  next() {
    if (++this.i >= this.items.length) return false;
    this.key = this.i;
    this.single = this.value = this.items[this.i];
    return true;
  }
}

class RangeIter {
  constructor(range) {
    this.range = range;
    this.size = range.size;
    this.i = -1;
  }
  next() {
    if (++this.i >= this.size) return false;
    this.key = this.i;
    this.single = this.value = this.range.at(this.i);
    return true;
  }
}

class MapIter {
  constructor(map) {
    this.map = map;
    this.keys = [...map.keys()];
    this.i = -1;
  }
  next() {
    if (++this.i >= this.keys.length) return false;
    this.single = this.key = this.keys[this.i];
    const v = this.map.get(this.key);
    this.value = v === undefined ? null : v;
    return true;
  }
}

function makeIterator(v) {
  if (Array.isArray(v)) return new SeqIter(v);
  if (v instanceof Range) return new RangeIter(v);
  if (v instanceof Map) return new MapIter(v);
  if (typeof v === 'string') return new SeqIter(v.split(''));
  throw new RuntimeError(`cannot iterate over a ${typeName(v)}`, {
    hint: typeof v === 'number' ? `did you mean 0..${display(v)}?` : null,
  });
}

// Edit distance where swapping two adjacent letters counts as one edit,
// so `cuont` is a single typo away from `count`.
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

function closest(name, candidates) {
  let best = null;
  let bestDist = Math.max(1, Math.floor(name.length / 3)) + 1;
  for (const c of candidates) {
    const d = editDistance(name, c);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

