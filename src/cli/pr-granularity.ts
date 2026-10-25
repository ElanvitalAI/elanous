import {
  landingHistoryGitLogArgs,
  type CmdRunner,
} from '../autopilot/pr-manager.js';
// ⭐ 계보 판정을 «새로 만들지 않는다» — `pr land` 와 preflight 가 쓰는 그 함수를 그대로 쓴다.
//   ⛔ 복사해 두 벌 만들면 「형제」의 정의가 도구마다 갈린다.
import { branchGoalId, branchLineageSlug } from './pr-lineage.js';

export const DEFAULT_GRANULARITY_SINCE = '1 day ago';

/** Distinct from `해당 없음`, `0`, or empty — a title that is neither `타입(범위)` nor unscoped `타입:` at the start. */
export const UNEXTRACTABLE_COMMIT_TITLE_PREFIX = '앞머리 미추출';

export const TOP_REPEATED_FILE_LIMIT = 20;

/** Distinct prefixes shown on a repeated-file row and the window summary. Overflow appends `, showing N of M`. */
export const TOP_PREFIX_COUNT_LIMIT = 5;

/**
 * Collision-proof separator between hash and author/time metadata in `git log --pretty`.
 * Absent from legacy `commit %H %s` lines, so a subject that starts with `email 숫자`
 * is never mistaken for metadata.
 */
export const LANDING_HISTORY_META_MARK = '\x1e';

function landingHistoryPrettyFormat(): string {
  const hex = LANDING_HISTORY_META_MARK.charCodeAt(0).toString(16).padStart(2, '0');
  return `--pretty=format:commit %H%x${hex}%ae %ct %s`;
}

export interface LandingCommit {
  hash: string;
  subject: string;
  files: string[];
  authorEmail: string;
  committedAtMs: number;
}

export interface PrefixFrequency {
  prefix: string;
  count: number;
}

export interface FileLandingFrequency {
  path: string;
  count: number;
  prefixes: PrefixFrequency[];
}

/** Mutually exclusive single-file landing kinds. Precedence: `docs/` → `.rules/` → `*.test.ts` → source. */
export interface SingleFileKindCounts {
  docs: number;
  rules: number;
  tests: number;
  source: number;
}

export interface GranularityStats {
  landingCount: number;
  singleFileLandingCount: number;
  singleFileLandingRatio: number | null;
  /** 단일 파일 착지의 성격 내역. 네 값의 합은 `singleFileLandingCount` 와 같다. */
  singleFileKindCounts: SingleFileKindCounts;
  prefixFrequencies: PrefixFrequency[];
  fileFrequencies: FileLandingFrequency[];
  /**
   * 창 요약의 「앞머리 미추출」 중 `classifyLandingSource` 가 harness 로 판정한 수.
   * 호출자가 head-ref 맵을 안 주면 0 — 기본 경로는 조회를 만들지 않는다.
   */
  unextractableHarnessCount: number;
}

export interface OverlapEntry {
  path: string;
  recentLandingCount: number;
}

/** Restrict `git log` to commits already on the resolved base, excluding HEAD-only feature commits. */
export function landingHistoryLogArgs(since: string | null, baseRef: string): string[] {
  return landingHistoryGitLogArgs(since, baseRef).map((arg) =>
    arg === '--pretty=format:commit %H' ? landingHistoryPrettyFormat() : arg,
  );
}

/** `타입(범위)` or unscoped `타입:` at the start of a commit title, or null when that shape is absent. */
export function extractCommitTitlePrefix(subject: string): string | null {
  const trimmed = subject.trim();
  const scoped = /^([^\s:(]+\([^)]+\))/.exec(trimmed);
  if (scoped?.[1]) return scoped[1];
  const unscoped = /^([^\s:(]+):/.exec(trimmed);
  return unscoped?.[1] ?? null;
}

function prefixBucket(subject: string): string {
  return extractCommitTitlePrefix(subject) ?? UNEXTRACTABLE_COMMIT_TITLE_PREFIX;
}

function emptySingleFileKindCounts(): SingleFileKindCounts {
  return { docs: 0, rules: 0, tests: 0, source: 0 };
}

const SINGLE_FILE_KIND_LABELS: Record<keyof SingleFileKindCounts, string> = {
  docs: '문서',
  rules: '규칙',
  tests: '시험',
  source: '소스',
};

/**
 * 단일 파일 착지 경로 → 성격. 우선순위는 `docs/` · `.rules/` · `*.test.ts` · 소스.
 * ⛔ 시험 단일 착지는 결함이 아니다 — `#13577` 과 겉이 같은 「봐야 할 모양」이다.
 */
export function classifySingleFilePath(path: string): keyof SingleFileKindCounts {
  if (path.startsWith('docs/')) return 'docs';
  if (path.startsWith('.rules/')) return 'rules';
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (base.endsWith('.test.ts')) return 'tests';
  return 'source';
}

function countSingleFileKinds(uniquePerCommit: readonly (readonly string[])[]): SingleFileKindCounts {
  const counts = emptySingleFileKindCounts();
  for (const files of uniquePerCommit) {
    if (files.length !== 1) continue;
    counts[classifySingleFilePath(files[0] ?? '')] += 1;
  }
  return counts;
}

function formatSingleFileKindCounts(counts: SingleFileKindCounts): string {
  return `  문서 ${counts.docs} · 규칙 ${counts.rules} · 시험 ${counts.tests} (봐야 할 모양) · 소스 ${counts.source}`;
}

function sortedPrefixFrequencies(freq: Map<string, number>): PrefixFrequency[] {
  return [...freq.entries()]
    .map(([prefix, count]) => ({ prefix, count }))
    .sort((left, right) => right.count - left.count || left.prefix.localeCompare(right.prefix));
}

function formatPrefixCounts(
  prefixes: readonly PrefixFrequency[],
  annotateUnextractableHarness?: number,
): string {
  if (prefixes.length === 0) return '';
  const shownEntries = prefixes.slice(0, TOP_PREFIX_COUNT_LIMIT);
  const shown = shownEntries.length;
  const total = prefixes.length;
  const detail = shownEntries
    .map((entry) => formatPrefixCountEntry(entry, annotateUnextractableHarness))
    .join(', ');
  const truncated = total > shown ? `, showing ${shown} of ${total}` : '';
  return `${detail}${truncated}`;
}

function formatPrefixCountEntry(
  entry: PrefixFrequency,
  annotateUnextractableHarness?: number,
): string {
  const base = `${entry.prefix} ${entry.count}`;
  if (
    entry.prefix !== UNEXTRACTABLE_COMMIT_TITLE_PREFIX
    || annotateUnextractableHarness === undefined
    || annotateUnextractableHarness <= 0
  ) {
    return base;
  }
  return `${base} (하니스 ${annotateUnextractableHarness})`;
}

export function parseCommitNameLog(output: string): LandingCommit[] {
  const commits: LandingCommit[] = [];
  let current: LandingCommit | null = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const commit = /^commit\s+([0-9a-f]{7,40})(.*)$/i.exec(line);
    if (commit) {
      const rest = commit[2] ?? '';
      let authorEmail = '';
      let committedAtMs = 0;
      let subject = '';
      if (rest.startsWith(LANDING_HISTORY_META_MARK)) {
        const metaRest = rest.slice(LANDING_HISTORY_META_MARK.length);
        const meta = /^(\S+@\S+)\s+(\d+)(?:\s+(.*))?$/.exec(metaRest);
        authorEmail = meta?.[1] ?? '';
        committedAtMs = meta ? Number(meta[2]) * 1000 : 0;
        subject = (meta ? (meta[3] ?? '') : metaRest).trim();
      } else {
        subject = rest.trim();
      }
      current = { hash: commit[1]!, subject, files: [], authorEmail, committedAtMs };
      commits.push(current);
      continue;
    }
    if (current) current.files.push(line.replaceAll('\\', '/'));
  }
  return commits;
}

export function parseNameOnlyList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().replaceAll('\\', '/'))
    .filter(Boolean);
}

export function unionPaths(...groups: readonly (readonly string[])[]): string[] {
  return [...new Set(groups.flat())].sort();
}

export function computeGranularityStats(
  commits: readonly LandingCommit[],
  headRefByPrNumber?: ReadonlyMap<number, string>,
): GranularityStats {
  const landingCount = commits.length;
  const uniquePerCommit = commits.map((commit) => [...new Set(commit.files)]);
  const singleFileLandingCount = uniquePerCommit.filter((files) => files.length === 1).length;
  const singleFileKindCounts = countSingleFileKinds(uniquePerCommit);
  const freq = new Map<string, number>();
  for (const files of uniquePerCommit) {
    for (const path of files) freq.set(path, (freq.get(path) ?? 0) + 1);
  }
  const fileFrequencies = [...freq.entries()]
    .map(([path, count]) => ({ path, count, prefixes: [] as PrefixFrequency[] }))
    .sort((left, right) => right.count - left.count || left.path.localeCompare(right.path));
  const selectedPaths = new Set(
    fileFrequencies.filter((entry) => entry.count >= 2).slice(0, TOP_REPEATED_FILE_LIMIT).map((entry) => entry.path),
  );
  const prefixByFile = new Map<string, Map<string, number>>();
  const prefixByWindow = new Map<string, number>();
  let unextractableHarnessCount = 0;
  for (let i = 0; i < uniquePerCommit.length; i++) {
    const subject = commits[i]?.subject ?? '';
    const bucket = prefixBucket(subject);
    prefixByWindow.set(bucket, (prefixByWindow.get(bucket) ?? 0) + 1);
    if (
      headRefByPrNumber
      && bucket === UNEXTRACTABLE_COMMIT_TITLE_PREFIX
      && classifyLandingSource(extractPrNumberFromSubject(subject), headRefByPrNumber) === 'harness'
    ) {
      unextractableHarnessCount += 1;
    }
    for (const path of uniquePerCommit[i] ?? []) {
      if (!selectedPaths.has(path)) continue;
      const byPrefix = prefixByFile.get(path) ?? new Map<string, number>();
      byPrefix.set(bucket, (byPrefix.get(bucket) ?? 0) + 1);
      prefixByFile.set(path, byPrefix);
    }
  }
  for (const entry of fileFrequencies) {
    const byPrefix = prefixByFile.get(entry.path);
    if (byPrefix) entry.prefixes = sortedPrefixFrequencies(byPrefix);
  }
  return {
    landingCount,
    singleFileLandingCount,
    singleFileLandingRatio: landingCount === 0 ? null : singleFileLandingCount / landingCount,
    singleFileKindCounts,
    prefixFrequencies: sortedPrefixFrequencies(prefixByWindow),
    fileFrequencies,
    unextractableHarnessCount,
  };
}

export function formatGranularityReport(stats: GranularityStats, since: string): string[] {
  const lines = [`최근 창: ${since}`, `착지 수: ${stats.landingCount}`];
  if (stats.singleFileLandingRatio === null) {
    lines.push('단일 파일 착지 비율: 측정할 수 없음 — 이 창에 착지가 없습니다.');
  } else {
    const pct = (stats.singleFileLandingRatio * 100).toFixed(1);
    lines.push(`단일 파일 착지: ${stats.singleFileLandingCount} (${pct}%)`);
  }
  lines.push(formatSingleFileKindCounts(stats.singleFileKindCounts));
  if (stats.prefixFrequencies.length > 0) {
    const detail = formatPrefixCounts(stats.prefixFrequencies, stats.unextractableHarnessCount);
    if (detail) lines.push(`착지 앞머리: ${detail}`);
  }
  const repeated = stats.fileFrequencies.filter((entry) => entry.count >= 2);
  if (repeated.length > 0) {
    lines.push('같은 파일을 여러 착지가 건드린 상위:');
    const shown = repeated.slice(0, TOP_REPEATED_FILE_LIMIT);
    const omittedFromList = repeated.length - shown.length;
    const repeatedKindCounts = emptySingleFileKindCounts();
    for (const { path, count } of repeated) {
      repeatedKindCounts[classifySingleFilePath(path)] += count;
    }
    for (const { path, count, prefixes } of shown) {
      const kind = classifySingleFilePath(path);
      const label = SINGLE_FILE_KIND_LABELS[kind];
      const detail = formatPrefixCounts(prefixes);
      lines.push(detail ? `  [${label}] ${path}  ${count}  ${detail}` : `  [${label}] ${path}  ${count}`);
    }
    const omittedNote =
      omittedFromList > 0 ? ` · 목록에 안 보이는 ${omittedFromList}개 파일이 이 합에 들어 있다` : '';
    lines.push(
      `  문서 ${repeatedKindCounts.docs} · 규칙 ${repeatedKindCounts.rules} · 시험 ${repeatedKindCounts.tests} · 소스 ${repeatedKindCounts.source}${omittedNote}`,
    );
    lines.push(`  소스·시험 합 ${repeatedKindCounts.source + repeatedKindCounts.tests}${omittedNote}`);
  }
  return lines;
}

export function overlapWithCurrentChanges(
  commits: readonly LandingCommit[],
  currentFiles: readonly string[],
): OverlapEntry[] {
  const freq = new Map<string, number>();
  for (const commit of commits) {
    for (const path of new Set(commit.files)) freq.set(path, (freq.get(path) ?? 0) + 1);
  }
  return [...new Set(currentFiles)]
    .filter((path) => (freq.get(path) ?? 0) > 0)
    .map((path) => ({ path, recentLandingCount: freq.get(path)! }))
    .sort((left, right) => right.recentLandingCount - left.recentLandingCount || left.path.localeCompare(right.path));
}

export function formatOverlapAdvisory(overlaps: readonly OverlapEntry[]): string | null {
  if (overlaps.length === 0) return null;
  const files = overlaps.map((entry) => `${entry.path} (${entry.recentLandingCount}회)`).join(', ');
  return `⚠ overlap: ${files} — 같은 파일을 최근 착지가 건드렸습니다. 쌓아 두려면 pr land --hold 를 쓰십시오.`;
}

export function previousLandingSummary(
  commits: readonly { subject: string; committedAtMs: number }[],
  nowMs: number,
): { subject: string; agoMinutes: number } | undefined {
  let latest: { subject: string; committedAtMs: number } | undefined;
  for (const commit of commits) {
    if (commit.committedAtMs > nowMs) continue;
    if (!latest || commit.committedAtMs > latest.committedAtMs) latest = commit;
  }
  if (!latest) return undefined;
  return {
    subject: latest.subject,
    agoMinutes: Math.floor((nowMs - latest.committedAtMs) / 60_000),
  };
}

function truncatePreviousLandingSubject(subject: string): string {
  const points = Array.from(subject);
  if (points.length <= 60) return subject;
  return `${points.slice(0, 57).join('')}...`;
}

export function formatRecentLandingRateAdvisory(input: {
  recentCount: number;
  windowMinutes: number;
  previous?: { subject: string; agoMinutes: number };
}): string | null {
  if (input.recentCount < 2) return null;
  const line = `⚠ recent-landings: 최근 ${input.windowMinutes}분에 이 저장소에 들어온 착지가 ${input.recentCount}건입니다 (저자 식별자가 하나뿐이라 세션별로 가르지 못합니다) — 같은 주제면 커밋하지 말고 다음 것과 함께 내십시오. 리뷰를 먼저 받아야 하면 pr land --hold.`;
  if (!input.previous) return line;
  const subject = truncatePreviousLandingSubject(input.previous.subject);
  return `${line}\n   직전 착지: "${subject}" (${input.previous.agoMinutes}분 전)`;
}

/** 이 저장소에서 저자 식별자는 세션을 가르지 못한다 — 최근 352 착지가 같은 저자 이메일이다. */
export function countRecentLandings(
  commits: readonly { authorEmail: string; committedAtMs: number }[],
  opts: { authorEmail: string; nowMs: number; windowMinutes: number },
): number {
  const author = opts.authorEmail.toLowerCase();
  const windowMs = opts.windowMinutes * 60_000;
  let count = 0;
  for (const commit of commits) {
    if (commit.committedAtMs > opts.nowMs) continue;
    if (opts.nowMs - commit.committedAtMs > windowMs) continue;
    if (commit.authorEmail.toLowerCase() !== author) continue;
    count += 1;
  }
  return count;
}

export function countRecentLandingsByAuthor(
  commits: readonly { authorEmail: string; committedAtMs: number }[],
  opts: { authorEmail: string; nowMs: number; windowMinutes: number },
): number {
  return countRecentLandings(commits, opts);
}

export function collectBaseLandingCommits(
  run: CmdRunner,
  cwd: string,
  opts: { since?: string | null; baseRef: string },
): LandingCommit[] | null {
  const since = opts.since === null
    ? null
    : opts.since?.trim() || DEFAULT_GRANULARITY_SINCE;
  const history = run('git', landingHistoryLogArgs(since, opts.baseRef), { cwd });
  if (!history.ok) return null;
  return parseCommitNameLog(history.out);
}

export type LandingSource = 'no-pr-number' | 'unmapped' | 'harness' | 'human';

export interface SourceSplitBucket {
  count: number;
  singleFileCount: number;
  totalFiles: number;
}

export interface SourceSplit {
  'no-pr-number': SourceSplitBucket;
  unmapped: SourceSplitBucket;
  harness: SourceSplitBucket;
  human: SourceSplitBucket;
}

const TRAILING_PR_NUMBER = /\(#(\d+)\)$/;

/** Trailing `(#12345)` only. A mid-title match is not a PR number. */
/** 한 계보 키의 착지들. 키가 같고 «해시만» 다른 브랜치가 형제다. */
export interface LineageGroup {
  readonly slug: string;
  readonly landings: number;
}

export interface LineageStats {
  /**
   * 골 id 를 담은 새 세대 브랜치 무리. ⛔ 경로 슬러그 무리와 한 배열에 섞지 않는다.
   * 생략 시 `groups` 로 폴백 — 옛 객체 리터럴 소비자가 신규 필드 없이 컴파일되게 둔다.
   */
  readonly goalGroups?: readonly LineageGroup[];
  /** 골 id 가 없는 옛 세대 경로 슬러그 무리. 생략 시 빈 갈래. */
  readonly pathGroups?: readonly LineageGroup[];
  /** 골 id 갈래 무리. `goalGroups` 가 있으면 그와 같다. */
  readonly groups: readonly LineageGroup[];
  /** 골 id 갈래 착지 수. `goalGroupedLandings` 가 있으면 그와 같다. */
  readonly groupedLandings: number;
  readonly goalGroupedLandings?: number;
  readonly pathGroupedLandings?: number;
  /**
   * ⛔ 「형제 아님」과 «다른 값» — 브랜치를 못 얻어 판정 «자체»를 못 한 착지.
   * `noPrNumber + outsideLookupWindow` 와 같다(옛 `브랜치 미상` 합).
   */
  readonly branchUnknown: number;
  /** 커밋 제목에 PR 번호가 없어 브랜치를 판정하지 못한 착지. */
  readonly noPrNumber: number;
  /**
   * PR 번호는 있으나 조회 «상한»에 닿아 브랜치를 못 얻은 착지.
   * ⛔ 조회가 상한에 «안 닿았으면» 이 값은 항상 0 이다 — 그때 못 찾은 것은
   *    「창 밖」이 아니라 `unmatchedPr`(조회에 «없었다»)다.
   */
  readonly outsideLookupWindow: number;
  /**
   * 조회가 상한에 닿지 «않았는데도» 맵에 없던 PR — 창 밖이 아니라 «조회에 없음»이다.
   * ⛔ 「창 밖」과 접으면 상한을 올리면 해결된다는 «거짓 처방»이 나온다.
   */
  readonly unmatchedPr: number;
}

const TOP_LINEAGE_GROUP_LIMIT = 10;

function groupsFromCounts(byKey: Map<string, number>): LineageGroup[] {
  return [...byKey.entries()]
    .filter(([, landings]) => landings >= 2)
    .map(([slug, landings]) => ({ slug, landings }))
    .sort((a, b) => b.landings - a.landings || a.slug.localeCompare(b.slug));
}

function landingsOf(groups: readonly LineageGroup[]): number {
  return groups.reduce((sum, g) => sum + g.landings, 0);
}

/**
 * 계보를 두 갈래로 묶는다.
 *
 * 🆕 `goalid-<id>` 를 담은 브랜치 → 그 골 id 가 키. 「같은 골」이라 말할 수 있다.
 * 🕰️ 안 담은 브랜치 → `branchLineageSlug` 가 내는 경로 슬러그가 키. 「같은 «경로»」만 말한다.
 * ⛔ 한 착지가 두 갈래에 동시에 들지 않는다. 옛 세대에서 골 id 를 복원하지 않는다.
 * ⛔ 해시로 묶으면 안 된다 — 해시는 «골 문면» 파생이라 같은 골의 다른 시도끼리도 갈린다.
 * ⚠️ 브랜치를 못 얻은 착지는 `branchUnknown` 으로 «따로» 센다 — 「형제 0」과 접으면
 *   다음 사람이 「형제가 없다」로 읽는다.
 */
export function computeLineageStats(
  commits: readonly LandingCommit[],
  headRefByPrNumber: ReadonlyMap<number, string>,
  lookupTruncated = false,
): LineageStats {
  const byGoalId = new Map<string, number>();
  const byPathSlug = new Map<string, number>();
  let noPrNumber = 0;
  let outsideLookupWindow = 0;
  let unmatchedPr = 0;
  for (const commit of commits) {
    const prNumber = extractPrNumberFromSubject(commit.subject);
    if (prNumber === null) { noPrNumber += 1; continue; }
    const headRef = headRefByPrNumber.get(prNumber);
    if (headRef === undefined) {
      // ⭐ 상한에 «닿았을 때만» 「창 밖」이라 말할 수 있다 — 안 닿았으면 전수를 봤는데도 없던 것이다.
      if (lookupTruncated) outsideLookupWindow += 1;
      else unmatchedPr += 1;
      continue;
    }
    const slug = branchLineageSlug(headRef);
    if (slug === null) continue;   // 하니스 브랜치가 아니다 — 계보 축의 대상이 «아니다»
    const goalId = branchGoalId(headRef);
    if (goalId !== null) {
      byGoalId.set(goalId, (byGoalId.get(goalId) ?? 0) + 1);
      continue;
    }
    byPathSlug.set(slug, (byPathSlug.get(slug) ?? 0) + 1);
  }
  const goalGroups = groupsFromCounts(byGoalId);
  const pathGroups = groupsFromCounts(byPathSlug);
  const goalGroupedLandings = landingsOf(goalGroups);
  const pathGroupedLandings = landingsOf(pathGroups);
  return {
    goalGroups,
    pathGroups,
    groups: goalGroups,
    groupedLandings: goalGroupedLandings,
    goalGroupedLandings,
    pathGroupedLandings,
    noPrNumber,
    outsideLookupWindow,
    unmatchedPr,
    branchUnknown: noPrNumber + outsideLookupWindow + unmatchedPr,
  };
}

function formatLineageKindLine(
  label: string,
  groups: readonly LineageGroup[],
  groupedLandings: number,
  unknownSuffix: string,
): string {
  return `${label}: 무리 ${groups.length} · 그 무리의 착지 ${groupedLandings}${unknownSuffix}`;
}

function appendGroupRows(lines: string[], groups: readonly LineageGroup[]): void {
  const shown = groups.slice(0, TOP_LINEAGE_GROUP_LIMIT);
  for (const { slug, landings } of shown) lines.push(`  ${slug}  ${landings}`);
  if (groups.length > shown.length) {
    lines.push(`  … ${shown.length}/${groups.length} 만 보였습니다`);
  }
}

/**
 * ⛔ 무리도 미상 원인도 없으면 절을 내지 않는다 — 빈 절로 산출을 길게 만들지 않는다.
 * 무리가 0이어도 `PR 번호 없음`/`조회 창 밖`이 있으면 그 수를 낸다.
 * ⛔ 「같은 골」과 「같은 «경로»」를 한 수에 합치지 않는다 — 다른 줄로 낸다.
 */
export function formatLineageReport(stats: LineageStats): string[] {
  const unknownParts: string[] = [];
  if (stats.noPrNumber > 0) unknownParts.push(`PR 번호 없음 ${stats.noPrNumber}`);
  if (stats.unmatchedPr > 0) unknownParts.push(`조회에 없음 ${stats.unmatchedPr}`);
  if (stats.outsideLookupWindow > 0) unknownParts.push(`조회 창 밖 ${stats.outsideLookupWindow}`);
  const goalGroups = stats.goalGroups ?? stats.groups;
  const pathGroups = stats.pathGroups ?? [];
  const goalGroupedLandings = stats.goalGroupedLandings ?? stats.groupedLandings;
  const pathGroupedLandings = stats.pathGroupedLandings ?? 0;
  if (goalGroups.length === 0 && pathGroups.length === 0 && unknownParts.length === 0) return [];
  const unknownSuffix = unknownParts.length > 0 ? ` · ${unknownParts.join(' · ')}` : '';
  const lines: string[] = [
    formatLineageKindLine('같은 골이 낸 착지(계보)', goalGroups, goalGroupedLandings, unknownSuffix),
  ];
  appendGroupRows(lines, goalGroups);
  if (pathGroups.length > 0) {
    lines.push(formatLineageKindLine('같은 «경로»가 낸 착지(계보)', pathGroups, pathGroupedLandings, unknownSuffix));
    appendGroupRows(lines, pathGroups);
  }
  return lines;
}

export function extractPrNumberFromSubject(subject: string): number | null {
  const match = TRAILING_PR_NUMBER.exec(subject.trim());
  if (!match) return null;
  return Number(match[1]);
}

export function classifyLandingSource(
  prNumber: number | null,
  headRefByPrNumber: ReadonlyMap<number, string>,
): LandingSource {
  if (prNumber === null) return 'no-pr-number';
  const headRef = headRefByPrNumber.get(prNumber);
  if (headRef === undefined) return 'unmapped';
  if (headRef.startsWith('self-impl/')) return 'harness';
  return 'human';
}

function emptySourceSplitBucket(): SourceSplitBucket {
  return { count: 0, singleFileCount: 0, totalFiles: 0 };
}

export function computeSourceSplit(
  commits: readonly LandingCommit[],
  headRefByPrNumber: ReadonlyMap<number, string>,
): SourceSplit {
  const split: SourceSplit = {
    'no-pr-number': emptySourceSplitBucket(),
    unmapped: emptySourceSplitBucket(),
    harness: emptySourceSplitBucket(),
    human: emptySourceSplitBucket(),
  };
  for (const commit of commits) {
    const source = classifyLandingSource(
      extractPrNumberFromSubject(commit.subject),
      headRefByPrNumber,
    );
    const files = [...new Set(commit.files)];
    const bucket = split[source];
    bucket.count += 1;
    if (files.length === 1) bucket.singleFileCount += 1;
    bucket.totalFiles += files.length;
  }
  return split;
}

function formatClassifiedSourceLine(
  label: 'harness' | 'human',
  bucket: SourceSplitBucket,
  classifiedCount: number,
): string {
  const pct = ((bucket.count / classifiedCount) * 100).toFixed(1);
  return `${label}: ${bucket.count} (${pct}%)  단일 파일 ${bucket.singleFileCount}  파일 합 ${bucket.totalFiles}`;
}

export function formatSourceSplitReport(split: SourceSplit): string[] {
  const lines: string[] = [];
  if (split['no-pr-number'].count > 0) {
    lines.push(
      `⚠ source-no-pr-number: 착지 ${split['no-pr-number'].count}건은 커밋 제목에 PR 번호가 없어 갈래를 판정하지 못했습니다.`,
    );
  }
  if (split.unmapped.count > 0) {
    lines.push(
      `⚠ source-unmapped: 착지 ${split.unmapped.count}건은 PR 번호를 읽었으나 그 번호의 브랜치를 조회하지 못했습니다.`,
    );
  }
  const classifiedCount = split.harness.count + split.human.count;
  if (classifiedCount === 0) {
    lines.push('판정 불가 — 갈래를 가를 자료가 없습니다.');
    return lines;
  }
  lines.push(formatClassifiedSourceLine('harness', split.harness, classifiedCount));
  lines.push(formatClassifiedSourceLine('human', split.human, classifiedCount));
  return lines;
}
