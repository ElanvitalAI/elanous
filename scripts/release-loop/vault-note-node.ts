#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot, prodInstanceRoot } from '../../src/instance/resolve.js';
import { listChecklist, type ChecklistItem } from '../../src/release-loop/checklist.js';
import { userConfigPath } from '../../src/user-config.js';
import { finishNode, readGraphContext, type GraphContext } from './node-verdict.js';

const directory = '40. Project/엘라누스 릴리스';
const indexName = '_색인 — 엘라누스 릴리스.md';
const kst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function publishedTime(value: string): { date: string; short: string; full: string } {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new Error(`invalid publishedAt: ${value}`);
  const parts = Object.fromEntries(kst.formatToParts(instant).map(({ type, value: part }) => [type, part]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, short: `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`, full: `${date} ${parts.hour}:${parts.minute} KST` };
}

function firstClause(title: string): string {
  return title.split(/\s+[—–·]\s+|[\n。]/, 1)[0]!.trim().replace(/\s+/g, ' ');
}

function changeCount(draft: string): number {
  return draft.split(/\r?\n/).filter((line) => /^\s*(?:[-*] |\d+\. )/.test(line)).length;
}

function configuredVaultRoot(configPath: string): string | undefined {
  if (!existsSync(configPath)) return undefined;
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { obsidian?: { vaultRoot?: unknown; vault?: unknown } };
  const value = raw.obsidian?.vaultRoot ?? raw.obsidian?.vault;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function releaseHistory(context: GraphContext, root: string): string[] {
  const identity = context as GraphContext & { graphId?: string; runId?: string };
  if (identity.graphId !== 'release-loop' || !identity.runId || !/^[\w.-]+$/.test(identity.runId)) return [];
  const dir = join(root, 'graph-runs', 'release-loop');
  type Run = { graphId: string; runId: string; startedAt?: string; input?: { version?: string };
    nodes?: Array<{ nodeId: string; ok: boolean; output?: string; error?: string }> };
  const current = JSON.parse(readFileSync(join(dir, `${identity.runId}.json`), 'utf8')) as Run;
  if (current.graphId !== 'release-loop' || current.runId !== identity.runId || current.input?.version !== context.input.version || !Array.isArray(current.nodes)) {
    throw new Error('release graph run identity mismatch');
  }
  const runs = readdirSync(dir).filter((file) => file.endsWith('.json') && !file.includes('.decision.json') && /^[\w.-]+\.json$/.test(file))
    .map((file) => {
      try { return JSON.parse(readFileSync(join(dir, file), 'utf8')) as Run; }
      catch { return undefined; }
    }).filter((run): run is Run => !!run && run.graphId === 'release-loop' && run.input?.version === context.input.version
      && Array.isArray(run.nodes) && (run.runId === identity.runId || !!current.startedAt && !!run.startedAt && run.startedAt <= current.startedAt));
  const history: string[] = [];
  for (const nodeId of ['gate', 'cutoff']) {
    const attempts = runs.flatMap((run) => run.nodes!.filter((node) => node.nodeId === nodeId));
    if (attempts.length < 2 || !current.nodes.some((node) => node.nodeId === nodeId && node.ok)) continue;
    const failed = attempts.find((node) => !node.ok);
    if (!failed) continue;
    let reason = failed.error;
    if (failed.output) {
      try {
        const data = JSON.parse(failed.output.trim().split('\n').at(-1)!) as { reason?: string; summary?: string };
        reason = data.reason ?? data.summary ?? reason;
      } catch { /* The graph retained an unstructured command failure. */ }
    }
    history.push(`- ${nodeId === 'gate' ? '게이트 재시도' : '재컷'}: ${reason ?? '사유 기록 없음'}`);
  }
  return history;
}

interface ReleaseRecord { version: string; tag: string; sourceCommit: string; publishedAt: string; publicRepo?: string }
export interface VaultNoteDeps {
  instanceRoot?: string;
  productionRoot?: string;
  vaultRoot?: string;
  configPath?: string;
  checklist?: (version: string) => Pick<ChecklistItem, 'id' | 'title' | 'owner' | 'status'>[];
}

export function featureFamily(id: string): string {
  const stem = id.replace(/[-_]?\d+[a-z]?$/i, '');
  return (stem.split('-')[0] || id).toUpperCase();
}

export function runVaultNote(context: GraphContext = readGraphContext(), deps: VaultNoteDeps = {}) {
  const version = context.input.version;
  try {
    if ((deps.instanceRoot ?? effectiveInstanceRoot()) !== (deps.productionRoot ?? prodInstanceRoot())) {
      debug.log('release.vault-note', 'skipped', { version, reason: 'isolated' });
      return { outcome: 'ok' as const, verdict: 'pass' as const, summary: 'skipped: isolated', skipped: 'isolated' };
    }
    const vault = deps.vaultRoot ?? configuredVaultRoot(deps.configPath ?? userConfigPath());
    if (!vault) {
      // OP 10-04 19:10 ③: no vault configured is not a failure — skip and say so.
      debug.log('release.vault-note', 'skipped', { version, reason: 'no-vault' });
      return { outcome: 'ok' as const, verdict: 'pass' as const, summary: 'skipped: no-vault', skipped: 'no-vault' };
    }
    const root = deps.instanceRoot ?? effectiveInstanceRoot();
    const record: ReleaseRecord = JSON.parse(readFileSync(join(root, 'release', version, 'release.json'), 'utf8'));
    if (record.version !== version || record.tag !== `v${version}` || !/^[0-9a-f]{8,40}$/i.test(record.sourceCommit))
      throw new Error('invalid release.json version, tag or sourceCommit');
    const publicRepo = record.publicRepo;
    if (typeof publicRepo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(publicRepo)) throw new Error('release.json publicRepo missing or invalid');
    const published = publishedTime(record.publishedAt);
    const draft = readFileSync(join(root, 'release', version, 'prepared', 'notes-draft.md'), 'utf8');
    const items = (deps.checklist ?? ((v) => listChecklist(v).items))(version).filter((item) => item.status === 'green');
    const oneLine = items.slice(0, 3).map((item) => firstClause(item.title)).join(' · ');
    const location = process.env.ELANOUS_GRAPH_CONTEXT;
    const identity = location && !('runId' in context)
      ? JSON.parse(location.trimStart().startsWith('{') ? location : readFileSync(location, 'utf8')) as { graphId?: string; runId?: string }
      : {};
    const history = releaseHistory({ ...identity, ...context }, root);
    // OP 10-04 19:10 ①: group by feature family (cell id family: HQ-FENCE2 → HQ · LOOP-OBS1 → LOOP · K10i → K), not by seat.
    const groups = new Map<string, typeof items>();
    for (const item of items) {
      const heading = featureFamily(item.id);
      if (!groups.has(heading)) groups.set(heading, []);
      groups.get(heading)!.push(item);
    }
    const abilities = [...groups].flatMap(([heading, group]) => [
      `### ${heading}`, '',
      ...group.flatMap((item) => [
        `- ${item.id} — ${firstClause(item.title)}`,
        ...[...item.title.matchAll(/`([^`]+)`/g)].map((match) => `  - 명령: \`${match[1]}\``),
        '',
      ]),
    ]);
    const target = join(vault, directory);
    const name = `엘라누스 v${version} (${published.date})`;
    // 대표 10-04 19:25: notes live under <major>.x/<major>.<minor>/ · the index stays at the top.
    const [major, minor] = version.split('.');
    const noteDir = join(target, `${major}.x`, `${major}.${minor}`);
    const note = join(noteDir, `${name}.md`);
    const indexPath = join(target, indexName);
    const current = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '# 엘라누스 릴리스\n\n| 판 | 발행 | 한 줄 |\n|---|---|---|\n';
    const row = `| [[${name}\\|v${version}]] | ${published.short} | ${oneLine.replace(/\|/g, '\\|')} |`;
    const rowExists = current.split(/\r?\n/).some((line) => line.startsWith('| [[') && line.includes(`|v${version}]]`));
    const header = /\| 판 \| 발행 \| 한 줄 \|\r?\n\|[- :|]+\|\r?\n/;
    if (!rowExists && !header.test(current)) throw new Error(`index table header missing: ${indexPath}`);
    mkdirSync(noteDir, { recursive: true });
    const content = [
      '---', `title: "엘라누스 v${version} — ${oneLine.replace(/"/g, '\\"')}"`,
      `version: ${version}`, `published: ${published.full}`, `cut: ${record.sourceCommit.slice(0, 8)}`,
      'tags: [elanous, release]', 'links:', `  github: https://github.com/${publicRepo}/releases/tag/${record.tag}`,
      `  npm: elanous@${version}`, '---', '', `# 엘라누스 v${version} — ${oneLine}`, '',
      '## 한 줄', '', oneLine, '',
      '## 발행 경과', '', `- ${published.full} 발행`, ...history, '',
      '## 이제 할 수 있는 것', '', ...abilities, '## 숫자', '',
      `- 변경 ${changeCount(draft)}건`, `- green 칸 ${items.length}개`, '',
    ].join('\n');
    // A handwritten note at the old flat location (e.g. OP's v0.2.13 sample) counts as existing — never duplicate it.
    let existed = existsSync(join(target, `${name}.md`));
    if (!existed) {
      try { writeFileSync(note, content, { flag: 'wx' }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        existed = true;
      }
    }
    if (!rowExists) {
      const tableHeader = header.exec(current)!;
      const tableStart = tableHeader.index + tableHeader[0].length;
      let insertAt = tableStart;
      const publishedKey = `${published.date} ${published.short.slice(6)}`;
      const rows = current.slice(tableStart).matchAll(/^\| \[\[.*?\((\d{4}-\d{2}-\d{2})\)\\?\|v([^\]]+)\]\] \| (\d{2}-\d{2} \d{2}:\d{2}) \|[^\r\n]*(?:\r?\n|$)/gm);
      for (const existing of rows) {
        if (existing.index !== insertAt - tableStart) break;
        const existingKey = `${existing[1]} ${existing[3]!.slice(6)}`;
        if (existingKey < publishedKey || (existingKey === publishedKey && existing[2]!.localeCompare(version, 'en', { numeric: true }) < 0)) break;
        insertAt += existing[0].length;
      }
      const newline = tableHeader[0].includes('\r\n') ? '\r\n' : '\n';
      const separator = insertAt === current.length && !current.endsWith('\n') ? newline : '';
      writeFileSync(indexPath, `${current.slice(0, insertAt)}${separator}${row}${newline}${current.slice(insertAt)}`);
    }
    debug.log('release.vault-note', existed ? 'skipped' : 'written', { version, reason: existed ? 'exists' : 'created' });
    return { outcome: 'ok' as const, verdict: 'pass' as const, summary: existed ? 'skipped: exists' : `vault note written: ${name}`, ...(existed ? { skipped: 'exists' } : {}) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debug.log('release.vault-note', 'failed', { version, reason });
    return { outcome: 'fail' as const, verdict: 'fail' as const, summary: `vault note failed: ${reason}`, reason };
  }
}

if (import.meta.main) {
  let version = '';
  try {
    const context = readGraphContext();
    version = context.input.version;
    process.exitCode = finishNode('vault-note', version, runVaultNote(context));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debug.log('release.vault-note', 'failed', { version, reason });
    process.exitCode = finishNode('vault-note', version, { outcome: 'fail', verdict: 'fail', summary: `vault note failed: ${reason}`, reason });
  }
}
