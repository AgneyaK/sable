// Recursive-descent parser producing a plain-object AST.
//
// Precedence, loosest to tightest:
//
//   =  += -= ...      (right associative)
//   |>                pipe
//   or
//   and
//   not               (prefix)
//   == !=
//   < <= > >= in
//   .. ..=            (non-associative)
//   + -
//   * / %
//   -                 (prefix)
//   **                (right associative)
//   call, index, field, method
//
// The parser recovers from errors at statement boundaries so one typo
// doesn't hide every other problem in the file.

import { tokenize } from './lexer.js';
import { CompileError } from './errors.js';

class ParseFail extends Error {}

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);
// Expressions that end in a block don't need a `;` when used as statements.
const BLOCK_LIKE = new Set(['if', 'while', 'for', 'match']);
const SYNC_POINTS = new Set(['let', 'fn', 'return', 'if', 'while', 'for', 'match']);
const MAX_ERRORS = 25;

export function parse(source) {
  const parser = new Parser(source);
  const program = parser.parseProgram();
  if (parser.errors.length) throw new CompileError(parser.errors);
  return program;
}

const spanOf = (from, to = from) => ({ start: from.start, end: to.end, line: from.line, col: from.col });

function describe(t) {
  switch (t.type) {
    case 'eof': return 'end of input';
    case 'ident': return `'${t.value}'`;
    case 'number': return `number ${t.text}`;
    case 'string':
    case 'template': return 'a string';
    default: return `'${t.type}'`;
  }
}

class Parser {
  constructor(source, range) {
    this.source = source;
    const { tokens, errors } = tokenize(source, range);
    this.tokens = tokens;
    this.errors = [...errors];
    this.i = 0;
    this.blockDepth = 0;
  }

  // -- token helpers ---------------------------------------------------------

  peek(offset = 0) {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)];
  }

  get prev() {
    return this.tokens[Math.max(0, this.i - 1)];
  }

  check(type) {
    return this.peek().type === type;
  }

  advance() {
    const t = this.peek();
    if (t.type !== 'eof') this.i++;
    return t;
  }

  match(...types) {
    return types.includes(this.peek().type) ? this.advance() : null;
  }

  expect(type, message) {
    if (this.check(type)) return this.advance();
    this.fail(this.peek(), `${message}, found ${describe(this.peek())}`);
  }

  report(spanLike, message, hint = null) {
    this.errors.push({ message, span: spanOf(spanLike), hint });
  }

  fail(spanLike, message, hint = null) {
    this.report(spanLike, message, hint);
    throw new ParseFail();
  }

  // Missing semicolons are reported just after the previous token, which is
  // where the user needs to type one.
  expectSemicolon(what) {
    if (this.match(';')) return;
    const p = this.prev;
    const at = { start: p.end, end: p.end + 1, line: p.line, col: p.col + (p.end - p.start) };
    if (p.text && p.text.includes('\n')) at.col = p.col;
    this.fail(at, `expected ';' after ${what}`);
  }

  synchronize() {
    // Leave a closing brace for the enclosing block to consume.
    if (!(this.blockDepth > 0 && this.check('}'))) this.advance();
    while (!this.check('eof')) {
      if (this.prev.type === ';') return;
      if (SYNC_POINTS.has(this.peek().type) || this.check('}')) return;
      this.advance();
    }
  }

  // -- statements --------------------------------------------------------------

  parseProgram() {
    const first = this.peek();
    const { stmts, tail } = this.parseItems('eof');
    return { type: 'Program', body: stmts, tail, span: spanOf(first, this.peek()) };
  }

  /** Statements up to `end`; a trailing expression without `;` is the value. */
  parseItems(end) {
    const stmts = [];
    let tail = null;
    while (!this.check(end) && !this.check('eof')) {
      if (this.errors.length >= MAX_ERRORS) break;
      if (this.match(';')) continue;
      try {
        const item = this.parseItem(end);
        if (item.tail) tail = item.node;
        else stmts.push(item.node);
      } catch (e) {
        if (!(e instanceof ParseFail)) throw e;
        this.synchronize();
      }
    }
    return { stmts, tail };
  }

  parseItem(end) {
    const t = this.peek();
    switch (t.type) {
      case 'let':
        return { node: this.parseLet() };
      case 'fn':
        if (this.peek(1).type === 'ident') return { node: this.parseFnDecl() };
        break;
      case 'return':
      case 'break':
      case 'continue':
        return { node: this.parseJump(end) };
    }

    let expr;
    let blockLike = BLOCK_LIKE.has(t.type);
    if (t.type === '{' && !this.looksLikeMap()) {
      expr = this.parseBlock();
      blockLike = true;
    } else if (blockLike) {
      expr = this.parsePrimary();
    } else {
      expr = this.parseExpression();
    }

    if (this.match(';')) return { node: { type: 'ExprStmt', expr, span: expr.span } };
    if (this.check(end)) return { node: expr, tail: true };
    if (blockLike) return { node: { type: 'ExprStmt', expr, span: expr.span } };
    this.expectSemicolon('expression');
  }

  parseLet() {
    const kw = this.advance();
    const name = this.expect('ident', "expected a variable name after 'let'");
    let init = null;
    if (this.match('=')) init = this.parseExpression();
    else if (ASSIGN_OPS.has(this.peek().type)) {
      this.fail(this.peek(), `unexpected '${this.peek().type}' in let statement`, "use '=' to initialise a variable");
    }
    this.expectSemicolon('let statement');
    return { type: 'Let', name: name.value, init, span: spanOf(kw, name) };
  }

  parseFnDecl() {
    const kw = this.advance();
    const name = this.advance();
    const params = this.parseParams();
    const body = this.parseBlock("expected '{' before function body");
    return { type: 'Function', name: name.value, params, body, declaration: true, span: spanOf(kw, name) };
  }

  parseParams() {
    this.expect('(', "expected '(' before parameter list");
    const params = [];
    while (!this.check(')')) {
      const p = this.expect('ident', 'expected a parameter name');
      params.push({ name: p.value, span: spanOf(p) });
      if (!this.match(',')) break;
    }
    this.expect(')', "expected ')' after parameters");
    return params;
  }

  // return / break / continue
  parseJump(end) {
    const kw = this.advance();
    let value = null;
    if (kw.type === 'return' && !this.check(';') && !this.check('}') && !this.check(end)) {
      value = this.parseExpression();
    }
    if (!this.check('}') && !this.check(end)) this.expectSemicolon(`'${kw.type}'`);
    else this.match(';');
    const type = { return: 'Return', break: 'Break', continue: 'Continue' }[kw.type];
    return { type, value, span: spanOf(kw) };
  }

  parseBlock(message = "expected '{'") {
    const open = this.expect('{', message);
    this.blockDepth++;
    try {
      const { stmts, tail } = this.parseItems('}');
      const close = this.expect('}', "expected '}' to close block");
      return { type: 'Block', stmts, tail, span: spanOf(open, close) };
    } finally {
      this.blockDepth--;
    }
  }

  // -- expressions -------------------------------------------------------------

  parseExpression() {
    return this.parseAssignment();
  }

  parseAssignment() {
    const target = this.parsePipe();
    const t = this.peek();
    if (!ASSIGN_OPS.has(t.type)) return target;
    this.advance();
    if (!['Ident', 'Index', 'Field'].includes(target.type)) {
      this.report(t, 'invalid assignment target', 'only variables, indexes and fields can be assigned to');
    }
    const value = this.parseAssignment();
    return { type: 'Assign', op: t.type, target, value, span: join(target.span, value.span), opSpan: spanOf(t) };
  }

  // `x |> f(a)` means `f(x, a)`; `x |> f` means `f(x)`.
  parsePipe() {
    let left = this.parseOr();
    while (this.check('|>')) {
      const op = this.advance();
      const right = this.parseOr();
      const span = join(left.span, right.span);
      if (right.type === 'Call' || right.type === 'Method') {
        left = { ...right, args: [left, ...right.args], span };
      } else {
        left = { type: 'Call', callee: right, args: [left], span, opSpan: spanOf(op) };
      }
    }
    return left;
  }

  parseOr() {
    return this.binary(() => this.parseAnd(), ['or'], 'Logical');
  }

  parseAnd() {
    return this.binary(() => this.parseNot(), ['and'], 'Logical');
  }

  parseNot() {
    if (this.check('not')) {
      const op = this.advance();
      const operand = this.parseNot();
      return { type: 'Unary', op: 'not', operand, span: join(spanOf(op), operand.span) };
    }
    return this.parseEquality();
  }

  parseEquality() {
    return this.binary(() => this.parseComparison(), ['==', '!=']);
  }

  parseComparison() {
    return this.binary(() => this.parseRange(), ['<', '<=', '>', '>=', 'in']);
  }

  parseRange() {
    const start = this.parseTerm();
    if (!this.check('..') && !this.check('..=')) return start;
    const op = this.advance();
    const end = this.parseTerm();
    return { type: 'Range', start, end, inclusive: op.type === '..=', span: join(start.span, end.span), opSpan: spanOf(op) };
  }

  parseTerm() {
    return this.binary(() => this.parseFactor(), ['+', '-']);
  }

  parseFactor() {
    return this.binary(() => this.parseUnary(), ['*', '/', '%']);
  }

  parseUnary() {
    if (this.check('-')) {
      const op = this.advance();
      const operand = this.parseUnary();
      return { type: 'Unary', op: '-', operand, span: join(spanOf(op), operand.span) };
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePostfix();
    if (!this.check('**')) return base;
    const op = this.advance();
    const exponent = this.parseUnary();
    return { type: 'Binary', op: '**', left: base, right: exponent, span: join(base.span, exponent.span), opSpan: spanOf(op) };
  }

  binary(next, ops, type = 'Binary') {
    let left = next();
    while (ops.includes(this.peek().type)) {
      const op = this.advance();
      const right = next();
      left = { type, op: op.type, left, right, span: join(left.span, right.span), opSpan: spanOf(op) };
    }
    return left;
  }

  parsePostfix() {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.match('(')) {
        const args = this.parseArgs();
        expr = { type: 'Call', callee: expr, args, span: join(expr.span, spanOf(this.prev)) };
      } else if (this.match('[')) {
        const index = this.parseExpression();
        const close = this.expect(']', "expected ']' after index");
        expr = { type: 'Index', object: expr, index, span: join(expr.span, spanOf(close)) };
      } else if (this.match('.')) {
        const name = this.expect('ident', "expected a field or method name after '.'");
        if (this.match('(')) {
          const args = this.parseArgs();
          expr = { type: 'Method', object: expr, name: name.value, args, span: join(expr.span, spanOf(this.prev)), nameSpan: spanOf(name) };
        } else {
          expr = { type: 'Field', object: expr, name: name.value, span: join(expr.span, spanOf(name)) };
        }
      } else {
        return expr;
      }
    }
  }

  parseArgs() {
    const args = [];
    while (!this.check(')')) {
      args.push(this.parseExpression());
      if (!this.match(',')) break;
    }
    this.expect(')', "expected ')' after arguments");
    return args;
  }

  parsePrimary() {
    const t = this.peek();
    switch (t.type) {
      case 'number':
        this.advance();
        return { type: 'Number', value: t.value, span: spanOf(t) };
      case 'string':
        this.advance();
        return { type: 'String', value: t.value, span: spanOf(t) };
      case 'template':
        this.advance();
        return this.parseTemplate(t);
      case 'true':
      case 'false':
        this.advance();
        return { type: 'Bool', value: t.type === 'true', span: spanOf(t) };
      case 'nil':
        this.advance();
        return { type: 'Nil', span: spanOf(t) };
      case 'ident':
        this.advance();
        return { type: 'Ident', name: t.value, span: spanOf(t) };
      case '(': {
        this.advance();
        const expr = this.parseExpression();
        this.expect(')', "expected ')'");
        return expr;
      }
      case '[':
        return this.parseList();
      case '{':
        return this.looksLikeMap() ? this.parseMap() : this.parseBlock();
      case 'if':
        return this.parseIf();
      case 'while':
        return this.parseWhile();
      case 'for':
        return this.parseFor();
      case 'match':
        return this.parseMatch();
      case 'fn':
        return this.parseFnExpr();
      case '|':
        return this.parseLambda();
    }
    this.fail(t, `expected an expression, found ${describe(t)}`);
  }

  parseTemplate(token) {
    const parts = token.parts.map((part) => {
      if (part.kind === 'str') return { type: 'String', value: part.value, span: spanOf(token) };
      const sub = new Parser(this.source, part);
      try {
        const expr = sub.parseExpression();
        if (!sub.check('eof')) sub.report(sub.peek(), `unexpected ${describe(sub.peek())} in string interpolation`);
        return expr;
      } catch (e) {
        if (!(e instanceof ParseFail)) throw e;
        return { type: 'Nil', span: spanOf(token) };
      } finally {
        this.errors.push(...sub.errors);
      }
    });
    return { type: 'Template', parts, span: spanOf(token) };
  }

  parseList() {
    const open = this.advance();
    const items = [];
    while (!this.check(']')) {
      items.push(this.parseExpression());
      if (!this.match(',')) break;
    }
    const close = this.expect(']', "expected ']' to close list");
    return { type: 'List', items, span: spanOf(open, close) };
  }

  // `{}` and `{ key: ...` are maps; anything else starting with `{` is a block.
  looksLikeMap() {
    const next = this.peek(1);
    if (next.type === '}') return true;
    return ['ident', 'string', 'number'].includes(next.type) && this.peek(2).type === ':';
  }

  parseMap() {
    const open = this.advance();
    const entries = [];
    while (!this.check('}')) {
      const k = this.peek();
      if (k.type !== 'ident' && k.type !== 'string' && k.type !== 'number') {
        this.fail(k, `expected a map key (a name, string or number), found ${describe(k)}`);
      }
      this.advance();
      this.expect(':', "expected ':' after map key");
      entries.push({ key: k.value, value: this.parseExpression() });
      if (!this.match(',')) break;
    }
    const close = this.expect('}', "expected '}' to close map");
    return { type: 'Map', entries, span: spanOf(open, close) };
  }

  parseIf() {
    const kw = this.advance();
    const cond = this.parseExpression();
    const then = this.parseBlock("expected '{' after if condition");
    let otherwise = null;
    if (this.match('else')) {
      otherwise = this.check('if') ? this.parseIf() : this.parseBlock("expected '{' or 'if' after 'else'");
    }
    return { type: 'If', cond, then, otherwise, span: spanOf(kw, this.prev) };
  }

  parseWhile() {
    const kw = this.advance();
    const cond = this.parseExpression();
    const body = this.parseBlock("expected '{' after while condition");
    return { type: 'While', cond, body, span: spanOf(kw) };
  }

  parseFor() {
    const kw = this.advance();
    const vars = [];
    const first = this.expect('ident', "expected a loop variable after 'for'");
    vars.push({ name: first.value, span: spanOf(first) });
    if (this.match(',')) {
      const second = this.expect('ident', "expected a second loop variable after ','");
      vars.push({ name: second.value, span: spanOf(second) });
    }
    this.expect('in', "expected 'in' after loop variable");
    const iter = this.parseExpression();
    const body = this.parseBlock("expected '{' after for loop header");
    return { type: 'For', vars, iter, body, span: spanOf(kw, this.prev) };
  }

  parseMatch() {
    const kw = this.advance();
    const subject = this.parseExpression();
    this.expect('{', "expected '{' after match subject");
    const arms = [];
    while (!this.check('}') && !this.check('eof')) {
      const pattern = this.parsePattern();
      let guard = null;
      if (this.match('if')) guard = this.parseExpression();
      this.expect('=>', "expected '=>' after match pattern");
      // A braced arm body ends at its closing brace.
      const body = this.check('{') ? this.parsePrimary() : this.parseExpression();
      arms.push({ pattern, guard, body });
      if (this.match(',')) continue;
      if (body.type !== 'Block' && !this.check('}')) {
        this.fail(this.peek(), `expected ',' between match arms, found ${describe(this.peek())}`);
      }
    }
    const close = this.expect('}', "expected '}' to close match");
    return { type: 'Match', subject, arms, span: spanOf(kw, close) };
  }

  parsePattern() {
    const first = this.parsePatternAtom();
    if (!this.check('|')) return first;
    const alternatives = [first];
    while (this.match('|')) alternatives.push(this.parsePatternAtom());
    for (const alt of alternatives) {
      if (alt.type === 'BindPattern') this.report(alt.span, `cannot bind '${alt.name}' inside a '|' pattern`);
    }
    return { type: 'OrPattern', alternatives, span: join(first.span, alternatives.at(-1).span) };
  }

  parsePatternAtom() {
    const t = this.peek();
    if (t.type === 'ident') {
      this.advance();
      if (t.value === '_') return { type: 'WildcardPattern', span: spanOf(t) };
      return { type: 'BindPattern', name: t.value, span: spanOf(t) };
    }
    const lo = this.parsePatternLiteral();
    if (typeof lo.value === 'number' && (this.check('..') || this.check('..='))) {
      const op = this.advance();
      const hi = this.parsePatternLiteral();
      if (typeof hi.value !== 'number') this.report(hi.span, 'range patterns need numeric bounds');
      return { type: 'RangePattern', lo: lo.value, hi: hi.value, inclusive: op.type === '..=', span: join(lo.span, hi.span) };
    }
    return { type: 'LiteralPattern', value: lo.value, span: lo.span };
  }

  parsePatternLiteral() {
    const t = this.peek();
    if (t.type === '-' && this.peek(1).type === 'number') {
      this.advance();
      const n = this.advance();
      return { value: -n.value, span: spanOf(t, n) };
    }
    switch (t.type) {
      case 'number':
      case 'string':
        this.advance();
        return { value: t.value, span: spanOf(t) };
      case 'true':
      case 'false':
        this.advance();
        return { value: t.type === 'true', span: spanOf(t) };
      case 'nil':
        this.advance();
        return { value: null, span: spanOf(t) };
      case 'template':
        this.fail(t, 'string patterns cannot contain interpolation');
    }
    this.fail(t, `expected a pattern, found ${describe(t)}`);
  }

  parseFnExpr() {
    const kw = this.advance();
    const name = this.match('ident');
    const params = this.parseParams();
    const body = this.parseBlock("expected '{' before function body");
    return { type: 'Function', name: name ? name.value : null, params, body, span: spanOf(kw, this.prev) };
  }

  // |a, b| a + b    and    || 42
  parseLambda() {
    const open = this.advance();
    const params = [];
    while (!this.check('|')) {
      const p = this.expect('ident', 'expected a parameter name');
      params.push({ name: p.value, span: spanOf(p) });
      if (!this.match(',')) break;
    }
    this.expect('|', "expected '|' after lambda parameters");
    const body = this.parseExpression();
    return { type: 'Function', name: null, params, body, span: join(spanOf(open), body.span) };
  }
}

function join(a, b) {
  return { start: a.start, end: Math.max(a.end, b.end), line: a.line, col: a.col };
}
