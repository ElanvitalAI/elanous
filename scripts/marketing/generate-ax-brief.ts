import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { FEATURE_MATURITY } from '../../src/maturity/feature-maturity.js';
import type { ChecklistItem } from '../../src/release-loop/checklist.js';
import type { ReleaseSchedule } from '../../src/release-loop/release-schedule.js';
import type { MergedRunLedgerQuery } from '../../src/self-implement/run-ledger.js';
import { generateFeatureMap } from './generate-feature-map.js';
import { draftReleaseStory } from '../release-story/draft.js';

const MAP = resolve(import.meta.dir, '../../docs/marketing/MAP-value-props-to-features.md');
const AUTONOMY = new Set(['ORCH1', 'ORCH2', 'LOOP-LIVE1', 'AUTOQ-LOOP', 'AUTHOR-PAR', 'RUN-HELPER', 'FINISH-RATE']);
const ROADMAP = /^(?:ENT-|KPACK|GRID)/;

export interface AxBriefSources {
  featureMap: () => string;
  checklist: (version: string) => readonly ChecklistItem[];
  schedules: () => readonly ReleaseSchedule[];
  merges: () => Pick<MergedRunLedgerQuery, 'entries' | 'ledgerDirectoryMissing' | 'unreadableLedgerCount' | 'excludedLedgerCount'>;
  now?: () => Date;
}

type Source<T> = { ok: true; value: T } | { ok: false; reason: string };

function readSource<T>(read: () => T): Source<T> {
  try { return { ok: true, value: read() }; }
  catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
}

function reason(source: Source<unknown>): string {
  return source.ok ? '' : `못 읽음 · 사유: ${cell(source.reason)}`;
}

function versionNumbers(version: string): number[] | null {
  return /^\d+\.\d+\.\d+$/.test(version) ? version.split('.').map(Number) : null;
}

function after03(version: string): boolean {
  const parts = versionNumbers(version);
  return !!parts && (parts[0]! > 0 || parts[1]! >= 3);
}

function compareVersions(left: string, right: string): number {
  const a = versionNumbers(left)!, b = versionNumbers(right)!;
  return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
}

function firstLine(evidence: string | undefined): string {
  return evidence?.split(/\r?\n/, 1)[0]?.trim() || '근거 없음';
}

/** Read-only report: failures in one ledger do not turn other sections into claims of success. */
export function generateAxBrief(version: string, sources: AxBriefSources): string {
  const now = (sources.now ?? (() => new Date()))().toISOString();
  const feature = readSource(sources.featureMap);
  const current = readSource(() => sources.checklist(version));
  const schedules = readSource(sources.schedules);
  const merges = readSource(sources.merges);
  const mergeCount = merges.ok && !merges.value.ledgerDirectoryMissing
    ? new Set(merges.value.entries.filter((entry) => entry.merged).map((entry) => entry.prNumber)).size : null;
  const mergeValue = merges.ok && !merges.value.ledgerDirectoryMissing && merges.value.unreadableLedgerCount > 0
    ? `못 읽음 · 사유: 원장 ${merges.value.unreadableLedgerCount}건 판독 실패 · 확인된 병합 ${mergeCount}건 (집계 불완전)`
    : mergeCount ?? (merges.ok ? '못 읽음 · 사유: 원장 디렉터리 없음' : reason(merges));
  const mergeCaveat = merges.ok && !merges.value.ledgerDirectoryMissing && (merges.value.unreadableLedgerCount || merges.value.excludedLedgerCount)
    ? ` · 미반영 원장: 못 읽음 ${merges.value.unreadableLedgerCount}건 · 중복 병합 제외 ${merges.value.excludedLedgerCount}건` : '';
  const featureRows = feature.ok ? feature.value.split(/\r?\n/).filter((line) => /^\| .* \| (?:된다|베타) \|/.test(line)) : [];
  const autonomous = current.ok ? current.value.filter((item) => AUTONOMY.has(item.id)) : [];
  const roadmap = schedules.ok ? schedules.value.filter((schedule) => after03(schedule.version)).sort((a, b) => compareVersions(a.version, b.version)) : [];
  const roadmapSources = roadmap.map((schedule) => ({ version: schedule.version, result: schedule.version === version ? current : readSource(() => sources.checklist(schedule.version)) }));
  const roadmapFailures = roadmapSources.filter(({ result }) => !result.ok).map(({ version: v, result }) => `${v}: ${reason(result)}`);
  const roadmapRows = roadmapSources.flatMap(({ version: v, result }) => result.ok
    ? result.value.filter((item) => ROADMAP.test(item.id)).map((item) => `| ${cell(v)} | ${cell(item.id)} | ${cell(item.title)} |`)
    : []);
  const owners = [...new Set(autonomous.map((item) => item.owner).filter((owner): owner is string => !!owner))];
  return [
    '# AX-BRIEF — 내부·파트너용 AX 브리핑',
    '',
    '> 공개 문서가 아닙니다. 내부 수치·자리 이름을 포함하며 외부 공개 판정으로 쓰지 않습니다.',
    `> 생성: ${cell(version)} · ${now} · 원천: FEATURE-MAP 생성 출력, 릴리스 체크리스트, 릴리스 일정(release schedules), self-implement run-ledger`,
    '',
    '## 1. 지금 되는 것',
    '',
    feature.ok ? '| 기능 | 성숙도 | 칸 id | 근거 PR |' : reason(feature),
    ...(feature.ok ? ['|---|---|---|---|', ...featureRows] : []),
    '',
    '## 2. 자율 단계표',
    '',
    current.ok ? '| 칸 | 판 | 상태 | 근거 첫 줄 |' : reason(current),
    ...(current.ok ? ['|---|---|---|---|', ...autonomous.map((item) => `| ${cell(item.id)} | ${cell(version)} | ${cell(item.status)} | ${cell(firstLine(item.evidence))} |`)] : []),
    ...(current.ok ? [`자리 이름: ${owners.length ? owners.map(cell).join(' · ') : '원장에 없음'}`] : []),
    '',
    `실제 병합 수 (self-implement run-ledger 전체 기록 · 중복 PR 제외 · 외부/수동 병합 제외): ${mergeValue}${mergeCaveat}`,
    '',
    '## 3. 로드맵 계단',
    '',
    '> 계획 · 바뀔 수 있습니다',
    schedules.ok ? '| 판 | 칸 | 제목 |' : reason(schedules),
    ...(schedules.ok ? ['|---|---|---|', ...roadmapRows, ...roadmapFailures.map((failure) => `못 읽음 · 사유: ${cell(failure)}`)] : []),
    '',
    '## 4. 도입 경로 (파일럿 기준 · 한 자리부터)',
    '',
    '1. **설치 한 줄 → 웹 앱 첫 화면** — 쓰던 구독을 그대로 알아본다.',
    '2. **한 자리(예: 마케팅 또는 기술)만** — L1(한 줄 → 병합)을 그 팀 저장소에서. 측정: 발사 대비 병합 · 사람 수확 비율.',
    '3. **결정 카드** — 비가역·공개만 사람에게. 나머지는 자리에 위임 범위를 적는다.',
    '4. **자리 넷 ⊕ 그림자 루프** — L2 를 «기록만»으로 일주일 대조한 뒤 live.',
    '5. **지식 팩** — 사내 문서·절차를 팩으로(로드맵 §3 · 유료 판매는 결정 뒤).',
    '',
  ].join('\n');
}

/** Derive the next release's internal brief from its ledgers and the RELEASE-STORY version-note draft.
 * The release loop supplies its version, ledger sources and isolated story paths; the standalone CLI stays unchanged. */
export function generateNextVersionAxBrief(
  nextVersion: string,
  sources: AxBriefSources,
  storyOptions: Omit<Parameters<typeof draftReleaseStory>[0], 'version'> = {},
): string {
  const brief = generateAxBrief(nextVersion, sources);
  const story = draftReleaseStory({ ...storyOptions, version: nextVersion });
  const announcementFile = story.files.find((file) => basename(file) === 'announcement.md');
  const announcement = story.status === 'drafted' && announcementFile
    ? readFileSync(announcementFile, 'utf8').replace(/^# [^\r\n]*\r?\n/, '').trim()
    : '사용자 대상 변경 없음 — RELEASE-STORY 초안을 건너뜀';
  return `${brief}\n## 5. 다음 판 변화·근거 (RELEASE-STORY 초안)\n\n> 공개 전 CMO 확인 필요 · 원천: release/next.md, 해당 판의 green 칸, 연결된 검증 소구점 원장\n\n${announcement}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} 값이 필요하다`);
    args.splice(index, 2);
    return value;
  };
  const version = option('--version');
  const out = option('--out');
  if (!version || args.length) throw new Error('Usage: bun scripts/marketing/generate-ax-brief.ts --version <v> [--out <file>]');
  const { listChecklist } = await import('../../src/release-loop/checklist.js');
  const { listSchedules } = await import('../../src/release-loop/release-schedule.js');
  const { queryMergedRunLedgers } = await import('../../src/self-implement/run-ledger.js');
  const { releaseLedgerRoot } = await import('../../src/instance/resolve.js');
  const root = releaseLedgerRoot();
  const checklist = (v: string) => listChecklist(v, root).items;
  const body = generateAxBrief(version, {
    featureMap: () => generateFeatureMap({ map: readFileSync(MAP, 'utf8'), items: checklist(version), registry: FEATURE_MATURITY, version }),
    checklist,
    schedules: () => listSchedules(root),
    merges: () => queryMergedRunLedgers(),
  });
  if (out) writeFileSync(out, body);
  else process.stdout.write(body);
}
