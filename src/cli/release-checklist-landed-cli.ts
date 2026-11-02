import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { listChecklist, ownerMatches, parseOwner } from '../release-loop/checklist.js';
import * as features from '../release-loop/feature-store.js';
import { evidencePlan, fetchMergedChecklistPrs, landedButYellow, type MergedPrRunner } from '../release-loop/landed-but-yellow.js';
import { isReleaseVersion, readChecklistContext } from './release-checklist-read-cli.js';
import { mayWriteReleaseChecklist } from './release-checklist-write.js';
import { CliUserError } from './cli-user-error.js';
import { writeStdoutJson } from './stdout-json.js';
function compare(a: string, b: string): number {
  const p = (v: string) => {
    const [c, r] = v.split('-'),
      [x, y, z] = c!.split('.').map(Number),
      [s, n] = r?.split('.') ?? [];
    return [x!, y!, z!, s === undefined ? 3 : ({ alpha: 0, beta: 1, rc: 2 } as Record<string, number>)[s]!, Number(n ?? 0)];
  };
  const x = p(a),
    y = p(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}
const runner: MergedPrRunner = (cmd, args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    const out: Buffer[] = [],
      err: Buffer[] = [];
    let timed = false,
      t: ReturnType<typeof setTimeout> | undefined,
      k: ReturnType<typeof setTimeout> | undefined;
    let child;
    try {
      child = spawn(cmd, [...args], {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ status: null, stdout: '', stderr: String(e) });
      return;
    }
    if (timeoutMs !== undefined)
      t = setTimeout(() => {
        timed = true;
        child.kill('SIGTERM');
        k = setTimeout(() => child.kill('SIGKILL'), 100);
      }, timeoutMs);
    child.stdout?.on('data', (b: Buffer) => out.push(b));
    child.stderr?.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e) =>
      resolve({
        status: null,
        stdout: Buffer.concat(out).toString(),
        stderr: String(e),
      }),
    );
    child.on('close', (code) => {
      if (t) clearTimeout(t);
      if (k) clearTimeout(k);
      resolve({
        status: code,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
        ...(timed ? { timedOut: true } : {}),
      });
    });
  });
function printRows(rows: ReturnType<typeof landedButYellow>, items: ReturnType<typeof listChecklist>['items']): void {
  const updated = new Map(items.map((i) => [i.id, i.updatedAt]));
  const date = (iso: string) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(iso));
    const p = (name: string) => parts.find((v) => v.type === name)?.value;
    return `${p('month')}-${p('day')} ${p('hour')}:${p('minute')}`;
  };
  for (const r of rows)
    console.log(
      `${r.id} ${r.owner ?? '-'} ${r.status === 'yellow' ? '🟡' : '🔴'} ← ${r.prs.map((p, i) => `#${p.number} «${p.title}» (${date(p.mergedAt)} · 근거에 ${r.alreadyInEvidence[i] ? '있음' : '없음'}${p.mergedAt > (updated.get(r.id) ?? '') ? ' · 칸보다 새것' : ''})`).join(' · ')}`,
    );
  console.log(`${rows.length}칸 · 그중 근거에 없는 PR 이 있는 칸 ${rows.filter((r) => r.alreadyInEvidence.includes(false)).length}`);
}
export function registerReleaseChecklistLandedCommand(program: Command): void {
  const checklist = program
    .command('release')
    .description('공개 배포')
    .command('checklist')
    .description('판별 확인표 조회·갱신')
    .option('--version <v>', '판 또는 별칭(기본: package.json 의 개발판에서 -dev.N 제거)')
    .option('--json', '결과 JSON')
    .option('--hq-override', '본부 임대 거부를 관측하며 수동 우회');
  checklist
    .command('landed-but-yellow')
    .description('병합 PR 이 있지만 노랑·빨강인 칸(기본 읽기 전용)')
    .option('--version <v>', '판 또는 별칭')
    .option('--json', '결과 JSON')
    .option('--hq-override', '본부 임대 거부를 관측하며 수동 우회')
    .option('--owner <owner>', '자리 또는 하위 자리로 거르기')
    .option('--open', '미발행 일정 판 중 칸이 있는 판 전부')
    .option('--apply-evidence', '확실한 PR 짝의 근거를 붙인다(상태는 그대로)')
    .option('--dry-run', '근거 추가 없이 계획만 출력')
    .option(
      '--limit <ms>',
      '병합 PR 창 조회 시간 상한(밀리초) — 기본 무제한, 명시하면 초과 시 부분 결과와 stopReason·남은 칸 판 목록을 낸다',
    )
    .option('--time-budget <ms>', 'deprecated alias of --limit')
    .action(
      async (
        o: {
          owner?: string;
          open?: boolean;
          applyEvidence?: boolean;
          dryRun?: boolean;
          limit?: string;
          timeBudget?: string;
        },
        cmd: Command,
      ) => {
        let start = performance.now();
        const stage = (name: string, data: Record<string, unknown>) => {
          const now = performance.now();
          debug.log('release.landed-yellow', 'stage', {
            stage: name,
            ms: Math.round(now - start),
            ...data,
          });
          start = now;
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            (async () => {
              await import('../domains/standalone-log-sink.js').then((m) => m.registerStandaloneLogSink('release-landed-yellow'));
            })(),
            new Promise<void>((r) => {
              timer = setTimeout(r, 1000);
            }),
          ]);
        } catch {
        } finally {
          clearTimeout(timer);
        }
        try {
          const inherited = cmd.parent?.opts() as { version?: string; json?: boolean } | undefined,
            local = cmd.opts() as { version?: string; json?: boolean };
          if (o.open && (local.version !== undefined || inherited?.version !== undefined))
            throw new CliUserError('--open 과 --version 을 함께 쓸 수 없다');
          const json = local.json ?? inherited?.json;
          if (o.owner !== undefined) parseOwner(o.owner);
          const include = o.open || local.version !== undefined || inherited?.version !== undefined,
            released = include ? features.releasedVersion() : '';
          const schedules = include && existsSync(join(releaseLedgerRoot(), 'release', 'features.sqlite')) ? features.readSchedules() : [];
          const open = schedules
            .filter(({ version }) => isReleaseVersion(version) && (!released || compare(version, released) > 0))
            .sort((a, b) => compare(a.version, b.version))
            .map(({ version }) => listChecklist(version))
            .filter((s) => s.items.length);
          stage('snapshots', { n: open.length, schedules: schedules.length });
          if (o.open && !open.length) {
            if (json) await writeStdoutJson('[]\n');
            else console.log('열린 판 없음');
            return;
          }
          if (o.applyEvidence && !o.dryRun && !mayWriteReleaseChecklist(cmd)) return;
          const snapshots = o.open ? open : [listChecklist(readChecklistContext(cmd).version)],
            now = new Date();
          const times = (o.open ? snapshots : [...open, ...snapshots]).flatMap((s) =>
            s.items
              .filter((i) => (i.status === 'yellow' || i.status === 'red') && (o.owner === undefined || ownerMatches(i.owner, o.owner)))
              .map((i) => Date.parse(i.updatedAt))
              .filter(Number.isFinite),
          );
          const since = times.length
            ? new Date(Math.min(...times)).toISOString().slice(0, 10)
            : new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
          if (o.limit !== undefined && o.timeBudget !== undefined)
            throw new CliUserError('--limit 과 --time-budget 중 하나만 지정할 수 있다');
          const limit = o.limit ?? o.timeBudget,
            ms = limit === undefined ? undefined : Number(limit);
          if (ms !== undefined && (!Number.isFinite(ms) || ms <= 0))
            throw new CliUserError(`잘못된 시간 상한: ${limit}`, '--limit <ms> — 양의 밀리초 수치');
          const cacheFile = join(releaseLedgerRoot(), 'release', 'landed-but-yellow-cache.json');
          const fetched = await fetchMergedChecklistPrs(since, now, runner, process.cwd(), {
            cacheFile,
            ...(ms === undefined ? {} : { timeBudgetMs: ms }),
          });
          stage('merged-prs', {
            n: fetched.prs.length,
            calls: fetched.calls,
            since,
            truncated: fetched.truncated,
            ...(fetched.stopReason ? { stopReason: fetched.stopReason } : {}),
          });
          const results = [] as Array<{
            version: string;
            rows?: ReturnType<typeof landedButYellow>;
            plan?: ReturnType<typeof evidencePlan>;
          }>;
          let added = 0,
            skipped = 0;
          for (const snapshot of snapshots) {
            const rows = landedButYellow(snapshot.items, fetched.prs, {
                owner: o.owner,
              }),
              mentions = new Set(
                rows.flatMap((r) => r.prs.flatMap((p) => (p.basis === 'mention' ? [JSON.stringify([r.id, p.number])] : []))),
              ).size;
            if (o.open) skipped += mentions;
            if (o.open && !json) console.log(`— ${snapshot.version} —`);
            if (o.applyEvidence || o.dryRun) {
              const plan = evidencePlan(rows),
                log = json ? console.error : console.log;
              for (const { id, ref } of plan) {
                if (!o.dryRun)
                  features.evidenceAdd(id, snapshot.version, ref, process.env.ELANOUS_TRACK || 'cli', snapshot.released, snapshot.dev);
                log(`${o.dryRun ? '·' : '✅'} ${id} 근거 ${ref}`);
              }
              const count = o.dryRun ? 0 : plan.length;
              added += count;
              log(`붙임 ${count} · 건너뜀(언급만) ${mentions}`);
              results.push({ version: snapshot.version, plan });
            } else {
              if (!json) printRows(rows, snapshot.items);
              results.push({ version: snapshot.version, rows });
            }
          }
          stage('match', {
            n: results.reduce((n, r) => n + (r.rows?.length ?? r.plan?.length ?? 0), 0),
            versions: snapshots.length,
            prs: fetched.prs.length,
          });
          if (o.open) {
            if (o.applyEvidence && !o.dryRun)
              debug.log('release.checklist', 'evidence-synced', {
                versions: snapshots.map((s) => s.version),
                added,
                skippedMention: skipped,
              });
            if (!json) console.log(`판 ${snapshots.length} · 붙임 합 ${added} · 건너뜀(언급만) 합 ${skipped}`);
            if (json)
              await writeStdoutJson(
                `${JSON.stringify(fetched.stopReason ? { results, stopReason: fetched.stopReason, remainingVersions: snapshots.map((s) => s.version), remainingWindows: fetched.remainingWindows } : results)}\n`,
              );
          } else if (json) {
            if (o.applyEvidence && !o.dryRun)
              debug.log('release.checklist', 'evidence-synced', {
                added,
                skippedMention: skipped,
              });
            const output = o.applyEvidence || o.dryRun ? results[0]!.plan : results[0]!.rows;
            await writeStdoutJson(
              `${JSON.stringify(fetched.stopReason ? { results, stopReason: fetched.stopReason, remainingVersions: snapshots.map((s) => s.version), remainingWindows: fetched.remainingWindows } : output)}\n`,
            );
          }
          if (fetched.truncated) console.error('⚠ 병합 PR 400개 상한: 목록이 잘렸을 수 있다');
          if (fetched.stopReason)
            console.error(
              `⚠ 병합 PR 조회 시간 상한 도달: 부분 결과 ${fetched.prs.length} · 남은 판 ${snapshots.map((s) => s.version).join(' · ')} · 미조회 UTC 창 ${fetched.remainingWindows.length}(${fetched.remainingWindows.slice(0, 3).join(' · ')}${fetched.remainingWindows.length > 3 ? ' …' : ''})`,
            );
        } catch (e) {
          console.error(`⛔ ${e instanceof Error ? e.message : String(e)}`);
          process.exitCode = 1;
        }
      },
    );
}
