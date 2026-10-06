// A position-aware JSON/JSONC reader. Edits touch only the owned server value;
// comments, unknown settings and whitespace elsewhere retain their bytes.
export function parseJsonc(text) {
  let i = 0;
  function trivia() {
    for (;;) {
      while (/\s/.test(text[i] || '') && i < text.length) i++;
      if (text.slice(i, i + 2) === '//') { i = text.indexOf('\n', i + 2); if (i < 0) i = text.length; }
      else if (text.slice(i, i + 2) === '/*') { const end = text.indexOf('*/', i + 2); if (end < 0) throw new Error('Unterminated JSONC comment'); i = end + 2; }
      else return;
    }
  }
  function string() {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') i += 2;
      else if (text[i++] === '"') return { value: JSON.parse(text.slice(start, i)), start, end: i };
    }
    throw new Error('Unterminated JSON string');
  }
  function node() {
    trivia(); const start = i;
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      i++; const properties = []; const value = Object.create(null);
      trivia();
      while (text[i] !== '}') {
        if (text[i] !== '"') throw new Error(`Expected JSON object key at ${i}`);
        const key = string();
        if (Object.hasOwn(value, key.value)) throw new Error(`Duplicate JSON key ${key.value}`);
        trivia(); if (text[i++] !== ':') throw new Error('Expected colon');
        const child = node(); value[key.value] = child.value;
        trivia(); let comma = null;
        if (text[i] === ',') { comma = i++; trivia(); }
        else if (text[i] !== '}') throw new Error('Expected comma or closing object');
        properties.push({ key: key.value, start: key.start, end: child.end, comma, node: child });
      }
      const close = i++; return { value, start, end: i, close, properties };
    }
    if (text[i] === '[') {
      i++; const value = []; trivia();
      while (text[i] !== ']') {
        value.push(node().value); trivia();
        if (text[i] === ',') { i++; trivia(); }
        else if (text[i] !== ']') throw new Error('Expected comma or closing array');
      }
      i++; return { value, start, end: i };
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!match) throw new Error(`Invalid JSON value at ${i}`);
    i += match[0].length; return { value: JSON.parse(match[0]), start, end: i };
  }
  const root = node(); trivia(); if (i !== text.length) throw new Error(`Unexpected content at ${i}`);
  if (!root.properties) throw new Error('Agent config must be a JSON object');
  return root;
}

function edits(text, changes) {
  for (const edit of changes.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}

function objectProperty(text, object, key, value) {
  const property = object.properties.find(p => p.key === key);
  if (property) {
    if (value !== undefined && sameValue(property.node.value, value)) return text;
    if (value !== undefined) return edits(text, [{ start: property.node.start, end: property.node.end, text: JSON.stringify(value, null, 2) }]);
    const changes = [{ start: property.start, end: property.comma === null ? property.end : property.comma + 1, text: '' }];
    const position = object.properties.indexOf(property);
    if (property.comma === null && position > 0) {
      const comma = object.properties[position - 1].comma;
      if (comma !== null) changes.push({ start: comma, end: comma + 1, text: '' });
    }
    return edits(text, changes);
  }
  if (value === undefined) return text;
  const lineStart = text.lastIndexOf('\n', object.start) + 1;
  const parentIndent = /^\s*/.exec(text.slice(lineStart, object.start))[0].replace(/\n/g, '');
  const indentation = `${parentIndent}  `;
  const serialized = JSON.stringify(value, null, 2).replace(/\n/g, `\n${indentation}`);
  const changes = [{ start: object.close, end: object.close, text: `\n${indentation}${JSON.stringify(key)}: ${serialized}\n${parentIndent}` }];
  const last = object.properties.at(-1);
  if (last && last.comma === null) changes.push({ start: last.end, end: last.end, text: ',' });
  return edits(text, changes);
}

export function jsonEntry(text, container, key = 'fruitctl') {
  let node = parseJsonc(text || '{}');
  for (const segment of container) {
    const property = node.properties.find(p => p.key === segment);
    if (!property) return undefined;
    node = property.node;
    if (!node.properties) throw new Error(`Config ${segment} must be an object`);
  }
  return node.properties.find(p => p.key === key)?.node.value;
}

export function patchJsonEntry(text, container, value, key = 'fruitctl') {
  text ||= '{}\n';
  let node = parseJsonc(text);
  for (let offset = 0; offset < container.length; offset++) {
    const segment = container[offset];
    const property = node.properties.find(p => p.key === segment);
    if (!property) {
      if (value === undefined) return text;
      let wrapped = { [key]: value };
      for (const remaining of container.slice(offset + 1).reverse()) wrapped = { [remaining]: wrapped };
      return objectProperty(text, node, segment, wrapped);
    }
    node = property.node;
    if (!node.properties) throw new Error(`Config ${segment} must be an object`);
  }
  return objectProperty(text, node, key, value);
}

function tomlBlocks(text) {
  const lines = [...text.matchAll(/^[ \t]*\[([^\]\r\n]+)\][ \t]*(?:#[^\r\n]*)?\r?$/gm)];
  const blocks = [];
  for (let index = 0; index < lines.length; index++) {
    const header = lines[index][1].trim();
    if (/^(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:fruitctl|"fruitctl"|'fruitctl')(?:\s*\.|$)/.test(header)) {
      const start = lines[index].index, boundary = lines[index + 1]?.index ?? text.length;
      // Keep the final owned line ending, but leave blank-line separators in place.
      const trailing = /(\r?\n)[ \t\r\n]*$/.exec(text.slice(start, boundary));
      const end = trailing ? start + trailing.index + trailing[1].length : boundary;
      blocks.push({ start, end, header });
    }
  }
  if (!blocks.length) {
    const serverHeader = lines.findIndex(line => /^(?:mcp_servers|"mcp_servers"|'mcp_servers')$/.test(line[1].trim()));
    const inlineServer = serverHeader >= 0 && /^\s*(?:fruitctl|"fruitctl"|'fruitctl')\s*=/m.test(text.slice(lines[serverHeader].index, lines[serverHeader + 1]?.index ?? text.length));
    if (inlineServer || /^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*(?:=|\.\s*(?:fruitctl|"fruitctl"|'fruitctl'))/m.test(text)) throw new Error('Inline/dotted TOML mcp_servers requires a declarative/manual merge');
  }
  return blocks;
}

export function tomlEntry(text) {
  const blocks = tomlBlocks(text);
  return blocks.length ? blocks.map(block => text.slice(block.start, block.end)).join('') : undefined;
}

export function patchTomlEntry(text, value) {
  const blocks = tomlBlocks(text);
  if (!blocks.length) return value === undefined ? text : `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n${value}`;
  if (value !== undefined && ownedFieldsMatch(blocks.map(block => text.slice(block.start, block.end)).join(''), value, 'codex')) return text;
  const changes = blocks.map((block, index) => ({ ...block, text: index === 0 ? value || '' : '' }));
  return edits(text, changes);
}

export function sameValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  }
  const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, index) => key === bk[index] && sameValue(a[key], b[key]));
}

export function ownedFieldsMatch(current, expected, agent) {
  if (agent === 'codex') return current?.trim() === expected?.trim();
  if (!current || !expected) return false;
  // Only these booleans are agent-managed state; changed commands/env/args
  // cannot be silently adopted or overwritten by an upgrade or uninstall.
  const clean = value => Object.fromEntries(Object.entries(value).filter(([key]) => !(agent === 'junie' && ['enabled', 'disabled'].includes(key)) && !(agent === 'opencode' && key === 'enabled')));
  return sameValue(clean(current), clean(expected));
}
