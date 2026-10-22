#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KnowhowLintError, lintKnowhow } from '../src/seat-loop/knowhow-lint.js';

export type RolePackRole = 'coordinator' | 'guardian';

export interface RolePack {
  role: RolePackRole;
  version: string;
  sha256: string;
  body: string;
  /** Built-in C/G rule identifiers; verified KNOWHOW identifiers appear in the body. */
  includedCardIds: string[];
  excludedCardIds: string[];
  sources: Array<{ path: string; sha256: string }>;
  /** Source docs absent from this root, e.g. the published package ships no internal docs. */
  missingSources: string[];
}

const KNOWHOW_PATH = 'docs/roles/OP/KNOWHOW.md';

/**
 * 카드 제목 문법은 src/seat-loop/knowhow-lint.ts 의 CARD_HEADING 과 같아야 한다.
 * 다르면 린트가 카드로 못 본 제목이 자를 때 조용히 사라지거나, 번호만 잘려 엉뚱한 아이디로 제외 기록에 남는다.
 */
const CARD_HEADING = /^[ \t]{0,3}##\s+(K-[A-Za-z]+-\d+)(?=$|\s|:|—)(.*)$/u;
const CARD_HEADING_LIKE = /^[ \t]{0,3}##\s*(K-[^\s:]*)/iu;
const SECTION_HEADING = /^[ \t]{0,3}##\s/u;

/**
 * KNOWHOW.md 를 `##` 제목 단위 카드로 자른다(코드 울타리 안은 본문으로 본다).
 * 린트 문법을 지킨 `## K-<role>-<number>` 제목만 카드로 반환하고, 카드처럼 보이지만 문법을 벗어난 제목은 파일 단위 린트처럼 실패한다.
 */
export function splitKnowhowCards(body: string): Array<{ id: string; title: string; text: string }> {
  const segments: Array<{ heading: string | null; lines: string[] }> = [{ heading: null, lines: [] }];
  let fence: { marker: string; length: number } | null = null;
  for (const line of body.split(/\r?\n/u)) {
    const fenceLine = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (fenceLine && fenceLine[1]![0] === fence.marker && fenceLine[1]!.length >= fence.length && /^[ \t]*$/u.test(fenceLine[2]!)) fence = null;
      segments.at(-1)!.lines.push(line);
      continue;
    }
    if (fenceLine) {
      fence = { marker: fenceLine[1]![0]!, length: fenceLine[1]!.length };
      segments.at(-1)!.lines.push(line);
      continue;
    }
    if (SECTION_HEADING.test(line)) {
      segments.push({ heading: line, lines: [] });
      continue;
    }
    segments.at(-1)!.lines.push(line);
  }
  const cards: Array<{ id: string; title: string; text: string }> = [];
  for (const segment of segments) {
    if (!segment.heading) continue;
    const heading = segment.heading.match(CARD_HEADING);
    if (!heading) {
      // 카드처럼 보이는 제목이 문법을 벗어나면 통과도 제외 기록도 불가능하다 — 조용히 빼지 않고 그 자리에서 실패한다.
      const like = segment.heading.match(CARD_HEADING_LIKE);
      if (like) throw new KnowhowLintError(KNOWHOW_PATH, like[1]!, '카드 제목 형식이 K-<자리>-<번호>를 벗어남');
      continue;
    }
    cards.push({ id: heading[1]!, title: heading[2]!.replace(/^[:\s—]+/u, '').trim(), text: [segment.heading, ...segment.lines].join('\n') });
  }
  return cards;
}

/**
 * KNOWHOW 카드 중 src/seat-loop/knowhow-lint.ts 의 린트를 통과한 항목만 검증된 출처로 싣는다.
 * 실패 항목(비밀값 포함)은 제외하고 그 아이디만 남긴다. 파일이 없으면 아무것도 싣지 않는다.
 */
export function collectVerifiedKnowhow(repo: string): {
  included: Array<{ id: string; title: string; text: string }>;
  excluded: string[];
  fileBody: string | null;
} {
  let body: string;
  try {
    body = readFileSync(resolve(repo, KNOWHOW_PATH), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { included: [], excluded: [], fileBody: null };
    throw error;
  }
  const included: Array<{ id: string; title: string; text: string }> = [];
  const excluded: string[] = [];
  for (const card of splitKnowhowCards(body)) {
    try {
      lintKnowhow(card.text, KNOWHOW_PATH);
      included.push({ id: card.id, title: card.title, text: card.text });
    } catch (error) {
      if (error instanceof KnowhowLintError) {
        excluded.push(card.id);
        continue;
      }
      throw error;
    }
  }
  return { included, excluded, fileBody: body };
}

const SOURCE_PATHS = [
  'AGENTS.md',
  'docs/roles/OP.md',
  'docs/handbook/LOOP-AGENTS.md',
  'docs/handbook/OPERATIONS.md',
  'scripts/coord-role-pack.ts',
] as const;

// OP's 2026-10-14 verified C/G harvest. These are guidance, never an L0 grant.
// Moving thresholds, dates, paths, and host capacity must be checked in live state.
const COORDINATOR_CARDS = [
  ['C1', '기둥 우선순위는 루프 에이전트(L1) > 그래프 엔지니어링(L2) > TUI > 마찰 없는 SETUP > 받침 > 바닥으로 제안한다.'],
  ['C2', '조율자·수호자·과제 담당 칸의 조기 전력화를 우선한다. M4 전 배치는 현 판 일정과 대표 결정을 다시 확인한다.'],
  ['C3', '가속 칸은 루브릭 점수가 낮아도 앞 판 후보가 된다. 승인된 점수 밖 이동은 근거에 배치 덮어씀과 결정 출처를 남긴다.'],
  ['C4', '판 용량은 고정값으로 보지 않는다. 착지 속도를 재고 뒤 판을 당길지 제안한다.'],
  ['C5', '판과 발행 날짜의 대응은 현 일정 정본에서 확인한다. 과거 날짜 공식만으로 이동을 결정하지 않는다.'],
  ['C6', '선행 칸의 판은 후행 칸보다 늦지 않게 제안한다. 컷 중인 판과 도는 런 칸은 옮기기 전 상태를 다시 확인한다.'],
  ['C7', '일반 리뷰는 2라운드째 전제·요구·분할을 적고, 3라운드에 must-fix가 남거나 같은 지적이 2회면 쪼개기·부분 착지·연결골로 트리아지한다.'],
  ['C8', '조각 착지 뒤에는 착지한 범위로 원 칸을 다시 이름 붙여 green을 제안하고, 잔여는 원 칸 선행과 남은 조각 근거를 가진 새 yellow 칸에 둔다.'],
  ['C9', '서로 기다리는 PR은 통합 착지 또는 무해한 독립 조각의 순차 착지를 제안한다. 미설정이면 몸이 0인지를 계약으로 확인한다.'],
  ['C10', 'TA 칸 첫 줄 대상 경로는 origin/main에 실제 있는 저장소 상대 파일로 확인한다. 신설 파일은 별도 신설 줄에 둔다.'],
  ['C11', '관측·A/B 운영만 하는 칸은 구현 대상 경로를 억지로 넣지 말고 명시적 hold와 판정 근거를 제안한다.'],
  ['C12', '여러 실패의 공용 원인이 확인되면 수리 칸을 컷 판의 P0·가속 후보로 제안하고, 영향 칸은 사유 있는 hold 뒤 수리 반영을 확인해 재발사를 제안한다.'],
  ['C13', '최우선은 순서의 맨 앞이라는 뜻이다. 다른 일을 멈추는 조정은 자원이 실제로 부딪칠 때만 제안한다.'],
  ['C14', '대표가 지정한 관심 태스크는 일반 리뷰 트리아지 상한 밖에서 지적 지점만 최소 수리하며 착지까지 추적한다. 막히면 다른 자리를 붙이도록 제안하고 추적 간격은 현재 지시를 확인한다.'],
] as const;

const GUARDIAN_CARDS = [
  ['G1', '착지와 TA 발사의 부하선은 서로 다를 수 있다. 현재 설정과 1분·5분 추세를 함께 재고 대기 루프에서 다시 판정한다.'],
  ['G2', 'mbp의 무거운 타입검사·게이트·리뷰·빌드는 승인된 원격 호스트에 배치한다. worktree 전수 검색을 피하고 무거운 로그 조회는 자리당 동시 1로 제한한다.'],
  ['G3', 'node-b의 착지·TUI 전용 슬롯과 일반 게이트 호스트의 현재 임대를 확인한다. 말로만 예약하지 말고 토큰·잠금으로 충돌을 막도록 제안한다.'],
  ['G4', 'TA 부모와 Pod의 원격 배치, 호스트별 상한, 자리별 주기 한도는 현재 설정과 런 상태로 확인한다.'],
  ['G5', '착지 슬롯은 전역으로 세고 OP 착지는 한 번에 하나씩 제안한다. 실행기 종료 뒤 고아 표지는 현 슬롯 원장에서 대조한다.'],
  ['G6', 'heavy-remote의 gate-host-busy는 착지 실패로 단정하지 말고 현재 실행기 규약의 대기·재시도 경로로 보낸다. mbp 로컬 폴백은 제안하지 않는다.'],
  ['G7', 'macOS 정기 작업의 gh 인증 실패는 keyring 접근 여부를 확인한다. 측정 실패는 못 잼과 종료 코드를 남기고 로그인 세션 루프를 제안한다.'],
  ['G8', '시험이 운영 상태에 쓴 흔적은 우주 격리 결함으로 기록한다. 격리 수리와 운영 흔적 확인 뒤에만 청소를 제안한다.'],
  ['G9', '운영 설정 변경은 사전 백업과 사후 diff를 요구한다. 문자열 SHA의 JSON 인용을 확인하고 비밀값은 출력하지 않는다.'],
  ['G10', '같은 날 shadow→live 전환과 루프 상태 파일이 어긋나면 틱 실패를 의심한다. 임시 복구와 mode별 상태 분리 수리를 구별한다.'],
  ['G11', '상주 감시는 세션 밖에서 돌리고 Monitor 만료 시 재무장과 심장박동을 확인한다.'],
  ['G12', 'smbd·Finder의 지속 CPU 점유는 mbp 기저 부하 후보로 관측하고, 본부 이전 전 재측정할 항목으로 남긴다.'],
] as const;

function sha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** Deterministic, read-only L0 role pack. Knowledge cards require a separate verified source. */
export function buildCoordRolePackManifest(role: RolePackRole, root = resolve(import.meta.dir, '..')): RolePack {
  const repo = resolve(root);
  // The pack body is inline. Source docs only contribute hashes, so an installed package without them still builds.
  const present = SOURCE_PATHS.filter((path) => existsSync(resolve(repo, path)));
  const missingSources = SOURCE_PATHS.filter((path) => !present.includes(path));
  const sources: RolePack['sources'] = present.map((path) => ({ path, sha256: sha256(readFileSync(resolve(repo, path), 'utf8')) }));
  const knowhow = collectVerifiedKnowhow(repo);
  if (knowhow.fileBody !== null) sources.push({ path: KNOWHOW_PATH, sha256: sha256(knowhow.fileBody) });
  const packageJson = resolve(repo, 'package.json');
  const version = existsSync(packageJson)
    ? (JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string }).version : 'unknown';
  const roleText = role === 'coordinator'
    ? [
        '## 역할: 조율자',
        '- 전체 칸과 자리의 관측을 모아 우선순위·분배·보류를 제안한다. 칸의 실제 판정은 담당 자리의 근거와 대조한다.',
        '- 질문에 답하기 전에 메시지, 확인표, 과제 카드, 로그를 읽는다. 못 읽은 값은 측정 불가로 밝힌다.',
        '- 세 번 실패하거나 새 경계가 반복되면 전제·요구·분할을 먼저 적는다. 핵심은 칸 판정에 필요한 것, 확장은 나머지다.',
        '- 막힌 칸 하나가 착지 줄 전체를 멈추게 하지 않는다. 다음 준비 완료 칸을 본다.',
      ]
    : [
        '## 역할: 수호자',
        '- 전체 자원·호스트·임대·계정·과금·무결성을 관측하고 입장 또는 대기를 제안한다.',
        '- 부하는 1분·5분 추세를 함께 보고, 한 번의 스파이크만으로 창을 닫지 않는다.',
        '- 무거운 게이트는 원격 호스트에서 한 번만 실행한다. host slot busy는 실행 전 거부이며 그동안 가벼운 검토를 먼저 한다.',
        '- 실제 공급자 크레딧과 경유 공급자의 비용을 구별하고, 비밀값은 출력하지 않는다.',
      ];
  const cards = role === 'coordinator' ? COORDINATOR_CARDS : GUARDIAN_CARDS;
  const lines = [
    '# 금지 목록',
    '- 돈·보안 설정·자격·계정·외부 공개·되돌릴 수 없는 일은 사람 승인 없이 실행하지 않는다.',
    '- L0에서는 우편 답글 제안만 한다. 칸 변경·잠금·착지·코드 쓰기는 하지 않는다.',
    '- `pr land` 거부를 우회하거나 `gh pr merge`·force push·rebase를 실행하지 않는다.',
    '- 자격 파일·토큰 원문을 읽거나 메시지·로그·팩에 싣지 않는다.',
    '- 관측 실패를 성공 또는 0건으로 바꾸지 않는다.',
    '',
    `# ${role} 역할 팩`,
    `판: ${version}`,
    '출처: AGENTS.md 요지 · docs/roles/OP.md §1~2 · docs/handbook/LOOP-AGENTS.md §0,§5,§10 · docs/handbook/OPERATIONS.md §2~5 · scripts/coord-role-pack.ts 운영 지식 v1',
    '권한과 현재 값은 코드·설정·운영 원장으로 다시 확인한다. 이 팩은 권한을 부여하지 않는다.',
    '',
    ...roleText,
    '',
    '## 검증된 운영 지식 v1',
    '각 줄은 판단 제안이며 현재 값·권한은 운영 원장과 설정에서 다시 확인한다.',
    '재는 명령: `eln release checklist status --version <판> --json`(칸·선행·판) · `eln config get harness.podPool`(Pod 풀) · `uptime`(부하 추세) · `eln self gate --help`(호스트·게이트 옵션). 명령이 못 재는 슬롯·런 상태는 담당 원장의 현행 명령을 확인한다.',
    ...cards.map(([id, rule]) => `- ${id} · ${rule} → 팩 ${role === 'coordinator' ? '조율자' : '수호자'} v1`),
    '',
    '## KNOWHOW — 검증된 출처',
    `docs/roles/OP/KNOWHOW.md 항목 중 src/seat-loop/knowhow-lint.ts 의 린트를 통과한 항목만 싣는다. 실패 항목·비밀값은 제외한다.`,
    ...knowhow.included.map((card) => `- ${card.id} · ${card.title}`),
    ...knowhow.included.flatMap((card) => ['', card.text]),
    '',
    '## 판단 순서',
    '1. 원 요청과 지금의 우편 스레드·확인표 칸을 대조한다.',
    '2. 코드·설정·실행 결과를 읽고, 문서와 충돌하면 현재 실행 결과를 따른다.',
    '3. 관측·판단 근거·다음 행동을 분리해 답한다. 쓰기는 현재 확인 단계가 허용한 명령으로만 한다.',
    '4. 근거가 없거나 안전 난간과 충돌하면 보류하고 담당 자리 또는 사람에게 올린다.',
    '',
    '위에 명시한 검증된 C/G 카드와 KNOWHOW 린트 통과 항목 외의 노하우는 포함하지 않는다. 현재 관측과 담당 자리의 검증된 원장을 직접 확인한다.',
    '## 출처 해시',
    ...sources.map((source) => `- ${source.path}: ${source.sha256}`),
    ...missingSources.map((path) => `- ${path}: 없음(이 설치본에 미포함)`),
    '',
  ];
  const body = lines.join('\n');
  return { role, version, sha256: sha256(body), body, includedCardIds: cards.map(([id]) => id), excludedCardIds: knowhow.excluded, sources, missingSources };
}

/** Prompt body consumed by coordinator and guardian agents. */
export function buildCoordRolePack(role: RolePackRole, root = resolve(import.meta.dir, '..')): string {
  return buildCoordRolePackManifest(role, root).body;
}

if (import.meta.main) {
  const roleArg = process.argv.indexOf('--role');
  const role = process.argv[roleArg + 1];
  if (roleArg < 0 || (role !== 'coordinator' && role !== 'guardian')) {
    console.error('usage: bun scripts/coord-role-pack.ts --role coordinator|guardian [--json]');
    process.exitCode = 2;
  } else {
    const pack = buildCoordRolePackManifest(role);
    process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(pack)}\n` : pack.body);
  }
}
