import { expect, test } from 'bun:test';
import { classifyPrebuildFailure } from './prebuild-failure-code.js';

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
