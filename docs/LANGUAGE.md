# The Sable language

This is a reference for everything Sable supports today. For a gentler
introduction, run [examples/hello.sb](../examples/hello.sb).

- [Lexical structure](#lexical-structure)
- [Values and types](#values-and-types)
- [Variables and scope](#variables-and-scope)
- [Operators](#operators)
- [Blocks and control flow](#blocks-and-control-flow)
- [Pattern matching](#pattern-matching)
- [Functions and closures](#functions-and-closures)
- [Built-in functions](#built-in-functions)
- [Methods](#methods)
- [Errors](#errors)

## Lexical structure

- **Comments**: `// to end of line` and `/* block */`. Block comments nest.
- **Numbers**: `42`, `3.14`, `1_000_000`, `0xff`, `6.02e23`. All numbers are
  64-bit floats.
- **Strings**: double quotes only. They may span lines. The escapes are `\n`,
  `\t`, `\r`, `\0`, `\\`, `\"`, `\{`, `\}` and `\u{1F600}`.
- **Interpolation**: `"sum = {a + b}"` evaluates the expression between the
  braces. To write a literal brace, use `\{`.
- **Identifiers**: `[A-Za-z_][A-Za-z0-9_]*`.
- **Keywords**: `let fn return if else while for in break continue match
  and or not true false nil`.
- **Semicolons** end statements. You can leave them off after a statement that
  ends in a block (`if`, `while`, `for`, `match`, `{ ... }`, `fn` declarations),
  and after the final expression of a block, which becomes the block's value.

## Values and types

| Type | Examples | Notes |
| --- | --- | --- |
| `nil` | `nil` | The absence of a value. |
| `bool` | `true`, `false` | |
| `number` | `1`, `-2.5`, `math.inf` | Integers print without a decimal point. |
| `string` | `"hi"` | Immutable. Indexing gives one-character strings. |
| `list` | `[1, "a", [2]]` | Mutable and growable. Negative indexes count from the end. |
| `map` | `{ name: "x", "two words": 2, 3: "three" }` | Keys can be strings, numbers, bools or nil. Insertion order is kept. |
| `range` | `0..10`, `1..=5`, `range(0, 10, 2)` | Lazy. Iterate them, index them, or call list methods on them. |
| `function` | `fn(x) { x }`, `\|x\| x`, `print` | First-class values. |

`type(value)` returns the type's name as a string.

**Truthiness:** only `nil` and `false` are falsy. `0`, `""` and `[]` are truthy.

**Equality:** `==` compares lists and maps structurally, so `[1, [2]] == [1, [2]]`
is true. Functions are only equal to themselves.

## Variables and scope

```rust
let x = 10;        // declare
x = x + 1;         // assign
x += 1;            // also -=, *=, /=, %=
let x = "shadow";  // redeclaring in the same scope shadows the old binding
```

Variables declared at the top level of a program are **globals**. Globals are
looked up when the code runs, so functions can refer to each other in any
order. Everything else (block variables, function parameters, loop variables)
is a **local**, resolved at compile time.

Assigning to a variable that was never declared is an error. Fields and
indexes can be assigned too: `m.name = "x"`, `xs[0] = 1`, `m["key"] += 1`.

## Operators

From loosest to tightest binding:

| Operators | Meaning |
| --- | --- |
| `=` `+=` `-=` `*=` `/=` `%=` | assignment (right associative; evaluates to the assigned value) |
| `\|>` | pipe: `x \|> f(a)` is `f(x, a)`, and `x \|> f` is `f(x)` |
| `or` | short-circuit or, returns the deciding operand |
| `and` | short-circuit and, returns the deciding operand |
| `not` | logical not |
| `==` `!=` | structural equality |
| `<` `<=` `>` `>=` `in` | comparison (numbers with numbers, strings with strings) and membership |
| `..` `..=` | exclusive and inclusive ranges |
| `+` `-` | addition (numbers), concatenation (strings, lists), subtraction |
| `*` `/` `%` | multiplication (`"ab" * 3` repeats), division, modulo |
| `-` | negation |
| `**` | exponentiation (right associative, so `-2 ** 2` is `-4`) |
| `f()` `x[i]` `x.name` `x.m()` | call, index, field, method |

Notes:

- `%` takes the sign of the divisor, so `-1 % 3` is `2`. That makes it handy for
  wrapping around a grid.
- Dividing by zero, or taking a modulo by zero, is a runtime error.
- `x in xs` works on lists (by element), strings (by substring), maps (by key)
  and ranges.
- `"a" + 1` is an error. Use interpolation (`"a{1}"`) or `str(1)` instead.

## Blocks and control flow

Every one of these is an expression.

```rust
let y = { let t = 3; t * t };                   // a block's value is its last expression
let sign = if n < 0 { -1 } else if n == 0 { 0 } else { 1 };
while i < 10 { i += 1; }                        // evaluates to nil
for x in [1, 2, 3] { print(x); }                // lists
for i in 0..5 { }                               // ranges
for ch in "abc" { }                             // strings, one character at a time
for key in map { }                              // maps: one variable gives the key
for i, x in list { }                            // index and value
for key, value in map { }                       // key and value
```

`break` and `continue` work in both kinds of loop. `return` leaves the current
function early. A block whose last statement ends in `;` evaluates to `nil`.

At the start of a statement, `{` opens a block. The exceptions are `{}` and
`{ key: ...`, which are map literals.

## Pattern matching

```rust
match value {
  0 => "zero",                    // literal: numbers, strings, true, false, nil
  1 | 2 | 3 => "small",           // alternatives
  4..10 => "medium",              // ranges, numbers only (..= for inclusive)
  "hi" | "hello" => "greeting",
  n if n < 0 => "negative {n}",   // binding with a guard
  _ => "anything else",           // wildcard
}
```

Arms are tried from top to bottom. A binding pattern such as `n` matches
anything and names the value inside the arm. If no arm matches, the result is
`nil`. Arms are separated by commas, which are optional after a braced body.

## Functions and closures

```rust
fn add(a, b) { a + b }            // declaration; returns its last expression
let mul = fn(a, b) { a * b };     // anonymous function
let sq = |x| x * x;               // lambda shorthand; the body is one expression
let hello = || print("hi");       // no parameters

fn counter() {
  let n = 0;
  || { n += 1; n }                // captures `n` by reference
}
```

- Calling a function with the wrong number of arguments is an error.
- Closures capture **variables**, not values. Two closures that capture the
  same variable see each other's changes.
- Each iteration of a `for` loop gets a fresh loop variable, so a closure
  created inside the loop remembers that iteration's value.
- A function stored in a map can be called like a method: `obj.greet("x")`.
  That's how you write simple objects (see [calc.sb](../examples/calc.sb)).
- A lambda assigned with `let` takes its name from the variable, which shows
  up in stack traces.

## Built-in functions

| Function | Description |
| --- | --- |
| `print(...values)` | Prints the values separated by spaces. |
| `str(v)` / `repr(v)` | Display form / quoted form of a value. |
| `num(s)` | Parses a number. Returns `nil` if the string isn't one. |
| `int(v)` | Truncates a number toward zero, parsing it first if given a string. |
| `type(v)` | `"nil"`, `"bool"`, `"number"`, `"string"`, `"list"`, `"map"`, `"range"` or `"function"`. |
| `len(v)` | The length of a string, list, map or range. |
| `list(v)` | Turns a range, string or map (keys) into a list, or copies a list. |
| `range(end)`, `range(start, end, step?)` | An exclusive range with an optional step, which may be negative. |
| `min(...)`, `max(...)` | The smallest or largest of the arguments, or of a single list. |
| `chr(n)`, `ord(s)` | Converts between a character and its code point. |
| `clock()` | Seconds since start-up, with fractions, for timing code. |
| `assert(cond, msg?)`, `assert_eq(a, b, msg?)` | Raises an error unless the condition holds. |
| `error(msg)` | Raises a runtime error. |
| `try(fn)` | Calls `fn()` and returns `{ok, value, error}` instead of failing. |

`math` holds `sqrt floor ceil round trunc abs sign sin cos tan asin acos atan
atan2 exp log log2 log10 cbrt pow hypot min max clamp`. It also has `random()`,
`random_int(lo, hi)` (inclusive) and `seed(n)` for reproducible randomness, and
the constants `pi`, `e` and `inf`.

## Methods

Methods are called with `value.name(args)`. Methods that transform data return
new values. The ones that only change things in place (`push`, `pop`,
`insert`, `remove`, `extend`, `clear`, `set`) modify their receiver.

**Lists:** `len is_empty push(...xs) pop insert(i, x) remove(i) extend(xs)
clear copy first last contains(x) index_of(x) slice(start, end?) take(n)
skip(n) reverse join(sep?) map(f) filter(f) each(f) reduce(f, init?) find(f)
find_index(f) any(f) all(f) count(f?) flat flat_map(f) sum min max sort(cmp?)
sort_by(key) enumerate zip(other) unique chunk(n) group_by(key)`

**Strings:** `len is_empty upper lower trim trim_start trim_end split(sep?)
chars lines contains(s) starts_with(s) ends_with(s) index_of(s) count(s)
replace(from, to) repeat(n) slice(start, end?) pad_start(n, ch?)
pad_end(n, ch?) reverse is_digit is_alpha is_alnum is_space`

**Maps:** `len is_empty keys values entries has(k) get(k, default?) set(k, v)
remove(k) clear copy merge(other) each(f) filter(f) map_values(f)`. `each` and
`filter` call `f(key, value)`. Reading a missing key with `m[k]` or `m.k`
gives `nil`.

**Ranges:** `len contains(x) to_list step(n) sum`, plus every list method
(the range is turned into a list first).

**Numbers:** `abs floor ceil round(digits?) sqrt pow(e) is_int clamp(lo, hi)
to_fixed(digits)`.

## Errors

Compile errors (syntax, `break` outside a loop, duplicate parameters) are all
reported together before anything runs. Runtime errors stop the program and
show the failing expression along with a stack trace:

```text
runtime error: index 5 is out of bounds for a list of length 3
 --> main.sb:7:11
  |
7 |   let x = items[i];
  |           ^^^^^^^^
stack trace:
  at pick (main.sb:7:11)
  at <script> (main.sb:10:1)
```

Use `try(|| ...)` to catch runtime errors as values.
