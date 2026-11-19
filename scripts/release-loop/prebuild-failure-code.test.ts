import { expect, test } from 'bun:test';
import { classifyPrebuildFailure } from './prebuild-failure-code.js';
import { buildPrebuildFailure } from './gate-image-pin.js';

test('explicit prebuild evidence maps to stable failure codes; no cause is guessed from exit status', () => {
  const cases = [
    [{ stage: 'build', osErrorCode: 'ENOSPC' }, 'DISK_FULL'],
    [{ stage: 'push', registryPresent: false }, 'REGISTRY_ABSENT'],
    [{ stage: 'clone', mirrorComplete: false }, 'MIRROR_PARTIAL'],
    [{ stage: 'pack-pwa', packagePwaPresent: false }, 'PACK_MISSING_PWA'],
    [{ stage: 'clone', stateDirExists: false }, 'STATE_DIR_MISSING'],
    [{ stage: 'build', exit: 1 }, 'UNKNOWN'],
    [{ stage: 'build', reason: 'registry is absent' }, 'UNKNOWN'],
    [{ stage: 'push', registryPresent: true }, 'UNKNOWN'],
    [{ stage: 'clone', osErrorCode: 'EACCES' }, 'UNKNOWN'],
  ] as const;
  for (const [evidence, code] of cases) expect(classifyPrebuildFailure(evidence).code).toBe(code);
});

test('when several independent checks fail, report every observed cause in stable order', () => {
  expect(classifyPrebuildFailure({ stage: 'build', osErrorCode: 'ENOSPC', stateDirExists: false, mirrorComplete: false })).toEqual({
    code: 'DISK_FULL', causes: ['DISK_FULL', 'STATE_DIR_MISSING', 'MIRROR_PARTIAL'],
  });
  expect(classifyPrebuildFailure({ stage: 'push' })).toEqual({ code: 'UNKNOWN', causes: [] });
});

test('the prebuild failure result carries literal measured codes and stage receipts', () => {
  const receipt = [{ stage: 'clone' as const, exit: 1, ok: false, reason: 'probe failed' }];
  const cases = [
    [{ osErrorCode: 'ENOSPC' }, 'DISK_FULL'],
    [{ stateDirExists: false }, 'STATE_DIR_MISSING'],
    [{ mirrorComplete: false }, 'MIRROR_PARTIAL'],
    [{ packagePwaPresent: false }, 'PACK_MISSING_PWA'],
    [{ registryPresent: false }, 'REGISTRY_ABSENT'],
    [{}, 'UNKNOWN'],
  ] as const;
  for (const [evidence, code] of cases) {
    expect(buildPrebuildFailure('probe failed', 'clone', receipt, evidence)).toEqual({
      outcome: 'failed', reason: 'probe failed', stage: 'clone', receipt, failureCode: code,
      causes: code === 'UNKNOWN' ? [] : [code],
    });
  }
});
