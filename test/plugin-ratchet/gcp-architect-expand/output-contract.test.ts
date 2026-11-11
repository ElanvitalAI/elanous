import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyArchitectureOutput } from '../../../src/ux-sim/gcp-architect-expand/output-contract.js';

test('offline architecture sample satisfies the document gate', () => {
  const result = verifyArchitectureOutput(join(import.meta.dir, '../../../plugins/gcp-architect-expand/sim/sample-output'));
  expect(result).toEqual({ ok: true, errors: [] });
});

test('quality gate rejects an omitted legend and altered official icon evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gcp-output-quality-'));
  try {
    cpSync(join(import.meta.dir, '../../../plugins/gcp-architect-expand/sim/sample-output'), directory, { recursive: true });
    const diagramPath = join(directory, 'architecture.excalidraw');
    const diagram = JSON.parse(readFileSync(diagramPath, 'utf8'));
    diagram.elements.find((item: { id: string }) => item.id === 'legend-title').text = '';
    writeFileSync(diagramPath, JSON.stringify(diagram));
    const provenancePath = join(directory, 'icon-provenance.json');
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
    provenance.embeddedSha256.compute = 'wrong';
    writeFileSync(provenancePath, JSON.stringify(provenance));
    const result = verifyArchitectureOutput(directory);
    expect(result.errors).toContain('missing diagram legend');
    expect(result.errors).toContain('icon provenance mismatch: compute');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('verify rejects text touching a diagram box border', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gcp-output-overlap-'));
  try {
    cpSync(join(import.meta.dir, '../../../plugins/gcp-architect-expand/sim/sample-output'), directory, { recursive: true });
    const path = join(directory, 'architecture.excalidraw');
    const diagram = JSON.parse(readFileSync(path, 'utf8'));
    diagram.elements.find((item: { id: string }) => item.id === 'storage-body').x = 1450;
    writeFileSync(path, JSON.stringify(diagram));
    expect(verifyArchitectureOutput(directory).errors.some(value => value.includes('storage-body ↔ bucket'))).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('missing and malformed artifacts fail closed before approval', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gcp-output-check-'));
  try {
    expect(verifyArchitectureOutput(directory).ok).toBe(false);
    writeFileSync(join(directory, 'architecture.excalidraw'), '{');
    writeFileSync(join(directory, 'architecture.png'), 'not-a-png');
    writeFileSync(join(directory, 'architecture-design.pdf'), 'not-a-pdf');
    writeFileSync(join(directory, 'icon-provenance.json'), '{}');
    const result = verifyArchitectureOutput(directory);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('invalid editable Excalidraw JSON');
    expect(result.errors).toContain('invalid PNG render');
    expect(result.errors).toContain('invalid PDF');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
