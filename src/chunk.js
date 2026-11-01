// Bytecode format: opcodes, chunks, function prototypes and a disassembler.
//
// Code is a plain array of numbers. Each operand takes one slot, so there is
// no byte packing, and jump operands are absolute instruction offsets.

import { repr } from './values.js';

// [name, operand count (null = variable), stack effect (null = variable)]
const DEFS = [
  ['CONST', 1, 1], ['NIL', 0, 1], ['TRUE', 0, 1], ['FALSE', 0, 1],
  ['POP', 0, -1], ['POPN', 1, null], ['DUP', 0, 1], ['DUP2', 0, 2],
  ['GET_LOCAL', 1, 1], ['SET_LOCAL', 1, 0], ['GET_UPVALUE', 1, 1], ['SET_UPVALUE', 1, 0],
  ['GET_GLOBAL', 1, 1], ['SET_GLOBAL', 1, 0], ['DEFINE_GLOBAL', 1, -1],
  ['ADD', 0, -1], ['SUB', 0, -1], ['MUL', 0, -1], ['DIV', 0, -1], ['MOD', 0, -1], ['POW', 0, -1],
  ['NEG', 0, 0], ['NOT', 0, 0],
  ['EQ', 0, -1], ['NEQ', 0, -1], ['LT', 0, -1], ['LE', 0, -1], ['GT', 0, -1], ['GE', 0, -1], ['IN', 0, -1],
  ['RANGE', 1, -1],
  ['JUMP', 1, 0], ['JUMP_IF_FALSE', 1, 0], ['JUMP_IF_TRUE', 1, 0], ['POP_JUMP_IF_FALSE', 1, -1],
  ['CALL', 1, null], ['INVOKE', 2, null], ['CLOSURE', null, 1], ['RETURN', 0, -1], ['CLOSE_SCOPE', 1, null],
  ['LIST', 1, null], ['MAP', 1, null], ['INDEX_GET', 0, -1], ['INDEX_SET', 0, -2],
  ['FIELD_GET', 1, 0], ['FIELD_SET', 1, -1],
  ['ITER_PREP', 0, 0], ['ITER_NEXT', 2, null], ['INTERP', 1, null],
];

export const Op = Object.freeze(Object.fromEntries(DEFS.map(([name], i) => [name, i])));
export const OP_INFO = DEFS.map(([name, operands, effect]) => ({ name, operands, effect }));

export class Chunk {
  constructor(source) {
    this.code = [];
    this.spans = [];
    this.constants = [];
    this.source = source;
    this.constIndex = new Map();
  }

  write(value, span) {
    this.code.push(value);
    this.spans.push(span);
    return this.code.length - 1;
  }

  addConstant(value) {
    const t = typeof value;
    if (t === 'number' || t === 'string') {
      const key = t + ':' + (Object.is(value, -0) ? '-0' : String(value));
      const existing = this.constIndex.get(key);
      if (existing !== undefined) return existing;
      this.constIndex.set(key, this.constants.length);
    }
    this.constants.push(value);
    return this.constants.length - 1;
  }
}

export class FunctionProto {
  constructor(name, source, kind = 'function') {
    this.name = name;
    this.kind = kind;
    this.arity = 0;
    this.upvalueCount = 0;
    this.chunk = new Chunk(source);
  }
}

const JUMPS = new Set([Op.JUMP, Op.JUMP_IF_FALSE, Op.JUMP_IF_TRUE, Op.POP_JUMP_IF_FALSE]);
const NAMED = new Set([Op.GET_GLOBAL, Op.SET_GLOBAL, Op.DEFINE_GLOBAL, Op.FIELD_GET, Op.FIELD_SET]);

const label = (p) => (p.kind === 'script' ? '<script>' : `fn ${p.name ?? 'anonymous'}`);
const constText = (v) => (v instanceof FunctionProto ? `<${label(v)}>` : repr(v));

/** Human-readable listing of a function and every function nested in it. */
export function disassemble(proto) {
  const out = [];
  const visit = (p) => {
    const header = p.kind === 'script' ? '<script>' : `${label(p)} (arity ${p.arity}, upvalues ${p.upvalueCount})`;
    out.push(`== ${header} ==`);
    const { code, constants, spans } = p.chunk;
    let lastLine = -1;
    for (let ip = 0; ip < code.length; ) {
      const op = code[ip];
      const info = OP_INFO[op];
      const span = spans[ip];
      const loc = span && span.line !== lastLine ? `${span.line}:${span.col}` : '|';
      if (span) lastLine = span.line;

      let size = 1 + (info.operands ?? 0);
      let operands = '';
      let comment = '';
      if (op === Op.CLOSURE) {
        const fn = constants[code[ip + 1]];
        size = 2 + fn.upvalueCount * 2;
        operands = String(code[ip + 1]);
        const caps = [];
        for (let i = 0; i < fn.upvalueCount; i++) {
          caps.push(`${code[ip + 2 + i * 2] ? 'local' : 'upvalue'} ${code[ip + 3 + i * 2]}`);
        }
        comment = `<${label(fn)}>` + (caps.length ? ` captures [${caps.join(', ')}]` : '');
      } else if (op === Op.CONST) {
        operands = String(code[ip + 1]);
        comment = constText(constants[code[ip + 1]]);
      } else if (NAMED.has(op)) {
        operands = String(code[ip + 1]);
        comment = constants[code[ip + 1]];
      } else if (op === Op.INVOKE) {
        operands = `${code[ip + 1]} ${code[ip + 2]}`;
        comment = `.${constants[code[ip + 1]]}(${code[ip + 2]} args)`;
      } else if (JUMPS.has(op)) {
        operands = String(code[ip + 1]);
        comment = `-> ${String(code[ip + 1]).padStart(4, '0')}`;
      } else if (op === Op.ITER_NEXT) {
        operands = `${code[ip + 1]} ${code[ip + 2]}`;
        comment = `exit -> ${String(code[ip + 1]).padStart(4, '0')}`;
      } else if (info.operands) {
        operands = code.slice(ip + 1, ip + size).join(' ');
      }

      out.push(
        `${String(ip).padStart(4, '0')}  ${loc.padStart(6)}  ${info.name.padEnd(18)}${operands.padEnd(8)}${comment ? '; ' + comment : ''}`.trimEnd(),
      );
      ip += size;
    }
    for (const c of constants) {
      if (c instanceof FunctionProto) {
        out.push('');
        visit(c);
      }
    }
  };
  visit(proto);
  return out.join('\n');
}
