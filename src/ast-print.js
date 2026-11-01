// Renders an AST as an indented tree, for `sable ast` and the playground.

export function printAst(node) {
  const lines = [];
  walk(node, 0, null, lines);
  return lines.join('\n');
}

const isPlainChild = (v) => v !== null && typeof v === 'object';

function walk(node, indent, label, lines) {
  const pad = '  '.repeat(indent);
  const prefix = label ? `${label}: ` : '';
  const attrs = [];
  const children = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'span' || key.endsWith('Span') || value === null || value === undefined) continue;
    if (isPlainChild(value)) children.push([key, value]);
    else attrs.push(`${key}=${JSON.stringify(value)}`);
  }
  lines.push(`${pad}${prefix}${node.type ?? ''}${attrs.length ? (node.type ? ' ' : '') + attrs.join(' ') : ''}`);
  for (const [key, value] of children) {
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${pad}  ${key}:`);
      for (const item of value) {
        if (isPlainChild(item)) walk(item, indent + 2, null, lines);
        else lines.push(`${pad}    ${JSON.stringify(item)}`);
      }
    } else {
      walk(value, indent + 1, key, lines);
    }
  }
}
