// RES-POLICY-GUARDIAN — `eln res …`: the RES kingdom's policy, guardian patrol, shadow comparison and judgment capsule.
//   res policy show|check   — the single policy every seat/tool reads; in-policy = no RES approval (`res.policy allowed {rule}`)
//                             `check --actual <v> --actor <who>` = a decision point records the pair (guardian ⊕ actual) itself
//   res patrol [--dry-run|--shadow-cards] — one guardian patrol tick (graphs/ops/res-patrol.yaml runs it every 5 minutes);
//                             --shadow-cards = no actions, findings card every 30 min + Federation Board row
//   res shadow record       — the RES tab records its actual call; the guardian's «would» is written next to it
//   res shadow-report       — agreement %, disagreements (LOOP-AGENTS §2 rule 10)
//   res capsule "<q>"       — dormant RES: a one-question judgment brief (policy ⊕ lease ledger), optionally spawned
// Domain modules load inside the actions so registering `res` adds nothing to the CLI boot path.
import type { Command } from 'commander';
import type { ResAction } from '../res-policy/policy.js';
import { writeStdoutJson } from './stdout-json.js';

const ACTIONS = ['test', 'pregate', 'vm-start', 'vm-stop', 'vm-keep-on'] as const;
type ActionKind = typeof ACTIONS[number];

interface ActionOpts { action: string; host: string; universe?: string; inflight?: string; idleMinutes?: string; pressure?: boolean; spentUsd?: string; excludePid?: string }

const VERDICTS = ['allow', 'deny', 'ask'] as const;

/** Decision-point form: live context (heartbeats · inflight minus the caller's own lock · patrol idleSince) ⊕ explicit flags. */
async function contextActionFromOpts(opts: ActionOpts): Promise<{ action: ResAction; policy: import('../res-policy/policy.js').ResPolicy }> {
  const kind = opts.action as ActionKind;
  if (!ACTIONS.includes(kind)) throw new Error(`--action must be one of ${ACTIONS.join('|')}`);
  const host = opts.host.trim();
  if (!host) throw new Error('--host is required');
  const num = (value: string | undefined, name: string): number | undefined => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
    return n;
  };
  const excludePid = num(opts.excludePid, '--exclude-pid');
  const { contextAction, liveShadowContext } = await import('../res-policy/auto-record.js');
  const ctx = await liveShadowContext(excludePid !== undefined ? { excludePid } : {});
  const inflight = num(opts.inflight, '--inflight');
  const idleMinutes = num(opts.idleMinutes, '--idle-minutes');
  const spent = num(opts.spentUsd, '--spent-usd');
  const action = contextAction(kind, host, ctx, { ...(opts.universe === 'ops' ? { universe: 'ops' as const } : {}),
    ...(inflight !== undefined ? { inflight } : {}), ...(idleMinutes !== undefined ? { idleMinutes } : {}),
    ...(opts.pressure ? { pressure: true } : {}), ...(spent !== undefined ? { spentTodayUsd: spent } : {}) });
  return { action, policy: ctx.policy };
}

/** CLI flags → ResAction. `inflight` defaults to the live RES inflight count for the host. */
export function actionFromOpts(opts: ActionOpts, liveInflight: () => Record<string, number>): ResAction {
  const kind = opts.action as ActionKind;
  if (!ACTIONS.includes(kind)) throw new Error(`--action must be one of ${ACTIONS.join('|')}`);
  const host = opts.host.trim();
  if (!host) throw new Error('--host is required');
  const int = (value: string | undefined, name: string): number | undefined => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
    return n;
  };
  if (kind === 'test') return { kind, host, universe: opts.universe === 'ops' ? 'ops' : 'test' };
  if (kind === 'pregate') {
    const byHost = liveInflight();
    return { kind, host, inflight: int(opts.inflight, '--inflight') ?? byHost[host] ?? 0, inflightByHost: byHost };
  }
  if (kind === 'vm-start') return { kind, host, pressure: opts.pressure === true, spentTodayUsd: int(opts.spentUsd, '--spent-usd') ?? 0 };
  if (kind === 'vm-stop') return { kind, host, idleMinutes: int(opts.idleMinutes, '--idle-minutes') ?? 0 };
  return { kind, host };
}

function actionOptions(cmd: Command): Command {
  return cmd
    .requiredOption('--action <kind>', ACTIONS.join('|'))
    .requiredOption('--host <host>', 'target host')
    .option('--universe <u>', 'test (default) | ops — for --action test')
    .option('--inflight <n>', 'pregate runs in flight on the host (default: live RES inflight locks)')
    .option('--idle-minutes <n>', 'for vm-stop')
    .option('--pressure', 'for vm-start: local hosts are saturated')
    .option('--spent-usd <n>', 'for vm-start: cloud spend so far today')
    .option('--exclude-pid <pid>', "pregate: don't count this pid's own inflight lock (the caller already holds its slot)");
}

async function liveInflightFn(): Promise<() => Record<string, number>> {
  const { defaultPatrolRunDeps, pregateInflight } = await import('../res-policy/patrol-run.js');
  const deps = defaultPatrolRunDeps();
  return () => pregateInflight(deps.inflightDir(), deps.alive);
}

export function registerResCommands(program: Command): void {
  const res = program.command('res').description('RES 왕국 — 정책(단일 원본) · 수호자 순찰 · 그림자 비교 · 판단 캡슐');

  const policy = res.command('policy').description('RES 자원 정책');
  policy.command('show').description('유효 정책(코드 기본값 ⊕ 설정 res.policy) 출력')
    .option('--json', 'JSON 출력')
    .action(async (opts: { json?: boolean }) => {
      const { resolveResPolicy } = await import('../res-policy/policy.js');
      const { getUserConfig } = await import('../user-config/reader.js');
      const cfg = getUserConfig().res;
      const effective = resolveResPolicy(cfg);
      if (opts.json) await writeStdoutJson(JSON.stringify({ mode: cfg?.mode ?? 'shadow', dormant: cfg?.dormant === true, policy: effective }, null, 2) + '\n');
      else {
        console.log(`res policy ${effective.version} · mode=${cfg?.mode ?? 'shadow'} · dormant=${cfg?.dormant === true}`);
        console.log(`  pre-approved test hosts: ${effective.preApprovedTestHosts.join(' ')} · forbidden: ${effective.forbiddenTestHosts.join(' ')}`);
        console.log(`  cloud: ${effective.cloudHosts.join(' ')} · budget $${effective.vm.dailyBudgetUsd}/day · start at local load1 ≥ ${effective.vm.startWhenLocalLoad1} · stop after ${effective.vm.stopAfterIdleMinutes}m idle`);
        console.log(`  pregate slots: default ${effective.defaultPregateSlots} ${JSON.stringify(effective.pregateSlots)}`);
        console.log(`  load1 warn ${effective.load.warnLoad1} / critical ${effective.load.criticalLoad1} · free mem ≥ ${effective.load.minMemoryAvailablePercent}% · bun ≤ ${effective.load.maxBunPerLivePane}× live panes · TUI chain > ${effective.load.maxTuiProcessesPerSession} / ${Math.round(effective.load.maxBunRssMb / 1024)} GB`);
      }
    });
  actionOptions(policy.command('check').description('행동이 정책 안인지 판정(allow=0 · ask=3 · deny=4) — 정책 안이면 RES 에 묻지 않는다'))
    .option('--actual <verdict>', 'allow | deny | ask — 결정 지점이 실제로 내린 판정: 수호자 판정과 짝(pairId)으로 그림자 기록')
    .option('--actor <who>', '실제 판정 주체(pregate.py · hosts-cli …) — --actual 과 함께', 'res-tab')
    .option('--ref <ref>', '근거(head · 우편 번호 등)')
    .option('--json', 'JSON 출력')
    .action(async (opts: ActionOpts & { json?: boolean; actual?: string; actor: string; ref?: string }) => {
      if (opts.actual !== undefined) {
        if (!(VERDICTS as readonly string[]).includes(opts.actual)) { console.error('res policy check: --actual must be allow|deny|ask'); process.exitCode = 2; return; }
        const { writeShadowPair } = await import('../res-policy/auto-record.js');
        const { logResDecision } = await import('../res-policy/policy.js');
        let built: Awaited<ReturnType<typeof contextActionFromOpts>>;
        try { built = await contextActionFromOpts(opts); }
        catch (error) { console.error(`res policy check: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; return; }
        const pair = writeShadowPair({ action: built.action, actual: opts.actual as 'allow' | 'deny' | 'ask', actor: opts.actor, ...(opts.ref ? { ref: opts.ref } : {}) }, built.policy);
        logResDecision(built.action, pair.guardian, { via: 'cli', actor: opts.actor, actual: opts.actual, pairId: pair.pairId });
        if (opts.json) await writeStdoutJson(JSON.stringify({ action: built.action, ...pair.guardian, actual: opts.actual, agree: pair.agree, pairId: pair.pairId }) + '\n');
        else console.log(`res shadow ${pair.agree ? 'agree' : 'DISAGREE'} · ${built.action.kind} ${built.action.host}: actual=${opts.actual} (${opts.actor}) guardian=${pair.guardian.verdict} (${pair.guardian.rule}) · pair ${pair.pairId}`);
        process.exitCode = pair.guardian.verdict === 'allow' ? 0 : pair.guardian.verdict === 'ask' ? 3 : 4;
        return;
      }
      const { decideResAction, logResDecision, resolveResPolicy } = await import('../res-policy/policy.js');
      const { getUserConfig } = await import('../user-config/reader.js');
      const { recordResDecision } = await import('../resource-ledger/resource-ledger.js');
      const effective = resolveResPolicy(getUserConfig().res);
      let action: ResAction;
      try { action = actionFromOpts(opts, await liveInflightFn()); }
      catch (error) { console.error(`res policy check: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; return; }
      const decision = decideResAction(effective, action);
      logResDecision(action, decision, { via: 'cli' });
      try {
        recordResDecision({ source: 'guardian', action: action.kind, host: action.host, decision: decision.verdict, rule: decision.rule,
          policyVersion: effective.version, ref: 'policy-check' });
      } catch { /* the verdict stands even if the ledger is unwritable */ }
      if (opts.json) await writeStdoutJson(JSON.stringify({ action, ...decision }) + '\n');
      else console.log(`res.policy ${decision.verdict === 'allow' ? 'allowed' : decision.verdict === 'deny' ? 'denied' : 'ask'} ${decision.rule} — ${decision.detail}${decision.alternatives?.length ? ` · alternatives: ${decision.alternatives.join(' ')}` : ''}`);
      process.exitCode = decision.verdict === 'allow' ? 0 : decision.verdict === 'ask' ? 3 : 4;
    });

  res.command('patrol').description('수호자 순찰 한 틱(체인·부하·메모리·자격·pregate 슬롯·VM 압력) — 정책 밖은 «[수호자 · RES]» 카드')
    .option('--dry-run', '판정만 — 거두기·VM·카드·상태 기록 없음')
    .option('--shadow-cards', '그림자 + 카드: 거두기·VM 행동 0 · 정책 밖 발견은 30분 묶음 카드(RES · 휴면이면 OP) + Federation Board 줄')
    .option('--json', 'JSON 출력')
    .action(async (opts: { dryRun?: boolean; shadowCards?: boolean; json?: boolean }) => {
      if (opts.dryRun && opts.shadowCards) { console.error('res patrol: --dry-run and --shadow-cards are exclusive'); process.exitCode = 2; return; }
      const { defaultPatrolRunDeps, runResPatrolWith } = await import('../res-policy/patrol-run.js');
      const { beatSafe } = await import('../watch/heartbeat.js');
      let result: Awaited<ReturnType<typeof runResPatrolWith>>;
      try { result = await runResPatrolWith(defaultPatrolRunDeps(), { dryRun: opts.dryRun === true, shadowCards: opts.shadowCards === true }); }
      catch (error) {
        // WATCHER-HEARTBEAT — a crashing patrol is BROKEN on the watchers board, not a silent /tmp line.
        if (!opts.dryRun) beatSafe({ name: 'res-patrol', saw: 0, everyMin: 5, err: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      if (!opts.dryRun) beatSafe({ name: 'res-patrol', saw: result.findings.length, everyMin: 5, last: new Date().toISOString() });
      if (opts.json) await writeStdoutJson(JSON.stringify(result) + "\n");
      else {
        console.log(`res patrol ${result.outcome} · mode=${result.mode} · dormant=${result.dormant} · findings ${result.findings.length} (new ${result.fresh.length}, cleared ${result.cleared.length}) · reaped ${result.reaped.length} · vm ${result.vm.length} · card→${result.carded ?? '-'}${opts.dryRun ? ' · dry-run' : ''}${result.observeOnly ? ' · shadow-cards' : ''}${result.forcedShadow ? ` · forced shadow (${result.forcedShadow})` : ''}`);
        for (const finding of result.findings) console.log(`  ${result.fresh.includes(finding) ? 'NEW' : '   '} ${finding.severity} ${finding.rule} ${finding.subject}: ${finding.detail}`);
        for (const row of result.reaped) console.log(`  reap ${row.action} ${row.sessionId ?? '-'}: ${row.ok ? 'ok' : 'SKIP'} ${row.detail}`);
        for (const row of result.vm) console.log(`  vm ${row.action} ${row.host}: ${row.verdict} ${row.rule}${row.executed ? ' (executed)' : ''} — ${row.detail}`);
        for (const item of result.unmeasured) console.log(`  unmeasured: ${item}`);
      }
    });

  const shadow = res.command('shadow').description('그림자 — RES 탭 실제 판정과 수호자 «했을 판정» 짝 기록');
  actionOptions(shadow.command('record').description('RES 탭이 내린 판정을 기록(수호자 판정을 같은 pairId 로 옆에 기록)'))
    .requiredOption('--decision <verdict>', 'allow | deny | ask — RES 탭(또는 --actor)이 실제로 내린 판정')
    .option('--actor <who>', '실제 판정 주체(기본 res-tab)', 'res-tab')
    .option('--ref <ref>', '근거(우편 번호 등)')
    .option('--json', 'JSON 출력')
    .action(async (opts: ActionOpts & { decision: string; actor: string; ref?: string; json?: boolean }) => {
      if (!(VERDICTS as readonly string[]).includes(opts.decision)) { console.error('res shadow record: --decision must be allow|deny|ask'); process.exitCode = 2; return; }
      const { writeShadowPair } = await import('../res-policy/auto-record.js');
      let built: Awaited<ReturnType<typeof contextActionFromOpts>>;
      try { built = await contextActionFromOpts(opts); }
      catch (error) { console.error(`res shadow record: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; return; }
      const pair = writeShadowPair({ action: built.action, actual: opts.decision as 'allow' | 'deny' | 'ask', actor: opts.actor, ...(opts.ref ? { ref: opts.ref } : {}) }, built.policy);
      if (opts.json) await writeStdoutJson(JSON.stringify({ pairId: pair.pairId, agree: pair.agree, guardian: pair.guardian, res: opts.decision }) + '\n');
      else console.log(`res shadow ${pair.agree ? 'agree' : 'DISAGREE'} · ${built.action.kind} ${built.action.host}: res=${opts.decision} guardian=${pair.guardian.verdict} (${pair.guardian.rule}) · pair ${pair.pairId}`);
    });

  res.command('shadow-report').description('그림자 비교: 일치율 · 불일치 목록 · 표본(규칙 10)')
    .option('--hours <n>', '창(기본 24시간)', '24')
    .option('--accept-min-samples <n>', '수용 판정: 표본 ≥ n ∧ false-critical 0 ∧ missed-critical 0 ∧ 일치율 ≥ 80% → PASS(rc 0) · 아니면 FAIL(rc 1)')
    .option('--json', 'JSON 출력')
    .action(async (opts: { hours: string; acceptMinSamples?: string; json?: boolean }) => {
      const hours = Number(opts.hours);
      if (!Number.isFinite(hours) || hours <= 0) { console.error('res shadow-report: --hours must be positive'); process.exitCode = 2; return; }
      const minSamples = opts.acceptMinSamples === undefined ? undefined : Number(opts.acceptMinSamples);
      if (minSamples !== undefined && (!Number.isSafeInteger(minSamples) || minSamples < 1)) { console.error('res shadow-report: --accept-min-samples must be a positive integer'); process.exitCode = 2; return; }
      const { readResourceLedger } = await import('../resource-ledger/resource-ledger.js');
      const { formatShadowAcceptance, formatShadowReport, shadowAcceptance, shadowReport, shadowRows } = await import('../res-policy/shadow.js');
      const report = shadowReport(shadowRows(readResourceLedger()), new Date(Date.now() - hours * 3_600_000));
      const acceptance = minSamples === undefined ? null : shadowAcceptance(report, minSamples);
      if (opts.json) await writeStdoutJson(JSON.stringify(acceptance ? { ...report, acceptance } : report, null, 2) + '\n');
      else console.log(acceptance ? `${formatShadowReport(report)}\n${formatShadowAcceptance(acceptance)}` : formatShadowReport(report));
      if (acceptance && !acceptance.pass) process.exitCode = 1;
    });

  res.command('capsule <question>').description('RES 휴면 시 판단 캡슐 — 정책 ⊕ 임대 장부를 넣은 한 질문 브리프(--spawn 이면 미션으로 띄움)')
    .option('--spawn', '`eln mission run` 으로 서브에이전트를 띄운다')
    .option('--agent <agent>', 'codex | claude (기본 codex)', 'codex')
    .action(async (question: string, opts: { spawn?: boolean; agent: string }) => {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { spawnElanousSync } = await import('../instance/spawn-elanous.js');
      const { effectiveInstanceRoot } = await import('../instance/resolve.js');
      const { readResourceLedger } = await import('../resource-ledger/resource-ledger.js');
      const { resolveResPolicy } = await import('../res-policy/policy.js');
      const { getUserConfig } = await import('../user-config/reader.js');
      const { buildResCapsuleBrief } = await import('../res-policy/capsule.js');
      const { defaultPatrolRunDeps, heartbeatHosts, pregateInflight } = await import('../res-policy/patrol-run.js');
      const { debug } = await import('../debug/log.js');
      const now = new Date();
      const events = readResourceLedger();
      const deps = defaultPatrolRunDeps();
      const brief = buildResCapsuleBrief({ question, policy: resolveResPolicy(getUserConfig().res), events,
        hosts: heartbeatHosts(events, now), pregateInflight: pregateInflight(deps.inflightDir(), deps.alive), now });
      const dir = join(effectiveInstanceRoot(), 'loops', 'res-patrol', 'capsules');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${now.toISOString().replace(/[:.]/g, '-')}.md`);
      writeFileSync(path, brief, { mode: 0o600 });
      const agent = opts.agent === 'claude' ? 'claude' : 'codex';
      const argv = ['mission', 'run', '--agent', agent, '--prompt-file', path, '--output-format', 'json'];
      debug.log('res.capsule', opts.spawn ? 'spawn' : 'brief', { path, agent });
      if (!opts.spawn) { console.log(`res capsule brief: ${path}\nspawn: eln mission run --agent ${agent} --prompt-file ${path}`); return; }
      const run = spawnElanousSync(argv, { encoding: 'utf8', timeout: 60_000 });
      process.stdout.write(String(run.stdout ?? ''));
      if (run.status !== 0) { process.stderr.write(String(run.stderr ?? '')); process.exitCode = run.status ?? 1; }
    });
  // RES-READY-POOL-RESERVATION: leases are records; the res-burst-lease graph starts, registers, drains and stops.
  const lease = res.command('lease').description('burst lease — the res-burst-lease graph starts/registers/drains/stops the host');
  const leaseRoot = async (opts: { root?: string }) => {
    const { resRoot } = await import('../res-graphs/burst.js');
    const { homedir } = await import('node:os');
    const { join: joinPath } = await import('node:path');
    return opts.root ?? resRoot(process.env.ELANOUS_SEAT_STATE ?? joinPath(homedir(), 'elanous-hq', 'seat-state'));
  };
  lease.command('start <host>').description('request a lease (the graph activates it on its next tick)')
    .requiredOption('--reason <text>', 'why (shown on the board and receipts)')
    .option('--ttl <dur>', 'lease length: 4h · 90m', '4h').option('--budget <usd>', 'stop when spend reaches this (USD)')
    .option('--requester <seat>', 'who asked', process.env.ELANOUS_TRACK ?? 'OP').option('--root <dir>', 'state root (tests)')
    .action(async (host: string, opts: { reason: string; ttl: string; budget?: string; requester: string; root?: string }) => {
      const { requestLease, BURST_HOSTS } = await import('../res-graphs/burst.js');
      if (!(BURST_HOSTS as readonly string[]).includes(host)) throw new Error(`host must be one of ${BURST_HOSTS.join(' ')}`);
      const l = requestLease(await leaseRoot(opts), { host, ttlMin: parseTtl(opts.ttl), budgetUsd: opts.budget === undefined ? null : Number(opts.budget),
        reason: opts.reason, requester: opts.requester }, new Date());
      console.log(`lease ${l.id} requested · ${l.host} ttl ${l.ttlMin}m — res-burst-lease activates it on the next trigger tick`);
    });
  // RES-CAPACITY-LEASE (대표 11-25 22:4x): ask for a SIZE, the planner picks the host and the lease graph readies it.
  const capacityRun = async (req: import('../res-graphs/capacity.js').CapacityRequest, opts: { json?: boolean; dryRun?: boolean; root?: string; discover?: boolean }) => {
    const cap = await import('../res-graphs/capacity.js');
    const r = await leaseRoot(opts); const now = new Date();
    if (opts.discover) cap.discoverCatalog(r, now);
    const d = cap.planCapacity(r, req, now);
    const leases = d.outcome === 'picked' && !opts.dryRun ? cap.commitCapacity(r, req, d, now) : [];
    if (opts.json) { await writeStdoutJson(JSON.stringify({ request: req, decision: d, leases }, null, 2) + '\n'); }
    else {
      console.log(cap.formatDecision(d));
      for (const l of leases) console.log(`lease ${l.id} requested · ${l.host} ttl ${l.ttlMin}m — res-burst-lease: start → ready checks → register → TTL stop`);
      if (d.outcome === 'picked' && opts.dryRun) console.log('(dry run — no lease written)');
    }
    const { debug } = await import('../debug/log.js');
    debug.log('res.capacity', d.outcome, { ramGiB: req.ramGiB, count: req.count, hosts: d.outcome === 'refused' ? [] : d.picks.map(p => p.host) });
    if (d.outcome !== 'picked') process.exitCode = d.outcome === 'needs-ceo' ? 3 : 2;
  };
  lease.command('request').description('ask for capacity (RAM/cpu), not a host — the planner picks local/LAN → ready cloud → cheapest cloud')
    .requiredOption('--ram <size>', 'RAM per machine: 128G · 64GB · 1T').option('--cpu <n>', 'min cpus').option('--ttl <dur>', 'lease length: 4h · 90m', '4h')
    .option('--count <n>', 'machines', '1').option('--budget <usd>', 'cloud spend this request may use without a CEO card')
    .requiredOption('--reason <text>', 'why').option('--requester <seat>', 'who asked', process.env.ELANOUS_TRACK ?? 'OP')
    .option('--discover', 'refresh the host catalog (ssh/cloud map) first').option('--dry-run', 'decide only').option('--json').option('--root <dir>', 'state root (tests)')
    .action(async (opts: { ram: string; cpu?: string; ttl: string; count: string; budget?: string; reason: string; requester: string; discover?: boolean; dryRun?: boolean; json?: boolean; root?: string }) => {
      const { parseSize } = await import('../res-graphs/capacity.js');
      await capacityRun({ ramGiB: parseSize(opts.ram), cpu: opts.cpu ? Number(opts.cpu) : null, ttlMin: parseTtl(opts.ttl), count: Number(opts.count),
        budgetUsd: opts.budget === undefined ? null : Number(opts.budget), reason: opts.reason, requester: opts.requester }, opts);
    });
  lease.command('ask <line...>').description('natural-language capacity request («128GB 머신 하나 4시간») → structured fields → planner')
    .option('--reason <text>', 'why (else the line itself)').option('--requester <seat>', 'who asked', process.env.ELANOUS_TRACK ?? 'OP')
    .option('--discover').option('--dry-run').option('--json').option('--root <dir>')
    .action(async (words: string[], opts: { reason?: string; requester: string; discover?: boolean; dryRun?: boolean; json?: boolean; root?: string }) => {
      const { classifyCapacityRequest } = await import('../res-graphs/capacity-intake.js');
      const line = words.join(' ');
      const f = await classifyCapacityRequest(line);
      if (!f) { console.error(`could not read a size and a duration from «${line}» — use: eln res lease request --ram 128G --ttl 4h --reason …`); process.exitCode = 2; return; }
      if (!opts.json) console.log(`intake: ${f.count}× ${f.ramGiB} GB${f.cpu ? `/${f.cpu} cpu` : ''} · ttl ${f.ttlMin}m${f.budgetUsd ? ` · budget $${f.budgetUsd}` : ''} · ${f.urgency}`);
      await capacityRun({ ramGiB: f.ramGiB, cpu: f.cpu, ttlMin: f.ttlMin, count: f.count, budgetUsd: f.budgetUsd, urgency: f.urgency,
        reason: opts.reason ?? f.reason ?? line, requester: opts.requester }, opts);
    });
  res.command('catalog').description('host catalog: ram/cpu/kind/cost/ready/lease (defaults ⊕ discovered cache ⊕ config)')
    .option('--discover', 'refresh by ssh sysctl/proc and cloud-vm.sh map').option('--json').option('--root <dir>')
    .action(async (opts: { discover?: boolean; json?: boolean; root?: string }) => {
      const cap = await import('../res-graphs/capacity.js'); const b = await import('../res-graphs/burst.js');
      const r = await leaseRoot(opts); const now = new Date();
      const failed = opts.discover ? cap.discoverCatalog(r, now).failed : [];
      const hosts = cap.loadCatalog(r); const leases = b.loadLeases(r); const rv = b.loadReservation(r); const pol = cap.loadPolicy(r);
      if (opts.json) { await writeStdoutJson(JSON.stringify({ hosts, failed, policy: pol }, null, 2) + '\n'); return; }
      for (const h of hosts) {
        const l = b.liveLease(leases, h.host);
        const ready = h.kind === 'cloud' ? (b.isReady(r, h.host, b.READY_MAX_AGE_DAYS, now) ? 'ready' : 'not-ready') : 'n/a';
        console.log(`${h.host.padEnd(7)} ${h.kind.padEnd(5)} ${String(h.ramGiB).padStart(4)} GB ${String(h.cpu).padStart(3)} cpu  $${h.ratePerHourUsd.toFixed(2)}/h  ${ready}`
          + `${h.load1 != null ? `  load ${h.load1}` : ''}${l ? `  lease ${l.id}` : ''}${rv?.active && pol.releaseReservedHosts.includes(h.host) ? '  release-reserved' : ''}`
          + `${h.leasable === false ? `  (not leasable: ${h.notLeasableWhy})` : ''}  [${h.source}]`);
      }
      for (const f of failed) console.log(`discover ✗ ${f.host}: ${f.why}`);
    });
  lease.command('adopt <host>').description('adopt a host started by hand as an active lease (drained at --ends-at)')
    .requiredOption('--started-at <iso>').requiredOption('--ends-at <iso>').requiredOption('--reason <text>')
    .option('--budget <usd>').option('--requester <seat>', 'who asked', process.env.ELANOUS_TRACK ?? 'OP').option('--root <dir>')
    .action(async (host: string, opts: { startedAt: string; endsAt: string; reason: string; budget?: string; requester: string; root?: string }) => {
      const { adoptLease } = await import('../res-graphs/burst.js');
      const l = adoptLease(await leaseRoot(opts), { host, startedAt: opts.startedAt, endsAt: opts.endsAt, reason: opts.reason, requester: opts.requester,
        budgetUsd: opts.budget === undefined ? null : Number(opts.budget) }, new Date());
      console.log(`lease ${l.id} adopted · ${l.host} active until ${l.endsAt} · rail permit issued by the graph`);
    });
  lease.command('stop <hostOrId>').description('requester done → the graph drains and stops on its next tick').option('--root <dir>')
    .action(async (hostOrId: string, opts: { root?: string }) => {
      const { markRequesterDone } = await import('../res-graphs/burst.js');
      const l = markRequesterDone(await leaseRoot(opts), hostOrId, new Date());
      console.log(`lease ${l.id} stop requested · res-burst-lease drains → stops → receipt`);
    });
  lease.command('list').description('leases, ready rows and the node-b reservation').option('--json').option('--all', 'include stopped/failed').option('--root <dir>')
    .action(async (opts: { json?: boolean; all?: boolean; root?: string }) => {
      const { loadLeases, loadReady, loadReservation, spentUsd } = await import('../res-graphs/burst.js');
      const r = await leaseRoot(opts); const now = new Date();
      const leases = loadLeases(r).filter(l => opts.all || ['requested', 'active', 'draining'].includes(l.state));
      if (opts.json) { await writeStdoutJson(JSON.stringify({ leases, ready: loadReady(r), reservation: loadReservation(r) }, null, 2) + '\n'); return; }
      if (!leases.length) console.log('no live lease');
      for (const l of leases) {
        const spent = spentUsd(l, now);
        console.log(`${l.id} ${l.host} ${l.state} ttl ${l.ttlMin}m${l.endsAt ? ` → ${l.endsAt}` : ''}${spent !== null ? ` · $${spent.toFixed(2)}` : ''}${l.budgetUsd != null ? `/$${l.budgetUsd}` : ''} · ${l.requester} · ${l.reason}`);
      }
      const rv = loadReservation(r);
      console.log(`reservation: ${rv?.active ? `node-b release-only (${rv.phase} ${rv.version} until ${rv.until})` : 'none'}`);
    });
}

export function parseTtl(text: string): number {
  const m = /^(\d+(?:\.\d+)?)(h|m)$/.exec(text.trim());
  if (!m) throw new Error('--ttl must look like 4h or 90m');
  const min = Math.round(Number(m[1]) * (m[2] === 'h' ? 60 : 1));
  if (min <= 0 || min > 24 * 60) throw new Error('--ttl must be within (0, 24h]');
  return min;
}
