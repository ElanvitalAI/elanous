// `eln alloc …` — ALLOCATION-BUDGET: who uses which LLM / machine, how much, until when, for what — on the lease ledger.
//   ls [--all] [--json]                          holding (active · expired-unreclaimed) and queued allocations (--all = last 24h)
//   who [--since 24h] [--json]                   by verified identity (seat · loop agent · TA card · capsule chain) ⊕ metering KPI
//   by-purpose [--since 24h] [--json]            by purpose (p0-cell · cut · review · gate · work · compaction · voice · experiment)
//   by-period [--unit hour|day] [--since 24h]    by KST hour / day
//   top [--provider p] [--since 24h] [--json]    shares of one (scarce) provider per identity
//   budget [--json]                              burn vs budget · forecast to exhaustion · paid cap · policy source
//   summary                                      the one line for the OP pulse / fed snapshot
//   advise [--land-queue n --ready n --judge n --hands-idle n] [--raise] [--json]   budget advisor proposals
//   grant --llm <provider[/model]> | --host <host> [--slots n] [--purpose k] [--ref r] [--ttl-min m] [--est-tokens n --est-usd n]
//   release <id> [--in n --out n --usd n --billing b --cpu-min n]
//   reclaim [--by who]                           TTL-expired leases → alloc.reclaim (the guardian runs this every pulse)
//   reconcile [--json]                           metered totals vs the provider usage snapshot (drift alert) → alloc-reconcile row
//   policy show | policy set <file.json>         budgets as data (OP · RES · GUARDIAN rows are trusted)
import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import type { AllocBudgetPolicy, AllocPurposeKind, AllocUsage } from './alloc-events.js';
import type { AllocGroup, AllocRow } from './fold.js';

const out = (s: string): void => { process.stdout.write(s.endsWith('\n') ? s : `${s}\n`); };
const parseSince = (s: string | undefined, now: Date): number => {
  const m = /^(\d+)\s*([mhd])$/.exec((s ?? '24h').trim());
  if (!m) return now.getTime() - 24 * 3_600_000;
  return now.getTime() - Number(m[1]) * (m[2] === 'd' ? 86_400_000 : m[2] === 'h' ? 3_600_000 : 60_000);
};
const usd = (n: number) => `$${n.toFixed(2)}`;
const short = (iso: string | undefined) => (iso ? iso.slice(5, 16).replace('T', ' ') : '-');
const resLine = (r: AllocRow) => r.resource.type === 'llm' ? `llm ${r.resource.provider}${r.resource.model ? `/${r.resource.model}` : ''}` : `host ${r.resource.host}×${r.resource.cpuSlots}`;

function groupTable(groups: readonly AllocGroup[]): string {
  if (!groups.length) return '(없음)';
  return groups.map(g => `${g.key.padEnd(28)} ${String(g.grants).padStart(4)}건  보유 ${g.holding}  대기 ${g.queued}  ${String(Math.round(g.share * 100)).padStart(3)}%  tok ${g.tokens}  ${usd(g.usd)} (유료 ${usd(g.paidUsd)})  cpu ${g.cpuMin.toFixed(1)}m  ${(g.durationMs / 60_000).toFixed(0)}분${g.chain ? `  · ${g.chain}` : ''}`).join('\n');
}

export function registerAllocCommands(program: Command): void {
  const alloc = program.command('alloc').description('ALLOCATION-BUDGET — LLM·머신 할당(신원·목적·기간·실사용) ⊕ 예산 — 임대 장부 위');
  const view = async () => (await import('./alloc.js')).allocView();

  alloc.command('ls').description('보유·대기 중 할당 (--all = 최근 24h 전부)').option('--all').option('--json').action(async (o: { all?: boolean; json?: boolean }) => {
    const v = await view();
    const { since, isHolding } = await import('./fold.js');
    // A queued request older than its TTL is no longer waiting (its caller moved on); --all still shows it.
    const waiting = (r: AllocRow) => r.state === 'queued' && v.now.getTime() - Date.parse(r.reservedAt) < r.ttlMs;
    const rows = o.all ? since(v.rows, v.now.getTime() - 86_400_000) : v.rows.filter(r => isHolding(r) || waiting(r));
    if (o.json) return out(JSON.stringify(rows, null, 2));
    const { chainLine } = await import('./identity.js');
    out(rows.length ? rows.map(r => `${r.state.padEnd(9)} ${r.id}  ${resLine(r)}  ${r.purpose.kind}${r.purpose.ref ? `:${r.purpose.ref}` : ''}  ${chainLine(r.who)}  ${short(r.grantedAt ?? r.reservedAt)} → ${r.state === 'queued' ? `ETA ${short(r.etaAt ?? undefined)}` : short(r.expiresAt)}${r.mode && r.mode !== 'granted' ? `  [${r.mode}] ${r.reason}` : ''}`).join('\n') : '(할당 없음)');
  });

  const grouped = (name: string, desc: string, fn: (rows: AllocRow[], policy: AllocBudgetPolicy, o: Record<string, string | boolean | undefined>) => Promise<AllocGroup[]>, extra?: (c: Command) => Command) => {
    const c = alloc.command(name).description(desc).option('--since <dur>', '24h · 7d · 90m', '24h').option('--json');
    (extra ? extra(c) : c).action(async (o: Record<string, string | boolean | undefined>) => {
      const v = await view();
      const { since, meteringKpi } = await import('./fold.js');
      const rows = since(v.rows, parseSince(o.since as string | undefined, v.now));
      const groups = await fn(rows, v.policy, o);
      const kpi = meteringKpi(rows);
      if (o.json) return out(JSON.stringify({ groups, kpi }, null, 2));
      out(`${groupTable(groups)}\n— 미터링 KPI: 미귀속 ${kpi.unattributed}/${kpi.total} (${Math.round(kpi.unattributedShare * 100)}%) · 목적 미상 ${kpi.unspecified}/${kpi.total} (${Math.round(kpi.unspecifiedShare * 100)}%) · 목표 0%`);
    });
  };
  grouped('who', '신원별 (자리·루프 에이전트·TA 카드·캡슐 사슬)', async (rows, p) => (await import('./fold.js')).byWho(rows, p));
  grouped('by-purpose', '목적별', async (rows, p) => (await import('./fold.js')).byPurpose(rows, p));
  grouped('by-period', 'KST 시간·일별', async (rows, p, o) => (await import('./fold.js')).byPeriod(rows, o.unit === 'day' ? 'day' : 'hour', p), c => c.option('--unit <u>', 'hour | day', 'hour'));
  grouped('top', '자원(공급자) 하나의 신원별 몫', async (rows, p, o) => (await import('./fold.js')).topConsumers(rows, p, o.provider as string | undefined), c => c.option('--provider <p>'));

  alloc.command('budget').description('예산 대비 소진 속도·소진 예측').option('--json').action(async (o: { json?: boolean }) => {
    const v = await view();
    const { budgetView } = await import('./fold.js');
    const b = budgetView(v.rows, v.policy, v.snap, v.now);
    if (o.json) return out(JSON.stringify(b, null, 2));
    out([`예산 ${b.day} (KST) · 정책 ${b.policySource}${v.policy.mode ? ` · 모드 ${v.policy.mode}` : ''}${v.snap ? '' : ' · ⚠ 잔량 스냅숏 없음 (eln usage status-cache)'}`,
      ...b.rows.map(r => `${r.provider.padEnd(11)} 창 ${r.usedPct === null ? '?' : `${Math.round(r.usedPct)}%`}${r.capPct !== null ? `/${r.capPct}%` : ''}${r.resetsIn ? ` (리셋 ${r.resetsIn})` : ''}  오늘 ${usd(r.todayUsd)}${r.dailyUsd !== null ? `/$${r.dailyUsd}` : ''}  소진 ${usd(r.burnUsdPerHour)}/h${r.hoursToDailyCap !== null ? `  일 예산까지 ${r.hoursToDailyCap.toFixed(1)}h` : ''}  보유 ${r.holding}${r.alert ? `  ⚠ ${r.alert}` : ''}`),
      `유료 합계 오늘 ${usd(b.paidTodayUsd)}/$${b.paidDailyCapUsd}${b.openRouterBalanceUsd !== null ? ` · OpenRouter 잔액 ${usd(b.openRouterBalanceUsd)}` : ''}${b.paidAlert ? ` · ⚠ ${b.paidAlert}` : ''}`].join('\n'));
  });

  alloc.command('summary').description('OP 펄스·연방 스냅숏 한 줄').action(async () => {
    const v = await view();
    out((await import('./fold.js')).allocSummaryLine(v.rows, v.policy, v.snap, v.now));
  });

  alloc.command('advise').description('예산 자문 — VM 투입·수리·충전·모드 전환·재배분 제안 (돈 → CEO 결정 카드)')
    .option('--land-queue <n>').option('--ready <n>').option('--judge <n>').option('--hands-idle <n>').option('--raise', 'money proposals → decisions raise (dedup per KST day)').option('--json')
    .action(async (o: { landQueue?: string; ready?: string; judge?: string; handsIdle?: string; raise?: boolean; json?: boolean }) => {
      const v = await view();
      const { budgetView } = await import('./fold.js');
      const { adviseBudget, proposalCard } = await import('./advisor.js');
      const { liveAdvisorWorld } = await import('./advisor-live.js');
      const n = (s?: string) => (s !== undefined && Number.isFinite(Number(s)) ? Number(s) : undefined);
      const q = [n(o.landQueue), n(o.ready), n(o.judge), n(o.handsIdle)];
      let queues = q.some(x => x !== undefined) ? { landQueue: q[0] ?? 0, readyCells: q[1] ?? 0, judgeQueue: q[2] ?? 0, handsIdle: q[3] ?? 0 } : null;
      if (!queues) {
        // The federation snapshot already measures these: land pending · judge queue · open release cells · idle hands.
        try {
          const { collectFedSources } = await import('../fed-observe/sources-live.js');
          const { sources: s } = await collectFedSources(v.now);
          if (s.land || s.judge || s.release || s.pool) queues = { landQueue: s.land?.pending ?? 0, judgeQueue: s.judge?.queue ?? 0,
            readyCells: s.release ? Math.max(0, s.release.total - s.release.green) : 0, handsIdle: (s.pool ?? []).filter(p => p.state === 'idle').length };
        } catch { /* queues stay unmeasured */ }
      }
      const world = liveAdvisorWorld(v.snap);
      const proposals = adviseBudget({ budget: budgetView(v.rows, v.policy, v.snap, v.now), rows: v.rows, policy: v.policy, ...world, queues, now: v.now });
      const raised: string[] = [];
      if (o.raise) {
        const { DecisionLedger } = await import('../decisions/decision-ledger.js');
        const { kstDay } = await import('./policy.js');
        const ledger = new DecisionLedger();
        const open = ledger.list({ status: 'open' });
        for (const p of proposals.filter(x => x.route === 'ceo')) {
          const card = proposalCard(p, kstDay(v.now));
          if (open.some(e => e.refs?.includes(card.refs[0]!))) continue;
          raised.push(ledger.raise({ ...card, options: [...card.options] }).id);
        }
      }
      if (o.json) return out(JSON.stringify({ proposals, raised, queues: queues ?? 'not given' }, null, 2));
      out(proposals.length ? proposals.map(p => `${p.route === 'ceo' ? 'CEO' : 'guardian'} [${p.kind}] ${p.title}${p.costUsd ? ` · $${p.costUsd}` : ''}\n   왜: ${p.why}\n   효과: ${p.effect} · 추천 ${p.recommend}`).join('\n') : '제안 없음');
      if (!queues) out('— 대기열 입력 없음: VM·착지 병목 판정은 --land-queue/--ready/--judge/--hands-idle 를 줄 때만');
      if (raised.length) out(`— CEO 결정 카드: ${raised.join(' · ')}`);
    });

  alloc.command('grant').description('할당 요청 (신원 = 이 프로세스 맥락 · 직접 입력 없음)')
    .option('--llm <provider/model>').option('--host <host>').option('--slots <n>', '', '1').option('--purpose <kind>').option('--ref <ref>')
    .option('--ttl-min <m>', '', '60').option('--est-tokens <n>').option('--est-usd <n>').option('--meter', 'record an existing placement (no decision)').option('--json')
    .action(async (o: { llm?: string; host?: string; slots: string; purpose?: string; ref?: string; ttlMin: string; estTokens?: string; estUsd?: string; meter?: boolean; json?: boolean }) => {
      const a = await import('./alloc.js');
      if (!o.llm === !o.host) { process.stderr.write('alloc grant: give exactly one of --llm or --host\n'); process.exitCode = 2; return; }
      const [provider, ...model] = (o.llm ?? '').split('/');
      const resource = o.llm ? { type: 'llm' as const, provider: provider!, ...(model.length ? { model: model.join('/') } : {}) } : { type: 'host' as const, host: o.host!, cpuSlots: Math.max(1, Number(o.slots) || 1) };
      const input = { consumer: 'manual' as const, resource, ttlMs: Math.max(1, Number(o.ttlMin) || 60) * 60_000,
        amount: { ...(o.estTokens ? { tokens: Number(o.estTokens) } : {}), ...(o.estUsd ? { usd: Number(o.estUsd) } : {}) },
        ...(o.purpose ? { purpose: o.purpose as AllocPurposeKind } : {}), ...(o.ref ? { ref: o.ref } : {}) };
      const t = o.meter ? a.meter(input) : a.grant(input);
      if (o.json) return out(JSON.stringify(t, null, 2));
      out(`${t.status}${t.mode ? ` (${t.mode})` : ''} ${t.id} · ${t.resource.type === 'llm' ? t.resource.provider : t.resource.host} · ${t.purpose.kind} · ${t.who.kind}:${t.who.id} · ${t.reason}${t.etaAt ? ` · ETA ${t.etaAt}` : ''}${t.alerts.length ? ` · ⚠ ${t.alerts.join(' · ')}` : ''}`);
    });

  alloc.command('release <id>').description('반납 ⊕ 실사용').option('--in <n>').option('--out <n>').option('--usd <n>').option('--billing <b>', 'subscription | paid | unknown').option('--cpu-min <n>')
    .action(async (id: string, o: { in?: string; out?: string; usd?: string; billing?: string; cpuMin?: string }) => {
      const billing = o.billing === 'subscription' || o.billing === 'paid' || o.billing === 'unknown' ? o.billing : undefined;
      const u: Omit<AllocUsage, 'basis'> = { ...(o.in ? { inputTokens: Number(o.in) } : {}), ...(o.out ? { outputTokens: Number(o.out) } : {}),
        ...(o.usd ? { usd: Number(o.usd) } : {}), ...(o.cpuMin ? { cpuMin: Number(o.cpuMin) } : {}), ...(billing ? { billing } : {}) };
      const ok = (await import('./alloc.js')).release(id, Object.keys(u).length ? u : null);
      out(ok ? `released ${id}` : `not released (unknown or already closed): ${id}`);
      if (!ok) process.exitCode = 1;
    });

  alloc.command('reclaim').description('TTL 지난 할당 회수 (수호자 임대관)').option('--by <who>', '', 'loop:guardian').action(async (o: { by: string }) => {
    const ids = (await import('./alloc.js')).reclaimExpired({ by: o.by });
    out(ids.length ? `reclaimed ${ids.length}: ${ids.join(' ')}` : 'nothing expired');
  });

  alloc.command('reconcile').description('미터링 합계 vs 공급자 잔량 스냅숏 (드리프트 경보)').option('--json').action(async (o: { json?: boolean }) => {
    const v = await view();
    const { reconcileMetering } = await import('./reconcile.js');
    const r = await import('../resource-ledger/resource-ledger.js');
    const row = reconcileMetering(v.events, v.rows, v.snap, v.now);
    r.recordAllocEventsWith(r.resourceLedgerPath(), () => [row]);
    if (o.json) return out(JSON.stringify(row, null, 2));
    out(row.rows.map(x => `${x.alert ? '⚠' : '·'} ${x.provider.padEnd(11)} 미터 ${x.grants}건 tok ${x.meteredTokens} $${x.meteredUsd.toFixed(2)} · 공급자 ${x.providerUsedPct ?? '?'}%${x.deltaUsedPct !== null ? ` (Δ${x.deltaUsedPct > 0 ? '+' : ''}${x.deltaUsedPct})` : ''} · ${x.why}`).join('\n') || '(공급자 없음)');
  });

  const pol = alloc.command('policy').description('예산 정책 (데이터 · OP·RES·GUARDIAN 행만 신뢰)');
  pol.command('show').option('--json').action(async () => {
    const v = await view();
    out(JSON.stringify(v.policy, null, 2));
  });
  pol.command('set <file>').description('JSON 파일 하나 = 정책 한 행 (부분 필드 가능 · 기본값 위에 합쳐진다)').action(async (file: string) => {
    const { resolveCallerIdentity } = await import('./identity.js');
    const { mergePolicy, POLICY_WRITERS } = await import('./policy.js');
    const who = resolveCallerIdentity();
    const by = who.chain.find(l => l.kind === 'seat')?.id ?? who.id;
    const r = await import('../resource-ledger/resource-ledger.js');
    // A partial file changes only what it names: nested maps (providers · ceilings · hosts) merge key by key over the current policy.
    const current: AllocBudgetPolicy & { source?: string } = { ...(await view()).policy };
    delete current.source;
    const policy = mergePolicy(current, JSON.parse(readFileSync(file, 'utf8')) as Partial<AllocBudgetPolicy>);
    r.recordAllocEventsWith(r.resourceLedgerPath(), () => [{ event: 'alloc-budget-policy', at: new Date().toISOString(), by, policy }]);
    out(`policy ${policy.version} recorded by ${by}${(POLICY_WRITERS as readonly string[]).includes(by) ? '' : ' — ⚠ not a trusted writer (OP · RES · GUARDIAN): kept in the ledger, ignored by the allocator'}`);
  });
}
