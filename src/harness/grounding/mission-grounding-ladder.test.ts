import { describe, expect, it } from 'bun:test';
import { adaptiveGround, type GroundingDeps } from './mission-grounding-ladder.js';

const deps: GroundingDeps = {
  ground: async () => ({ grounded: true, context: 'shared grounding evidence', files: ['src/feature.ts'] }),
  readFiles: (files) => files.join('\n'),
  gitProbe: async () => '',
  callSites: async () => '',
  research: async () => '',
  repoRoot: '/repo',
  assess: async () => '{"confidence":"high","nextTier":"none"}',
  maxTier: 1,
};

describe('shared mission grounding ladder', () => {
  it('returns adaptive grounding evidence from the extracted implementation', async () => {
    const result = await adaptiveGround('verify shared grounding', { seedFiles: ['src/feature.ts'] }, deps);

    expect(result).toMatchObject({
      context: expect.stringContaining('shared grounding evidence'),
      files: ['src/feature.ts'],
      confidence: 'high',
      grounded: true,
      tiersUsed: ['skim'],
    });
  });
});
