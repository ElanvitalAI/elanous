import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { devVersion, listChecklist, ownerMatches, parseOwner, parityGap, summarizeChecklist } from '../release-loop/checklist.js';
import { userConfigPath } from '../user-config.js';
import { CliUserError } from './cli-user-error.js';
import { writeStdoutJson } from './stdout-json.js';

const SEMVER = /^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/;
export function isReleaseVersion(version: string): boolean { return SEMVER.test(version); }

export function checklistCodenames(): Record<string, string> {
  const path = getElanousConfigDirOverride() ? join(effectiveInstanceRoot(), 'config.json') : userConfigPath();
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { release?: { codenames?: Record<string, string> } };
  return raw.release?.codenames ?? {};
}

export function checklistVersion(input: string | undefined, codenames: Record<string, string>): string {
  const v = input ?? devVersion().replace(/-dev\.\d+$/, '');
  const resolved = isReleaseVersion(v) ? v : Object.entries(codenames).find(([, name]) => name === v)?.[0] ?? v;
  if (!isReleaseVersion(resolved)) throw new CliUserError(`체크리스트 판 또는 별칭이 아니다: ${v}`);
  return resolved;
}

export function readChecklistContext(cmd: Command): { version: string; codenames: Record<string, string>; json?: boolean } {
  const opts = { ...(cmd.parent?.parent?.opts() as { version?: string; json?: boolean }), ...(cmd.parent?.opts() as { version?: string; json?: boolean }), ...(cmd.opts() as { version?: string; json?: boolean }) };
  const codenames = checklistCodenames();
  return { version: checklistVersion(opts.version, codenames), codenames, json: opts.json };
}

export async function checklistOutput(v: string, codenames: Record<string, string>, mode: 'list' | 'status', json?: boolean, owner?: string): Promise<void> {
  if (owner !== undefined) parseOwner(owner);
  const snapshot = listChecklist(v);
  const data = owner === undefined ? snapshot : { ...snapshot, items: snapshot.items.filter((item) => ownerMatches(item.owner, owner)) };
  const summary = summarizeChecklist(data);
  const parity = data.items.flatMap((item) => {
    const why = item.kind === 'screen' ? parityGap(item.evidence) : null;
    return why ? [{ id: item.id, why }] : [];
  });
  const result = { ...data, codename: codenames[v] ?? '', ...summary, parity };
  for (const { id, why } of parity) debug.log('release.checklist', 'parity-warning', { version: v, id, why });
  if (json) { await writeStdoutJson(`${JSON.stringify(result)}\n`); return; }
  console.log(`⚠ 짝 경고 ${parity.length}: ${parity.map(({ id }) => id).join(', ') || '없음'}`);
  console.log(`${v}${result.codename ? ` (${result.codename})` : ''} · 공개 ${data.released || '없음'} · 개발 ${data.dev}`);
  if (mode === 'list') {
    for (const item of data.items) console.log(`${({ green: '🟢', yellow: '🟡', red: '🔴', done: '✅' } as const)[item.status]} ${item.id} ${item.title}${item.owner ? ` · ${item.owner}` : ''}${item.ceoMinutes !== undefined ? ` · 대표 손 ${item.ceoMinutes}분${item.ceoDate ? ` (${item.ceoDate})` : ''}` : ''}`);
  } else {
    console.log(`🟢 ${summary.green} · 🟡 ${summary.yellow} · 🔴 ${summary.red} · ✅ ${summary.done}`);
    console.log(`🔴 칸: ${summary.blocked.join(', ') || '없음'}`);
    console.log(`담당별: ${Object.entries(summary.byOwner).map(([owner, count]) => `${owner} ${count}`).join(' · ') || '없음'}`);
  }
}

/** Register the same read commands on the full and lightweight release roots. */
export function registerChecklistReadCommands(checklist: Command): void {
  const withContext = (cmd: Command) => cmd.option('--version <v>', '판 또는 별칭').option('--json', '결과 JSON').option('--hq-override', '본부 임대 거부를 관측하며 수동 우회');
  withContext(checklist.command('list').description('모든 칸')).option('--owner <owner>', '자리 또는 하위 자리로 거르기').action(async (opts: { owner?: string }, cmd: Command) => {
    const { version, codenames, json } = readChecklistContext(cmd);
    await checklistOutput(version, codenames, 'list', json, opts.owner);
  });
  withContext(checklist.command('status').description('상태 요약')).option('--owner <owner>', '자리 또는 하위 자리로 거르기').action(async (opts: { owner?: string }, cmd: Command) => {
    const { version, codenames, json } = readChecklistContext(cmd);
    await checklistOutput(version, codenames, 'status', json, opts.owner);
  });
}

/** The light router enters only list/status, so no publishing modules are loaded. */
export function registerReleaseChecklistReadCommands(program: Command): void {
  const release = program.command('release').description('공개 배포 한 판 — prepare(로컬) → publish(--yes) → verify (docs/manual/MANUAL-versioning-and-release-2026-09-25.md)');
  const checklist = release.command('checklist').description('판별 확인표 조회·갱신')
    .option('--version <v>', '판 또는 별칭(기본: package.json 의 개발판에서 -dev.N 제거)')
    .option('--json', '결과 JSON')
    .option('--hq-override', '본부 임대 거부를 관측하며 수동 우회');
  registerChecklistReadCommands(checklist);
}
