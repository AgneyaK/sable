// Turns source text into a flat list of tokens.
//
// String interpolation is resolved here only as far as finding the
// boundaries of each `{expr}` hole; the parser re-lexes those ranges of the
// original source, so every span still points into the user's file.

export const KEYWORDS = new Set([
  'let', 'fn', 'return', 'if', 'else', 'while', 'for', 'in', 'break',
  'continue', 'true', 'false', 'nil', 'and', 'or', 'not', 'match',
]);

// Longest first, so `..=` wins over `..` and `|>` over `|`.
const PUNCTUATION = [
  '..=',
  '**', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '|>', '=>', '..',
  '+', '-', '*', '/', '%', '=', '<', '>', '(', ')', '[', ']', '{', '}', ',', '.', ':', ';', '|',
];

const isDigit = (c) => c >= '0' && c <= '9';
const isHex = (c) => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
const isIdentStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c) => isIdentStart(c) || isDigit(c);

/**
 * @param {string} source
 * @param {{ start?: number, end?: number, line?: number, col?: number }} [range]
 *   lex only part of `source`, with positions reported relative to the whole.
 */
export function tokenize(source, range) {
  const lexer = new Lexer(source, range);
  lexer.run();
  return { tokens: lexer.tokens, errors: lexer.errors };
}

class Lexer {
  constructor(src, { start = 0, end = src.length, line = 1, col = 1 } = {}) {
    this.src = src;
    this.pos = start;
    this.end = end;
    this.line = line;
    this.col = col;
    this.tokens = [];
    this.errors = [];
    if (this.src.charCodeAt(this.pos) === 0xfeff) this.pos++;
  }

  peek(offset = 0) {
    const p = this.pos + offset;
    return p < this.end ? this.src[p] : '\0';
  }

  advance() {
    const c = this.src[this.pos++];
    if (c === '\n') {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return c;
  }

  atEnd() {
    return this.pos >= this.end;
  }

  push(type, start, line, col, extra) {
    const token = { type, start, end: this.pos, line, col, text: this.src.slice(start, this.pos) };
    this.tokens.push(extra ? Object.assign(token, extra) : token);
  }

  error(message, start, line, col, hint = null) {
    const end = Math.max(this.pos, start + 1);
    this.errors.push({ message, span: { start, end, line, col }, hint });
  }

  run() {
    for (;;) {
      this.skipTrivia();
      if (this.atEnd()) break;
      this.scanToken();
    }
    this.push('eof', this.pos, this.line, this.col);
  }

  skipTrivia() {
    while (!this.atEnd()) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        this.advance();
      } else if (c === '/' && this.peek(1) === '/') {
        while (!this.atEnd() && this.peek() !== '\n') this.advance();
      } else if (c === '/' && this.peek(1) === '*') {
        this.blockComment();
      } else {
        break;
      }
    }
  }

  // Block comments nest, so commenting out code that has comments works.
  blockComment() {
    const start = this.pos, line = this.line, col = this.col;
    this.advance();
    this.advance();
    let depth = 1;
    while (!this.atEnd() && depth > 0) {
      if (this.peek() === '/' && this.peek(1) === '*') {
        this.advance();
        this.advance();
        depth++;
      } else if (this.peek() === '*' && this.peek(1) === '/') {
        this.advance();
        this.advance();
        depth--;
      } else {
        this.advance();
      }
    }
    if (depth > 0) {
      this.errors.push({ message: 'unterminated block comment', span: { start, end: start + 2, line, col } });
    }
  }

  scanToken() {
    const start = this.pos, line = this.line, col = this.col;
    const c = this.peek();

    if (isDigit(c)) return this.number(start, line, col);

    if (isIdentStart(c)) {
      while (isIdentPart(this.peek())) this.advance();
      const text = this.src.slice(start, this.pos);
      this.push(KEYWORDS.has(text) ? text : 'ident', start, line, col, { value: text });
      return;
    }

    if (c === '"') return this.string(start, line, col);

    for (const p of PUNCTUATION) {
      if (this.pos + p.length <= this.end && this.src.startsWith(p, this.pos)) {
        for (let i = 0; i < p.length; i++) this.advance();
        this.push(p, start, line, col);
        return;
      }
    }

    this.advance();
    const hints = {
      '!': "use 'not' for logical negation",
      '&': "use 'and' for logical and",
      "'": 'strings use double quotes',
    };
    this.error(`unexpected character '${c}'`, start, line, col, hints[c] ?? null);
  }

  number(start, line, col) {
    let value;
    if (this.peek() === '0' && (this.peek(1) === 'x' || this.peek(1) === 'X')) {
      this.advance();
      this.advance();
      while (isHex(this.peek()) || this.peek() === '_') this.advance();
      const digits = this.src.slice(start + 2, this.pos).replace(/_/g, '');
      if (!digits) this.error('hex literal needs at least one digit', start, line, col);
      value = parseInt(digits || '0', 16);
    } else {
      while (isDigit(this.peek()) || this.peek() === '_') this.advance();
      // `1..5` is a range, not the float `1.` followed by `.5`.
      if (this.peek() === '.' && isDigit(this.peek(1))) {
        this.advance();
        while (isDigit(this.peek()) || this.peek() === '_') this.advance();
      }
      const e = this.peek();
      const sign = this.peek(1);
      if ((e === 'e' || e === 'E') && (isDigit(sign) || ((sign === '+' || sign === '-') && isDigit(this.peek(2))))) {
        this.advance();
        if (sign === '+' || sign === '-') this.advance();
        while (isDigit(this.peek())) this.advance();
      }
      value = Number(this.src.slice(start, this.pos).replace(/_/g, ''));
    }

    if (isIdentStart(this.peek())) {
      while (isIdentPart(this.peek())) this.advance();
      this.error(`invalid number literal '${this.src.slice(start, this.pos)}'`, start, line, col);
    }
    this.push('number', start, line, col, { value });
  }

  string(start, line, col) {
    this.advance(); // opening quote
    const parts = [];
    let buf = '';
    let interpolated = false;

    for (;;) {
      if (this.atEnd()) {
        this.error('unterminated string', start, line, col, 'add a closing \'"\'');
        break;
      }
      const ch = this.advance();
      if (ch === '"') break;
      if (ch === '\\') {
        buf += this.escape();
        continue;
      }
      if (ch === '{') {
        interpolated = true;
        if (buf) parts.push({ kind: 'str', value: buf });
        buf = '';
        const exprStart = this.pos, exprLine = this.line, exprCol = this.col;
        if (!this.skipInterpolation()) {
          this.error('unterminated string interpolation', exprStart - 1, exprLine, exprCol - 1, "close it with '}'");
          break;
        }
        const exprEnd = this.pos - 1;
        if (this.src.slice(exprStart, exprEnd).trim() === '') {
          this.error('empty interpolation', exprStart - 1, exprLine, exprCol - 1, 'write \\{ for a literal brace');
        } else {
          parts.push({ kind: 'expr', start: exprStart, end: exprEnd, line: exprLine, col: exprCol });
        }
        continue;
      }
      buf += ch;
    }

    if (!interpolated) {
      this.push('string', start, line, col, { value: buf });
    } else {
      if (buf) parts.push({ kind: 'str', value: buf });
      this.push('template', start, line, col, { parts });
    }
  }

  escape() {
    const start = this.pos - 1, line = this.line, col = this.col - 1;
    if (this.atEnd()) return '';
    const e = this.advance();
    switch (e) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '0': return '\0';
      case '\\': return '\\';
      case '"': return '"';
      case '{': return '{';
      case '}': return '}';
      case 'u': {
        if (this.peek() !== '{') break;
        this.advance();
        let hex = '';
        while (isHex(this.peek())) hex += this.advance();
        if (this.peek() !== '}' || !hex || parseInt(hex, 16) > 0x10ffff) break;
        this.advance();
        return String.fromCodePoint(parseInt(hex, 16));
      }
    }
    this.error(`invalid escape sequence '\\${e}'`, start, line, col);
    return e;
  }

  // Skips to the `}` that closes an interpolation, stepping over nested
  // braces and string literals. Returns false on end of input.
  skipInterpolation() {
    let depth = 0;
    while (!this.atEnd()) {
      const ch = this.advance();
      if (ch === '{') depth++;
      else if (ch === '}') {
        if (depth === 0) return true;
        depth--;
      } else if (ch === '"' && !this.skipString()) return false;
    }
    return false;
  }

  skipString() {
    while (!this.atEnd()) {
      const ch = this.advance();
      if (ch === '\\') {
        if (!this.atEnd()) this.advance();
      } else if (ch === '"') return true;
      else if (ch === '{' && !this.skipInterpolation()) return false;
    }
    return false;
  }
}

/**
 * True when `source` looks unfinished: an open bracket, string or block
 * comment. The REPL uses this to decide whether to ask for another line.
 */
export function needsMoreInput(source) {
  const { tokens, errors } = tokenize(source);
  if (errors.some((e) => /^unterminated/.test(e.message))) return true;
  let depth = 0;
  for (const t of tokens) {
    if (t.type === '(' || t.type === '[' || t.type === '{') depth++;
    else if (t.type === ')' || t.type === ']' || t.type === '}') depth--;
  }
  return depth > 0;
}
