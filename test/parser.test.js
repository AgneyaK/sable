import { describe, test, assert, evaluate, compileError } from './harness.js';
import { parse, CompileError } from '../src/index.js';

describe('parser', () => {
  test('arithmetic precedence', () => {
    assert.equal(evaluate('1 + 2 * 3 - 4 / 2'), 5);
    assert.equal(evaluate('(1 + 2) * 3'), 9);
  });

  test('power is right associative and binds tighter than unary minus', () => {
    assert.equal(evaluate('2 ** 3 ** 2'), 512);
    assert.equal(evaluate('-2 ** 2'), -4);
  });

  test('not binds looser than comparison', () => {
    assert.equal(evaluate('not 1 == 2'), true);
    assert.equal(evaluate('not false and false'), false);
  });

  test('pipes insert the left side as the first argument', () => {
    const ast = parse('x |> f(1, 2)');
    const call = ast.tail;
    assert.equal(call.type, 'Call');
    assert.equal(call.args.map((a) => a.type), ['Ident', 'Number', 'Number']);
  });

  test('a braced key: value is a map, anything else is a block', () => {
    assert.equal(parse('{ a: 1 }').tail.type, 'Map');
    assert.equal(parse('let x = { 1 };').body[0].init.type, 'Block');
    assert.equal(parse('let x = {};').body[0].init.type, 'Map');
  });

  test('block-like statements need no semicolon', () => {
    assert.equal(evaluate('let x = 0; if true { x = 1 } while false {} x'), 1);
  });

  test('missing semicolon is reported after the previous token', () => {
    const err = compileError('let a = 1\nlet b = 2;', /expected ';' after let statement/);
    assert.equal([err.span.line, err.span.col], [1, 10]);
  });

  test('recovers to report several errors at once', () => {
    const err = compileError('let = 1;\nlet y = ;\nprint(1)');
    assert.ok(err.diagnostics.length >= 2, `got ${err.diagnostics.length} diagnostics`);
  });

  test('rejects invalid assignment targets', () => {
    compileError('1 = 2;', /invalid assignment target/);
  });

  test('reports errors inside string interpolation at the right spot', () => {
    const err = compileError('let s = "value: {1 +}";');
    assert.ok(err instanceof CompileError);
    assert.equal(err.span.line, 1);
    assert.ok(err.span.col > 9, 'points inside the string');
  });

  test('cannot bind names inside | patterns', () => {
    compileError('match 1 { a | 2 => 1 }', /cannot bind/);
  });
});
