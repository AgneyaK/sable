// A forgiving syntax highlighter. Unlike the real lexer it never fails, so
// it can colour half-typed code while you edit.

import { KEYWORDS } from '../src/lexer.js';

const CONSTANTS = new Set(['true', 'false', 'nil']);

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (cls, text) => `<span class="tok-${cls}">${escape(text)}</span>`;

export function highlight(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const rest = src.slice(i);
    let m;

    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += span('comment', src.slice(i, stop));
      i = stop;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += span('comment', src.slice(i, stop));
      i = stop;
    } else if (c === '"') {
      const [html, next] = string(src, i);
      out += html;
      i = next;
    } else if ((m = /^(0x[0-9a-fA-F_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?)/.exec(rest))) {
      out += span('number', m[0]);
      i += m[0].length;
    } else if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      const word = m[0];
      const after = src.slice(i + word.length).match(/^\s*\(/);
      if (CONSTANTS.has(word)) out += span('const', word);
      else if (KEYWORDS.has(word)) out += span('keyword', word);
      else if (after) out += span('fn', word);
      else out += escape(word);
      i += word.length;
    } else if ((m = /^(\.\.=|\|>|=>|\*\*|[=!<>+\-*/%]=?|\.\.|\|)/.exec(rest))) {
      out += span('op', m[0]);
      i += m[0].length;
    } else {
      out += escape(c);
      i++;
    }
  }
  return out;
}

// Strings, with `{...}` holes highlighted recursively.
function string(src, start) {
  let html = '';
  let buf = '"';
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      buf += src.slice(i, i + 2);
      i += 2;
    } else if (c === '"') {
      buf += c;
      i++;
      break;
    } else if (c === '{') {
      html += span('string', buf);
      buf = '';
      let depth = 1;
      let j = i + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        else if (src[j] === '"') {
          j = string(src, j)[1];
          continue;
        }
        if (depth > 0) j++;
      }
      html += span('interp', '{') + highlight(src.slice(i + 1, j));
      if (j < src.length) html += span('interp', '}');
      i = j + 1;
    } else {
      buf += c;
      i++;
    }
  }
  if (buf) html += span('string', buf);
  return [html, i];
}
