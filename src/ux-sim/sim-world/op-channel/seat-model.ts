// SIM-WORLD op-channel · OP-SEAT-MODEL (SEAT-MODEL-SURVIVES-MIGRATION): OP's `/model deep` must survive the els update-all
// migration (a new process = no in-memory session override). Normal · edge · fault, five seeds, literal expectations (rule 11).
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _resetSessionTierOverridesForTesting, getSessionTierOverride } from '../../../model-tier/session-override.js';
import { applyNextTuiModelTier, restoreSeatTier, seatTierPath } from '../../../tui/slash/model.js';
import { nextTuiFooterModel } from '../../../tui/chat/status-model.js';
import type { SimWorldScenario, SimWorldScenarioOutcome } from '../types.js';

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
/** Literal per seed: which /model the seat chose and the tier it must come back with. */
const CASES = [
  { seat: 'OP', choice: 'deep', tier: 'best' }, { seat: 'OP', choice: 'fast', tier: 'budget' }, { seat: 'TC', choice: 'normal', tier: 'balanced' },
  { seat: 'UX', choice: 'deep', tier: 'best' }, { seat: 'OPT', choice: 'fast', tier: 'budget' },
] as const;

export const simWorldScenarios: readonly SimWorldScenario[] = [{
  id: 'OP-SEAT-MODEL',
  title: 'a seat /model choice survives a migration (new process) · a session that already chose keeps it · a corrupt or unwritable store never breaks the session choice',
  async run(ctx) {
    try {
      for (let i = 0; i < 5; i++) {
        const seed = ctx.seed + i; const c = CASES[((seed % 5) + 5) % 5]!;
        const root = join(ctx.universeRoot, `seat-s${seed}`);
        // normal: choose → migrate (drop memory) → restored
        applyNextTuiModelTier(`before-${seed}`, c.tier, c.choice, { seat: c.seat, root });
        _resetSessionTierOverridesForTesting();
        const back = restoreSeatTier(`after-${seed}`, { seat: c.seat, root });
        if (back?.tier !== c.tier || getSessionTierOverride(`after-${seed}`)?.llm !== c.tier) return fail('lost-on-migration', `seed ${seed}: ${c.seat} chose ${c.choice}, after migration ${back?.tier ?? 'none'} (want ${c.tier})`);
        // the footer names the restored model, not the config route badge (live 11:2x: turns on sol · footer said terra)
        if (nextTuiFooterModel(`after-${seed}`, `openai-codex/m-${c.tier}`, 'gpt-6.1-terra') !== `openai-codex/m-${c.tier}`) return fail('footer-shows-route', `seed ${seed}`);
        // edge: a session that already has a choice is never overwritten by the seat file
        applyNextTuiModelTier(`own-${seed}`, 'budget', 'fast', { seat: '', root });
        if (restoreSeatTier(`own-${seed}`, { seat: c.seat, root }) !== null || getSessionTierOverride(`own-${seed}`)?.llm !== 'budget') return fail('overwrote-session', `seed ${seed}`);
        // fault 1: a corrupt seat file restores nothing (the default tier applies; no throw)
        const bad = join(ctx.universeRoot, `bad-s${seed}`);
        mkdirSync(join(bad, 'seat-model'), { recursive: true });
        writeFileSync(seatTierPath(bad, c.seat), '{"tier":"best","choice":');
        if (restoreSeatTier(`corrupt-${seed}`, { seat: c.seat, root: bad }) !== null) return fail('corrupt-restored', `seed ${seed}`);
        // fault 2: an unwritable store — the session choice still holds
        const ro = join(ctx.universeRoot, `ro-s${seed}`);
        mkdirSync(join(ro, 'seat-model'), { recursive: true });
        chmodSync(join(ro, 'seat-model'), 0o500);
        try { applyNextTuiModelTier(`ro-${seed}`, c.tier, c.choice, { seat: c.seat, root: ro }); }
        catch (e) { return fail('store-error-thrown', `seed ${seed}: ${String(e)}`); }
        finally { chmodSync(join(ro, 'seat-model'), 0o700); }
        if (getSessionTierOverride(`ro-${seed}`)?.llm !== c.tier) return fail('session-choice-lost', `seed ${seed}`);
        _resetSessionTierOverridesForTesting();
      }
      ctx.recorder.event('op-channel:seat-model', { seeds: 5 });
      return { ok: true };
    } finally { _resetSessionTierOverridesForTesting(); }
  },
}];
