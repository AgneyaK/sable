// Error types shared by every stage of the pipeline, plus a rustc-style
// pretty printer that renders a diagnostic with a code frame.

/** One or more problems found while lexing, parsing or compiling. */
export class CompileError extends Error {
  constructor(diagnostics) {
    super(diagnostics.map((d) => d.message).join('\n'));
    this.name = 'CompileError';
    /** @type {{ message: string, span: Span | null, hint?: string | null }[]} */
    this.diagnostics = diagnostics;
  }

  get span() {
    return this.diagnostics[0]?.span ?? null;
  }
}

/** An error raised while the VM is executing code. */
export class RuntimeError extends Error {
  constructor(message, { span = null, hint = null } = {}) {
    super(message);
    this.name = 'RuntimeError';
    this.span = span;
    this.hint = hint;
    /** Source text the span points into (set by the VM). */
    this.source = null;
    /** Call stack at the point of failure, innermost first. */
    this.trace = null;
  }
}

/**
 * @typedef {{ start: number, end: number, line: number, col: number }} Span
 */

const ANSI = {
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
  dim: (s) => `\x1b[2m${s}\x1b[22m`,
  red: (s) => `\x1b[31m${s}\x1b[39m`,
  blue: (s) => `\x1b[34m${s}\x1b[39m`,
  cyan: (s) => `\x1b[36m${s}\x1b[39m`,
};
const PLAIN = { bold: id, dim: id, red: id, blue: id, cyan: id };
function id(s) {
  return s;
}

const MAX_TRACE = 12;

/**
 * Render an error the way a compiler would:
 *
 *   error: undefined variable 'cuont'
 *    --> main.sb:3:5
 *     |
 *   3 |     cuont += 1;
 *     |     ^^^^^
 *     = hint: did you mean 'count'?
 */
export function formatError(err, source, { filename = '<input>', color = false } = {}) {
  const c = color ? ANSI : PLAIN;

  if (err instanceof CompileError) {
    return err.diagnostics
      .map((d) => diagnostic('error', d.message, d.span, d.hint, source, filename, c))
      .join('\n\n');
  }

  if (err instanceof RuntimeError) {
    let out = diagnostic('runtime error', err.message, err.span, err.hint, err.source ?? source, filename, c);
    const trace = err.trace ?? [];
    if (trace.length > 1) {
      out += '\n' + c.dim('stack trace:');
      const shown =
        trace.length > MAX_TRACE
          ? [...trace.slice(0, MAX_TRACE - 2), null, ...trace.slice(-2)]
          : trace;
      for (const frame of shown) {
        if (frame === null) {
          out += '\n' + c.dim(`  ... ${trace.length - MAX_TRACE + 2} more frames`);
          continue;
        }
        const where = frame.span ? `${filename}:${frame.span.line}:${frame.span.col}` : filename;
        out += '\n' + c.dim(`  at ${frame.name} (${where})`);
      }
    }
    return out;
  }

  return String(err?.stack ?? err);
}

function diagnostic(label, message, span, hint, source, filename, c) {
  const out = [`${c.red(c.bold(label + ':'))} ${c.bold(message)}`];
  const gutterWidth = span ? String(span.line).length : 1;
  const pad = ' '.repeat(gutterWidth);

  if (span && source != null) {
    const text = (source.split('\n')[span.line - 1] ?? '').replace(/\r$/, '');
    const startCol = span.col - 1;
    const width = Math.max(1, Math.min(span.end - span.start, text.length - startCol));
    // Preserve tabs so the carets line up with the code above them.
    const lead = text.slice(0, startCol).replace(/[^\t]/g, ' ');

    out.push(`${pad}${c.blue('-->')} ${filename}:${span.line}:${span.col}`);
    out.push(`${pad} ${c.blue('|')}`);
    out.push(`${c.blue(String(span.line))} ${c.blue('|')} ${text}`);
    out.push(`${pad} ${c.blue('|')} ${lead}${c.red('^'.repeat(width))}`);
  }
  if (hint) out.push(`${pad} ${c.blue('=')} ${c.cyan('hint:')} ${hint}`);
  return out.join('\n');
}
