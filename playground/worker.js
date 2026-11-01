// Runs programs off the main thread so an infinite loop can't freeze the
// page; the Stop button simply terminates this worker.

import { compile, VM, formatError, repr, CompileError, RuntimeError } from '../src/index.js';

const FLUSH_MS = 40;

self.onmessage = ({ data: { source } }) => {
  let pending = [];
  let lastFlush = performance.now();
  const flush = () => {
    if (pending.length) self.postMessage({ type: 'stdout', lines: pending });
    pending = [];
    lastFlush = performance.now();
  };
  const print = (line) => {
    pending.push(line);
    if (pending.length >= 500 || performance.now() - lastFlush > FLUSH_MS) flush();
  };

  const started = performance.now();
  try {
    const proto = compile(source);
    const value = new VM({ print }).interpret(proto);
    flush();
    self.postMessage({ type: 'done', value: value === null ? null : repr(value), ms: performance.now() - started });
  } catch (err) {
    flush();
    const ms = performance.now() - started;
    if (err instanceof CompileError || err instanceof RuntimeError) {
      const sameSource = !(err instanceof RuntimeError) || err.source == null || err.source === source;
      self.postMessage({
        type: 'error',
        message: formatError(err, source, { filename: 'main.sb' }),
        line: sameSource ? err.span?.line ?? null : null,
        ms,
      });
    } else {
      self.postMessage({ type: 'error', message: `internal error: ${err?.stack ?? err}`, line: null, ms });
    }
  }
};
