// Public API.

import { compile } from './compiler.js';
import { VM } from './vm.js';

export { tokenize, needsMoreInput } from './lexer.js';
export { parse } from './parser.js';
export { compile } from './compiler.js';
export { VM } from './vm.js';
export { disassemble, Op } from './chunk.js';
export { formatError, CompileError, RuntimeError } from './errors.js';
export { display, repr, typeName } from './values.js';
export { printAst } from './ast-print.js';

export const VERSION = '0.1.0';

/**
 * Compiles and runs `source`, returning the value of its last expression.
 *
 *   run('print("hi"); 1 + 2')  // prints "hi", returns 3
 */
export function run(source, { print, vm } = {}) {
  const machine = vm ?? new VM({ print });
  return machine.interpret(compile(source));
}
