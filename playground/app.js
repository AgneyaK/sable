import { compile, parse, tokenize, disassemble, printAst, formatError, CompileError } from '../src/index.js';
import { EXAMPLES } from '../examples/index.js';
import { highlight } from './highlight.js';

const $ = (id) => document.getElementById(id);
const editor = $('source');
const code = $('highlight');
const gutter = $('gutter');
const runButton = $('run');
const status = $('status');
const examples = $('examples');
const panels = {
  output: $('panel-output'),
  bytecode: $('panel-bytecode'),
  ast: $('panel-ast'),
  tokens: $('panel-tokens'),
};

const STORAGE_KEY = 'sable.playground.source';
const MAX_OUTPUT_LINES = 5000;
const INDENT = '  ';

let worker = null;
let running = false;
let activePanel = 'output';
let errorLine = null;
let outputLines = 0;

// -- storage and sharing ---------------------------------------------------------

const storage = {
  get() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  },
  set(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Private mode or storage disabled: nothing to remember.
    }
  },
};

function encodeSource(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeSource(encoded) {
  const bin = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function sourceFromHash() {
  const m = location.hash.match(/^#code=(.+)$/);
  if (!m) return null;
  try {
    return decodeSource(m[1]);
  } catch {
    return null;
  }
}

async function loadExample(file) {
  const res = await fetch(new URL(`../examples/${file}`, import.meta.url));
  if (!res.ok) throw new Error(`could not load ${file}`);
  return res.text();
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 1800);
}

// -- editor ----------------------------------------------------------------------

function render() {
  const text = editor.value;
  // A trailing newline keeps the overlay as tall as the textarea.
  code.innerHTML = highlight(text) + '\n';
  const count = text.split('\n').length;
  let lines = '';
  for (let i = 1; i <= count; i++) lines += i === errorLine ? `<span class="err">${i}</span>\n` : `${i}\n`;
  gutter.innerHTML = lines;
  syncScroll();
}

function syncScroll() {
  code.parentElement.scrollTop = editor.scrollTop;
  code.parentElement.scrollLeft = editor.scrollLeft;
  gutter.scrollTop = editor.scrollTop;
}

function updateCursor() {
  const before = editor.value.slice(0, editor.selectionStart);
  const line = before.split('\n').length;
  const col = before.length - before.lastIndexOf('\n');
  $('cursor').textContent = `Ln ${line}, Col ${col}`;
}

function setSource(text) {
  editor.value = text;
  editor.scrollTop = 0;
  editor.setSelectionRange(0, 0);
  errorLine = null;
  render();
  updateCursor();
  scheduleInspect();
}

// Replace the selection, keeping native undo history where the browser allows.
function insert(text) {
  if (!document.execCommand('insertText', false, text)) {
    editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end');
    onInput();
  }
}

function lineStart(pos) {
  return editor.value.lastIndexOf('\n', pos - 1) + 1;
}

function handleKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    toggleRun();
    return;
  }

  if (e.key === 'Tab') {
    e.preventDefault();
    const { selectionStart: start, selectionEnd: end, value } = editor;
    if (start === end && !e.shiftKey) return insert(INDENT);
    // Indent or dedent every selected line.
    const from = lineStart(start);
    const block = value.slice(from, end);
    const changed = e.shiftKey
      ? block.replace(/^ {1,2}/gm, '')
      : block.replace(/^/gm, INDENT);
    editor.setSelectionRange(from, end);
    insert(changed);
    editor.setSelectionRange(from, from + changed.length);
    return;
  }

  if (e.key === 'Enter') {
    // Keep the current indentation, and indent one more level after `{`, `[` or `(`.
    e.preventDefault();
    const pos = editor.selectionStart;
    const line = editor.value.slice(lineStart(pos), pos);
    let indent = line.match(/^\s*/)[0];
    if (/[{[(]\s*$/.test(line)) indent += INDENT;
    insert('\n' + indent);
    return;
  }

  if (e.key === '}' || e.key === ']' || e.key === ')') {
    // Typing a closer on an otherwise blank line dedents it.
    const pos = editor.selectionStart;
    const from = lineStart(pos);
    const line = editor.value.slice(from, pos);
    if (/^\s+$/.test(line) && line.length >= INDENT.length && editor.selectionStart === editor.selectionEnd) {
      e.preventDefault();
      editor.setSelectionRange(pos - INDENT.length, pos);
      insert(e.key);
    }
  }
}

function onInput() {
  if (errorLine !== null) errorLine = null;
  render();
  updateCursor();
  storage.set(editor.value);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  scheduleInspect();
}

// -- running -----------------------------------------------------------------------

function appendOutput(text, cls) {
  if (outputLines >= MAX_OUTPUT_LINES) return;
  const lines = text.split('\n');
  outputLines += lines.length;
  if (outputLines > MAX_OUTPUT_LINES) {
    lines.length = Math.max(0, lines.length - (outputLines - MAX_OUTPUT_LINES));
    lines.push(`... output truncated after ${MAX_OUTPUT_LINES} lines`);
    cls = cls ?? 'note';
  }
  const node = cls ? Object.assign(document.createElement('span'), { className: cls }) : document.createTextNode('');
  node.textContent = lines.join('\n') + '\n';
  panels.output.append(node);
  panels.output.scrollTop = panels.output.scrollHeight;
}

function setStatus(text, kind = '') {
  status.textContent = text;
  status.className = `status muted ${kind}`;
}

function setRunning(on) {
  running = on;
  runButton.classList.toggle('running', on);
  runButton.querySelector('.run-label').textContent = on ? 'Stop' : 'Run';
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'stdout') {
      appendOutput(data.lines.join('\n'));
      return;
    }
    setRunning(false);
    const ms = `${data.ms < 10 ? data.ms.toFixed(1) : Math.round(data.ms)} ms`;
    if (data.type === 'done') {
      if (data.value !== null) appendOutput(`=> ${data.value}`, 'result');
      setStatus(`finished in ${ms}`, 'ok');
    } else {
      appendOutput(data.message, 'error');
      errorLine = data.line;
      render();
      setStatus(`failed after ${ms}`, 'err');
    }
  };
  worker.onerror = (e) => {
    setRunning(false);
    appendOutput(`worker error: ${e.message}`, 'error');
    setStatus('crashed', 'err');
  };
  return worker;
}

function runProgram() {
  showPanel('output');
  panels.output.textContent = '';
  outputLines = 0;
  errorLine = null;
  render();
  setRunning(true);
  setStatus('running...');
  ensureWorker().postMessage({ source: editor.value });
}

function stopProgram() {
  worker?.terminate();
  worker = null;
  setRunning(false);
  appendOutput('stopped', 'note');
  setStatus('stopped', 'err');
}

function toggleRun() {
  if (running) stopProgram();
  else runProgram();
}

// -- inspector panels ----------------------------------------------------------------

function showPanel(name) {
  activePanel = name;
  for (const [key, el] of Object.entries(panels)) el.classList.toggle('active', key === name);
  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.panel === name;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
  }
  if (name !== 'output') inspect();
}

function inspect() {
  const source = editor.value;
  const panel = panels[activePanel];
  if (!panel || activePanel === 'output') return;
  try {
    if (activePanel === 'bytecode') panel.textContent = disassemble(compile(source));
    else if (activePanel === 'ast') panel.textContent = printAst(parse(source));
    else {
      const { tokens, errors } = tokenize(source);
      if (errors.length) throw new CompileError(errors);
      panel.textContent = tokens
        .map((t) => `${`${t.line}:${t.col}`.padEnd(8)}${t.type.padEnd(10)}${t.type === 'eof' ? '' : t.text}`)
        .join('\n');
    }
  } catch (err) {
    if (!(err instanceof CompileError)) throw err;
    panel.textContent = '';
    appendTo(panel, formatError(err, source, { filename: 'main.sb' }), 'error');
  }
}

function appendTo(panel, text, cls) {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  panel.append(el);
}

let inspectTimer = null;
function scheduleInspect() {
  if (activePanel === 'output') return;
  clearTimeout(inspectTimer);
  inspectTimer = setTimeout(inspect, 200);
}

// -- wiring ------------------------------------------------------------------------

async function init() {
  for (const { file, title } of EXAMPLES) {
    examples.append(new Option(title, file));
  }
  examples.prepend(new Option('Examples...', '', true, true));
  examples.options[0].disabled = true;

  examples.addEventListener('change', async () => {
    const file = examples.value;
    try {
      setSource(await loadExample(file));
      storage.set(editor.value);
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) {
      toast(e.message);
    }
    examples.selectedIndex = 0;
    editor.focus();
  });

  editor.addEventListener('input', onInput);
  editor.addEventListener('scroll', syncScroll);
  editor.addEventListener('keydown', handleKey);
  for (const ev of ['click', 'keyup', 'select']) editor.addEventListener(ev, updateCursor);
  runButton.addEventListener('click', toggleRun);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.target !== editor) {
      e.preventDefault();
      toggleRun();
    }
  });
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => showPanel(tab.dataset.panel));
  }

  $('share').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}#code=${encodeSource(editor.value)}`;
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied to clipboard');
    } catch {
      toast('Link is in the address bar');
    }
  });

  const initial = sourceFromHash() ?? storage.get() ?? (await loadExample(EXAMPLES[0].file).catch(() => 'print("Hello, Sable!");\n'));
  setSource(initial);
  editor.focus();
  editor.setSelectionRange(0, 0);
}

init();
