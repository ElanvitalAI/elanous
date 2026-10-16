/** Diagnostic comparison for the incremental compiler. Only union member order is ignored. */

function atomAt(value: string, start: number): { text: string; end: number } | null {
  if (value[start] === '"') {
    const end = value.indexOf('"', start + 1);
    return end < 0 ? null : { text: value.slice(start, end + 1), end: end + 1 };
  }
  const name = /^[A-Za-z_$][\w$]*/.exec(value.slice(start));
  if (!name) return null;
  let end = start + name[0].length;
  if (value[end] === '<') {
    let depth = 1;
    let cursor = end + 1;
    let quoted = false;
    for (; cursor < value.length; cursor++) {
      if (value[cursor] === '"' && value[cursor - 1] !== '\\') quoted = !quoted;
      if (quoted) continue;
      if (value[cursor] === '<') depth++;
      else if (value[cursor] === '>' && --depth === 0) break;
    }
    if (depth === 0) end = cursor + 1;
  }
  const raw = value.slice(start, end);
  return { text: raw.includes(' | ') && raw.includes('<') && raw.endsWith('>')
    ? `${name[0]}<${normalizeUnionAtoms(raw.slice(name[0].length + 1, -1))}>` : raw, end };
}

function normalizeUnionAtoms(line: string): string {
  let result = '';
  for (let i = 0; i < line.length;) {
    const first = atomAt(line, i);
    if (!first || line.slice(first.end, first.end + 3) !== ' | ') {
      if (first) { result += first.text; i = first.end; }
      else { result += line[i]!; i++; }
      continue;
    }
    const parts = [first.text];
    let end = first.end;
    while (line.slice(end, end + 3) === ' | ') {
      const next = atomAt(line, end + 3);
      if (!next) break;
      parts.push(next.text);
      end = next.end;
    }
    result += parts.sort().join(' | ');
    i = end;
  }
  return result;
}

function normalizeDiagnosticLine(line: string): string {
  // The observed reorder is a TypeScript union containing quoted literal members.
  // Bare quoted prose such as 'a | b' may be a string value, so keep it byte-exact.
  return line.replace(/'([^'\n]*\|[^'\n]*)'/g, (quoted, type: string) => type.includes('"') ? `'${normalizeUnionAtoms(type)}'` : quoted);
}

/** Include continuation lines; the existing gate parser reads only TS header lines. */
export function normalizedDiagnosticSet(output: string): string | null {
  const blocks: string[] = [];
  const other: string[] = [];
  let block: string[] | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (/^.+?\.[cm]?tsx?\(\d+,\d+\): error TS\d+:/.test(line)) {
      if (block) blocks.push(block.map(normalizeDiagnosticLine).join('\n'));
      block = [line];
    } else if (block && /^\s/.test(line)) block.push(line);
    else {
      if (block) blocks.push(block.map(normalizeDiagnosticLine).join('\n'));
      block = null;
      if (line.trim()) other.push(line);
    }
  }
  if (block) blocks.push(block.map(normalizeDiagnosticLine).join('\n'));
  if (/error TS\d+/.test(output) && blocks.length === 0) return null;
  return JSON.stringify({ blocks: blocks.sort(), other });
}
