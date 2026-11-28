import { readFileSync } from 'node:fs';
import { LineCounter, parseDocument } from 'yaml';

/** Shared syntax reader; consumers retain their own definition-specific validation. */
export function readDefinitionYaml(path: string) {
  const source = readFileSync(path, 'utf8');
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines, uniqueKeys: true });
  return { source, lines, doc };
}
