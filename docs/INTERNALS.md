# How Sable works

Sable is a classic four-stage pipeline: lexer → parser → compiler → virtual
machine. This document covers the parts that are less obvious from reading the
code.

## 1. Lexing

[`src/lexer.js`](../src/lexer.js) produces a flat array of tokens. Each token
carries `start`/`end` offsets plus a `line` and `col`. These spans travel
through every later stage, which is how a runtime error can still underline
the right characters.

String interpolation is the interesting part. When the lexer meets `{` inside
a string, it does not tokenize the expression. It only finds the matching `}`,
stepping over nested braces and nested strings, and records the range of
source text in between. The parser later starts a **sub-parser on that same
range of the original source**, so tokens inside `"{a + b}"` have spans that
point at their real position in the file.

## 2. Parsing

[`src/parser.js`](../src/parser.js) is a recursive-descent parser with one
function per precedence level. The AST is made of plain objects such as
`{ type: 'Binary', op: '+', left, right, span }`.

Some decisions worth knowing:

- **Pipes are desugared in the parser.** `x |> f(a)` becomes
  `Call(f, [x, a])`, so the compiler never sees a pipe.
- **Block-like statements end at their brace.** At the start of a statement,
  `if`, `while`, `for`, `match` and `{` are parsed as complete statements. So
  `if a { } [1, 2].each(f)` is two statements, not an index into the `if`.
  Rust has the same rule.
- **Maps versus blocks.** `{}` and `{ ident: ...` are maps, and anything else
  starting with `{` is a block. Looking two tokens ahead is enough to decide.
- **Error recovery.** A parse error records a diagnostic and throws an
  internal `ParseFail`. The statement loop catches it and skips ahead to the
  next likely statement start (`;`, `let`, `fn`, `}`, and so on). That way one
  missing semicolon doesn't hide the next five problems.

## 3. Compiling

[`src/compiler.js`](../src/compiler.js) walks the AST once and emits bytecode
into a `Chunk`: an array of numbers, a constant pool, and a span for each code
slot. Every function gets its own `FunctionProto` with its own chunk.

### Tracking the stack height at compile time

Most of the design follows from one decision: **the compiler always knows
exactly how tall the VM's stack will be.** Every opcode has a stack effect
(`CONST` is +1, `ADD` is −1, `CALL n` is −n, and so on). `emit` adds that
effect to `fs.depth` on every instruction.

This matters because blocks are expressions. Consider:

```rust
foo(1, { let a = 2; a * 10 })
```

When `let a` runs, `foo` and `1` are already on the stack as temporaries. A
compiler that numbers locals by counting declarations would give `a` the
wrong slot. Here, `a` simply gets slot `fs.depth - 1`: wherever its value
landed.

A block compiles to its statements, then its value, then
`CLOSE_SCOPE n`. That instruction pops the block's `n` locals from *under*
the value on top of the stack:

```text
before:  [... foo 1 a=2 20]      CLOSE_SCOPE 1
after:   [... foo 1 20]
```

`break` and `continue` compute how far the stack is above the loop's base,
emit `POPN` for exactly that many slots, and then jump.

### Variables

Name resolution happens at compile time and checks three places in order:

1. **Local**: found in the current function's `locals` list → `GET_LOCAL slot`.
2. **Upvalue**: found in an enclosing function → `GET_UPVALUE index`. Each
   function along the way records an `(isLocal, index)` capture descriptor,
   which `CLOSURE` uses at run time.
3. **Global**: otherwise `GET_GLOBAL name`, resolved when the code runs. That
   is why top-level functions can call each other in any order.

### Loops and match

A `for` loop keeps its iterator in a hidden local (`(iter)`). Each pass runs
`ITER_NEXT exit nvars`, which either pushes the next value(s) or jumps to
`exit`. The loop variables are declared in their own scope and popped at the
end of every iteration (closing any upvalues that captured them). That is
what gives each iteration a fresh binding.

`match` keeps its subject in a hidden local and tests each arm in turn. A
literal pattern compiles to `GET_LOCAL subject; CONST lit; EQ`. A range
pattern builds the range and uses `IN`. Alternatives become a chain of
`JUMP_IF_TRUE` jumps. When a guard fails, the arm's bindings are popped and
the next arm is tried.

### Constant folding

Arithmetic and comparisons on literal operands are computed while compiling,
so `60 * 60 * 24` becomes a single `CONST 86400`. Division and modulo by a
literal zero are left alone so the VM can report them with a proper error.

## 4. Running

[`src/vm.js`](../src/vm.js) is a stack machine. A call frame holds a closure,
an instruction pointer, and a `base`: the stack index of the function being
called, with its arguments right above it. The hot loop keeps `code`, `ip` and
`base` in local variables and writes `ip` back to the frame only when it
calls, returns or fails.

### Closures and upvalues

This is the technique from Lua, described in *Crafting Interpreters*:

- While the variable it refers to is still on the stack, an upvalue is
  **open**: it stores the stack index and reads and writes through it.
- When that stack slot is about to be discarded (on `RETURN`, `POPN` or
  `CLOSE_SCOPE`), the VM **closes** the upvalue: it copies the value into the
  upvalue object, and from then on the upvalue owns it.
- Open upvalues are kept in a linked list sorted by stack index, so two
  closures capturing the same variable share one upvalue object. This is why
  they see each other's writes.

### Re-entrancy

Built-ins like `list.map(f)` must call back into Sable. `vm.call(fn, args)`
pushes the callee and its arguments, pushes a frame, and runs the dispatch
loop until the number of frames drops back to where it was. Then it returns
the result to the native code. If the callback throws, `vm.call` restores the
stack and frame count before passing the error on, so the outer `run` loop is
left in a consistent state.

### Errors

Runtime errors are ordinary JavaScript exceptions (`RuntimeError`). When one
escapes the dispatch loop, the VM saves the current `ip` into the frame and
walks every frame to build a stack trace. Each frame's position comes from
`chunk.spans[ip - 1]`. Every operand slot carries the span of its instruction,
so this works whether a frame is paused inside a `CALL` or failed partway
through an instruction. `formatError` then renders the familiar code frame
with carets.

"Did you mean" hints compare the unknown name against the known globals or
methods. They use an edit distance that counts swapping two adjacent letters
as a single edit.

## Opcode reference

| Opcode | Operands | Stack effect |
| --- | --- | --- |
| `CONST` | index | → value |
| `NIL` `TRUE` `FALSE` | | → value |
| `POP` | | a → |
| `POPN` | n | n values → (closes upvalues) |
| `DUP` / `DUP2` | | duplicates the top one / top two values |
| `GET_LOCAL` / `SET_LOCAL` | slot | → v / v → v |
| `GET_UPVALUE` / `SET_UPVALUE` | index | → v / v → v |
| `GET_GLOBAL` / `SET_GLOBAL` / `DEFINE_GLOBAL` | name | → v / v → v / v → |
| `ADD` `SUB` `MUL` `DIV` `MOD` `POW` | | a b → result |
| `EQ` `NEQ` `LT` `LE` `GT` `GE` `IN` | | a b → bool |
| `NEG` `NOT` | | a → result |
| `RANGE` | inclusive | start end → range |
| `JUMP` | target | |
| `JUMP_IF_FALSE` / `JUMP_IF_TRUE` | target | peeks at the condition |
| `POP_JUMP_IF_FALSE` | target | cond → |
| `CALL` | argc | fn args... → result |
| `INVOKE` | name argc | receiver args... → result |
| `CLOSURE` | proto, then (isLocal, index) × upvalues | → closure |
| `RETURN` | | v → (pops the frame) |
| `CLOSE_SCOPE` | n | locals... v → v |
| `LIST` / `MAP` | n | n items / n key-value pairs → collection |
| `INDEX_GET` / `INDEX_SET` | | obj i → v / obj i v → v |
| `FIELD_GET` / `FIELD_SET` | name | obj → v / obj v → v |
| `ITER_PREP` | | iterable → iterator |
| `ITER_NEXT` | exit, nvars | iterator → iterator value(s), or jumps to exit |
| `INTERP` | n | n parts → string |
