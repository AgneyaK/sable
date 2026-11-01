import { describe, test, assert, evaluate, output } from './harness.js';

describe('values', () => {
  test('numbers, strings, booleans and nil', () => {
    assert.equal(evaluate('[1.5, "s", true, nil]'), [1.5, 's', true, null]);
  });

  test('only nil and false are falsy', () => {
    assert.equal(evaluate('[0, "", []].map(|x| if x { "t" } else { "f" })'), ['t', 't', 't']);
    assert.equal(evaluate('if nil { 1 } else { 2 }'), 2);
  });

  test('equality is structural for lists and maps', () => {
    assert.equal(evaluate('[1, [2, 3]] == [1, [2, 3]]'), true);
    assert.equal(evaluate('{ a: 1, b: 2 } == { b: 2, a: 1 }'), true);
    assert.equal(evaluate('[1] == [2]'), false);
  });

  test('printing formats nested values', () => {
    assert.equal(output('print([1, "two", { k: nil }], 0..3, 1..=2)'), '[1, "two", {k: nil}] 0..3 1..=2');
  });

  test('modulo takes the sign of the divisor', () => {
    assert.equal(evaluate('[-1 % 3, 7 % -3, 7 % 3]'), [2, -2, 1]);
  });

  test('string interpolation evaluates expressions', () => {
    assert.equal(evaluate('let x = 4; "{x} squared is {x * x}"'), '4 squared is 16');
  });

  test('string and list operators', () => {
    assert.equal(evaluate('"ab" + "cd"'), 'abcd');
    assert.equal(evaluate('"ab" * 3'), 'ababab');
    assert.equal(evaluate('[1] + [2, 3]'), [1, 2, 3]);
  });

  test('membership with in', () => {
    assert.equal(evaluate('[2 in [1, 2], "b" in "abc", "k" in {k: 1}, 5 in 0..5, 5 in 0..=5]'), [true, true, true, false, true]);
  });
});

describe('variables and scope', () => {
  test('blocks are expressions with their own scope', () => {
    assert.equal(evaluate('let x = 1; let y = { let x = 10; x + 1 }; [x, y]'), [1, 11]);
  });

  test('shadowing a variable with let', () => {
    assert.equal(evaluate('let x = 1; { let x = x + 1; let x = x * 10; x }'), 20);
  });

  test('compound assignment on variables, indexes and fields', () => {
    assert.equal(evaluate('let a = 1; a += 4; a *= 2; a'), 10);
    assert.equal(evaluate('let l = [1, 2]; l[1] += 5; l'), [1, 7]);
    assert.equal(evaluate('let m = { n: 1 }; m.n -= 3; m.n'), -2);
  });

  test('blocks inside call arguments get correct local slots', () => {
    assert.equal(evaluate('fn add(a, b) { a + b } add(1, { let t = 5; t * 2 })'), 11);
  });
});

describe('control flow', () => {
  test('if / else if / else chains', () => {
    const src = 'fn sign(n) { if n < 0 { -1 } else if n == 0 { 0 } else { 1 } } [sign(-5), sign(0), sign(3)]';
    assert.equal(evaluate(src), [-1, 0, 1]);
  });

  test('while with break and continue', () => {
    const src = `
      let i = 0; let seen = [];
      while true {
        i += 1;
        if i % 2 == 0 { continue; }
        if i > 7 { break; }
        seen.push(i);
      }
      seen`;
    assert.equal(evaluate(src), [1, 3, 5, 7]);
  });

  test('for over lists, ranges, strings and maps', () => {
    assert.equal(output('for x in [1, 2] { print(x); } for c in "ab" { print(c); } for k in {p: 1} { print(k); }'), '1\n2\na\nb\np');
    assert.equal(evaluate('let s = 0; for i in 1..=10 { s += i; } s'), 55);
  });

  test('two-variable for loops', () => {
    assert.equal(output('for i, x in ["a", "b"] { print(i, x); } for k, v in {x: 1} { print(k, v); }'), '0 a\n1 b\nx 1');
  });

  test('break out of nested blocks inside a for loop', () => {
    const src = 'let found = nil; for x in 0..100 { let y = x * x; if y > 50 { found = x; break; } } found';
    assert.equal(evaluate(src), 8);
  });

  test('loops evaluate to nil', () => {
    assert.equal(evaluate('let x = for i in 0..3 {}; x'), null);
  });

  test('early return from nested loops', () => {
    const src = 'fn find(grid, v) { for r in grid { for c in r { if c == v { return c * 100; } } } nil } find([[1, 2], [3, 4]], 3)';
    assert.equal(evaluate(src), 300);
  });
});

describe('match', () => {
  const classify = `
    fn classify(x) {
      match x {
        0 => "zero",
        1 | 2 => "small",
        3..10 => "medium",
        "hi" => "greeting",
        nil => "nothing",
        n if n < 0 => "negative {n}",
        _ => "other",
      }
    }`;

  test('literals, alternatives, ranges, guards and wildcards', () => {
    assert.equal(evaluate(classify + '[0, 2, 5, "hi", nil, -3, 99].map(classify)'),
      ['zero', 'small', 'medium', 'greeting', 'nothing', 'negative -3', 'other']);
  });

  test('no matching arm gives nil', () => {
    assert.equal(evaluate('match 5 { 1 => "one" }'), null);
  });

  test('a failed guard falls through to the next arm', () => {
    assert.equal(evaluate('match 10 { n if n > 100 => "big", n => n + 1 }'), 11);
  });

  test('arm bodies can be blocks with locals', () => {
    assert.equal(evaluate('match 3 { n => { let d = n * 2; d + 1 } }'), 7);
  });
});

describe('functions and closures', () => {
  test('recursion', () => {
    assert.equal(evaluate('fn fact(n) { if n <= 1 { 1 } else { n * fact(n - 1) } } fact(10)'), 3628800);
  });

  test('mutual recursion between globals', () => {
    const src = 'fn is_even(n) { if n == 0 { true } else { is_odd(n - 1) } } fn is_odd(n) { if n == 0 { false } else { is_even(n - 1) } } [is_even(10), is_odd(7)]';
    assert.equal(evaluate(src), [true, true]);
  });

  test('closures keep their own state', () => {
    const src = 'fn counter() { let n = 0; || { n += 1; n } } let a = counter(); let b = counter(); a(); a(); [a(), b()]';
    assert.equal(evaluate(src), [3, 1]);
  });

  test('closures share a captured variable', () => {
    const src = 'fn pair() { let v = 0; [|| v, |x| { v = x; }] } let p = pair(); p[1](42); p[0]()';
    assert.equal(evaluate(src), 42);
  });

  test('each loop iteration captures a fresh variable', () => {
    assert.equal(evaluate('let fs = []; for i in 0..3 { fs.push(|| i); } fs.map(|f| f())'), [0, 1, 2]);
  });

  test('deeply nested captures', () => {
    assert.equal(evaluate('fn a(x) { |y| |z| x + y + z } a(1)(2)(3)'), 6);
  });

  test('local functions can recurse', () => {
    assert.equal(evaluate('fn outer() { fn loop_(n) { if n == 0 { "done" } else { loop_(n - 1) } } loop_(5) } outer()'), 'done');
  });

  test('anonymous fn expressions', () => {
    assert.equal(evaluate('let f = fn(a, b) { a * b }; f(6, 7)'), 42);
  });

  test('lambdas named by let show up in traces', () => {
    assert.equal(output('let shout = |s| s.upper(); print(shout)'), '<fn shout>');
  });

  test('map members that are functions can be called like methods', () => {
    assert.equal(evaluate('let obj = { greet: |n| "hi {n}" }; obj.greet("bo")'), 'hi bo');
  });

  test('constant expressions are folded at compile time', () => {
    assert.equal(evaluate('2 * 3 + 4 ** 2 - "a".len()'), 21);
  });
});
