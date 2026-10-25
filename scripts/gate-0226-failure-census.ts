#!/usr/bin/env bun
/**
 * GATE-0226-REMAINING-90 — 0.2.26 gate 실패 ID 전수표의 무결성 검증 진입점.
 *
 * 판정: `docs/reports/gate-0226-failure-census.tsv`가 accepted 실패 ID 96건을 중복 없이 보존하고,
 * 그중 `provider-intake` 6건(첫 감소 칸 GATE-0226-PROVIDER-INTAKE6)을 제외한 90건이 정확히 남으며,
 * `Error: no ACP` 로그 사건(34회)은 실패 ID로 더해지지 않았음. 보고서 md의 96행 색인과 선언 카운트도 실측과 일치.
 *
 * 사용: bun run scripts/gate-0226-failure-census.ts [--tsv <path>] [--report <path>] [--accepted <path|none>] [--json] [--write-repair-card]
 *
 * `--write-repair-card`: 표의 `repair_card` 칸을 묶음·주인에서 다시 계산해 되쓴다(검증은 그대로 이어진다).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const CENSUS_TSV = 'docs/reports/gate-0226-failure-census.tsv';
export const CENSUS_REPORT = 'docs/reports/REPORT-gate-0226-failure-census.md';
export const DEFAULT_ACCEPTED = 'elanous-hq/seat-state/OP/tools/accepted-0226.json';

export const EXPECTED_HEADER = [
  'no',
  'test_id',
  'source_file',
  'group',
  'classification',
  'root_cause',
  'repro_command',
  'evidence',
  'prescription',
  'owner',
  'replacement_contract_if_deleted',
  'status',
  'repair_card',
] as const;

export const TOTAL_IDS = 96;
export const INTAKE_GROUP = 'provider-intake';
export const INTAKE_IDS = 6;
export const REMAINING_IDS = 90;

export const EXPECTED_STATUS: Record<string, number> = {
  'hypothesis-unverified': 68,
  'paired-reproduced-root-cause-candidate': 7,
  'untriaged': 21,
};

export const EXPECTED_GROUP: Record<string, number> = {
  'UX-gate-pair': 5,
  'blocked-draft': 7,
  'plugin-stdin-EPIPE-candidate': 7,
  'provider-intake': 6,
  'provider-self-implement': 2,
  'remaining-review': 61,
  'webclone-measure': 8,
};

export const REQUIRED_FIELDS = ['classification', 'root_cause', 'repro_command', 'evidence', 'prescription', 'owner'] as const;

export const NO_ACP_MARKER = 'Error: no ACP';
export const ACP_LOG_EVENTS = 34;
export const NO_DELETION_PROPOSAL = '시험 삭제 제안 없음';

/** 묶음 → 수리 칸. `remaining-review` 만 주인별로 다시 쪼갠다. */
export const REPAIR_CARDS_BY_GROUP: Record<string, string> = {
  'provider-intake': 'GATE-0226-PROVIDER-INTAKE6',
  'webclone-measure': 'GATE-0226-WEBCLONE-MEASURE',
  'blocked-draft': 'GATE-0226-BLOCKED-DRAFT',
  'plugin-stdin-EPIPE-candidate': 'GATE-0226-PLUGIN-STDIN-EPIPE',
  'UX-gate-pair': 'GATE-0226-UX-GATE-PAIR',
  'provider-self-implement': 'GATE-0226-PROVIDER-SELF-IMPLEMENT',
};

export const REMAINING_CARD_PREFIX = 'GATE-0226-REMAINING-';

/** 주인 표기(`TC/OP gate`·`UX/Android·OP gate`)에서 두 글자 이상 대문자 트랙 이름만 뽑아 칸 이름 꼬리를 만든다. */
export function ownerSlug(owner: string): string {
  const tracks: string[] = [];
  for (const token of owner.split(/[/·]/)) {
    const match = /^[A-Z]{2,}/.exec(token.trim());
    if (match && !tracks.includes(match[0])) tracks.push(match[0]);
  }
  return tracks.join('-');
}

/** 한 실패 ID를 어느 수리 칸이 이어받는지 정한다. 묶음 단위 칸 + `remaining-review` 는 주인 단위 칸. */
export function repairCardFor(group: string, owner: string): string {
  const fixed = REPAIR_CARDS_BY_GROUP[group];
  if (fixed) return fixed;
  const slug = ownerSlug(owner);
  return slug.length > 0 ? `${REMAINING_CARD_PREFIX}${slug}` : REMAINING_CARD_PREFIX;
}

export type CensusRow = Record<(typeof EXPECTED_HEADER)[number], string>;

export type CensusAudit = {
  ok: boolean;
  problems: string[];
  counts: {
    rows: number;
    intake: number;
    remaining: number;
    status: Record<string, number>;
    group: Record<string, number>;
    repair: Record<string, number>;
  };
  intakeIds: string[];
  remainingIds: string[];
  acpLogEvents: number;
  ledger: { path: string; status: 'compared' | 'skipped' | 'failed'; ids: number };
};

/** RFC4180 형식의 탭 구분 표를 읽는다. 실패 ID 안의 따옴표·탭·개행을 보존한다. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === '\t') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim().length > 0));
}

function encodeCell(value: string): string {
  return /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** `CensusRow`를 탭 구분 표로 되쓴다(따옴표는 필요할 때만, 줄바꿈은 `\n`). */
export function serializeTsv(rows: CensusRow[]): string {
  const lines = [EXPECTED_HEADER.join('\t')];
  for (const row of rows) lines.push(EXPECTED_HEADER.map((name) => encodeCell(row[name])).join('\t'));
  return `${lines.join('\n')}\n`;
}

/**
 * 표의 `repair_card` 칸을 묶음·주인에서 다시 계산해 파일에 되쓴다.
 * 표에 정본 스키마 밖 칸이 있으면 자료를 잃지 않도록 거부한다.
 */
export function writeRepairCards(path: string): number {
  const rawRows = parseTsv(readFileSync(path, 'utf8'));
  const header = rawRows[0] ?? [];
  const unknown = header.filter((name) => !(EXPECTED_HEADER as readonly string[]).includes(name));
  if (unknown.length > 0) throw new Error(`${path}: 정본 스키마 밖 칸 (${unknown.join(', ')})`);
  const rows: CensusRow[] = rawRows.slice(1).map((cells) => {
    const row = {} as CensusRow;
    EXPECTED_HEADER.forEach((name) => {
      const at = header.indexOf(name);
      row[name] = at >= 0 ? (cells[at] ?? '') : '';
    });
    row.repair_card = repairCardFor(row.group, row.owner);
    return row;
  });
  writeFileSync(path, serializeTsv(rows), 'utf8');
  return rows.length;
}

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function sortedTally(values: string[]): Record<string, number> {
  const counted = tally(values);
  const out: Record<string, number> = {};
  for (const key of Object.keys(counted).sort()) out[key] = counted[key]!;
  return out;
}

function sameTally(actual: Record<string, number>, expected: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of keys) if ((actual[key] ?? 0) !== (expected[key] ?? 0)) return false;
  return true;
}

/** 보고서 md의 `| 번호 | \`실패 ID\` | 묶음 | \`상태\` | 주인 |` 색인 행을 읽는다. */
export function parseReportIndex(report: string): Array<{ no: number; test_id: string; group: string; status: string; owner: string }> {
  const out: Array<{ no: number; test_id: string; group: string; status: string; owner: string }> = [];
  for (const line of report.split('\n')) {
    const match = /^\| (\d+) \| `(.+?)` \| (.+?) \| `(.+?)` \| (.+?) \|$/.exec(line);
    if (!match) continue;
    out.push({
      no: Number(match[1]),
      test_id: match[2]!.replace(/\\\|/g, '|'),
      group: match[3]!.trim(),
      status: match[4]!,
      owner: match[5]!.trim(),
    });
  }
  return out;
}

/** 보고서 md가 선언한 `총 N건 = provider-intake M건 + 나머지 K건` 문면을 읽는다. */
export function parseReportCounts(report: string): { total: number; intake: number; remaining: number } | null {
  const match = /총 (\d+)건 = provider-intake (\d+)건[^\n]*나머지 (\d+)건/.exec(report);
  if (!match) return null;
  return { total: Number(match[1]), intake: Number(match[2]), remaining: Number(match[3]) };
}

/** 보고서 md의 수리 칸 표 `| \`GATE-0226-…\` | N |` 행을 읽는다. */
export function parseReportRepairCards(report: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of report.split('\n')) {
    const match = /^\| `(GATE-0226-[A-Z0-9-]+)` \| (\d+) \|/.exec(line);
    if (match) out[match[1]!] = Number(match[2]);
  }
  return out;
}

function readAcceptedIds(path: string): string[] | null {
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${path}: accepted 원장이 배열이 아니다`);
  return parsed.map((entry) => {
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) throw new Error(`${path}: id 없는 항목`);
    return id;
  });
}

export type AuditInput = {
  tsvText: string;
  reportText: string;
  /** accepted 원장 ID. null 이면 비교 불가(원장 부재)를 산출로 남긴다. */
  acceptedIds: string[] | null;
  ledgerPath: string;
  ledgerRequired: boolean;
};

export function auditCensus(input: AuditInput): CensusAudit {
  const problems: string[] = [];
  const rawRows = parseTsv(input.tsvText);
  const header = rawRows[0] ?? [];
  const headerMatches = header.length === EXPECTED_HEADER.length && EXPECTED_HEADER.every((name, at) => header[at] === name);
  if (!headerMatches) {
    problems.push(`tsv-header: 기대 ${EXPECTED_HEADER.join(',')} / 실측 ${header.join(',')}`);
  }
  const rows: CensusRow[] = rawRows.slice(1).map((cells) => {
    const row = {} as CensusRow;
    EXPECTED_HEADER.forEach((name, at) => {
      row[name] = cells[at] ?? '';
    });
    return row;
  });

  if (rows.length !== TOTAL_IDS) problems.push(`row-count: 기대 ${TOTAL_IDS}행 / 실측 ${rows.length}행`);

  const numbering = rows.map((row) => Number(row.no));
  const numbered = numbering.every((value, at) => value === at + 1);
  if (!numbered) problems.push(`row-numbering: no 컬럼이 1..${rows.length} 순차가 아니다 (${numbering.slice(0, 5).join(',')}…)`);

  const ids = rows.map((row) => row.test_id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    const dupes = Object.entries(tally(ids))
      .filter(([, count]) => count > 1)
      .map(([id]) => id);
    problems.push(`unique-ids: 중복 ${ids.length - uniqueIds.size}건 (${dupes.slice(0, 3).join(' | ')})`);
  }

  const intakeRows = rows.filter((row) => row.group === INTAKE_GROUP);
  const otherRows = rows.filter((row) => row.group !== INTAKE_GROUP);
  const intakeIds = intakeRows.map((row) => row.test_id);
  const remainingIds = otherRows.map((row) => row.test_id);
  if (intakeRows.length !== INTAKE_IDS) {
    problems.push(`intake-split: ${INTAKE_GROUP} 기대 ${INTAKE_IDS}건 / 실측 ${intakeRows.length}건`);
  }
  if (otherRows.length !== REMAINING_IDS) {
    problems.push(`intake-split: 제외 후 나머지 기대 ${REMAINING_IDS}건 / 실측 ${otherRows.length}건`);
  }
  const overlap = remainingIds.filter((id) => intakeIds.includes(id));
  if (overlap.length > 0) problems.push(`intake-split: 제외 대상이 남은 묶음에도 있다 (${overlap.slice(0, 3).join(' | ')})`);
  if (new Set(remainingIds).size !== remainingIds.length) {
    problems.push(`intake-split: 제외 후 90건에 id 중복이 있다`);
  }

  const intakeCard = REPAIR_CARDS_BY_GROUP[INTAKE_GROUP]!;
  const wrongCard = rows.filter((row) => row.repair_card !== repairCardFor(row.group, row.owner));
  if (wrongCard.length > 0) {
    problems.push(
      `repair-card: 묶음·주인에서 유도한 칸 이름과 다른 행 ${wrongCard.length}건 (no ${wrongCard.slice(0, 4).map((row) => row.no).join(',')})`,
    );
  }
  const repair = sortedTally(rows.map((row) => row.repair_card));
  const onIntakeCard = rows.filter((row) => row.repair_card === intakeCard);
  if (onIntakeCard.length !== INTAKE_IDS) {
    problems.push(`repair-card: ${intakeCard} 기대 ${INTAKE_IDS}건 / 실측 ${onIntakeCard.length}건`);
  }
  const afterIntakeCard = rows.filter((row) => row.repair_card !== intakeCard);
  if (afterIntakeCard.length !== REMAINING_IDS) {
    problems.push(`repair-card: ${intakeCard} 제외 후 기대 ${REMAINING_IDS}건 / 실측 ${afterIntakeCard.length}건`);
  }

  const status = sortedTally(rows.map((row) => row.status));
  if (!sameTally(status, EXPECTED_STATUS)) {
    problems.push(`status-totals: 기대 ${JSON.stringify(EXPECTED_STATUS)} / 실측 ${JSON.stringify(status)}`);
  }
  const group = sortedTally(rows.map((row) => row.group));
  if (!sameTally(group, EXPECTED_GROUP)) {
    problems.push(`group-totals: 기대 ${JSON.stringify(EXPECTED_GROUP)} / 실측 ${JSON.stringify(group)}`);
  }

  const acpAttributed = rows.filter((row) => [row.evidence, row.root_cause, row.repro_command].some((cell) => cell.includes(NO_ACP_MARKER)));
  if (acpAttributed.length > 0) {
    problems.push(`no-acp-exclusion: \`${NO_ACP_MARKER}\` 로그 사건을 실패 ID로 센 행 ${acpAttributed.length}건 (${acpAttributed.map((row) => row.no).join(',')})`);
  }

  const blankCells: string[] = [];
  const deletionProposals: string[] = [];
  for (const row of rows) {
    for (const field of REQUIRED_FIELDS) {
      if (row[field].trim().length === 0) blankCells.push(`${row.no}.${field}`);
    }
    if (row.replacement_contract_if_deleted.trim().length === 0) blankCells.push(`${row.no}.replacement_contract_if_deleted`);
    else if (!row.replacement_contract_if_deleted.includes(NO_DELETION_PROPOSAL)) deletionProposals.push(row.no);
  }
  if (blankCells.length > 0) problems.push(`evidence-completeness: 빈 칸 ${blankCells.length}개 (${blankCells.slice(0, 6).join(',')})`);
  if (deletionProposals.length > 0) {
    problems.push(`no-test-deletion-proposed: 근거 없이 시험 삭제를 제안한 행 ${deletionProposals.length}건 (${deletionProposals.slice(0, 6).join(',')})`);
  }

  const index = parseReportIndex(input.reportText);
  if (index.length !== rows.length) {
    problems.push(`report-index-parity: 보고서 색인 ${index.length}행 / TSV ${rows.length}행`);
  } else {
    const mismatched = rows.filter((row, at) => {
      const entry = index[at]!;
      return entry.no !== at + 1 || entry.test_id !== row.test_id || entry.group !== row.group || entry.status !== row.status || entry.owner !== row.owner;
    });
    if (mismatched.length > 0) {
      problems.push(`report-index-parity: TSV와 어긋난 색인 행 ${mismatched.length}건 (no ${mismatched.slice(0, 4).map((row) => row.no).join(',')})`);
    }
  }

  const declared = parseReportCounts(input.reportText);
  if (!declared) {
    problems.push('report-counts: 보고서에 `총 N건 = provider-intake M건 … 나머지 K건` 선언이 없다');
  } else if (declared.total !== rows.length || declared.intake !== intakeRows.length || declared.remaining !== otherRows.length) {
    problems.push(
      `report-counts: 보고서 선언 ${declared.total}/${declared.intake}/${declared.remaining} / 실측 ${rows.length}/${intakeRows.length}/${otherRows.length}`,
    );
  }
  const declaredRepair = parseReportRepairCards(input.reportText);
  if (Object.keys(declaredRepair).length === 0) {
    problems.push('report-repair-parity: 보고서에 수리 칸 표(`| `GATE-0226-…` | N |`)가 없다');
  } else if (!sameTally(declaredRepair, repair)) {
    problems.push(`report-repair-parity: 보고서 선언 ${JSON.stringify(declaredRepair)} / 실측 ${JSON.stringify(repair)}`);
  }
  if (!input.reportText.includes(NO_ACP_MARKER) || !input.reportText.includes(`${ACP_LOG_EVENTS}회`) || !input.reportText.includes('겹침은 0건')) {
    problems.push(`report-counts: 보고서가 \`${NO_ACP_MARKER}\` ${ACP_LOG_EVENTS}회 · 겹침 0건 배제를 명시하지 않는다`);
  }

  let ledger: CensusAudit['ledger'];
  if (input.acceptedIds === null) {
    if (input.ledgerRequired) {
      problems.push(`accepted-ledger: 원장 파일이 없다 (${input.ledgerPath})`);
      ledger = { path: input.ledgerPath, status: 'failed', ids: 0 };
    } else {
      ledger = { path: input.ledgerPath, status: 'skipped', ids: 0 };
    }
  } else {
    const accepted = new Set(input.acceptedIds);
    const missing = ids.filter((id) => !accepted.has(id));
    const extra = [...accepted].filter((id) => !uniqueIds.has(id));
    if (missing.length > 0 || extra.length > 0 || accepted.size !== rows.length) {
      problems.push(`accepted-ledger: 원장 ${accepted.size}건 / TSV ${rows.length}건 · 누락 ${missing.length} · 여분 ${extra.length}`);
      ledger = { path: input.ledgerPath, status: 'failed', ids: accepted.size };
    } else {
      ledger = { path: input.ledgerPath, status: 'compared', ids: accepted.size };
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    counts: { rows: rows.length, intake: intakeRows.length, remaining: otherRows.length, status, group, repair },
    intakeIds,
    remainingIds,
    acpLogEvents: acpAttributed.length,
    ledger,
  };
}

export function renderText(audit: CensusAudit): string {
  const lines: string[] = [];
  lines.push(`rows: ${audit.counts.rows} (${INTAKE_GROUP} ${audit.counts.intake} excluded → ${audit.counts.remaining})`);
  lines.push(`group: ${Object.entries(audit.counts.group).map(([key, value]) => `${key}=${value}`).join(' ')}`);
  lines.push(`status: ${Object.entries(audit.counts.status).map(([key, value]) => `${key}=${value}`).join(' ')}`);
  lines.push(`repair-cards: ${Object.entries(audit.counts.repair).map(([key, value]) => `${key}=${value}`).join(' ')}`);
  lines.push(`no-acp: ${audit.acpLogEvents} (로그 ${ACP_LOG_EVENTS}회 사건은 실패 ID가 아니다)`);
  lines.push(`accepted-ledger: ${audit.ledger.status} ${audit.ledger.path}${audit.ledger.status === 'skipped' ? ' (원장 부재 — 원장 대조 미실시)' : ''}`);
  for (const problem of audit.problems) lines.push(`FAIL ${problem}`);
  lines.push(audit.ok ? 'census: PASS' : `census: FAIL (${audit.problems.length})`);
  return lines.join('\n');
}

type CliOptions = {
  tsv: string;
  report: string;
  accepted: string | null;
  acceptedExplicit: boolean;
  json: boolean;
  writeRepairCard: boolean;
};

function parseArgs(argv: string[], cwd: string): CliOptions {
  const options: CliOptions = {
    tsv: resolve(cwd, CENSUS_TSV),
    report: resolve(cwd, CENSUS_REPORT),
    accepted: join(homedir(), DEFAULT_ACCEPTED),
    acceptedExplicit: false,
    json: false,
    writeRepairCard: false,
  };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]!;
    const next = argv[at + 1];
    if (arg === '--tsv' && next) {
      options.tsv = resolve(cwd, next);
      at += 1;
    } else if (arg === '--report' && next) {
      options.report = resolve(cwd, next);
      at += 1;
    } else if (arg === '--accepted' && next) {
      options.acceptedExplicit = true;
      options.accepted = next === 'none' ? null : resolve(cwd, next);
      at += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--write-repair-card') {
      options.writeRepairCard = true;
    } else {
      throw new Error(`알 수 없는 인자: ${arg}`);
    }
  }
  return options;
}

export function main(argv: string[] = process.argv.slice(2), cwd: string = process.cwd()): number {
  let options: CliOptions;
  try {
    options = parseArgs(argv, cwd);
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    return 2;
  }
  for (const path of [options.tsv, options.report]) {
    if (!existsSync(path)) {
      console.error(`FAIL inputs: 필수 파일이 없다 — ${path}`);
      return 2;
    }
  }
  if (options.writeRepairCard) {
    const rewritten = writeRepairCards(options.tsv);
    process.stdout.write(`repair-card: ${rewritten}행 재계산 → ${options.tsv}\n`);
  }
  const acceptedIds = options.accepted ? readAcceptedIds(options.accepted) : null;
  const audit = auditCensus({
    tsvText: readFileSync(options.tsv, 'utf8'),
    reportText: readFileSync(options.report, 'utf8'),
    acceptedIds,
    ledgerPath: options.accepted ?? 'none',
    ledgerRequired: options.acceptedExplicit && options.accepted !== null,
  });
  process.stdout.write(`${options.json ? JSON.stringify(audit, null, 2) : renderText(audit)}\n`);
  return audit.ok ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main());
}
