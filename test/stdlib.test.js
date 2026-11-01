import { describe, test, assert, evaluate, output, runtimeError } from './harness.js';

describe('globals', () => {
  test('conversions', () => {
    assert.equal(evaluate('[str(1.5), num("42"), num("x"), int(3.9), int("-7.2"), type([]), type(nil)]'),
      ['1.5', 42, null, 3, -7, 'list', 'nil']);
  });

  test('len and list', () => {
    assert.equal(evaluate('[len("abc"), len([1]), len({a: 1}), len(0..10)]'), [3, 1, 1, 10]);
    assert.equal(evaluate('list("ab") + list(0..3)'), ['a', 'b', 0, 1, 2]);
  });

  test('range with a step, including negative steps', () => {
    assert.equal(evaluate('list(range(0, 10, 3))'), [0, 3, 6, 9]);
    assert.equal(evaluate('list(range(5, 0, -2))'), [5, 3, 1]);
  });

  test('min and max', () => {
    assert.equal(evaluate('[min(3, 1, 2), max([4, 9, 2]), min("b", "a")]'), [1, 9, 'a']);
  });

  test('try catches runtime errors', () => {
    assert.equal(evaluate('let r = try(|| error("boom")); [r.ok, r.error]'), [false, 'boom']);
    assert.equal(evaluate('try(|| 1 + 1).value'), 2);
  });

  test('assert and assert_eq', () => {
    runtimeError('assert(1 > 2, "math is broken")', /assertion failed: math is broken/);
    runtimeError('assert_eq([1], [2])', /\[1\] != \[2\]/);
  });

  test('chr and ord', () => {
    assert.equal(evaluate('[chr(65), ord("a")]'), ['A', 97]);
  });

  test('math is deterministic after seeding', () => {
    assert.equal(evaluate('math.seed(7); let a = math.random(); math.seed(7); a == math.random()'), true);
    assert.equal(evaluate('math.seed(1); (0..100).map(|_| math.random_int(1, 6)).all(|n| n >= 1 and n <= 6)'), true);
  });

  test('math functions and constants', () => {
    assert.equal(evaluate('[math.sqrt(16), math.floor(2.7), math.max(1, 5), math.pi > 3.14]'), [4, 2, 5, true]);
  });
});

describe('list methods', () => {
  test('push, pop, insert, remove', () => {
    assert.equal(evaluate('let l = [1]; l.push(2, 3); let p = l.pop(); l.insert(0, 0); l.remove(1); [l, p]'), [[0, 2], 3]);
  });

  test('negative indexes count from the end', () => {
    assert.equal(evaluate('let l = [1, 2, 3]; [l[-1], l.slice(-2)]'), [3, [2, 3]]);
  });

  test('higher-order methods', () => {
    assert.equal(evaluate('[1, 2, 3, 4].filter(|x| x % 2 == 0).map(|x| x * 10)'), [20, 40]);
    assert.equal(evaluate('[1, 2, 3].reduce(|a, b| a + b)'), 6);
    assert.equal(evaluate('[[1, 2], [3]].flat_map(|x| x)'), [1, 2, 3]);
    assert.equal(evaluate('[[3, 4].find(|x| x > 3), [1].find(|x| x > 3)]'), [4, null]);
    assert.equal(evaluate('[[1, 2].any(|x| x > 1), [1, 2].all(|x| x > 1), [1, 2, 3].count(|x| x > 1)]'), [true, false, 2]);
  });

  test('sort, sort_by and reverse return new lists', () => {
    assert.equal(evaluate('let l = [3, 1, 2]; let s = l.sort(); [l, s, l.reverse()]'), [[3, 1, 2], [1, 2, 3], [2, 1, 3]]);
    assert.equal(evaluate('["ccc", "a", "bb"].sort_by(|s| s.len())'), ['a', 'bb', 'ccc']);
    assert.equal(evaluate('[1, 2, 3].sort(|a, b| b - a)'), [3, 2, 1]);
    assert.equal(evaluate('[[2, "b"], [1, "z"], [1, "a"]].sort()'), [[1, 'a'], [1, 'z'], [2, 'b']]);
  });

  test('assorted helpers', () => {
    assert.equal(evaluate('[1, 2, 3, 4, 5].chunk(2)'), [[1, 2], [3, 4], [5]]);
    assert.equal(evaluate('["a", "b"].enumerate()'), [[0, 'a'], [1, 'b']]);
    assert.equal(evaluate('[1, 2].zip(["x", "y", "z"])'), [[1, 'x'], [2, 'y']]);
    assert.equal(evaluate('[1, 1, [2], [2], 3].unique()'), [1, [2], 3]);
    assert.equal(evaluate('[1, 2, 3].join("-")'), '1-2-3');
    assert.equal(evaluate('[[1, 2, 3].sum(), [5, 1].min(), [].first()]'), [6, 1, null]);
    assert.equal(evaluate('[1, 2].index_of(2)'), 1);
  });

  test('group_by builds a map of lists', () => {
    assert.equal(evaluate('[1, 2, 3, 4].group_by(|x| x % 2)'), new Map([[1, [1, 3]], [0, [2, 4]]]));
  });
});

describe('string methods', () => {
  test('case, trimming and searching', () => {
    assert.equal(evaluate('["Hi".upper(), "Hi".lower(), "  x ".trim(), "hello".contains("ell"), "hello".index_of("z")]'),
      ['HI', 'hi', 'x', true, null]);
  });

  test('split, lines and chars', () => {
    assert.equal(evaluate('"  a b   c ".split()'), ['a', 'b', 'c']);
    assert.equal(evaluate('"a,b".split(",")'), ['a', 'b']);
    assert.equal(evaluate('"x\\ny".lines()'), ['x', 'y']);
    assert.equal(evaluate('"ab".chars()'), ['a', 'b']);
  });

  test('replace, repeat, pad and reverse', () => {
    assert.equal(evaluate('["a-b-c".replace("-", "+"), "ab".repeat(2), "7".pad_start(3, "0"), "abc".reverse()]'),
      ['a+b+c', 'abab', '007', 'cba']);
  });

  test('character classes', () => {
    assert.equal(evaluate('["123".is_digit(), "ab1".is_alpha(), " ".is_space(), "".is_digit()]'), [true, false, true, false]);
  });
});

describe('map, range and number methods', () => {
  test('map methods', () => {
    assert.equal(evaluate('let m = {a: 1}; m.set("b", 2); [m.keys(), m.values(), m.has("a"), m.get("z", 0), m.remove("a"), m.len()]'),
      [['a', 'b'], [1, 2], true, 0, 1, 1]);
    assert.equal(evaluate('{a: 1, b: 2}.filter(|k, v| v > 1).keys()'), ['b']);
    assert.equal(evaluate('{a: 1}.merge({b: 2}).entries()'), [['a', 1], ['b', 2]]);
  });

  test('missing map keys read as nil', () => {
    assert.equal(evaluate('let m = {}; [m["nope"], m.nope]'), [null, null]);
  });

  test('ranges support list methods and their own', () => {
    assert.equal(evaluate('(1..=4).map(|x| x * x)'), [1, 4, 9, 16]);
    assert.equal(evaluate('[(1..=100).sum(), (0..10).step(5).to_list(), (0..10).len()]'), [5050, [0, 5], 10]);
  });

  test('number methods', () => {
    assert.equal(evaluate('[(-3).abs(), 2.567.round(2), 7.5.floor(), 3.to_fixed(2), 4.is_int()]'), [3, 2.57, 7, '3.00', true]);
  });
});

describe('print', () => {
  test('joins its arguments with spaces', () => {
    assert.equal(output('print("a", 1, [true])'), 'a 1 [true]');
  });
});
