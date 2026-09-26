import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNextFluentRouteOpts } from './next-fluent-wiring.js';
import { resetUserConfig } from '../../user-config.js';
import { handleNextFluentPreview } from './next-fluent.js';

const preview = () => new Request('http://x/v1/next-fluent/preview', {
  method: 'POST',
  body: JSON.stringify({ refId: 'phase:1', refKind: 'task', outcome: 'failed', completedAt: 1 }),
});

describe('next-fluent route wiring', () => {
  test('empty nextFluent config opens the deterministic route without a persona lane', async () => {
    const originalXdg = process.env.XDG_CONFIG_HOME;
    const root = mkdtempSync(join(tmpdir(), 'next-fluent-route-'));
    process.env.XDG_CONFIG_HOME = root;
    resetUserConfig();
    try {
      const opts = buildNextFluentRouteOpts({
        lookupPhase: () => ({ isMissionPhase: true, status: 'failed', hasPr: false, missionCompleted: false, hasCritique: false }),
      });
      expect(opts.deps.enabled()).toBe(true);
      expect(opts.deps.laneCallable).toBeUndefined();
      const response = await handleNextFluentPreview(preview(), opts);
      expect(response.status).toBe(200);
      const card = (await response.json() as { card: { suggestions: unknown[]; transcript: string } }).card;
      expect(card.suggestions.length).toBeGreaterThan(0);
      expect(card.transcript).toBe('');
      mkdirSync(join(root, 'elanous'), { recursive: true });
      writeFileSync(join(root, 'elanous', 'config.json'), JSON.stringify({ nextFluent: { enabled: false, personas: false } }));
      resetUserConfig();
      expect(buildNextFluentRouteOpts().deps.enabled()).toBe(true);
      expect(buildNextFluentRouteOpts().deps.laneCallable).toBeUndefined();
      writeFileSync(join(root, 'elanous', 'config.json'), JSON.stringify({ nextFluent: { personas: true } }));
      resetUserConfig();
      const withPersona = buildNextFluentRouteOpts();
      expect(withPersona.deps.enabled()).toBe(true);
      expect(withPersona.deps.laneCallable).toBeDefined();
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdg;
      resetUserConfig();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
