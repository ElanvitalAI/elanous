import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loopAgentContractErrors } from '../loops/contract/validate.js';
import {
  DEFAULT_SUPERVISOR_DEFINITION_PATHS,
  loadSupervisorDefinitions,
  supervisorDefinitionErrors,
  type SupervisorDefinition,
} from './definition-loader.js';

const rlaLoopPath = resolve(import.meta.dir, '../../graphs/release/rla/loop.yaml');
const runDoctorPath = resolve(import.meta.dir, 'definitions/run-doctor.supervisor.yaml');
const readDefinition = (path: string): SupervisorDefinition => parseYaml(readFileSync(path, 'utf8')) as SupervisorDefinition;

function withTempFiles(files: Record<string, unknown>, run: (paths: Record<string, string>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'supervisor-def-'));
  try {
    const paths = Object.fromEntries(Object.entries(files).map(([name, doc]) => {
      const path = join(dir, name);
      writeFileSync(path, stringifyYaml(doc));
      return [name, path];
    }));
    run(paths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('supervisor/v1 definition loader', () => {
  test('loads the rla, macrophage, heal, silence and run-doctor definitions as one valid set', () => {
    const result = loadSupervisorDefinitions();
    expect(result.errors).toEqual([]);
    expect(result.definitions.map(loaded => loaded.definition.ref)).toEqual([
      'loop:rla@1', 'loop:macrophage@1', 'loop:heal@1', 'loop:silence@1', 'loop:run-doctor@1',
    ]);
    expect(result.definitions.every(loaded => loaded.definition.kind === 'supervisor')).toBe(true);
    expect(result.definitions[0]!.source).toBe(rlaLoopPath);
  });

  test('rla definition is read from the supervisor block of its loop card and keeps the card authority', () => {
    const card = parseYaml(readFileSync(rlaLoopPath, 'utf8')) as Record<string, unknown> & { supervisor: SupervisorDefinition };
    expect(card.apiVersion).toBe('elanous.dev/loop/v1');
    expect(card.supervisor.authority).toEqual(card.authority as string[]);
    expect(card.supervisor.memory.global.write).toBe('none');
  });

  test('rejects a set where two definitions are final actors for the same signal', () => {
    const rival = { ...readDefinition(runDoctorPath), ref: 'loop:rival-doctor@1' };
    withTempFiles({ 'rival.yaml': rival }, ({ 'rival.yaml': rivalPath }) => {
      const result = loadSupervisorDefinitions([runDoctorPath, rivalPath!]);
      expect(result.definitions).toEqual([]);
      expect(result.errors).toEqual([
        `signal run.failed has two final actors: loop:run-doctor@1 (${runDoctorPath}) and loop:rival-doctor@1 (${rivalPath})`,
      ]);
    });
  });

  test('allows many observers of a signal alongside its single final actor', () => {
    const observer = { ...readDefinition(runDoctorPath), ref: 'loop:autopsy@1', role: 'observer',
      signals: [{ signal: 'run.failed', actor: 'observer' }] };
    withTempFiles({ 'autopsy.yaml': observer }, ({ 'autopsy.yaml': observerPath }) => {
      const result = loadSupervisorDefinitions([...DEFAULT_SUPERVISOR_DEFINITION_PATHS, observerPath!]);
      expect(result.errors).toEqual([]);
      expect(result.definitions).toHaveLength(6);
    });
  });

  test('rejects a duplicate ref across files', () => {
    withTempFiles({ 'copy.yaml': readDefinition(runDoctorPath) }, ({ 'copy.yaml': copyPath }) => {
      const result = loadSupervisorDefinitions([runDoctorPath, copyPath!]);
      expect(result.definitions).toEqual([]);
      expect(result.errors).toEqual([`duplicate supervisor ref loop:run-doctor@1: ${runDoctorPath} and ${copyPath}`]);
    });
  });

  test('rejects schema violations: wrong kind, unknown field, global memory write, duplicate signal', () => {
    const base = readDefinition(runDoctorPath);
    expect(supervisorDefinitionErrors(base)).toEqual([]);
    expect(supervisorDefinitionErrors({ ...base, kind: 'seat' })).toContain('/kind must be equal to constant');
    expect(supervisorDefinitionErrors({ ...base, extra: true })).toContain('/ must NOT have additional properties');
    expect(supervisorDefinitionErrors({ ...base, memory: { ...base.memory, global: { ...base.memory.global, write: 'append' } } }))
      .toContain('/memory/global/write must be equal to constant');
    expect(supervisorDefinitionErrors({ ...base, escalation: { ...base.escalation, silenceAfter: 'PT' } }))
      .toContain('/escalation/silenceAfter must match pattern "^P(?=.)(?:[0-9]+D)?(?:T(?=[0-9])(?:[0-9]+H)?(?:[0-9]+M)?(?:[0-9]+S)?)?$"');
    expect(supervisorDefinitionErrors({ ...base, signals: [...base.signals, { signal: 'run.failed', actor: 'observer' }] }))
      .toEqual(['/signals/2 duplicate signal: run.failed']);
  });

  test('a loop card without a supervisor block is rejected', () => {
    withTempFiles({ 'card.yaml': { apiVersion: 'elanous.dev/loop/v1', id: 'loop:bare@1' } }, ({ 'card.yaml': cardPath }) => {
      const result = loadSupervisorDefinitions([cardPath!]);
      expect(result.definitions).toEqual([]);
      expect(result.errors).toEqual([`${cardPath}: / must be object`]);
    });
  });

  test('loop-agent manifest contract still rejects kind: supervisor at its root', () => {
    expect(loopAgentContractErrors({ kind: 'supervisor' }).some(error => error.startsWith('/kind'))).toBe(true);
  });
});
