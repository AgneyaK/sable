import { describe, test, assert } from './harness.js';
import { tokenize, needsMoreInput } from '../src/index.js';

const types = (src) => tokenize(src).tokens.map((t) => t.type);
const values = (src) => tokenize(src).tokens.filter((t) => t.type !== 'eof').map((t) => t.value);

describe('lexer', () => {
  test('numbers in every notation', () => {
    assert.equal(values('42 3.14 1_000_000 0xff 1e3 2.5e-2'), [42, 3.14, 1000000, 255, 1000, 0.025]);
  });

  test('a dot after a number starts a range, not a fraction', () => {
    assert.equal(types('1..5'), ['number', '..', 'number', 'eof']);
    assert.equal(types('0..=9'), ['number', '..=', 'number', 'eof']);
  });

  test('longest punctuation match wins', () => {
    assert.equal(types('a |> b ** c += d => e'), ['ident', '|>', 'ident', '**', 'ident', '+=', 'ident', '=>', 'ident', 'eof']);
  });

  test('keywords and identifiers', () => {
    assert.equal(types('let fn_name = not nil'), ['let', 'ident', '=', 'not', 'nil', 'eof']);
  });

  test('escape sequences', () => {
    assert.equal(values('"a\\nb\\t\\"q\\" \\{x\\} \\u{1F600}"'), ['a\nb\t"q" {x} 😀']);
  });

  test('interpolated strings become template tokens', () => {
    const [t] = tokenize('"hi {name}!"').tokens;
    assert.equal(t.type, 'template');
    assert.equal(t.parts.map((p) => p.kind), ['str', 'expr', 'str']);
  });

  test('interpolation can contain strings and braces', () => {
    const [t] = tokenize('"{m["k"]} and {f({a: 1})}"').tokens;
    assert.equal(t.parts.filter((p) => p.kind === 'expr').length, 2);
  });

  test('line and block comments, which nest', () => {
    assert.equal(types('1 // one\n/* a /* nested */ comment */ 2'), ['number', 'number', 'eof']);
  });

  test('tracks line and column', () => {
    const t = tokenize('let\n  x').tokens[1];
    assert.equal([t.line, t.col], [2, 3]);
  });

  test('reports unterminated strings', () => {
    const { errors } = tokenize('"oops');
    assert.match(errors[0].message, /unterminated string/);
  });

  test('suggests `not` for `!`', () => {
    const { errors } = tokenize('!x');
    assert.match(errors[0].hint, /not/);
  });

  test('needsMoreInput detects unfinished code', () => {
    assert.ok(needsMoreInput('fn f() {'));
    assert.ok(needsMoreInput('let s = "abc'));
    assert.ok(!needsMoreInput('let x = [1, 2];'));
  });
});
