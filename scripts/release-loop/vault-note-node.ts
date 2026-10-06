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

// 구분자(` — ` · ` · ` · 줄바꿈 · 。)는 짝이 맞는 «…» 밖에서만 자른다.
function firstClause(title: string): string {
  let depth = 0;
  let end = title.length;
  // Balanced «…», (…), […], {…}, “…” and "…" spans are kept whole — a separator inside them never ends the clause.
  const closers: Record<string, string> = { '«': '»', '(': ')', '[': ']', '{': '}', '“': '”', '‘': '’' };
  const stack: string[] = [];
  let quoted = false;
  let single = false;
  for (let i = 0; i < title.length; i++) {
    const char = title[i]!;
    if (char === '"' && (quoted || title.indexOf('"', i + 1) > i)) { quoted = !quoted; continue; }
    // ASCII ' quotes like ", except a word-internal apostrophe (doesn't).
    if (char === "'" && !(/\p{L}/u.test(title[i - 1] ?? '') && /\p{L}/u.test(title[i + 1] ?? ''))
      && (single || title.indexOf("'", i + 1) > i)) { single = !single; continue; }
    if (single) continue;
    if (closers[char] && title.indexOf(closers[char]!, i) > i) { stack.push(closers[char]!); continue; }
    if (stack.length && char === stack.at(-1)) { stack.pop(); continue; }
    if (quoted || stack.length) continue;
    if (char === '«' && title.indexOf('»', i) > i) depth++;
    else if (char === '»' && depth > 0) depth--;
    else if (depth === 0 && (char === '\n' || char === '。' || (/[—–·]/.test(char) && /\s/.test(title[i - 1] ?? '') && /\s/.test(title[i + 1] ?? '')))) { end = i; break; }
  }
  const clause = title.slice(0, end);
  const unmatched = new Set<number>();
  const open: number[] = [];
  for (let i = 0; i < clause.length; i++) {
    if (clause[i] === '«') open.push(i);
    else if (clause[i] === '»') { if (open.length) open.pop(); else unmatched.add(i); }
  }
  for (const i of open) unmatched.add(i);
  return clause.split('').filter((_, i) => !unmatched.has(i)).join('').trim().replace(/\s+/g, ' ');
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

type LedgerNode = { nodeId: string; ok: boolean; output?: string };
type LedgerRun = { graphId: string; runId: string; startedAt?: string; input?: { version?: string }; nodes?: LedgerNode[] };

function publishedPreviousRun(dir: string, root: string, previousVersion: string, current: LedgerRun): LedgerRun | undefined {
  const record: unknown = JSON.parse(readFileSync(join(root, 'release', previousVersion, 'release.json'), 'utf8'));
  if (!record || typeof record !== 'object') return undefined;
  const published = record as Record<string, unknown>;
  if (published.version !== previousVersion || published.tag !== `v${previousVersion}`
    || typeof published.sourceCommit !== 'string' || !/^[0-9a-f]{8,40}$/i.test(published.sourceCommit)
    || typeof published.publishedAt !== 'string' || !Number.isFinite(Date.parse(published.publishedAt))) return undefined;
  const publishedAt = published.publishedAt as string;
  const candidates = readdirSync(dir).filter((file) => /^[\w.-]+\.json$/.test(file) && !file.endsWith('.decision.json')).flatMap((file) => {
    try {
      const value = JSON.parse(readFileSync(join(dir, file), 'utf8')) as LedgerRun;
      if (value.graphId !== 'release-loop' || value.input?.version !== previousVersion || !Array.isArray(value.nodes)
        || !value.nodes.some((node) => node.nodeId === 'publish' && node.ok)
        || ledgerOutput(value, 'publish')?.tag !== published.tag
        || ledgerOutput(value, 'version-release')?.commit !== published.sourceCommit
        || (typeof value.startedAt === 'string' && value.startedAt > publishedAt)
        || (typeof current.startedAt === 'string' && typeof value.startedAt === 'string' && value.startedAt > current.startedAt)) return [];
      return [value];
    } catch { return []; }
  });
  // Repeated publications of the same tag/commit cannot identify which run supplied the published count.
  if (new Set(candidates.map((entry) => ledgerOutput(entry, 'known-issues')?.count)).size > 1) return undefined;
  return candidates[0];
}

function ledgerOutput(run: LedgerRun, nodeId: string): Record<string, unknown> | undefined {
  const node = run.nodes?.filter((entry) => entry.nodeId === nodeId && entry.ok).at(-1);
  try {
    const raw = node?.output?.trim().split(/\r?\n/).at(-1);
    const value: unknown = JSON.parse(raw ?? '');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function stabilityLine(context: GraphContext, root: string): string {
  const identity = context as GraphContext & { graphId?: string; runId?: string };
  const fields: Record<string, string | number> = { introduced: '?', preexisting: '?', recut: '?', hosts: '?', knownIssuesDelta: '?' };
  const unreadable: string[] = [];
  let line: string;
  try {
    if (identity.graphId !== 'release-loop' || !identity.runId || !/^[\w.-]+$/.test(identity.runId)) throw new Error('런 식별자 없음');
    const dir = join(root, 'graph-runs', 'release-loop');
    const ledgerPath = join(dir, `${identity.runId}.json`);
    if (!existsSync(ledgerPath)) throw new Error(`런 원장 없음(${identity.runId}.json)`);
    const run = JSON.parse(readFileSync(ledgerPath, 'utf8')) as LedgerRun;
    if (run.graphId !== 'release-loop' || run.runId !== identity.runId || run.input?.version !== context.input.version || !Array.isArray(run.nodes)) throw new Error('런 원장 식별 불일치');
    const gate = ledgerOutput(run, 'gate');
    if (Array.isArray(gate?.introduced)) fields.introduced = gate.introduced.length;
    else unreadable.push('gate.introduced');
    if (typeof gate?.preexisting === 'number' && Number.isSafeInteger(gate.preexisting) && gate.preexisting >= 0) fields.preexisting = gate.preexisting;
    else unreadable.push('gate.preexisting');
    // The cutoff manifest contains baseline/cutoff SHAs and included landings, not the cut branch's pick count.
    // Neither a different SHA nor the number of included landings establishes whether there was a recut.
    unreadable.push('cutoff.pick count not recorded');
    // ops-upgrade is downstream of vault-note in the release graph; its host results do not exist yet.
    unreadable.push('ops-upgrade.hosts not yet available');
    const current = ledgerOutput(run, 'known-issues');
    try {
      // Same baseline as the landing section: the newest earlier version that was actually published (an unpublished, folded version is skipped).
      const previousVersion = previousPublishedCut(root, context.input.version)?.version;
      const previousRun = previousVersion ? publishedPreviousRun(dir, root, previousVersion, run) : undefined;
      const previous = previousRun ? ledgerOutput(previousRun, 'known-issues')?.count : undefined;
      if (typeof current?.count === 'number' && Number.isSafeInteger(current.count) && current.count >= 0
        && typeof previous === 'number' && Number.isSafeInteger(previous) && previous >= 0) {
        const delta = current.count - previous;
        fields.knownIssuesDelta = `${delta >= 0 ? '+' : ''}${delta}`;
      } else unreadable.push('known-issues.count(previous/current)');
    } catch { unreadable.push('known-issues.count(previous/current)'); }
    line = `안정: 게이트 introduced ${fields.introduced} · preexisting ${fields.preexisting} · 재컷 ${fields.recut} · 호스트 판올림 성공 ${fields.hosts} · known-issues 직전 판 대비 ${fields.knownIssuesDelta}`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    unreadable.push(reason);
    line = `안정: 측정 불가: ${reason.replace(/[\r\n]+/g, ' ')}`;
  }
  try { debug.log('release-loop.vault-note', 'stability-line', { fields, unreadable }); } catch { /* Observation cannot block publication. */ }
  return line;
}

interface ReleaseRecord { version: string; tag: string; sourceCommit: string; publishedAt: string; publicRepo?: string }

const landingTopics = [
  { name: '조직·루프', match: /조직|좌석|스튜어드|본부|운영|자율|루프|미션|cron|schedule|seat|steward|loop|mission|hq\b|ops\b/i },
  { name: '하니스', match: /하니스|골|게이트|검증|테스트|리뷰|실행기|워크트리|harness|goal|gate|review|test|worktree|self-implement|self-dev|graph/i },
  { name: '채널·PWA', match: /채널|화면|텔레그램|디스코드|메신저|발송|알림|모바일|음성|channel|pwa|telegram|discord|outbound|tui|web|ios|android/i },
  { name: '지식·교훈', match: /지식|기억|교훈|관측|로그|리서치|검색|문서|knowledge|memory|lesson|research|observation|logs|docs|manual/i },
  { name: '공개·브랜드', match: /공개|브랜드|발행|릴리스|홍보|광고|마케팅|public|brand|release|publish|marketing|npm/i },
  { name: '그 밖', match: /[\s\S]*/ },
] as const;

type LandingLine = { title: string; line?: string; sha: string; prNumber?: number };

function balanced(text: string): boolean {
  const pairs: Record<string, string> = { '»': '«', ')': '(', ']': '[', '}': '{', '”': '“', '’': '‘' };
  const stack: string[] = [];
  let quote = false;
  let single = false;
  const chars = [...text];
  for (const [i, char] of chars.entries()) {
    if (char === '"') { quote = !quote; continue; }
    // ASCII ' pairs like ", except a word-internal apostrophe (doesn't) which never opens a quote.
    if (char === "'") {
      if (!(/\p{L}/u.test(chars[i - 1] ?? '') && /\p{L}/u.test(chars[i + 1] ?? ''))) single = !single;
      continue;
    }
    if (char in pairs) { if (stack.pop() !== pairs[char]) return false; }
    else if ('«([{“‘'.includes(char)) stack.push(char);
  }
  return !quote && !single && stack.length === 0;
}

function landingClause(text: string): string {
  // A candidate with broken punctuation is not repaired by deleting its unmatched character.
  if (!balanced(text)) return '';
  // release/next.md lines lead with their kind («feat — …»); the headline is the change, not the kind.
  const trimmed = text.replace(/^-\s+/, '');
  // Release bookkeeping (version bumps, «release 0.2.14» notes) is never this release's headline (0.2.15 real note).
  if (/^(?:version|release)\s*:/i.test(trimmed) || /^(?:docs|chore)(?:\([^)]*\))?\s*:\s*release\s+v?\d/i.test(trimmed)) return '';
  // Commit subjects lead with a conventional prefix («docs(marketing): …»); the headline is the change itself.
  const body = trimmed.replace(/^(feat|fix|internal|docs|test|perf|refactor|chore|ops|security|breaking)\s+[—–-]\s+/i, '')
    .replace(/^[a-z]+(?:\([^)]*\))?!?:\s+/i, '');
  const clause = shortClause(firstClause(body));
  return balanced(clause) ? clause : '';
}

/** A headline clause longer than 60 characters is cut at its first comma/semicolon, else at a word boundary with «…». */
function shortClause(clause: string): string {
  const chars = [...clause];
  if (chars.length <= 60) return clause;
  const head = chars.slice(0, 60).join('');
  // The first comma/semicolon after a minimal 10-character lead ends the clause.
  const stop = head.slice(10).search(/[,;，；]/);
  if (stop >= 0) return head.slice(0, 10 + stop);
  const space = head.lastIndexOf(' ');
  return `${(space >= 20 ? head.slice(0, space) : head).trimEnd()}…`;
}

function versionKey(value: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

/** Newest release below `version` with a readable release.json; null when there is none to compare against. */
function previousPublishedCut(root: string, version: string): { version: string; sourceCommit: string } | null {
  const current = versionKey(version);
  if (!current) return null;
  const compare = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
  const earlier = readdirSync(join(root, 'release'))
    .map((name) => ({ name, key: versionKey(name) }))
    .filter((row): row is { name: string; key: number[] } => !!row.key && compare(row.key, current) < 0)
    .sort((a, b) => compare(b.key, a.key));
  for (const { name } of earlier) {
    const path = join(root, 'release', name, 'release.json');
    if (!existsSync(path)) continue;
    const record = JSON.parse(readFileSync(path, 'utf8')) as { sourceCommit?: unknown };
    if (typeof record.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(record.sourceCommit)) throw new Error(`v${name} release.json sourceCommit invalid`);
    return { version: name, sourceCommit: record.sourceCommit };
  }
  // Earlier versions exist but none was published: the «직전 판 컷» claim cannot be checked, so it is not presented as settled.
  if (earlier.length) throw new Error(`직전 판 컷 확인 못 함 — 이전 판 ${earlier.length}개에 release.json 없음`);
  return null;
}

function landingsAtCut(root: string, version: string, cut: string): { groups: Array<{ name: string; lines: LandingLine[] }>; error?: string } {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'release', version, 'manifest.json'), 'utf8')) as {
      version?: unknown; baseline?: { sha?: unknown }; cutoff?: { sha?: unknown }; in?: unknown;
    };
    if (manifest.version !== version || !/^[0-9a-f]{8,40}$/i.test(String(manifest.baseline?.sha ?? ''))
      || manifest.cutoff?.sha !== cut || !Array.isArray(manifest.in)
      || !manifest.in.every((entry: unknown) => {
        const item = entry as Partial<LandingLine> | null;
        return item && typeof item.title === 'string' && typeof item.sha === 'string'
          && (item.line === undefined || typeof item.line === 'string')
          && (item.prNumber === undefined || Number.isInteger(item.prNumber));
      })) throw new Error('manifest.json 판·직전 컷·이번 컷 또는 착지 줄 불일치');
    // The «직전 판 컷» claim is checked against the newest earlier published release, when one exists.
    const previous = previousPublishedCut(root, version);
    if (previous && previous.sourceCommit.toLowerCase() !== String(manifest.baseline!.sha).toLowerCase())
      throw new Error(`직전 판 컷 불일치 — manifest baseline ${String(manifest.baseline!.sha).slice(0, 8)} ≠ v${previous.version} 컷 ${previous.sourceCommit.slice(0, 8)}`);
    const groups = landingTopics.map(({ name }) => ({ name, lines: [] as LandingLine[] }));
    for (const entry of manifest.in as LandingLine[]) {
      const text = entry.line?.trim() || entry.title.trim();
      const topic = landingTopics.findIndex(({ match }) => match.test(text));
      groups[topic]!.lines.push(entry);
    }
    return { groups: groups.filter((group) => group.lines.length) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { groups: [], error: `manifest.json: ${reason.replace(/^manifest\.json\s*/, '').replace(/\s+/g, ' ')}` };
  }
}

function representative(groups: Array<{ name: string; lines: LandingLine[] }>, fallback: string): string {
  const candidates = [...groups].sort((a, b) => b.lines.length - a.lines.length);
  const lines = candidates.map(({ lines }) => lines.map((entry) => landingClause(entry.line?.trim() || entry.title)).find(Boolean))
    .filter((line): line is string => !!line).slice(0, 3);
  return lines.join(' · ') || fallback;
}
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
    const landings = landingsAtCut(root, version, record.sourceCommit);
    const oneLine = representative(landings.groups, items.map((item) => landingClause(item.title)).filter(Boolean).slice(0, 3).join(' · ') || '착지 내용 확인 필요');
    const location = process.env.ELANOUS_GRAPH_CONTEXT;
    let identity: { graphId?: string; runId?: string } = {};
    if (location && !('runId' in context)) {
      try { identity = JSON.parse(location.trimStart().startsWith('{') ? location : readFileSync(location, 'utf8')) as typeof identity; }
      catch { /* Missing or malformed graph identity is reported by the stability line, not by publication. */ }
    }
    const runContext = { ...identity, ...context };
    const stability = stabilityLine(runContext, root);
    let history: string[];
    try { history = releaseHistory(runContext, root); }
    catch (error) {
      history = [];
      try { debug.log('release.vault-note', 'history-unreadable', { reason: error instanceof Error ? error.message : String(error) }); } catch { /* Observation cannot block publication. */ }
    }
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
    const landingSection = landings.error
      ? [`- 못 읽음 · ${landings.error}`]
      : landings.groups.length
        ? landings.groups.flatMap(({ name, lines }) => [
          `### ${name} (${lines.length}건)`, '',
          ...lines.map((entry) => `- ${entry.line?.trim() || entry.title.trim()}${entry.prNumber ? ` (#${entry.prNumber})` : ''}`), '',
        ])
        : ['- 착지 0건'];
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
      '---', `title: ${JSON.stringify(`엘라누스 v${version} — ${oneLine}`)}`,
      `version: ${version}`, `published: ${published.full}`, `cut: ${record.sourceCommit.slice(0, 8)}`,
      'tags: [elanous, release]', 'links:', `  github: https://github.com/${publicRepo}/releases/tag/${record.tag}`,
      `  npm: elanous@${version}`, '---', '', `# 엘라누스 v${version} — ${oneLine}`, '',
      '## 한 줄', '', oneLine, '',
      '## 발행 경과', '', `- ${published.full} 발행`, ...history, '',
      '## 이번 판 착지 (직전 판 컷 ~ 이번 판 컷)', '', ...landingSection,
      '## 이제 할 수 있는 것', '', ...abilities, '## 숫자', '',
      `- 변경 ${changeCount(draft)}건`, `- green 칸 ${items.length}개`, stability, '',
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
