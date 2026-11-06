#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync as writeTempFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function mergeManual(baseText, oursText, theirsText) {
  const markers = (text) => {
    const begin = '<!-- BEGIN GENERATED MOCK DEVICE CATALOG -->';
    const end = '<!-- END GENERATED MOCK DEVICE CATALOG -->';
    const start = text.indexOf(begin);
    const finish = text.indexOf(end);
    if (start < 0 || finish < start) throw new Error('generated device catalog markers missing');
    return { begin, end, start, finish };
  };
  const [base, ours, theirs] = [baseText, oursText, theirsText].map(markers);
  const skeleton = (text, marker) => `${text.slice(0, marker.start + marker.begin.length)}\n${marker.end}${text.slice(marker.finish + marker.end.length)}`;
  const temp = mkdtempSync(join(tmpdir(), 'ux-sim-manual-merge-'));
  let mergedSkeleton;
  try {
    const paths = ['ours.md', 'base.md', 'theirs.md'].map((name) => join(temp, name));
    [skeleton(oursText, ours), skeleton(baseText, base), skeleton(theirsText, theirs)].forEach((text, index) => writeTempFile(paths[index], text));
    const result = spawnSync('git', ['merge-file', '--stdout', paths[0], paths[1], paths[2]], { encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 0) throw new Error(result.status === 1 ? 'manual non-generated content conflict' : `git merge-file failed: ${result.stderr || result.error?.message}`);
    mergedSkeleton = result.stdout;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  const mergedMarkers = markers(mergedSkeleton);
  // The complete marked section is generated from the merged catalog by merge-train.
  // Keep one side here; integration regenerates it after the source catalog is merged.
  return `${mergedSkeleton.slice(0, mergedMarkers.start)}${oursText.slice(ours.start, ours.finish + ours.end.length)}${mergedSkeleton.slice(mergedMarkers.finish + mergedMarkers.end.length)}`;
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
