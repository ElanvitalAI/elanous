// `eln usage route ledger|pick|mark|policy` ⊕ `eln review <PR>` — LLM-ROUTE-BY-GUARDIAN entry points.
// Every refusal/skip prints its reason (stderr), so a blocked review says which value blocked it.
import { spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import { judgeReviewEnd } from './review-start.js';
import { buildLedger, decideRoute, reportResult, type RouteDef } from './router.js';
import { liveRouterPorts, routeLlm } from './route-store.js';

const stateRoot = () => (require('../instance/resolve.js') as typeof import('../instance/resolve.js')).effectiveInstanceRoot();

export function registerRouteCommands(usage: Command): void {
  const route = usage.command('route').description('LLM router (guardian 연료관): one provider ledger · policy table (data) · route health — which account/model each use gets and why');
  route.command('ledger').description('Per route: remaining % · health (last ok/fail · class) · cost class').option('--json')
    .action((o: { json?: boolean }) => {
      const p = liveRouterPorts(stateRoot()); const u = p.readUsage(); const s = p.readState();
      const rows = buildLedger(p.policy, u?.accounts ?? [], s.health, p.now(), u?.ts);
      if (o.json) { console.log(JSON.stringify({ usageTs: u?.ts ?? null, rows })); return; }
      console.log(`usage snapshot ${u ? new Date(u.ts).toISOString() : 'none'}${p.overrideError ? ` · policy warning: ${p.overrideError}` : ''}`);
      for (const r of rows) console.log(`${r.route.padEnd(15)} ${`${r.provider}/${r.model}`.padEnd(26)} ${r.cost.padEnd(12)} left ${r.remainingPct === null ? '?' : `${Math.round(r.remainingPct)}%`}`.padEnd(70) + ` ${r.healthy ? 'healthy' : 'DOWN'} · ${r.health}`);
    });
  route.command('pick <use>').description('Pick the route for a use (review · compaction · capsule · hand-hard|medium|easy · voice · ta)')
    .option('--ref <ref>', 'job ref (PR@head) — scopes failure-count rules').option('--exclude <csv>', 'routes already tried').option('--json')
    .action((use: string, o: { ref?: string; exclude?: string; json?: boolean }) => {
      const d = decideRoute(liveRouterPorts(stateRoot()), use, { ...(o.ref ? { ref: o.ref } : {}), ...(o.exclude ? { exclude: o.exclude.split(',').map(x => x.trim()).filter(Boolean) } : {}) });
      if (o.json) console.log(JSON.stringify(d));
      else {
        for (const s of d.skipped) console.error(`skip ${s.route}: ${s.reason}`);
        if (d.alarm) console.error(d.alarm);
        console.log(d.route ? `${d.route} ${d.def!.provider}/${d.def!.model} (${d.via})` : `none (${d.via})`);
      }
      if (!d.route) process.exitCode = 3;
    });
  route.command('mark <route>').description('Record a call result: --ok, or --error <text> (classified; bounded repair; card when spent)')
    .option('--ok').option('--error <text>').option('--ref <ref>').option('--json')
    .action((id: string, o: { ok?: boolean; error?: string; ref?: string; json?: boolean }) => {
      if (!o.ok && !o.error) { console.error('mark needs --ok or --error <text>'); process.exitCode = 2; return; }
      const r = reportResult(liveRouterPorts(stateRoot()), id, o.ok ? { ok: true } : { ok: false, error: o.error!, ...(o.ref ? { ref: o.ref } : {}) });
      console.log(o.json ? JSON.stringify(r) : o.ok ? `${id} ok` : `${id} ${r.class} · ${r.unhealthy ? 'down' : 'cleared'} · repair ${r.repair ? `${r.repair.steps.join('→')} = ${r.repair.result}` : '-'}${r.cardSent ? ' · card sent' : ''}`);
    });
  route.command('policy').description('The effective routing policy (from kit/resource-facts: <state>/resource-facts/policy.json keys llm · review · caps ⊕ defaults)')
    .action(() => { const p = liveRouterPorts(stateRoot()); if (p.overrideError) console.error(`policy warning: ${p.overrideError}`); console.log(JSON.stringify(p.policy, null, 2)); });
}

/** self review arguments for a route (engine → reviewer flags). */
export function selfReviewArgsFor(def: RouteDef): string[] {
  if (def.engine === 'claude-acp') return ['--acp', '--acp-backend', 'claude', '--acp-model', def.model];
  return ['--model', def.model];
}

function lastJson(text: string): Record<string, unknown> | null {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean).reverse();
  for (const l of lines) {
    if (!l.startsWith('{') && !l.startsWith('[')) continue;
    try { const v = JSON.parse(l) as unknown; const o = Array.isArray(v) ? v[v.length - 1] : v; if (o && typeof o === 'object') return o as Record<string, unknown>; } catch { /* next */ }
  }
  return null;
}

function prHead(pr: string): string | null {
  const r = spawnSync('gh', ['pr', 'view', pr, '--json', 'headRefOid', '-q', '.headRefOid'], { encoding: 'utf8', timeout: 40_000 });
  const h = (r.stdout ?? '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/u.test(h) ? h : null;
}

/** Persist a verdict only after its head was re-verified (never on re-queue): review-results/route-<route>-<PR>-<head12>.json.
 *  A grok review is recorded as `reviewer=grok(fallback)` with why (CEO rule 11-11). */
function persistVerifiedReview(route: string, engine: string, pr: string, head: string, result: Record<string, unknown>, why: string): void {
  try {
    const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const dir = join(stateRoot(), 'review-results'); mkdirSync(dir, { recursive: true });
    const file = join(dir, `route-${route}-${pr}-${head.slice(0, 12)}.json`);
    const tagged = engine === 'grok' ? { ...result, reviewer: 'grok(fallback)', fallbackReason: why.slice(0, 600) } : { ...result, reviewer: route };
    writeFileSync(file, `${JSON.stringify(tagged)}\n`);
    console.error(`[review route] saved ${file}${engine === 'grok' ? ' · reviewer=grok(fallback)' : ''}`);
  } catch (e) { console.error(`[review route] verdict not saved: ${e instanceof Error ? e.message : String(e)}`); }
}

/** Drop a caller's --save: the router persists only after the head re-check. */
function withoutSave(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === '--save') { i++; continue; } if (args[i]!.startsWith('--save=')) continue; out.push(args[i]!); }
  return out;
}

// 출처: CEO 11-27 brief — try at most this many routes for one review before the waiver path (each failure marks health).
const MAX_ROUTES_PER_REVIEW = 4;

export function registerReviewCommand(program: Command): void {
  program.command('review <pr> [extra...]')
    .description('Review a PR on the route the guardian\'s policy picks (Terra first · Claude ACP when healthy · grok after 2 Terra overloads and <70% · never GLM). Prints every skip/refusal reason. Extra args go to `self review`.')
    .allowUnknownOption(true)
    .action((pr: string, extra: string[] = []) => {
      const n = pr.replace(/^#/u, '');
      if (!/^\d+$/u.test(n)) { console.error(`review: not a PR number: ${pr}`); process.exitCode = 2; return; }
      const head = prHead(n);
      if (!head) { console.error(`review: could not read the head of #${n} (gh pr view)`); process.exitCode = 3; return; }
      const ports = liveRouterPorts(stateRoot());
      const ref = `${n}@${head.slice(0, 12)}`;
      const tried: string[] = []; let fullTried = extra.includes('--full');
      for (let attempt = 0; attempt < MAX_ROUTES_PER_REVIEW; attempt++) {
        const d = decideRoute(ports, 'review', { ref, exclude: tried });
        for (const s of d.skipped) console.error(`[review route] skip ${s.route}: ${s.reason}`);
        if (d.alarm) console.error(d.alarm);
        if (!d.route || !d.def) { console.error(`[review route] no route — ${d.via === 'wait' ? 'waiver path' : 'no candidate'} (#${n} ${head.slice(0, 12)})`); process.exitCode = 3; return; }
        console.error(`[review route] #${n} ${head.slice(0, 12)} → ${d.route} (${d.def.provider}/${d.def.model}) via ${d.via}`);
        const args = [process.argv[1]!, 'self', 'review', n, ...selfReviewArgsFor(d.def), '--json', ...withoutSave(extra), ...(fullTried && !extra.includes('--full') ? ['--full'] : [])];
        const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, ...(d.def.env ?? {}) }, maxBuffer: 32 * 1024 * 1024 });
        const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
        const result = lastJson(r.stdout ?? '');
        const end = judgeReviewEnd({ headAtStart: head, headNow: prHead(n), result: result as never, text });
        if (end.action === 'record' && result) persistVerifiedReview(d.route, d.def.engine, n, head, result, d.skipped.map(x => `${x.route}: ${x.reason}`).join(' · '));
        if (end.action === 'record') { reportResult(ports, d.route, { ok: true }); process.stdout.write(r.stdout ?? ''); console.error(`[review route] ${end.why}`); process.exitCode = r.status ?? 0; return; }
        if (end.action === 'requeue') { console.error(`[review route] ${end.why}`); process.exitCode = 75; return; }
        if (end.action === 'stop') { process.stdout.write(r.stdout ?? ''); console.error(`[review route] ${end.why}`); process.exitCode = r.status || 3; return; }
        if (end.action === 'retry-full' && !fullTried) { fullTried = true; console.error(`[review route] ${end.why}`); attempt--; continue; }
        const f = reportResult(ports, d.route, { ok: false, error: text.slice(-2000), ref });
        console.error(`[review route] ${d.route} failed (${f.class}): ${end.why}${f.repair ? ` · repair ${f.repair.steps.join('→')} = ${f.repair.result}` : ''}${f.cardSent ? ' · card sent' : ''}`);
        tried.push(d.route);
      }
      console.error(`[review route] ${MAX_ROUTES_PER_REVIEW} routes tried for #${n} — waiver path`); process.exitCode = 3;
    });
}

/** `eln route llm <use>` — the router as one entry under the shared `route` root (`route host <purpose>` = machines). */
export function registerRouteLlmCommand(program: Command): void {
  const root = program.commands.find(c => c.name() === 'route')
    ?? program.command('route').description('Ledger routing — every LLM and machine choice from the ledger (route llm · route host)');
  root.command('llm <use>').description('LLM route for a use: review · work · compaction · capsule · voice · ta (policy table ⊕ account facts ⊕ route health)')
    .option('--difficulty <tier>', 'work only: hard | medium | easy', 'medium').option('--ref <ref>', 'job ref (PR@head)').option('--exclude <csv>', 'routes already tried').option('--json')
    .action((use: string, o: { difficulty: string; ref?: string; exclude?: string; json?: boolean }) => {
      const difficulty = (['hard', 'medium', 'easy'].includes(o.difficulty) ? o.difficulty : 'medium') as 'hard' | 'medium' | 'easy';
      const d = routeLlm(use, { stateRoot: stateRoot(), difficulty, ...(o.ref ? { ref: o.ref } : {}), ...(o.exclude ? { exclude: o.exclude.split(',').map(x => x.trim()).filter(Boolean) } : {}) });
      if (o.json) console.log(JSON.stringify(d));
      else {
        for (const s of d.skipped) console.error(`skip ${s.route}: ${s.reason}`);
        if (d.alarm) console.error(d.alarm);
        console.log(d.route ? `${d.route} ${d.def!.provider}/${d.def!.model} (${d.via})` : `none (${d.via})`);
      }
      if (!d.route) process.exitCode = 3;
    });
}
