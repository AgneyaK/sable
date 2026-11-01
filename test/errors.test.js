import { describe, test, assert, evaluate, runtimeError, compileError } from './harness.js';
import { run, VM, compile, formatError, RuntimeError } from '../src/index.js';

describe('runtime errors', () => {
  test('type errors name the operand types', () => {
    runtimeError('1 + "a"', /cannot apply '\+' to number and string/);
    runtimeError('"a" < 1', /cannot compare string and number/);
    runtimeError('-"x"', /cannot negate a string/);
  });

  test('division by zero', () => {
    runtimeError('let z = 0; 1 / z', /division by zero/);
    runtimeError('1 % 0', /modulo by zero/);
  });

  test('index errors', () => {
    runtimeError('[1, 2][5]', /index 5 is out of bounds for a list of length 2/);
    runtimeError('[1][0.5]', /whole number/);
    runtimeError('"abc"[0] = "x"', /strings are immutable/);
  });

  test('wrong argument counts', () => {
    runtimeError('fn f(a, b) { a } f(1)', /function 'f' expects 2 arguments but got 1/);
    runtimeError('len(1, 2)', /len\(\) expects 1 argument but got 2/);
    runtimeError('[].push()', /list.push\(\) expects at least 1 argument/);
  });

  test('calling something that is not a function', () => {
    runtimeError('let x = 3; x()', /cannot call a value of type number/);
  });

  test('undefined variables suggest close matches', () => {
    const err = runtimeError('let count = 1; print(cuont);', /undefined variable 'cuont'/);
    assert.equal(err.hint, "did you mean 'count'?");
  });

  test('unknown methods suggest close matches', () => {
    const err = runtimeError('[1].pussh(2)', /list has no method 'pussh'/);
    assert.equal(err.hint, "did you mean 'push'?");
  });

  test('field access on a method name hints at calling it', () => {
    const err = runtimeError('[1].len', /no field 'len'/);
    assert.match(err.hint, /\.len\(\)/);
  });

  test('cannot iterate over a number', () => {
    const err = runtimeError('for i in 10 {}', /cannot iterate over a number/);
    assert.match(err.hint, /0\.\.10/);
  });

  test('errors carry the span of the failing expression', () => {
    const err = runtimeError('let a = 1;\nlet b = a + nil;');
    assert.equal([err.span.line, err.span.col], [2, 11]);
  });

  test('stack traces list every active function', () => {
    const err = runtimeError('fn inner() { error("deep") }\nfn outer() { inner() }\nouter();');
    assert.equal(err.trace.map((f) => f.name), ['inner', 'outer', '<script>']);
  });

  test('errors inside callbacks unwind through native code', () => {
    const err = runtimeError('fn bad(x) { x.nope() } [1, 2].map(bad)', /number has no method 'nope'/);
    assert.equal(err.trace[0].name, 'bad');
  });

  test('stack overflow is caught', () => {
    runtimeError('fn forever(n) { forever(n + 1) } forever(0)', /stack overflow/);
  });

  test('the VM is usable again after an error', () => {
    const vm = new VM({ print: () => {} });
    assert.throws(() => run('error("first")', { vm }), RuntimeError);
    assert.equal(run('1 + 1', { vm }), 2);
  });

  test('closures survive an error in the script that made them', () => {
    const vm = new VM({ print: () => {} });
    assert.throws(() => run('let get = { let secret = 41; || secret + 1 }; error("x")', { vm }));
    assert.equal(run('get()', { vm }), 42);
  });
});

describe('compile errors', () => {
  test('break outside a loop', () => {
    compileError('break;', /'break' outside of a loop/);
  });

  test('duplicate parameters', () => {
    compileError('fn f(a, a) { a }', /duplicate parameter 'a'/);
  });
});

describe('formatError', () => {
  test('renders a code frame with carets', () => {
    const source = 'let total = 0;\nlet x = total + "1";';
    let err;
    try {
      evaluate(source);
    } catch (e) {
      err = e;
    }
    const text = formatError(err, source, { filename: 'demo.sb' });
    assert.equal(text.split('\n').slice(0, 5).join('\n'), [
      "runtime error: cannot apply '+' to number and string",
      ' --> demo.sb:2:15',
      '  |',
      '2 | let x = total + "1";',
      '  |               ^',
    ].join('\n'));
    assert.match(text, /hint:/);
  });

  test('renders every compile diagnostic', () => {
    const source = 'let = 1;\nlet b = ;';
    let err;
    try {
      compile(source);
    } catch (e) {
      err = e;
    }
    const text = formatError(err, source);
    assert.equal(text.match(/^error:/gm).length, err.diagnostics.length);
  });

  test('long traces are abbreviated', () => {
    let err;
    try {
      evaluate('fn down(n) { if n == 0 { error("bottom") } else { down(n - 1) } } down(50)');
    } catch (e) {
      err = e;
    }
    assert.match(formatError(err, ''), /more frames/);
  });
});
