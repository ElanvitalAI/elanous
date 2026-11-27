// `eln policy …` — the LLM account policy pack (LLM-ACCOUNT-POLICY-YAML · CEO 11-27 16:2x/16:3x).
//   eln policy show [llm-accounts] [--json]          effective values ⊕ layer of each · revision · phase · consumers
//   eln policy lint [llm-accounts] [--file <yaml>]    lint the pack ⊕ live overlay (or a candidate file) · exit 1 on error
//   eln policy explain [llm-accounts] [--account x]   the decision chain («credits OFF because override by 대표 until …»)
//   eln policy override set --scope s --action a --why w [--until <ISO|6h>] [--until-event reset:…] [--crown <decision id>]
//   eln policy override ls [--all] [--json] · eln policy override clear <id> --why w [--crown <decision id>]
//   The actor is the caller's seat identity (OP · RES · GUARDIAN); CEO only via --crown (a decision in the ledger).
// Exit codes: 0 = ok · 1 = lint error / refused · 2 = usage.
import type { Command } from 'commander';
import { readFileSync } from 'node:fs';

const PACKS = ['llm-accounts'];
const checkPack = (name: string | undefined): boolean => {
  if (!name || PACKS.includes(name)) return true;
  console.error(`policy: unknown pack ${name} (${PACKS.join(' · ')})`); process.exitCode = 2; return false;
};

/** The acting identity: the caller's seat (ELANOUS_TRACK · ELANOUS_SEAT · seats/<X> cwd) — never a free flag; CEO only
 *  when carrying out a decision (`--crown <id>`, checked against the decisions ledger). */
function actorOf(crown: string | undefined): string {
  if (crown?.trim()) return 'CEO';
  const { callerSeat } = require('../mail-route/sender.js') as typeof import('../mail-route/sender.js');
  return callerSeat() ?? '';
}

export function registerPolicyCommands(program: Command): void {
  const policy = program.command('policy').description('Policy packs (graphs/policies/*.yaml ⊕ live overlay) — llm-accounts: credits · caps · route order · levels · phases · overrides');
  policy.command('show [pack]').description('Effective values, the layer that set each, revision, phase, overrides and consumer revisions').option('--json')
    .action(async (pack: string | undefined, o: { json?: boolean }) => {
      if (!checkPack(pack)) return;
      const a = await import('./llm-accounts.js'); const d = await import('./llm-decide.js');
      const loaded = a.loadLlmAccountPack();
      const dec = d.llmAccountDecision();
      const consumers = d.judgeConsumers(d.readAppliedReports(), { revision: loaded.revision, changedAtMs: loaded.changedAtMs });
      if (o.json) { console.log(JSON.stringify({ loaded, decision: dec, consumers })); return; }
      console.log(`llm-accounts rev ${loaded.revision ?? '(none)'} · pack ${loaded.packPath}${loaded.overlayApplied ? ` ⊕ overlay ${loaded.overlayPath}` : ''}`);
      if (!loaded.pack) console.log('  ⚠ no usable pack — consumers read the legacy config keys (llm.codexQuotaPolicy · llm.codexCreditAccounts · …)');
      console.log(`  phase ${dec.phase.value}${dec.phase.since ? ` since ${dec.phase.since}` : ''} (${dec.phase.winner?.layer ?? 'default'})${dec.phase.pending ? ` · ⏳ ${dec.phase.pending} awaits the CEO` : ''} · implementation ${dec.implementation.value} · fallback ${dec.fallback.join(' → ') || '-'}`);
      for (const [p, pp] of Object.entries(loaded.pack?.providers ?? {})) {
        const src = (k: string) => loaded.leafSources[`providers.${p}.${k}`] ?? 'pack';
        if (pp.weeklyCapPercent !== null) console.log(`  ${p} weekly cap ${pp.weeklyCapPercent}% [${src('weekly_cap_percent')}]`);
        if (pp.fallbackModel) console.log(`  ${p} fallback model ${pp.fallbackModel} [${src('fallback_model')}]`);
        for (const acc of pp.order) {
          const ap = pp.accounts[acc]!; const ad = dec.accounts.find(x => x.id === `${p}:${acc}`);
          const denied = Object.entries(ap.uses).filter(([, v]) => !v).map(([u]) => u);
          console.log(`  ${p}:${acc} ${ap.capPercent === null ? 'no subscription window' : `cap ${ap.capPercent}%`} [${src(`accounts.${acc}.subscription_cap_percent`)}] · credits ${String(ap.credits)} [${src(`accounts.${acc}.credits`)}]${denied.length ? ` · never for ${denied.join(',')} [${src(`accounts.${acc}.uses`)}]` : ''} → now ${ad?.credits.value ? 'ON' : 'OFF'}${ap.dailyCreditBudget !== null ? ` · daily budget ${ap.dailyCreditBudget}` : ''}${ap.creditFloor !== null ? ` · floor ${ap.creditFloor}` : ''} · level ${ad?.level ?? 'L0'}/${ad?.creditLevel ?? 'L0'}`);
        }
      }
      for (const [p, r] of Object.entries(dec.route)) console.log(`  route ${p}: ${r.join(' → ') || '(none)'}`);
      for (const [p, c] of Object.entries(dec.creditRoute)) console.log(`  credit route ${p} (${c.order} [${loaded.leafSources[`providers.${p}.credit_order`] ?? 'pack'}]): ${c.accounts.join(' → ') || '(none)'}`);
      console.log(`  overrides active ${dec.overrides.active.length} · expired ${dec.overrides.expired.length} · conflicts ${dec.conflicts.length}`);
      for (const c of consumers) console.log(`  consumer ${`${c.consumer}@${c.report.host}:${c.report.pid}`.padEnd(34)} ${c.status.padEnd(7)} ${c.why}`);
      for (const w of dec.warnings) console.log(`  ⚠ ${w}`);
    });
  policy.command('lint [pack]').description('Lint the pack ⊕ live overlay (or --file <candidate.yaml> merged over the repo pack)').option('--file <path>').option('--json')
    .action(async (pack: string | undefined, o: { file?: string; json?: boolean }) => {
      if (!checkPack(pack)) return;
      const a = await import('./llm-accounts.js');
      const { parseDocument } = await import('yaml');
      let result: { revision: string | null; errors: readonly string[]; warnings: readonly string[]; overlayApplied?: boolean };
      if (o.file) {
        let raw: unknown;
        try { const doc = parseDocument(readFileSync(o.file, 'utf8'), { uniqueKeys: true }); if (doc.errors.length) throw new Error(doc.errors.map(e => e.message).join('; ')); raw = doc.toJS() ?? {}; }
        catch (e) { console.error(`policy lint: ${o.file}: ${String(e).slice(0, 200)}`); process.exitCode = 1; return; }
        const base = (() => { try { return parseDocument(readFileSync(a.packPath(), 'utf8')).toJS(); } catch { return {}; } })();
        const merged = a.mergeRaw(base, raw);
        const l = a.lintPack(merged);
        result = { revision: l.pack ? a.packRevision(merged) : null, errors: l.errors, warnings: l.warnings };
      } else {
        a.resetLlmAccountPackCache();
        const l = a.loadLlmAccountPack();
        // An overlay that was dropped is an error for lint (it is only a warning for the running consumers).
        const dropped = l.warnings.filter(w => w.startsWith('overlay ignored'));
        result = { revision: l.revision, errors: [...l.errors, ...dropped, ...(l.pack ? [] : ['no usable pack'])], warnings: l.warnings.filter(w => !dropped.includes(w)), overlayApplied: l.overlayApplied };
      }
      if (o.json) console.log(JSON.stringify(result));
      else {
        for (const e of result.errors) console.log(`✗ ${e}`);
        for (const w of result.warnings) console.log(`⚠ ${w}`);
        console.log(result.errors.length ? `llm-accounts: ${result.errors.length} error(s)` : `llm-accounts: ok · rev ${result.revision}${result.overlayApplied ? ' (overlay applied)' : ''}`);
      }
      if (result.errors.length) process.exitCode = 1;
    });
  policy.command('explain [pack]').description('Why each knob is what it is — policy ⊕ level/phase ⊕ overrides, winner first').option('--account <name>').option('--json')
    .action(async (pack: string | undefined, o: { account?: string; json?: boolean }) => {
      if (!checkPack(pack)) return;
      const d = await import('./llm-decide.js');
      const dec = d.llmAccountDecision();
      if (o.json) { console.log(JSON.stringify(o.account ? { ...dec, accounts: dec.accounts.filter(a => a.account === o.account || a.id === o.account) } : dec)); return; }
      for (const line of d.explainLines(dec, o.account)) console.log(line);
    });
  const ov = policy.command('override').description('Interventions as ledger facts (CEO > safety > OP/RES > guardian auto) — each one expires');
  ov.command('set').description('Set an override (default until = pack overrides.default_hours)')
    .requiredOption('--scope <scope>', '<provider>:<account>[:credits] · <provider> · *')
    .requiredOption('--action <action>', 'demote|skip|tier_down|credits_deny|credits_allow|fallback:<n>|mode:<phase>')
    .requiredOption('--why <text>').option('--until <time>', 'ISO time or <n>m|h|d').option('--until-event <event>', 'reset:<provider>:<account>[,…]')
    .option('--crown <decision-id>', 'carry out a CEO decision (decisions ledger id) answered with the option naming «<action> <scope>» (mode:/fallback: alone) — ranks CEO').option('--json')
    .action(async (o: { scope: string; action: string; why: string; until?: string; untilEvent?: string; crown?: string; json?: boolean }) => {
      const m = await import('./llm-override.js');
      const r = m.setOverride({ by: actorOf(o.crown), scope: o.scope, action: o.action, why: o.why,
        ...(o.until ? { until: o.until } : {}), ...(o.untilEvent ? { untilEvent: o.untilEvent } : {}), ...(o.crown ? { ref: o.crown } : {}) });
      if ('error' in r) { console.error(`policy override set: ${r.error}`); process.exitCode = 1; return; }
      console.log(o.json ? JSON.stringify(r.event) : `${r.event.id} · ${r.event.by} ${r.event.scope} ${r.event.action} until ${r.event.until}${r.event.untilEvent ? ` | ${r.event.untilEvent}` : ''}`);
    });
  ov.command('ls').description('Active overrides (--all = with the expired and why)').option('--all').option('--json')
    .action(async (o: { all?: boolean; json?: boolean }) => {
      const d = await import('./llm-decide.js');
      const dec = d.llmAccountDecision();
      if (o.json) { console.log(JSON.stringify(o.all ? dec.overrides : { active: dec.overrides.active })); return; }
      if (!dec.overrides.active.length) console.log('(no active override)');
      for (const x of dec.overrides.active) console.log(`${x.id} ${x.by.padEnd(8)} ${x.scope} ${x.action} until ${x.until}${x.untilEvent ? ` | ${x.untilEvent}` : ''} — ${x.why}`);
      if (o.all) for (const x of dec.overrides.expired) console.log(`✗ ${x.o.id} ${x.o.by.padEnd(8)} ${x.o.scope} ${x.o.action} — ${x.why}`);
    });
  ov.command('clear <id>').description('Clear an override (at or below your rank)').requiredOption('--why <text>').option('--crown <decision-id>', 'clear as the CEO (a decision answered with the option naming clear:<id>)')
    .action(async (id: string, o: { why: string; crown?: string }) => {
      const m = await import('./llm-override.js');
      const r = m.clearOverride({ by: actorOf(o.crown), id, why: o.why, ...(o.crown ? { ref: o.crown } : {}) });
      if ('error' in r) { console.error(`policy override clear: ${r.error}`); process.exitCode = 1; return; }
      console.log(`${id} cleared by ${r.event.by}`);
    });
}
