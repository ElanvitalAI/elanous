#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const same = isDeepStrictEqual;

function identity(value) {
  if (typeof value === 'string') return `string:${value}`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.id === 'string') return `id:${value.id}`;
  if (typeof value.path === 'string') return `path:${value.path}`;
  return null;
}

function mergeArray(base, ours, theirs, path) {
  if ([...base, ...ours, ...theirs].every((item) => identity(item) !== null)) {
    const [baseById, oursById, theirsById] = [base, ours, theirs].map(
      (items) => new Map(items.map((item) => [identity(item), item])),
    );
    const merged = [];
    const identities = new Set([...baseById.keys(), ...oursById.keys(), ...theirsById.keys()]);

    for (const key of identities) {
      const baseItem = baseById.get(key);
      const ourItem = oursById.get(key);
      const theirItem = theirsById.get(key);
      if (baseItem === undefined) {
        if (ourItem !== undefined && theirItem !== undefined && !same(ourItem, theirItem)) {
          throw new Error(`same new identity differs at ${path}/${key}`);
        }
        merged.push(ourItem ?? theirItem);
      } else if (ourItem === undefined || theirItem === undefined) {
        throw new Error(`identity removed at ${path}/${key}`);
      } else if (same(ourItem, theirItem)) {
        merged.push(ourItem);
      } else if (same(ourItem, baseItem)) {
        merged.push(theirItem);
      } else if (same(theirItem, baseItem)) {
        merged.push(ourItem);
      } else {
        throw new Error(`same identity changed differently at ${path}/${key}`);
      }
    }
    return merged;
  }

  // Non-identity arrays are append-only: preserve the multiplicity of every base value.
  const checkedBaseItems = [];
  for (const baseItem of base) {
    if (checkedBaseItems.some((item) => same(item, baseItem))) continue;
    checkedBaseItems.push(baseItem);
    const baseCount = base.filter((item) => same(item, baseItem)).length;
    const oursCount = ours.filter((item) => same(item, baseItem)).length;
    const theirsCount = theirs.filter((item) => same(item, baseItem)).length;
    if (oursCount < baseCount || theirsCount < baseCount) throw new Error(`array removal/change at ${path}`);
  }
  const merged = [...base];
  for (const item of [...ours, ...theirs]) {
    if (!merged.some((existing) => same(existing, item))) merged.push(item);
  }
  return merged;
}

function mergeValue(base, ours, theirs, path = '$') {
  if (Array.isArray(base) && Array.isArray(ours) && Array.isArray(theirs)) {
    return mergeArray(base, ours, theirs, path);
  }
  if (base && ours && theirs && [base, ours, theirs].every((value) => typeof value === 'object' && !Array.isArray(value))) {
    const merged = {};
    const fields = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
    for (const field of fields) {
      const hasBase = Object.hasOwn(base, field);
      const hasOurs = Object.hasOwn(ours, field);
      const hasTheirs = Object.hasOwn(theirs, field);
      const baseValue = base[field];
      const ourValue = ours[field];
      const theirValue = theirs[field];

      if (!hasOurs && !hasTheirs) continue;
      if (!hasBase) {
        if (hasOurs && hasTheirs && !same(ourValue, theirValue)) {
          throw new Error(`same new field differs at ${path}.${field}`);
        }
        merged[field] = hasOurs ? ourValue : theirValue;
      } else if (!hasOurs) {
        if (!same(theirValue, baseValue)) throw new Error(`delete/change at ${path}.${field}`);
      } else if (!hasTheirs) {
        if (!same(ourValue, baseValue)) throw new Error(`change/delete at ${path}.${field}`);
      } else {
        merged[field] = mergeValue(baseValue, ourValue, theirValue, `${path}.${field}`);
      }
    }
    return merged;
  }

  if (same(ours, theirs)) return ours;
  if (same(ours, base)) return theirs;
  if (same(theirs, base)) return ours;
  throw new Error(`content conflict at ${path}`);
}

function mergeCatalog(baseText, oursText, theirsText) {
  const base = JSON.parse(baseText);
  const ours = JSON.parse(oursText);
  const theirs = JSON.parse(theirsText);
  return `${JSON.stringify(mergeValue(base, ours, theirs), null, 2)}\n`;
}

function parseManual(text) {
  const lines = text.split(/\r?\n/);
  const begin = '<!-- BEGIN GENERATED MOCK DEVICE CATALOG -->';
  const end = '<!-- END GENERATED MOCK DEVICE CATALOG -->';
  const start = lines.indexOf(begin);
  const finish = lines.indexOf(end);
  if (start < 0 || finish <= start) throw new Error('generated device catalog markers missing');
  const header = lines.findIndex((line, index) => index > start && index < finish && /^\| ID \| 장치 \|/.test(line));
  if (header < 0 || !/^\|[-| :]+\|$/.test(lines[header + 1] ?? '')) throw new Error('generated device table header missing');
  const headerCells = lines[header].split('|').slice(1, -1).map((cell) => cell.trim());
  if (headerCells.length !== 6 || headerCells.some((cell) => !cell)) throw new Error('generated device table must have six named columns');
  const rows = lines.slice(header + 2, finish);
  return { lines, start, finish, header, headerCells, rows };
}

function mergeManual(baseText, oursText, theirsText) {
  const [base, ours, theirs] = [baseText, oursText, theirsText].map(parseManual);
  const outsideTable = (document) => [
    ...document.lines.slice(0, document.header + 2),
    ...document.lines.slice(document.finish),
  ];
  if (!same(outsideTable(base), outsideTable(ours)) || !same(outsideTable(base), outsideTable(theirs))) {
    throw new Error('manual non-table change');
  }

  const rowId = (row) => row.split('|')[1]?.trim();
  function appendedRows(document) {
    const body = document.lines.slice(document.header + 2, document.finish);
    const baseRowsArePrefix = same(document.rows.slice(0, base.rows.length), base.rows);
    const allRowsAreValid = body.length === document.rows.length && body.every((line) => {
      if (!line.startsWith('|') || !line.endsWith('|')) return false;
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      return cells.length === base.headerCells.length && Boolean(cells[0]);
    });
    if (!baseRowsArePrefix || !allRowsAreValid) throw new Error('manual table is not append-only');

    for (const row of base.rows) {
      if (!document.rows.includes(row)) throw new Error(`manual base row changed or removed: ${rowId(row)}`);
    }
    return document.rows.slice(base.rows.length);
  }

  const additions = new Map();
  for (const row of [...appendedRows(ours), ...appendedRows(theirs)]) {
    const id = rowId(row);
    if (!id) throw new Error('manual appended row has no first-column ID');
    const baseRow = base.rows.find((existingRow) => rowId(existingRow) === id);
    if (baseRow) throw new Error(`manual appended ID duplicates a base row: ${id}`);
    const existing = additions.get(id);
    if (existing && existing !== row) throw new Error(`manual appended ID differs: ${id}`);
    additions.set(id, row);
  }

  const mergedRows = [...base.rows, ...[...additions.values()].sort((left, right) => rowId(left).localeCompare(rowId(right)))];
  const mergedLines = [
    ...base.lines.slice(0, base.header + 2),
    ...mergedRows,
    ...base.lines.slice(base.finish),
  ];
  const newline = baseText.includes('\r\n') ? '\r\n' : '\n';
  // split/join preserves the input's existing trailing newline (including no newline).
  return mergedLines.join(newline);
}

const [kind, basePath, oursPath, theirsPath] = process.argv.slice(2);
try {
  const base = readFileSync(basePath, 'utf8');
  const ours = readFileSync(oursPath, 'utf8');
  const theirs = readFileSync(theirsPath, 'utf8');
  const merged = kind === 'catalog'
    ? mergeCatalog(base, ours, theirs)
    : kind === 'manual'
      ? mergeManual(base, ours, theirs)
      : (() => { throw new Error(`unknown merge type ${kind}`); })();
  writeFileSync(oursPath, merged);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
