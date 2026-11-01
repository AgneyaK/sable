#!/usr/bin/env node
// Command-line entry point: run files, inspect compiler output, or start a REPL.

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  compile, parse, tokenize, VM, disassemble, formatError, printAst, repr,
  needsMoreInput, CompileError, RuntimeError, VERSION,
} from '../src/index.js';

const useColor = (stream) => Boolean(stream.isTTY) && !process.env.NO_COLOR;
const dim = (s) => (useColor(process.stdout) ? `\x1b[2m${s}\x1b[22m` : s);

const HELP = `Sable ${VERSION}

Usage:
  sable                      start the interactive REPL
  sable <file.sb>            run a file
  sable run <file.sb>        run a file
  sable -e <code>            run a snippet of code
  sable disasm <file.sb>     print the compiled bytecode
  sable ast <file.sb>        print the syntax tree
  sable tokens <file.sb>     print the token stream
  sable --version            print the version
  sable --help               show this message
`;

function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case 'repl':
      return repl();
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(HELP);
      return 0;
    case '-v':
    case '--version':
      console.log(`sable ${VERSION}`);
      return 0;
    case '-e':
      if (rest[0] === undefined) return usage('-e needs some code to run');
      return execute(rest[0], '<eval>');
    case 'run':
      return runFile(rest[0]);
    case 'disasm':
    case 'ast':
    case 'tokens':
      return inspect(cmd, rest[0]);
    default:
      if (cmd.startsWith('-')) return usage(`unknown option '${cmd}'`);
      return runFile(cmd);
  }
}

function usage(message) {
  console.error(`sable: ${message}\n`);
  process.stderr.write(HELP);
  return 2;
}

function readSource(path) {
  if (!path) {
    usage('missing file name');
    return null;
  }
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    console.error(`sable: cannot read '${path}': ${e.code === 'ENOENT' ? 'no such file' : e.message}`);
    return null;
  }
}

function report(err, source, filename) {
  if (err instanceof CompileError || err instanceof RuntimeError) {
    console.error(formatError(err, source, { filename, color: useColor(process.stderr) }));
    return 1;
  }
  throw err;
}

function execute(source, filename) {
  try {
    new VM().interpret(compile(source));
    return 0;
  } catch (e) {
    return report(e, source, filename);
  }
}

function runFile(path) {
  const source = readSource(path);
  return source === null ? 1 : execute(source, path);
}

function inspect(what, path) {
  const source = readSource(path);
  if (source === null) return 1;
  try {
    if (what === 'disasm') {
      console.log(disassemble(compile(source)));
    } else if (what === 'ast') {
      console.log(printAst(parse(source)));
    } else {
      const { tokens, errors } = tokenize(source);
      if (errors.length) throw new CompileError(errors);
      for (const t of tokens) {
        console.log(`${`${t.line}:${t.col}`.padEnd(8)}${t.type.padEnd(10)}${t.type === 'eof' ? '' : t.text}`);
      }
    }
    return 0;
  } catch (e) {
    return report(e, source, path);
  }
}

// -- REPL ------------------------------------------------------------------------

const REPL_HELP = `Commands:
  :help        show this message
  :bytecode    toggle printing bytecode before running
  :globals     list the variables you have defined
  :reset       forget everything and start over
  :quit        exit (or press Ctrl+D)
Lines with unclosed brackets or strings continue on the next line.`;

function repl() {
  let vm = new VM();
  let showBytecode = false;
  let buffer = '';

  console.log(`Sable ${VERSION}. Type :help for help, :quit to exit.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });

  const command = (line) => {
    switch (line) {
      case ':help':
        console.log(REPL_HELP);
        break;
      case ':bytecode':
        showBytecode = !showBytecode;
        console.log(`bytecode display ${showBytecode ? 'on' : 'off'}`);
        break;
      case ':globals': {
        const names = vm.userGlobals();
        if (!names.length) console.log(dim('(none)'));
        for (const name of names) console.log(`${name} = ${repr(vm.globals.get(name))}`);
        break;
      }
      case ':reset':
        vm = new VM();
        console.log('state cleared');
        break;
      case ':q':
      case ':quit':
      case ':exit':
        rl.close();
        return;
      default:
        console.log(`unknown command '${line}'. Try :help`);
    }
  };

  const evaluate = (source) => {
    let proto;
    try {
      proto = compile(source);
    } catch (e) {
      // Be forgiving about a missing final semicolon: `let x = 1` should work.
      if (!(e instanceof CompileError) || /[;}]\s*$/.test(source)) return report(e, source, '<repl>');
      try {
        proto = compile(source + ';');
      } catch {
        return report(e, source, '<repl>');
      }
    }
    if (showBytecode) console.log(dim(disassemble(proto)));
    try {
      const value = vm.interpret(proto);
      if (value !== null) console.log(dim(repr(value)));
    } catch (e) {
      report(e, source, '<repl>');
    }
  };

  rl.on('line', (line) => {
    if (!buffer && line.trim().startsWith(':')) {
      command(line.trim());
      if (!rl.closed) rl.prompt();
      return;
    }
    buffer = buffer ? `${buffer}\n${line}` : line;
    if (needsMoreInput(buffer)) {
      rl.setPrompt('. ');
      rl.prompt();
      return;
    }
    const source = buffer;
    buffer = '';
    rl.setPrompt('> ');
    if (source.trim()) evaluate(source);
    rl.prompt();
  });

  rl.on('SIGINT', () => {
    if (buffer) {
      buffer = '';
      process.stdout.write('\n');
      rl.setPrompt('> ');
      rl.prompt();
    } else {
      rl.close();
    }
  });

  rl.on('close', () => {
    process.stdout.write('\n');
    process.exit(0);
  });

  rl.prompt();
}

const code = main(process.argv.slice(2));
if (typeof code === 'number') process.exitCode = code;
