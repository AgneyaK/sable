// Single-pass compiler from AST to bytecode.
//
// The compiler tracks the exact height of the VM stack at every instruction
// (`fs.depth`). That is what lets blocks be expressions: a `let` inside
// `foo(1, { let a = 2; a })` lives above the temporaries for `foo` and `1`,
// and its slot is simply wherever the stack happens to be when it's declared.
// Each block leaves its value on top and then drops its locals from
// underneath it with CLOSE_SCOPE.

import { parse } from './parser.js';
import { Op, OP_INFO, FunctionProto } from './chunk.js';
import { CompileError } from './errors.js';
import { floorMod } from './values.js';

export function compile(source, { ast } = {}) {
  return new Compiler(source).compileProgram(ast ?? parse(source));
}

const BINARY_OPS = {
  '+': Op.ADD, '-': Op.SUB, '*': Op.MUL, '/': Op.DIV, '%': Op.MOD, '**': Op.POW,
  '==': Op.EQ, '!=': Op.NEQ, '<': Op.LT, '<=': Op.LE, '>': Op.GT, '>=': Op.GE, in: Op.IN,
};
const COMPOUND_OPS = { '+=': Op.ADD, '-=': Op.SUB, '*=': Op.MUL, '/=': Op.DIV, '%=': Op.MOD };

class FnState {
  constructor(enclosing, name, kind, source) {
    this.enclosing = enclosing;
    this.proto = new FunctionProto(name, source, kind);
    this.kind = kind;
    // Slot 0 holds the function being called.
    this.locals = [{ name: '', scope: 0, slot: 0 }];
    this.upvalues = [];
    this.scopeDepth = 0;
    this.depth = 1;
    this.loops = [];
  }
}

const isIrrefutable = (p) => p.type === 'WildcardPattern' || p.type === 'BindPattern';

class Compiler {
  constructor(source) {
    this.source = source;
    this.errors = [];
    this.fs = null;
    this.span = null;
  }

  compileProgram(program) {
    this.fs = new FnState(null, null, 'script', this.source);
    this.span = program.span;
    this.compileItems(program.body, program.tail);
    this.emit(Op.RETURN);
    if (this.errors.length) throw new CompileError(this.errors);
    return this.fs.proto;
  }

  error(message, span, hint = null) {
    this.errors.push({ message, span, hint });
  }

  // -- emitting --------------------------------------------------------------

  get chunk() {
    return this.fs.proto.chunk;
  }

  here() {
    return this.chunk.code.length;
  }

  emit(op, ...operands) {
    const at = this.chunk.write(op, this.span);
    for (const x of operands) this.chunk.write(x, this.span);
    const effect = OP_INFO[op].effect;
    if (effect !== null) this.fs.depth += effect;
    return at;
  }

  adjust(n) {
    this.fs.depth += n;
  }

  /** Emits a forward jump and returns the operand slot to patch later. */
  emitJump(op) {
    return this.emit(op, -1) + 1;
  }

  patch(slot, target = this.here()) {
    this.chunk.code[slot] = target;
  }

  constant(value) {
    return this.chunk.addConstant(value);
  }

  emitValue(v) {
    if (v === null) this.emit(Op.NIL);
    else if (v === true) this.emit(Op.TRUE);
    else if (v === false) this.emit(Op.FALSE);
    else this.emit(Op.CONST, this.constant(v));
  }

  popN(n) {
    if (n > 0) {
      this.emit(Op.POPN, n);
      this.adjust(-n);
    }
  }

  // -- scopes and variables --------------------------------------------------

  beginScope() {
    this.fs.scopeDepth++;
  }

  /** Drops this scope's locals; with keepValue, the value on top survives. */
  endScope(keepValue) {
    const fs = this.fs;
    fs.scopeDepth--;
    let n = 0;
    while (fs.locals.length && fs.locals.at(-1).scope > fs.scopeDepth) {
      fs.locals.pop();
      n++;
    }
    if (n === 0) return;
    if (keepValue) {
      this.emit(Op.CLOSE_SCOPE, n);
      this.adjust(-n);
    } else {
      this.popN(n);
    }
  }

  addLocal(name, slot) {
    this.fs.locals.push({ name, scope: this.fs.scopeDepth, slot });
  }

  isGlobalScope() {
    return this.fs.kind === 'script' && this.fs.scopeDepth === 0;
  }

  resolveLocal(fs, name) {
    for (let i = fs.locals.length - 1; i >= 0; i--) {
      if (fs.locals[i].name === name) return fs.locals[i];
    }
    return null;
  }

  resolveUpvalue(fs, name) {
    if (!fs.enclosing) return -1;
    const local = this.resolveLocal(fs.enclosing, name);
    if (local) return this.addUpvalue(fs, local.slot, true);
    const outer = this.resolveUpvalue(fs.enclosing, name);
    if (outer !== -1) return this.addUpvalue(fs, outer, false);
    return -1;
  }

  addUpvalue(fs, index, isLocal) {
    const existing = fs.upvalues.findIndex((u) => u.index === index && u.isLocal === isLocal);
    if (existing !== -1) return existing;
    fs.upvalues.push({ index, isLocal });
    fs.proto.upvalueCount = fs.upvalues.length;
    return fs.upvalues.length - 1;
  }

  resolve(name) {
    const local = this.resolveLocal(this.fs, name);
    if (local) return { kind: 'local', index: local.slot };
    const up = this.resolveUpvalue(this.fs, name);
    if (up !== -1) return { kind: 'upvalue', index: up };
    return { kind: 'global', index: this.constant(name) };
  }

  emitGet(ref) {
    this.emit({ local: Op.GET_LOCAL, upvalue: Op.GET_UPVALUE, global: Op.GET_GLOBAL }[ref.kind], ref.index);
  }

  emitSet(ref) {
    this.emit({ local: Op.SET_LOCAL, upvalue: Op.SET_UPVALUE, global: Op.SET_GLOBAL }[ref.kind], ref.index);
  }

  // -- statements --------------------------------------------------------------

  compileItems(stmts, tail) {
    for (const s of stmts) this.compileStmt(s);
    if (tail) this.compileExpr(tail);
    else this.emit(Op.NIL);
  }

  compileStmt(node) {
    const saved = this.span;
    this.span = node.span;
    switch (node.type) {
      case 'Let':
        if (node.init?.type === 'Function' && !node.init.name) this.compileFunction(node.init, node.name);
        else if (node.init) this.compileExpr(node.init);
        else this.emit(Op.NIL);
        this.span = node.span;
        if (this.isGlobalScope()) this.emit(Op.DEFINE_GLOBAL, this.constant(node.name));
        else this.addLocal(node.name, this.fs.depth - 1);
        break;

      case 'Function': // a `fn name() {}` declaration
        if (this.isGlobalScope()) {
          this.compileFunction(node);
          this.emit(Op.DEFINE_GLOBAL, this.constant(node.name));
        } else {
          // Declared before the body is compiled so the function can recurse.
          this.addLocal(node.name, this.fs.depth);
          this.compileFunction(node);
        }
        break;

      case 'Return': {
        const depth = this.fs.depth;
        if (node.value) this.compileExpr(node.value);
        else this.emit(Op.NIL);
        this.emit(Op.RETURN);
        this.fs.depth = depth;
        break;
      }

      case 'Break':
      case 'Continue': {
        const loop = this.fs.loops.at(-1);
        const word = node.type.toLowerCase();
        if (!loop) {
          this.error(`'${word}' outside of a loop`, node.span);
          break;
        }
        const depth = this.fs.depth;
        this.popN(depth - loop.depth);
        if (node.type === 'Break') loop.breaks.push(this.emitJump(Op.JUMP));
        else this.emit(Op.JUMP, loop.continueTarget);
        this.fs.depth = depth;
        break;
      }

      case 'ExprStmt':
        this.compileExpr(node.expr);
        this.emit(Op.POP);
        break;

      default:
        this.compileExpr(node);
        this.emit(Op.POP);
    }
    this.span = saved;
  }

  compileFunction(node, inferredName = null) {
    const fs = new FnState(this.fs, node.name ?? inferredName, 'function', this.source);
    this.fs = fs;
    fs.proto.arity = node.params.length;
    this.beginScope();
    const seen = new Set();
    node.params.forEach((p, i) => {
      if (seen.has(p.name)) this.error(`duplicate parameter '${p.name}'`, p.span);
      seen.add(p.name);
      this.addLocal(p.name, i + 1);
    });
    fs.depth = 1 + node.params.length;

    if (node.body.type === 'Block') {
      this.span = node.body.span;
      this.compileItems(node.body.stmts, node.body.tail);
    } else {
      this.compileExpr(node.body);
    }
    this.emit(Op.RETURN);

    this.fs = fs.enclosing;
    this.span = node.span;
    const captures = fs.upvalues.flatMap((u) => [u.isLocal ? 1 : 0, u.index]);
    this.emit(Op.CLOSURE, this.constant(fs.proto), ...captures);
  }

  // -- expressions -------------------------------------------------------------

  compileExpr(node) {
    const saved = this.span;
    this.span = node.span;
    this.compileExprInner(node);
    this.span = saved;
  }

  compileExprInner(node) {
    switch (node.type) {
      case 'Number':
      case 'String':
      case 'Bool':
        return this.emitValue(node.value);
      case 'Nil':
        return this.emit(Op.NIL);

      case 'Template': {
        for (const part of node.parts) this.compileExpr(part);
        this.emit(Op.INTERP, node.parts.length);
        return this.adjust(1 - node.parts.length);
      }

      case 'Ident':
        return this.emitGet(this.resolve(node.name));

      case 'Assign':
        return this.compileAssign(node);

      case 'Unary': {
        const folded = this.fold(node);
        if (folded) return this.emitValue(folded.value);
        this.compileExpr(node.operand);
        return this.emit(node.op === '-' ? Op.NEG : Op.NOT);
      }

      case 'Binary': {
        const folded = this.fold(node);
        if (folded) return this.emitValue(folded.value);
        this.compileExpr(node.left);
        this.compileExpr(node.right);
        this.span = node.opSpan ?? node.span;
        return this.emit(BINARY_OPS[node.op]);
      }

      case 'Logical': {
        this.compileExpr(node.left);
        const end = this.emitJump(node.op === 'and' ? Op.JUMP_IF_FALSE : Op.JUMP_IF_TRUE);
        this.emit(Op.POP);
        this.compileExpr(node.right);
        return this.patch(end);
      }

      case 'Range':
        this.compileExpr(node.start);
        this.compileExpr(node.end);
        this.span = node.opSpan ?? node.span;
        return this.emit(Op.RANGE, node.inclusive ? 1 : 0);

      case 'List':
        for (const item of node.items) this.compileExpr(item);
        this.emit(Op.LIST, node.items.length);
        return this.adjust(1 - node.items.length);

      case 'Map':
        for (const { key, value } of node.entries) {
          this.emitValue(key);
          this.compileExpr(value);
        }
        this.emit(Op.MAP, node.entries.length);
        return this.adjust(1 - 2 * node.entries.length);

      case 'Call':
        this.compileExpr(node.callee);
        for (const arg of node.args) this.compileExpr(arg);
        this.span = node.span;
        this.emit(Op.CALL, node.args.length);
        return this.adjust(-node.args.length);

      case 'Method':
        this.compileExpr(node.object);
        for (const arg of node.args) this.compileExpr(arg);
        this.span = node.nameSpan ?? node.span;
        this.emit(Op.INVOKE, this.constant(node.name), node.args.length);
        return this.adjust(-node.args.length);

      case 'Index':
        this.compileExpr(node.object);
        this.compileExpr(node.index);
        this.span = node.span;
        return this.emit(Op.INDEX_GET);

      case 'Field':
        this.compileExpr(node.object);
        this.span = node.span;
        return this.emit(Op.FIELD_GET, this.constant(node.name));

      case 'Function':
        return this.compileFunction(node);

      case 'Block':
        this.beginScope();
        this.compileItems(node.stmts, node.tail);
        return this.endScope(true);

      case 'If':
        return this.compileIf(node);
      case 'While':
        return this.compileWhile(node);
      case 'For':
        return this.compileFor(node);
      case 'Match':
        return this.compileMatch(node);
    }
    throw new Error(`compiler: unhandled node type ${node.type}`);
  }

  compileAssign(node) {
    const { target, value } = node;
    const binop = COMPOUND_OPS[node.op] ?? null;

    if (target.type === 'Ident') {
      const ref = this.resolve(target.name);
      if (binop !== null) {
        this.emitGet(ref);
        this.compileExpr(value);
        this.span = node.opSpan;
        this.emit(binop);
      } else {
        this.compileExpr(value);
      }
      this.span = target.span;
      return this.emitSet(ref);
    }

    if (target.type === 'Index') {
      this.compileExpr(target.object);
      this.compileExpr(target.index);
      if (binop !== null) {
        this.emit(Op.DUP2);
        this.span = target.span;
        this.emit(Op.INDEX_GET);
        this.compileExpr(value);
        this.span = node.opSpan;
        this.emit(binop);
      } else {
        this.compileExpr(value);
      }
      this.span = target.span;
      return this.emit(Op.INDEX_SET);
    }

    if (target.type === 'Field') {
      const name = this.constant(target.name);
      this.compileExpr(target.object);
      if (binop !== null) {
        this.emit(Op.DUP);
        this.span = target.span;
        this.emit(Op.FIELD_GET, name);
        this.compileExpr(value);
        this.span = node.opSpan;
        this.emit(binop);
      } else {
        this.compileExpr(value);
      }
      this.span = target.span;
      return this.emit(Op.FIELD_SET, name);
    }

    // The parser already reported this; keep the stack balanced.
    this.compileExpr(value);
  }

  compileIf(node) {
    this.compileExpr(node.cond);
    const elseJump = this.emitJump(Op.POP_JUMP_IF_FALSE);
    const depth = this.fs.depth;
    this.compileExpr(node.then);
    const endJump = this.emitJump(Op.JUMP);
    this.patch(elseJump);
    this.fs.depth = depth;
    if (node.otherwise) this.compileExpr(node.otherwise);
    else this.emit(Op.NIL);
    this.patch(endJump);
  }

  compileWhile(node) {
    const start = this.here();
    const depth = this.fs.depth;
    this.compileExpr(node.cond);
    const exit = this.emitJump(Op.POP_JUMP_IF_FALSE);
    const loop = { depth, breaks: [], continueTarget: start };
    this.fs.loops.push(loop);
    this.compileExpr(node.body);
    this.emit(Op.POP);
    this.emit(Op.JUMP, start);
    this.fs.loops.pop();
    this.patch(exit);
    for (const b of loop.breaks) this.patch(b);
    this.fs.depth = depth;
    this.emit(Op.NIL);
  }

  // The iterator lives in a hidden local. Each pass pushes fresh loop
  // variables and pops them again (closing any captured ones), so closures
  // made in different iterations see different variables.
  compileFor(node) {
    this.beginScope();
    this.compileExpr(node.iter);
    this.span = node.iter.span;
    this.emit(Op.ITER_PREP);
    this.addLocal('(iter)', this.fs.depth - 1);

    const start = this.here();
    const iterDepth = this.fs.depth;
    const nvars = node.vars.length;
    const exit = this.emit(Op.ITER_NEXT, -1, nvars) + 1;
    this.adjust(nvars);

    this.beginScope();
    node.vars.forEach((v, i) => this.addLocal(v.name, iterDepth + i));
    const loop = { depth: iterDepth, breaks: [], continueTarget: start };
    this.fs.loops.push(loop);
    this.compileExpr(node.body);
    this.emit(Op.POP);
    this.fs.loops.pop();
    this.endScope(false);
    this.emit(Op.JUMP, start);

    this.patch(exit);
    for (const b of loop.breaks) this.patch(b);
    this.fs.depth = iterDepth;
    this.emit(Op.NIL);
    this.endScope(true);
  }

  compileMatch(node) {
    this.beginScope();
    this.compileExpr(node.subject);
    const subject = this.fs.depth - 1;
    this.addLocal('(match)', subject);
    const base = this.fs.depth;
    const ends = [];

    for (const arm of node.arms) {
      this.span = arm.pattern.span;
      let next = null;
      if (!isIrrefutable(arm.pattern)) {
        this.compilePatternTest(arm.pattern, subject);
        next = this.emitJump(Op.POP_JUMP_IF_FALSE);
      }

      this.beginScope();
      if (arm.pattern.type === 'BindPattern') {
        this.emit(Op.GET_LOCAL, subject);
        this.addLocal(arm.pattern.name, this.fs.depth - 1);
      }
      let guardFail = null;
      if (arm.guard) {
        this.compileExpr(arm.guard);
        guardFail = this.emitJump(Op.POP_JUMP_IF_FALSE);
      }
      const armDepth = this.fs.depth;
      this.compileExpr(arm.body);
      this.endScope(true);
      ends.push(this.emitJump(Op.JUMP));

      if (guardFail !== null) {
        this.patch(guardFail);
        this.fs.depth = armDepth;
        this.popN(armDepth - base);
      }
      if (next !== null) this.patch(next);
      this.fs.depth = base;
    }

    // No arm matched.
    this.emit(Op.NIL);
    for (const e of ends) this.patch(e);
    this.endScope(true);
  }

  compilePatternTest(p, subject) {
    switch (p.type) {
      case 'WildcardPattern':
      case 'BindPattern':
        return this.emit(Op.TRUE);
      case 'LiteralPattern':
        this.emit(Op.GET_LOCAL, subject);
        this.emitValue(p.value);
        return this.emit(Op.EQ);
      case 'RangePattern':
        this.emit(Op.GET_LOCAL, subject);
        this.emitValue(p.lo);
        this.emitValue(p.hi);
        this.emit(Op.RANGE, p.inclusive ? 1 : 0);
        return this.emit(Op.IN);
      case 'OrPattern': {
        const ends = [];
        p.alternatives.forEach((alt, i) => {
          this.compilePatternTest(alt, subject);
          if (i < p.alternatives.length - 1) {
            ends.push(this.emitJump(Op.JUMP_IF_TRUE));
            this.emit(Op.POP);
          }
        });
        for (const e of ends) this.patch(e);
      }
    }
  }

  // -- constant folding --------------------------------------------------------

  /** Returns `{ value }` if `node` is a compile-time constant, else null. */
  fold(node) {
    switch (node.type) {
      case 'Number':
      case 'String':
      case 'Bool':
        return { value: node.value };
      case 'Nil':
        return { value: null };
      case 'Unary': {
        const v = this.fold(node.operand);
        if (!v) return null;
        if (node.op === '-') return typeof v.value === 'number' ? { value: -v.value } : null;
        return { value: v.value === null || v.value === false };
      }
      case 'Binary': {
        const l = this.fold(node.left);
        const r = l && this.fold(node.right);
        return r ? foldBinary(node.op, l.value, r.value) : null;
      }
    }
    return null;
  }
}

function foldBinary(op, a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    switch (op) {
      case '+': return { value: a + b };
      case '-': return { value: a - b };
      case '*': return { value: a * b };
      // Leave division by zero to the VM so it reports a proper error.
      case '/': return b === 0 ? null : { value: a / b };
      case '%': return b === 0 ? null : { value: floorMod(a, b) };
      case '**': return { value: a ** b };
      case '<': return { value: a < b };
      case '<=': return { value: a <= b };
      case '>': return { value: a > b };
      case '>=': return { value: a >= b };
      case '==': return { value: a === b };
      case '!=': return { value: a !== b };
    }
  }
  if (typeof a === 'string' && typeof b === 'string' && op === '+') return { value: a + b };
  return null;
}
