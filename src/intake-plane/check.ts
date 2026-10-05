/**
 * Intake check — 바깥에서 들어온 사실을 elanous 현재와 대조한다.
 *
 * 한 줄은 `바깥 사실 → elanous 현재(근거 경로:줄) → 판정` 이다.
 * 판정이 구멍/낡음(없음·판단 필요)인 항목만 골 초안 파일을 쓴다.
 * 하니스 런은 발사하지 않는다. 태스크도 등록하지 않는다.
 *
 * 자는 원천을 읽어서 만든다. 원천이 바뀌면 코드를 고치지 않아도 따라간다.
 *   능력  catalog/resources.yaml required_for ⊕ catalog/external-commands.yaml
 *   표면  src/index.ts ⊕ src/cli 아래 TypeScript 파일의 .command 등록 ⊕ .option 이름·설명
 *   약속  내부 문서 `FAQ` ⊕ docs/PRFAQ-… §4(⬜)·§5
 *   기억  surface-events FTS — 코드·문서와 다른 칸
 */
import { requirePosixShellCommand } from '../platform/default-shell.js';
import { execFileSync, spawnSync } from 'node:child_process';
import ts from 'typescript';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { debug } from '../debug/log.js';
import { openSurfaceEventsDb, recallEvents } from '../domains/surface-events.js';
import { extractJsonBlock, skeletonFallback } from './decompose.js';

export const INTAKE_CHECK_MODE = 'check' as const;

export type IntakeCheckVerdict = '있음' | '없음' | '못 쟀다' | '판단 필요';

/** 골 초안을 쓰는 판정. 「못 쟀다」는 구멍이 아니다. */
/** 골 초안을 쓰는 판정 — 원장의 🔴(구멍)만. 「판단 필요」는 🟡(설계 판단)이라 초안을 쓰지 않는다. */
export const GAP_VERDICTS: readonly IntakeCheckVerdict[] = ['없음'];

export interface IntakeCheckFact {
  /** 대조할 사실 한 줄. */
  readonly text: string;
  /** 문서에서 뽑은 원문 인용. 같은 사실이 두 번 들어오면 둘 다 남긴다. */
  readonly quote?: string;
  readonly sourceRef?: string;
  /** 선가공에서 부정형을 긍정형으로 바꿨을 때의 원 주장. */
  readonly originalClaim?: string;
}

export interface IntakeCheckEvidence {
  readonly axis: 'capability' | 'surface' | 'promise' | 'memory' | 'repo';
  readonly summary: string;
  /** `path:line` — 실재하는 파일만. */
  readonly path?: string;
  readonly line?: number;
  /** 저장소 축에서 문서·주석은 언급, 실행 코드만 동작 근거다. */
  readonly repoKind?: RepoProbeMatch['kind'];
  /** 탐색이 실패했을 때의 사유. 일치가 있어도 실패를 가리지 않는다. */
  readonly failure?: string;
  /** 「없음」일 때 친 탐색 패턴. */
  readonly pattern?: string;
  /** 기억 축은 판정과 별칸. */
  readonly recall?: boolean;
  /**
   * 같은 이름이 여러 입구에 있을 때, 주장을 부정하는 입구(거부 문구).
   * 판정을 뒤집지 않고 반대 근거로만 남긴다.
   */
  readonly contrary?: boolean;
}

export interface IntakeReplacementCandidate {
  readonly tool: string;
  readonly paidDependency: string;
  readonly status: '현장 시험 필요';
  /** A comparison claim is not evidence that any of these checks have passed. */
  readonly trial: {
    readonly installation: '미검증';
    readonly sampleRun: '미검증';
    readonly license: '미검증';
    readonly maintenanceStatus: '미검증';
  };
}

export interface IntakeCheckItem {
  readonly fact: string;
  readonly replacementCandidate?: IntakeReplacementCandidate;
  /** Source identity preserved from the supplied fact for card-backed goal evidence. */
  readonly sourceRef?: string;
  readonly originalClaims?: readonly string[];
  readonly quotes: readonly string[];
  readonly verdict: IntakeCheckVerdict;
  /** `바깥 사실 → elanous 현재 → 판정` */
  readonly line: string;
  readonly current: string;
  readonly evidence: readonly IntakeCheckEvidence[];
  readonly patterns: readonly string[];
  readonly failures: readonly string[];
  readonly goalDraftPath?: string;
}

export interface IntakeCheckReport {
  readonly mode: typeof INTAKE_CHECK_MODE;
  readonly tree: string;
  readonly commit: string;
  readonly items: readonly IntakeCheckItem[];
  readonly goalDraftPaths: readonly string[];
  /** 하니스 발사 횟수. 이 착지에서는 항상 0. */
  readonly harnessLaunches: 0;
  /** 문서 모드 선가공이 남긴 주장 수. `--fact` 는 생략. */
  readonly keptClaims?: number;
  /** 선가공이 남겼지만 대조할 이름 토큰이 없는 주장 수. `--fact` 는 생략. */
  readonly unnamedClaims?: number;
  /** 문서 모드 선가공이 버린 항목 수. */
  readonly discardedFacts?: number;
  /** 버린 항목과 그 이유. */
  readonly discards?: readonly IntakePreprocessDiscard[];
  /** 비교·시너지 제안 수(근거 없음 포함). */
  readonly proposalCount?: number;
  readonly proposals?: readonly IntakeCompareProposal[];
}

/** 선가공 렌즈 여섯. 🅞 원장 · PR #20009. */
export const PREPROCESS_LENSES = [
  'L1 능력',
  'L2 모델·가격',
  'L3 하니스 운영',
  'L4 관측·측정',
  'L5 라이선스·약관',
  'L6 방법론',
] as const;

export type PreprocessLens = (typeof PREPROCESS_LENSES)[number];

export interface IntakePreprocessClaim {
  /** elanous 에 대한 주장. FACT_LINE 원문을 그대로 주장으로 쓰지 않는다. */
  readonly text: string;
  /** 문서의 원문 인용. */
  readonly quote: string;
  readonly lens: PreprocessLens;
  /** 부정형에서 정규화했을 때 호출자가 쓴 원 주장. */
  readonly originalText?: string;
}

export interface IntakePreprocessDiscard {
  readonly quote: string;
  readonly reason: string;
}

export interface IntakePreprocessResult {
  readonly claims: readonly IntakePreprocessClaim[];
  readonly discards: readonly IntakePreprocessDiscard[];
}

/** 주입형 선가공 호출자. 문서 원문과 렌즈 목록을 받고 JSON 텍스트를 돌려준다. */
export interface IntakePreprocessCaller {
  /** `anchors` = elanous 에 이미 있는 명령·능력 이름 — 선가공이 대응점을 그 이름으로 적게 한다. */
  (args: { document: string; lenses: readonly PreprocessLens[]; anchors?: readonly string[] }): Promise<string> | string;
}

/** 비교·시너지 제안 종류. 「못 쟀다」에서 나오는 종류는 없다. */
export type IntakeProposalKind = '추가' | '보강' | '시너지';

export interface IntakeCompareProposal {
  readonly kind: IntakeProposalKind;
  /** 근거가 된 사실(선가공 주장 또는 --fact 문장). */
  readonly fact: string;
  /** 대조 단계가 낸 `path:line`. */
  readonly contrast: string;
  /** 시너지가 결합하는 능력 id · 입구 이름. 둘 이상. */
  readonly surfaces?: readonly string[];
  /** 자에 없거나 대조가 내지 않은 근거. */
  readonly ungrounded?: '근거 없음';
  /** 초안 후보로 남은 제안만 파일을 쓴다. */
  readonly draftPath?: string;
}

export interface IntakeCompareCaller {
  (args: {
    items: readonly IntakeCheckItem[];
    ruler: { capabilities: readonly string[]; surfaces: readonly string[] };
  }): Promise<string> | string;
}

export interface RulerCapability {
  readonly id: string;
  readonly source: string;
}

export interface RulerSurface {
  readonly name: string;
  readonly source: string;
  readonly line: number;
  /** 입구 옵션 설명. `self entrances --json` 의 options[].description 과 같은 문장. */
  readonly description?: string;
}

export interface RulerPromise {
  readonly text: string;
  readonly source: string;
  readonly line: number;
  /** §4 의 ⬜ — 아직 사실 아님. 판정은 「판단 필요」로 간다. */
  readonly notYet: boolean;
}

export interface IntakeCheckRuler {
  readonly capabilities: readonly RulerCapability[];
  readonly surfaces: readonly RulerSurface[];
  readonly promises: readonly RulerPromise[];
  readonly failures: readonly IntakeCheckEvidence[];
}

export interface RepoProbeHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

type RepoProbeMatch = RepoProbeHit & { readonly kind: 'behavior' | 'document' | 'comment' };
type RepoProbeResult = {
  hits: RepoProbeMatch[];
  more: boolean;
  supported: boolean;
  failure?: string;
  incomplete?: { failed: boolean; reason: string };
  /** 구현 경로 예산이 동작 근거를 찾기 전에 다했다 — 이 이름은 너무 흔해 끝까지 못 쟀다(관측 실패가 아니라 미측정). */
  exhausted?: string;
};

export interface IntakeCheckDeps {
  readonly root: string;
  readonly readFile: (absPath: string) => string;
  readonly listFiles?: (root: string) => readonly string[];
  readonly recall?: (query: string) => readonly string[] | { error: string };
  readonly commit?: () => string | { error: string };
  readonly now?: () => string;
  /** 테스트가 골 초안 디렉터리를 임시 루트로 고정할 때. */
  readonly draftDir?: string;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
  /**
   * 하니스 런 발사. 프로덕션 deps 에 항상 함수로 실린다.
   * check 경로는 이 함수를 호출하지 않는다 — 골 초안 파일만 쓴다.
   */
  readonly launchHarness?: (goalPath: string) => void;
  /**
   * 문서 모드 선가공. 주입되면 `--file`·`--url`·stdin 에서 FACT_LINE 대신 이 호출자가 주장을 만든다.
   * `--fact` 는 부르지 않는다. 예외는 「못 쟀다(선가공 실패)」이고 FACT_LINE 으로 되돌아가지 않는다.
   */
  readonly preprocess?: IntakePreprocessCaller;
  /**
   * 비교·시너지. 대조 뒤에 한 번 부른다. 근거가 자에 있고 대조 `path:line` 을 댄 제안만 초안 후보.
   */
  readonly compare?: IntakeCompareCaller;
  /**
   * 주입되면 저장소 탐색 대신 이 대조기가 판정한다.
   * 증거를 무시하고 항상 「없음」을 내는 가짜는 지원 사실의 「있음」 기대를 깨뜨린다.
   */
  readonly comparer?: (
    fact: IntakeCheckFact,
    ruler: IntakeCheckRuler,
  ) => { verdict: IntakeCheckVerdict; current: string; evidence: readonly IntakeCheckEvidence[]; patterns: readonly string[]; failures: readonly string[] };
}

const TOKEN_RE = /`([^`]{2,80})`|(--[a-z][a-z0-9-]*)|([a-z][a-z0-9]*(?:-[a-z0-9]+){1,6})/gi;

/** Repository-relative path candidates are measured before identifier content search. */
function repoPathToken(token: string): { path: string; certain: boolean } | undefined {
  const lineNumbered = /:\d+$/.test(token);
  const path = token.replace(/:\d+$/, '').replace(/^\.\//, '');
  if (isAbsolute(path) || path.split('/').some((segment) => segment === '.' || segment === '..' || !segment)) return undefined;
  if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(path) || !(path.includes('/') || /\.[a-z][a-z0-9]*$/i.test(path))) return undefined;
  // A slash or a :line suffix makes it a path; a bare dotted name may equally be an identifier (system.status).
  return { path, certain: path.includes('/') || lineNumbered };
}

function probeRepoPath(deps: IntakeCheckDeps, path: string): { present: boolean; failure?: string } {
  const abs = resolve(deps.root, path);
  try {
    const info = statSync(abs);
    const root = realpathSync(deps.root);
    const target = realpathSync(abs);
    const fromRoot = relative(root, target);
    if (fromRoot === '..' || fromRoot.startsWith('../') || isAbsolute(fromRoot)) {
      return { present: false, failure: `저장소 밖 경로: ${path}` };
    }
    return { present: info.isFile() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      for (const part of [deps.root, ...path.split('/').map((_, index, parts) => resolve(deps.root, ...parts.slice(0, index + 1)))]) {
        try {
          if (lstatSync(part).isSymbolicLink()) {
            try {
              statSync(part);
              const fromRoot = relative(realpathSync(deps.root), realpathSync(part));
              if (fromRoot === '..' || fromRoot.startsWith('../') || isAbsolute(fromRoot)) {
                return { present: false, failure: `저장소 밖 경로: ${path}` };
              }
            } catch (targetError) {
              return { present: false, failure: targetError instanceof Error ? targetError.message : String(targetError) };
            }
          }
        } catch (inspectionError) {
          if ((inspectionError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          return { present: false, failure: inspectionError instanceof Error ? inspectionError.message : String(inspectionError) };
        }
      }
      return { present: false };
    }
    return { present: false, failure: error instanceof Error ? error.message : String(error) };
  }
}

/** 시험·프로브·골 문서가 사실 문장 자체를 인용한 줄은 실재 근거가 아니다. */
function isTestPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/i.test(normalized)
    || /\.(?:test|spec)\./i.test(normalized);
}

function isEvidencePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (isTestPath(normalized)) return false;
  if (normalized.startsWith('docs/goals/')) return false;
  if (normalized.includes('/docs/goals/')) return false;
  if (normalized.startsWith('scripts/_')) return false;
  // The intake tool's own source quotes example claims (prompts) and its own messages — it must not measure itself.
  if (normalized.startsWith('src/intake-plane/')) return false;
  return true;
}

export function tokensOf(fact: string): string[] {
  const out: string[] = [];
  for (const match of fact.matchAll(TOKEN_RE)) {
    const token = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (token.length >= 2 && !out.includes(token)) out.push(token);
  }
  return out;
}

const BEHAVIOR_STOP = new Set([
  '으로', '를', '을', '은', '는', '이', '가', '한다', '있다', '없다',
]);

const BEHAVIOR_ALIASES: Readonly<Record<string, readonly string[]>> = {
  고른다: ['고른다', '고르', 'select', 'choose'],
  지원한다: ['지원한다', '지원', 'support'],
  무작위로: ['무작위로', '무작위', 'random'],
};

/** 근거가 사실의 동작을 부정하면 「있음」이 아니다. */
const BEHAVIOR_NEGATIVES: Readonly<Record<string, readonly string[]>> = {
  무작위로: ['random', '무작위'],
};

/**
 * 입구가 그 옵션을 거부한다고 말하는 문장.
 * 특정 플래그 전용 파서가 아니다 — 거부 문구가 있으면 그 입구는 지지 근거가 아니다.
 */
const ENTRANCE_REFUSAL = /무효한 옵션|unknown option|not a valid option|지원하지 않|전달되지 않/i;

function behaviorNeedles(fact: string): string[] {
  const clause = fact
    .replace(/`[^`]*`/g, ' ')
    .replace(/--[a-z0-9-]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clause
    .split(/[^\p{L}\p{N}-]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && !BEHAVIOR_STOP.has(part));
}

/** 이 줄이 옵션을 거부하는 입구면 지지 근거로 쓰지 않는다. */
export function entranceRefuses(text: string): boolean {
  return ENTRANCE_REFUSAL.test(text);
}

/**
 * 이름이 가리키는 동작이 근거 줄에 실제로 있는지.
 * 이름 토큰만 있고 동작 낱말이 근거에 없으면 false → 「판단 필요」.
 * 동작 낱말 자체가 없으면(이름만 있는 사실) 이름 실재로 충분하다.
 * 거부 입구의 문장은 동작을 뒷받침하지 않는다.
 * 특정 사실·플래그 전용 마커는 두지 않는다. 입구 설명·능력 원천의 문장을 그대로 대조한다.
 */
export function behaviorSupported(fact: string, evidenceText: string): boolean {
  if (entranceRefuses(evidenceText)) return false;
  const needles = behaviorNeedles(fact);
  if (needles.length === 0) return false;
  const hay = evidenceText.toLowerCase();
  for (const part of needles) {
    const negatives = BEHAVIOR_NEGATIVES[part];
    if (negatives && !negatives.some((alias) => hay.includes(alias.toLowerCase()))) return false;
  }
  const hits = needles.filter((part) => {
    const aliases = BEHAVIOR_ALIASES[part] ?? [part];
    return aliases.some((alias) => hay.includes(alias.toLowerCase()));
  });
  return hits.length >= Math.min(2, needles.length) && hits.length / needles.length >= 0.5;
}

/** 약속 축의 원천 문서 — 시험 픽스처도 이 목록으로 만든다. */
export const INTAKE_PROMISE_SOURCES: readonly string[] = [
  'docs/FAQ.md',
  'docs/PRFAQ-elanous-docs-working-backwards-2026-09-22.md',
];

export function deriveRuler(deps: IntakeCheckDeps): IntakeCheckRuler {
  const failures: IntakeCheckEvidence[] = [];
  const capabilities: RulerCapability[] = [];
  const surfaces: RulerSurface[] = [];
  const promises: RulerPromise[] = [];

  const read = (rel: string): { body?: string; failure?: string } => {
    try {
      return { body: deps.readFile(resolve(deps.root, rel)) };
    } catch (error) {
      return { failure: error instanceof Error ? error.message : String(error) };
    }
  };

  const resourcesRead = read('catalog/resources.yaml');
  const resources = resourcesRead.body;
  if (resourcesRead.failure && resourcesRead.failure.length > 0) {
    failures.push({
      axis: 'capability',
      summary: 'catalog/resources.yaml 를 읽지 못했다',
      failure: resourcesRead.failure,
      pattern: 'catalog/resources.yaml',
    });
  }
  if (resources !== undefined && resources.length > 0) {
    try {
      const doc = parseYaml(resources) as { resources?: unknown };
      const rows = Array.isArray(doc.resources) ? doc.resources : [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const required = (row as { required_for?: unknown }).required_for;
        const ids = Array.isArray(required) ? required : [];
        for (const id of ids) {
          if (typeof id === 'string' && id.trim() && !capabilities.some((c) => c.id === id)) {
            capabilities.push({ id, source: 'catalog/resources.yaml' });
          }
        }
      }
    } catch (error) {
      failures.push({
        axis: 'capability',
        summary: 'catalog/resources.yaml 파싱 실패',
        failure: error instanceof Error ? error.message : String(error),
        pattern: 'required_for',
      });
    }
  }

  const commandsRead = read('catalog/external-commands.yaml');
  const commands = commandsRead.body;
  if (commandsRead.failure && commandsRead.failure.length > 0) {
    failures.push({
      axis: 'capability',
      summary: 'catalog/external-commands.yaml 를 읽지 못했다',
      failure: commandsRead.failure,
      pattern: 'catalog/external-commands.yaml',
    });
  }
  if (commands !== undefined && commands.length > 0) {
    try {
      const doc = parseYaml(commands) as { commands?: unknown };
      const rows = Array.isArray(doc.commands) ? doc.commands : [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const id = (row as { id?: unknown; name?: unknown }).id ?? (row as { name?: unknown }).name;
        if (typeof id === 'string' && id.trim() && !capabilities.some((c) => c.id === id)) {
          capabilities.push({ id, source: 'catalog/external-commands.yaml' });
        }
      }
    } catch (error) {
      failures.push({
        axis: 'capability',
        summary: 'catalog/external-commands.yaml 파싱 실패',
        failure: error instanceof Error ? error.message : String(error),
        pattern: 'commands',
      });
    }
  }

  const cliDir = 'src/cli';
  const cliSources: string[] = [];
  const walkCli = (rel: string): void => {
    for (const entry of readdirSync(resolve(deps.root, rel), { withFileTypes: true })) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walkCli(path);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) cliSources.push(path);
    }
  };
  try {
    walkCli(cliDir);
  } catch (error) {
    failures.push({
      axis: 'surface',
      summary: `${cliDir} 를 읽지 못했다`,
      failure: error instanceof Error ? error.message : String(error),
      pattern: cliDir,
    });
  }
  for (const rel of ['src/index.ts', ...cliSources.sort()]) {
    const loaded = read(rel);
    if (loaded.failure && loaded.failure.length > 0) {
      failures.push({
        axis: 'surface',
        summary: `${rel} 를 읽지 못했다`,
        failure: loaded.failure,
        pattern: rel,
      });
    }
    const body = loaded.body;
    if (body === undefined || body.length === 0) continue;
    const lines = body.split('\n');
    lines.forEach((text, i) => {
      const match = text.match(/\.command\('([^']+)'\)/);
      if (!match?.[1]) return;
      const name = match[1].split(/\s+/)[0] ?? match[1];
      if (!surfaces.some((s) => s.name === name)) {
        surfaces.push({ name, source: rel, line: i + 1 });
      }
    });
    const optionRe = /\.option\(\s*(['"])(--[a-z][a-z0-9-]*)[^'"]*\1(?:\s*,\s*(['"])([\s\S]*?)\3)?/gi;
    for (const option of body.matchAll(optionRe)) {
      const flagName = option[2] ?? '';
      const description = (option[4] ?? '').replace(/\\'/g, "'").replace(/\s+/g, ' ').trim();
      const at = body.slice(0, option.index ?? 0).split('\n').length;
      if (!flagName || surfaces.some((s) => s.name === flagName && s.description === description)) continue;
      surfaces.push({ name: flagName, source: rel, line: at, ...(description ? { description } : {}) });
    }
  }

  for (const rel of INTAKE_PROMISE_SOURCES) {
    const loaded = read(rel);
    if (loaded.failure && loaded.failure.length > 0) {
      failures.push({
        axis: 'promise',
        summary: `${rel} 를 읽지 못했다`,
        failure: loaded.failure,
        pattern: rel,
      });
      continue;
    }
    const body = loaded.body;
    if (body === undefined || body.length === 0) continue;
    const lines = body.split('\n');
    // PRFAQ 는 §4(보도자료 · ⬜ = 아직 사실 아님)와 §5(실측 FAQ)만 약속이다. 절 상태는 «제목 줄»에서만 바꾼다.
    const isPrfaq = rel.includes('PRFAQ');
    let section: string | undefined;
    lines.forEach((text, i) => {
      if (/^#{1,2} /.test(text)) {
        const m = text.match(/^#{1,2}\s+§\s*(\d+)/) ?? text.match(/^#{1,2}\s+(\d+)[.\s]/);
        section = m?.[1];
      }
      const trimmed = text.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      if (isPrfaq && section !== '4' && section !== '5') return;
      const notYet = trimmed.includes('⬜') || trimmed.includes('아직 사실 아님');
      if (trimmed.length < 8) return;
      promises.push({ text: trimmed, source: rel, line: i + 1, notYet });
    });
  }

  return { capabilities, surfaces, promises, failures };
}

const REPO_SAMPLE_SIZE = 12;

function repoHitKind(deps: IntakeCheckDeps, path: string, line: number, text: string, pattern: string,
  commentsByPath: Map<string, { body: string; starts: readonly number[]; comments: readonly { start: number; end: number }[] }>,
): RepoProbeMatch['kind'] {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('docs/') || /\.(?:md|mdx|markdown)$/i.test(normalized)) return 'document';
  if (/\.[cm]?[jt]sx?$/.test(normalized)) {
    let source = commentsByPath.get(path);
    if (!source) {
      const body = deps.readFile(resolve(deps.root, path));
      // A bare scanner loses sync on template literals and regexes; the parser keeps it, so comments come from token trivia.
      const kind = /\.[cm]?[jt]sx$/.test(normalized) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const file = ts.createSourceFile(normalized, body, ts.ScriptTarget.Latest, false, kind);
      const byStart = new Map<number, number>();
      const visit = (node: ts.Node): void => {
        for (const range of ts.getLeadingCommentRanges(body, node.pos) ?? []) byStart.set(range.pos, range.end);
        for (const range of ts.getTrailingCommentRanges(body, node.end) ?? []) byStart.set(range.pos, range.end);
        for (const child of node.getChildren(file)) visit(child);
      };
      visit(file);
      const comments = [...byStart].map(([start, end]) => ({ start, end })).sort((a, b) => a.start - b.start);
      const starts = [0];
      for (let i = 0; i < body.length; i++) if (body[i] === '\n') starts.push(i + 1);
      source = { body, starts, comments };
      commentsByPath.set(path, source);
    }
    const offset = source.starts[line - 1];
    if (offset !== undefined) {
      const originalLine = source.body.slice(offset, source.starts[line] ?? source.body.length);
      let at = originalLine.indexOf(pattern);
      let foundCode = false;
      let foundComment = false;
      while (at >= 0) {
        const pos = offset + at;
        // Scanner ranges are sorted by offset; locate only the last range starting before this hit.
        let low = 0;
        let high = source.comments.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (source.comments[mid]!.start <= pos) low = mid + 1;
          else high = mid;
        }
        if (low > 0 && pos < source.comments[low - 1]!.end) foundComment = true;
        else foundCode = true;
        at = originalLine.indexOf(pattern, at + pattern.length);
      }
      if (foundCode) return 'behavior';
      if (foundComment) return 'comment';
    }
    return 'comment';
  }
  // Non-TS strings containing # can be classified as comments; this conservatively misses evidence, never creates a false 「있음」.
  const at = text.indexOf(pattern);
  const prefix = at < 0 ? text : text.slice(0, at);
  if (/^\s*(?:#|\/\/|\/\*|\*|--\s)/.test(text) || /(?:^|\s)#/.test(prefix)
    || /\/\/|\/\*/.test(prefix)) return 'comment';
  return 'behavior';
}

function probeRepo(deps: IntakeCheckDeps, pattern: string, fact: string): RepoProbeResult {
  const hits: RepoProbeMatch[] = [];
  const counts = { behavior: 0, document: 0, comment: 0 };
  const commentsByPath = new Map<string, { body: string; starts: readonly number[]; comments: readonly { start: number; end: number }[] }>();
  let more = false;
  let supported = false;
  // 관측이 완결되지 않은 이유 — 잘림(failed=false)·실패(failed=true). 판정부가 「없음」을 단정하지 않는 데 쓴다.
  let incomplete: { failed: boolean; reason: string } | undefined;
  const note = (failed: boolean, reason: string): void => {
    more = true;
    if (!incomplete || (failed && !incomplete.failed)) incomplete = { failed, reason };
  };
  const out = (result: Omit<RepoProbeResult, 'incomplete'>): RepoProbeResult => (incomplete ? { ...result, incomplete } : result);
  const add = (path: string, line: number, text: string): void => {
    if (!isEvidencePath(path)) return;
    const normalizedPath = path.replace(/^\.\//, '');
    const kind = repoHitKind(deps, normalizedPath, line, text, pattern, commentsByPath);
    const hit = { path: normalizedPath, line, text: text.trim(), kind };
    const supports = kind === 'behavior' && behaviorSupported(fact, text);
    if (supports) supported = true;
    if (counts[kind]++ < REPO_SAMPLE_SIZE) hits.push(hit);
    else {
      if (supports) {
        const at = hits.findIndex((row) => row.kind === 'behavior' && !behaviorSupported(fact, row.text));
        if (at >= 0) hits[at] = hit;
      }
      more = true;
    }
  };
  if (deps.listFiles) {
    try {
      for (const rel of deps.listFiles(deps.root)) {
        if (!isEvidencePath(rel)) continue;
        const document = rel.replace(/^\.\//, '').startsWith('docs/') || /\.(?:md|mdx|markdown)$/i.test(rel);
        let body: string;
        try {
          body = deps.readFile(resolve(deps.root, rel));
        } catch (error) {
          if (!document) throw error;
          note(true, `문서 읽기 실패: ${rel}`);
          continue;
        }
        const lines = body.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i]!.includes(pattern)) continue;
          // Injected file lists are small; read them all so later mentions and «더 있음» are not dropped after the first support.
          add(rel, i + 1, lines[i]!);
        }
      }
      return out({ hits, more, supported });
    } catch (error) {
      return out({ hits: [], more: false, supported: false, failure: error instanceof Error ? error.message : String(error) });
    }
  }
  // Bound the filename stream as well as file reads; incomplete implementation paths cannot prove absence. A budget is not absence.
  const budgetBytes = 16_000_000;
  const deadline = Date.now() + 20_000;
  let consumed = 0;
  const listing = mkdtempSync(join(tmpdir(), 'intake-repo-list-'));
  try {
    const collect = (label: string, globs: readonly string[]): { paths: string[]; incomplete: boolean; failure?: string } => {
      const listingPath = join(listing, label);
      const output = openSync(listingPath, 'w');
      let result: ReturnType<typeof spawnSync>;
      try {
        result = spawnSync(requirePosixShellCommand('bash'), ['-c', 'set -o pipefail; rg -l -0 -F -e "$1" "${@:2}" . | head -c 1000000', 'intake-rg', pattern, ...globs.flatMap((glob) => ['--glob', glob])], {
          cwd: deps.root, encoding: 'buffer', timeout: 20_000, maxBuffer: 64_000, stdio: ['ignore', output, 'pipe'],
        });
      } finally {
        closeSync(output);
      }
      if (result.error || (result.status !== 0 && result.status !== 1 && result.status !== 141)) {
        return { paths: [], incomplete: false, failure: result.error?.message ?? (result.stderr?.toString().trim() || `rg exited ${result.status}`) };
      }
      const incomplete = result.status === 141 || statSync(listingPath).size >= 1_000_000;
      const names = readFileSync(listingPath, 'utf8').split('\0');
      if (incomplete) names.pop();
      return { paths: names.filter(Boolean), incomplete };
    };
    const implementation = collect('implementation', ['!node_modules', '!.git', '!docs/**', '!*.md', '!*.mdx', '!*.markdown']);
    if (implementation.failure) return out({ hits, more, supported, failure: implementation.failure });
    const mentions = collect('mentions', ['!node_modules', '!.git', 'docs/**', '*.md', '*.mdx', '*.markdown']);
    if (mentions.failure) note(true, `문서 탐색 실패: ${mentions.failure}`);
    else if (mentions.incomplete) note(false, '문서 목록이 상한에서 잘림');
    const paths = [...mentions.paths, ...implementation.paths];
    for (let index = 0; index < paths.length; index++) {
      const path = paths[index]!.replace(/^\.\//, '');
      if (!isEvidencePath(path)) continue;
      const document = path.startsWith('docs/') || /\.(?:md|mdx|markdown)$/i.test(path);
      let fd: number;
      try {
        fd = openSync(resolve(deps.root, path), 'r');
      } catch (error) {
        if (!document) throw error;
        note(true, `문서 읽기 실패: ${path}`);
        continue;
      }
      try {
        let size: number;
        try {
          size = statSync(resolve(deps.root, path)).size;
        } catch (error) {
          if (!document) throw error;
          note(true, `문서 읽기 실패: ${path}`);
          continue;
        }
        // Mentions are samples only: unread documentation cannot change a completed implementation verdict.
        const readLimit = document ? Math.min(size, 128_000) : size;
        if (document && readLimit < size) note(false, `문서가 128KB 에서 잘림: ${path}`);
        const buffer = Buffer.alloc(64_000);
        const decoder = new TextDecoder();
        let carry = '';
        let position = 0;
        let line = 0;
        const accept = (text: string): boolean => {
          line++;
          if (!text.includes(pattern)) return false;
          add(path, line, text);
          return supported;
        };
        const finishExecutable = (remainingRows: readonly string[], tail: string): RepoProbeResult => {
          if (more || remainingRows.some((row) => row.includes(pattern)) || tail.includes(pattern)
            || paths.slice(index + 1).some((next) => isEvidencePath(next))) return out({ hits, more: true, supported });
          let pending = tail;
          while (position < readLimit) {
            if (Date.now() > deadline || consumed >= budgetBytes) {
              return out({ hits, more: true, supported });
            }
            const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, budgetBytes - consumed, readLimit - position), position);
            if (!bytes) break;
            position += bytes;
            if (!document) consumed += bytes;
            pending += decoder.decode(buffer.subarray(0, bytes), { stream: true });
            if (pending.includes(pattern)) return out({ hits, more: true, supported });
            pending = pending.slice(-pattern.length + 1);
          }
          return out({ hits, more: false, supported });
        };
        while (position < readLimit) {
          if (!document && (Date.now() > deadline || consumed >= budgetBytes)) {
            return out({ hits, more: true, supported, ...(supported ? {} : { exhausted: '탐색 예산 소진 (바이트·시간)' }) });
          }
          const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, document ? readLimit - position : budgetBytes - consumed, readLimit - position), position);
          if (!bytes) break;
          position += bytes;
          if (!document) consumed += bytes;
          const rows = (carry + decoder.decode(buffer.subarray(0, bytes), { stream: true })).split('\n');
          carry = rows.pop() ?? '';
          for (let i = 0; i < rows.length; i++) {
            if (accept(rows[i]!)) return finishExecutable(rows.slice(i + 1), carry);
          }
        }
        if (carry && accept(carry + decoder.decode())) return out({ hits, more: more || paths.slice(index + 1).some((next) => isEvidencePath(next)), supported });
      } finally {
        closeSync(fd);
      }
    }
    return out(implementation.incomplete && !supported
      ? { hits, more: true, supported, exhausted: '탐색 예산 소진 (구현 파일 목록)' }
      : { hits, more, supported });
  } catch (error) {
    return out({ hits, more, supported, failure: error instanceof Error ? error.message : String(error) });
  } finally {
    rmSync(listing, { recursive: true, force: true });
  }
}

function commitOf(deps: IntakeCheckDeps): { sha: string; failure?: string } {
  if (deps.commit) {
    const value = deps.commit();
    if (typeof value === 'string') return { sha: value };
    return { sha: '', failure: value.error };
  }
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: deps.root, encoding: 'utf8', timeout: 10_000 }).trim();
    return { sha };
  } catch (error) {
    return { sha: '', failure: error instanceof Error ? error.message : String(error) };
  }
}

function judgeFact(
  fact: IntakeCheckFact,
  ruler: IntakeCheckRuler,
  deps: IntakeCheckDeps,
): Omit<IntakeCheckItem, 'quotes' | 'goalDraftPath'> {
  if (deps.comparer) {
    const forced = deps.comparer(fact, ruler);
    const evidence = [...forced.evidence];
    if (deps.recall) attachRecall(deps, fact, evidence);
    const failures = evidence.map((row) => row.failure).filter((row): row is string => !!row);
    const verdict: IntakeCheckVerdict = failures.length > 0 ? '못 쟀다' : forced.verdict;
    return {
      fact: fact.text,
      verdict,
      current: forced.current,
      line: `${fact.text} → ${forced.current} → ${verdict}`,
      evidence,
      patterns: forced.patterns,
      failures,
    };
  }
  const evidence: IntakeCheckEvidence[] = [...ruler.failures];
  const patterns: string[] = [];
  const tokens = tokensOf(fact.text);
  patterns.push(...tokens.map((token) => `token:${token}`));

  let nameHit = false;
  let repoMentionHit = false;
  let behaviorHit = false;
  let notYet = false;
  const supportTexts: string[] = [];
  const incompleteRepo: { token: string; failed: boolean; reason: string }[] = [];
  let ambiguousFileOnly = false;
  const exhaustedTokens: { token: string; reason: string }[] = [];

  for (const token of tokens) {
    const cap = ruler.capabilities.find((row) => row.id === token);
    if (cap) {
      nameHit = true;
      evidence.push({
        axis: 'capability',
        summary: `능력 ${cap.id} (${cap.source})`,
        path: cap.source,
        pattern: token,
      });
      supportTexts.push(`${cap.id} ${cap.source}`);
    }
    const named = ruler.surfaces.filter((row) => row.name === token);
    const supporting = named.filter((row) => {
      const described = row.description ? `${row.name} ${row.description}` : row.name;
      return !entranceRefuses(described) && behaviorSupported(fact.text, described);
    });
    const chosen = supporting[0] ?? named.find((row) => !entranceRefuses(row.description ?? ''));
    if (chosen) {
      nameHit = true;
      const described = chosen.description ? `${chosen.name} ${chosen.description}` : chosen.name;
      evidence.push({
        axis: 'surface',
        summary: described,
        path: chosen.source,
        line: chosen.line,
        pattern: token,
      });
      supportTexts.push(described);
      if (behaviorSupported(fact.text, described)) behaviorHit = true;
    }
    for (const refused of named) {
      const described = refused.description ? `${refused.name} ${refused.description}` : refused.name;
      if (!entranceRefuses(described)) continue;
      if (chosen && refused.source === chosen.source && refused.line === chosen.line) continue;
      evidence.push({
        axis: 'surface',
        summary: described,
        path: refused.source,
        line: refused.line,
        pattern: token,
        contrary: true,
      });
    }
  }

  for (const token of tokens) {
    // src/index.ts intake check .action → runIntakeCheck / runIntakeCheckDocument → judgeFact → probeRepo.
    // src/nexus/api/meta-api.ts handleIntakePost → runIntakeCheckDocument → judgeFact → probeRepo.
    const candidate = repoPathToken(token);
    if (candidate !== undefined) {
      const { path, certain } = candidate;
      const observed = probeRepoPath(deps, path);
      patterns.push(`file exists ${path}`);
      if (observed.failure) {
        evidence.push({ axis: 'repo', summary: `경로 관측 실패: ${token}`, failure: observed.failure, pattern: token });
        continue;
      }
      if (observed.present) {
        evidence.push({ axis: 'repo', summary: `파일 존재: ${path}`, path, pattern: token });
        if (certain) {
          nameHit = true;
          supportTexts.push(`파일 존재: ${path}`);
        } else {
          // A dotted name without a slash may be a file or an identifier; the file alone decides neither 있음 nor 없음.
          ambiguousFileOnly = true;
        }
      }
      // Certain paths are measured solely by file existence; bare dotted names are also searched as identifiers.
      // Known limit: an absent bare dotted name that other files mention stays 판단 필요 (a withheld verdict, never a false one).
      if (certain) continue;
    }
    const probed = probeRepo(deps, token, fact.text);
    patterns.push(`rg -F -e ${token}`);
    if (probed.failure) {
      evidence.push({
        axis: 'repo',
        summary: `탐색 실패: ${token}`,
        failure: probed.failure,
        pattern: token,
      });
      continue;
    }
    if (probed.incomplete) incompleteRepo.push({ token, ...probed.incomplete });
    if (probed.exhausted) exhaustedTokens.push({ token, reason: probed.exhausted });
    if (probed.hits.length === 0) continue;
    if (probed.hits.some((hit) => hit.kind !== 'behavior')) repoMentionHit = true;
    const executable = probed.hits.filter((hit) => hit.kind === 'behavior' && !entranceRefuses(hit.text));
    if (executable.length > 0) nameHit = true;
    supportTexts.push(...executable.map((hit) => hit.text));
    if (probed.supported) behaviorHit = true;
    for (const kind of ['behavior', 'document', 'comment'] as const) {
      const visible = probed.hits.filter((row) => row.kind === kind && !entranceRefuses(row.text));
      for (const hit of (kind === 'behavior'
        ? [visible.find((row) => behaviorSupported(fact.text, row.text)) ?? visible[0]].filter((row): row is RepoProbeMatch => !!row)
        : visible)) {
        evidence.push({
          axis: 'repo',
          summary: `${kind === 'behavior' ? '동작 근거' : kind === 'document' ? '문서 언급' : '주석 언급'}: ${token} @ ${hit.path}:${hit.line} ${hit.text}`.trim(),
          repoKind: kind,
          path: hit.path,
          line: hit.line,
          pattern: token,
        });
      }
    }
    for (const refused of probed.hits.filter((hit) => entranceRefuses(hit.text))) {
      evidence.push({
        axis: 'repo',
        summary: `${token} @ ${refused.path}:${refused.line} ${refused.text}`.trim(),
        path: refused.path,
        line: refused.line,
        pattern: token,
        contrary: true,
      });
    }
    if (probed.more || executable.length > 1) evidence.push({ axis: 'repo', summary: `${token}: 표본 외 더 있음`, pattern: token });
  }

  // 흔한 이름의 예산 소진은 그 이름의 미측정이다. 잴 수 있는 이름이 하나도 없을 때만 주장 전체가 「못 쟀다」다.
  const measuredTokenCount = tokens.filter((token) => !exhaustedTokens.some((row) => row.token === token)).length;
  for (const row of exhaustedTokens) {
    evidence.push(measuredTokenCount === 0
      ? { axis: 'repo', summary: `탐색 실패: ${row.token}`, failure: row.reason, pattern: row.token }
      : { axis: 'repo', summary: `${row.token}: 너무 흔한 이름 — ${row.reason}, 끝까지 못 쟀다`, pattern: row.token });
  }

  // 약속은 «주장»이지 «증거»가 아니다 — 이름·⬜ 만 올리고 동작 근거(behaviorHit)는 능력·표면·저장소 축에서만 온다.
  const evidenceNameHit = nameHit;
  let promiseHit = false;
  for (const promise of ruler.promises) {
    const overlap = tokens.some((token) => promise.text.includes(token));
    if (!overlap) continue;
    if (promise.notYet) notYet = true;
    evidence.push({
      axis: 'promise',
      summary: promise.notYet ? `⬜ 아직 사실 아님: ${promise.text.slice(0, 80)}` : promise.text.slice(0, 80),
      path: promise.source,
      line: promise.line,
    });
    supportTexts.push(promise.text);
    promiseHit = true;
  }

  if (deps.recall) attachRecall(deps, fact, evidence);

  let failures = evidence.map((row) => row.failure).filter((row): row is string => !!row);
  const claimedBehavior = behaviorNeedles(fact.text).filter((part) => part !== 'elanous' && part !== '에' && part !== '의').length > 0;
  let verdict: IntakeCheckVerdict;
  const staleDoc = notYet && evidenceNameHit && (!claimedBehavior || behaviorHit);
  if (failures.length > 0) verdict = '못 쟀다';
  else if (tokens.length === 0) verdict = '판단 필요';
  else if (staleDoc) verdict = '있음';
  else if (notYet) verdict = '판단 필요';
  else if (!evidenceNameHit && !promiseHit && !repoMentionHit && !ambiguousFileOnly) verdict = '없음';
  else if (!evidenceNameHit) verdict = '판단 필요';
  else if (claimedBehavior && !behaviorHit) verdict = '판단 필요';
  else verdict = '있음';
  // 확신 판정(있음·없음)은 관측이 완결됐을 때만 — 문서 탐색이 잘렸거나 실패했으면 「없음」을 단정하지 않는다.
  if (verdict === '없음' && incompleteRepo.length > 0) {
    for (const row of incompleteRepo) {
      evidence.push({ axis: 'repo', summary: `${row.token}: ${row.reason}`, pattern: row.token, ...(row.failed ? { failure: row.reason } : {}) });
    }
    verdict = incompleteRepo.some((row) => row.failed) ? '못 쟀다' : '판단 필요';
    failures = evidence.map((row) => row.failure).filter((row): row is string => !!row);
    if (verdict === '판단 필요') supportTexts.unshift('저장소 탐색 미완 — 잘린 문서가 있어 없음으로 단정하지 않는다');
  }
  // 일부 이름을 못 쟀으면 나머지 이름만으로 확신 판정(있음·없음)을 내지 않는다.
  if (exhaustedTokens.length > 0 && measuredTokenCount > 0 && (verdict === '있음' || verdict === '없음')) {
    verdict = '판단 필요';
    supportTexts.unshift(`너무 흔한 이름(${exhaustedTokens.map((row) => row.token).join(' · ')})은 끝까지 못 쟀다 — 나머지 이름만으로는 단정하지 않는다`);
  }
  if (staleDoc) {
    evidence.push({ axis: 'promise', summary: '약속 문서가 늙었다 — §4 ⬜ 인데 능력·표면·저장소 증거가 있다' });
  }
  if (verdict === '판단 필요' && !evidenceNameHit && ambiguousFileOnly && !repoMentionHit && !promiseHit) {
    supportTexts.unshift('같은 이름의 파일은 있으나 식별자 근거가 없다 — 파일인지 식별자인지 가를 수 없다');
  } else if (verdict === '판단 필요' && tokens.length === 0) {
    supportTexts.unshift('잴 이름이 없다 — 저장소에서 찾을 이름 토큰을 적어야 대조할 수 있다');
  } else if (verdict === '판단 필요' && !evidenceNameHit && promiseHit) {
    supportTexts.unshift('문서만 있다 — 약속 문서에만 나오고 능력·표면·저장소 증거가 없다');
  } else if (verdict === '판단 필요' && !evidenceNameHit && repoMentionHit) {
    supportTexts.unshift('문서·주석 언급만 있다 — 동작 근거가 없다');
  }

  const current = verdict === '없음'
    ? `전수 탐색 0건 (${patterns.join(' · ')})`
    : verdict === '못 쟀다'
      ? failures.join(' | ')
      : verdict === '있음'
        ? (supportTexts.find((text) => behaviorSupported(fact.text, text) && !entranceRefuses(text))
          ?? supportTexts.find((text) => !entranceRefuses(text))
          ?? '이름만 확인')
        : supportTexts.find((text) => !entranceRefuses(text)) || '이름만 확인';

  return {
    fact: fact.text,
    verdict,
    current,
    line: `${fact.text} → ${current} → ${verdict}`,
    evidence,
    patterns,
    failures,
  };
}

function attachRecall(deps: IntakeCheckDeps, fact: IntakeCheckFact, evidence: IntakeCheckEvidence[]): void {
  if (!deps.recall) return;
  const recalled = deps.recall(fact.text);
  if (Array.isArray(recalled)) {
    evidence.push({
      axis: 'memory',
      summary: recalled.length > 0 ? `기억 ${recalled.length}건` : '기억 0건',
      recall: true,
      pattern: fact.text,
    });
    return;
  }
  const failure = 'error' in recalled ? recalled.error : 'recall failed';
  evidence.push({
    axis: 'memory',
    summary: '기억을 못 쟀다',
    failure,
    recall: true,
    pattern: fact.text,
  });
}

function factKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A stated possibility is a trial candidate, not proof of a working replacement. */
function replacementCandidate(fact: string): IntakeReplacementCandidate | undefined {
  if (!/(?:대체(?:하|한|할| 가능| 후보|재)|replace|replacement|alternative to)/i.test(fact)
    || /(?:대체하지\s*(?:는|도|조차|를)?\s*(?:않|못)|대체\s*못|대체할\s*수\s*(?:는|도|가)?\s*없|대체(?:가|는| 후보가)?\s*(?:아니|불가)|cannot replace|can't replace|does not replace|not a replacement)/i.test(fact)) return undefined;
  const paid = fact.match(/(?:유료|paid)\s*(?:(?:서비스|의존성|도구|툴|API|dependency|service|tool)\s*)?`?([a-z][\w.-]+)`?/i);
  // firecrawl is a named paid-dependency example even when the claim omits the word "paid".
  const paidDependency = paid?.[1] ?? fact.match(/(?:^|[^\w])`?(firecrawl)`?(?=$|[^\w])/i)?.[1];
  if (!paidDependency) return undefined;
  const names = [...fact.matchAll(/`([a-z][\w.-]+)`/gi)].map((match) => match[1]!);
  const explicit = names.filter((name) => name.toLowerCase() !== paidDependency.toLowerCase());
  const plain = fact.match(/^\s*([a-z][\w.-]+)\s*(?:가|이|는|은|으로|로|can\b|could\b|may\b)/i)?.[1];
  const tool = explicit.length === 1 ? explicit[0] : explicit.length === 0 ? plain : undefined;
  if (!tool || tool.toLowerCase() === paidDependency.toLowerCase() || tool.toLowerCase() === 'elanous') return undefined;
  // Names appearing together do not establish the direction of replacement.
  const clause = fact.replace(/`/g, '').replace(/(?:유료|paid)\s*(?:(?:서비스|의존성|도구|툴|API|dependency|service|tool)\s*)?/gi, '');
  const escape = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const name = (value: string): string => `(?<![\\w.-])${escape(value)}(?![\\w.-])`;
  const toolName = name(tool);
  const dependencyName = name(paidDependency);
  const replaces = (subject: string, object: string): boolean => [
    new RegExp(`${subject}\\s*(?:이|가|은|는)?\\s+${object}\\s*(?:을|를)\\s*대체(?:하|한|할| 가능| 후보|재)`, 'i'),
    new RegExp(`${object}\\s*(?:을|를)\\s+${subject}\\s*(?:이|가|은|는)\\s*대체(?:하|한|할| 가능| 후보|재)`, 'i'),
    new RegExp(`${subject}\\s+(?:can |could |may )?replace(?:s|d)?\\s+${object}`, 'i'),
    new RegExp(`${subject}\\s+(?:is |could be |may be )?(?:an? )?(?:replacement|alternative)\\s+to\\s+${object}`, 'i'),
  ].some((pattern) => pattern.test(clause));
  if (!replaces(toolName, dependencyName) || replaces(dependencyName, toolName)) return undefined;
  return {
    tool,
    paidDependency,
    status: '현장 시험 필요',
    trial: { installation: '미검증', sampleRun: '미검증', license: '미검증', maintenanceStatus: '미검증' },
  };
}

function isLens(value: string): value is PreprocessLens {
  return (PREPROCESS_LENSES as readonly string[]).includes(value);
}

function preprocessSkeleton(document: string): IntakePreprocessResult {
  const fallback = skeletonFallback({ rawText: document });
  const quote = fallback.missions[0]?.tasks[0]?.intent?.trim() || document.trim();
  return {
    claims: [],
    discards: [{ quote, reason: fallback.rationale || '선가공 JSON 을 읽지 못했다' }],
  };
}

/** 호출자 JSON 을 주장·버림으로 읽는다. 파싱 실패는 skeletonFallback 으로 전부 버린다. */
export function parsePreprocessCallerText(text: string, document: string): IntakePreprocessResult {
  const raw = extractJsonBlock(text);
  if (!raw || typeof raw !== 'object') return preprocessSkeleton(document);
  const body = raw as { claims?: unknown; discards?: unknown };
  const claims: IntakePreprocessClaim[] = [];
  const discards: IntakePreprocessDiscard[] = [];
  if (Array.isArray(body.claims)) {
    for (const row of body.claims) {
      if (!row || typeof row !== 'object') continue;
      const claim = row as { text?: unknown; quote?: unknown; lens?: unknown };
      const claimText = typeof claim.text === 'string' ? claim.text.trim() : '';
      const quote = typeof claim.quote === 'string' ? claim.quote.trim() : '';
      const lens = typeof claim.lens === 'string' ? claim.lens.trim() : '';
      if (!claimText || !quote || !isLens(lens)) continue;
      // 부정 표지를 포함한 목적어는 기계적으로 뒤집지 않는다. 명확한 부재형만 존재 질문으로 바꾼다.
      const negativeMarker = /없|않|못|아니|안\s*(?:한|하|된|되|있)|0\s*(?:개|건)|미지원|불가능|부재|비존재|불가|(?:보유|지원|존재)하지/;
      const zero = claimText.match(/^elanous\s*(?:는|은)\s*(.+?)\s*(?:를|을)\s*0\s*(?:개|건)\s*보유한다[.。]?$/);
      const normalized = zero ? `elanous 에 ${zero[1]} 가 있다` : claimText;
      if (negativeMarker.test(normalized)) {
        discards.push({ quote, reason: `부정형 주장을 긍정형으로 안전하게 정규화할 수 없음: ${claimText}` });
        continue;
      }
      claims.push({ text: normalized, quote, lens, ...(zero ? { originalText: claimText } : {}) });
    }
  }
  if (Array.isArray(body.discards)) {
    for (const row of body.discards) {
      if (!row || typeof row !== 'object') continue;
      const discard = row as { quote?: unknown; reason?: unknown };
      const quote = typeof discard.quote === 'string' ? discard.quote.trim() : '';
      const reason = typeof discard.reason === 'string' ? discard.reason.trim() : '';
      if (!quote || !reason) continue;
      discards.push({ quote, reason });
    }
  }
  if (claims.length === 0 && discards.length === 0) return preprocessSkeleton(document);
  return { claims, discards };
}

export async function runPreprocess(
  document: string,
  caller: IntakePreprocessCaller,
  anchors?: readonly string[],
): Promise<IntakePreprocessResult> {
  const text = await caller({ document, lenses: PREPROCESS_LENSES, ...(anchors && anchors.length > 0 ? { anchors } : {}) });
  return parsePreprocessCallerText(text, document);
}

function contrastRefs(item: IntakeCheckItem): string[] {
  const refs: string[] = [];
  for (const row of item.evidence) {
    if (!row.path || typeof row.line !== 'number' || row.line <= 0) continue;
    if (row.contrary || (row.axis === 'repo' && row.repoKind !== undefined && row.repoKind !== 'behavior')) continue;
    const ref = `${row.path}:${row.line}`;
    if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

const INTAKE_ANCHOR_LIMIT = 600;

/** 선가공에 줄 이름: 명령 이름(옵션 제외) ⊕ 능력 id. 선가공이 이미 있는 기능을 그 이름으로 가리키게 한다. */
export function intakeAnchorNames(ruler: IntakeCheckRuler): string[] {
  const names = new Set<string>();
  for (const row of ruler.surfaces) if (/^[a-z][a-z0-9:-]*$/i.test(row.name)) names.add(row.name);
  for (const row of ruler.capabilities) names.add(row.id);
  return [...names].slice(0, INTAKE_ANCHOR_LIMIT);
}

function rulerNames(ruler: IntakeCheckRuler): { capabilities: string[]; surfaces: string[] } {
  return {
    capabilities: ruler.capabilities.map((row) => row.id),
    surfaces: ruler.surfaces.map((row) => row.name),
  };
}

function kindForVerdict(verdict: IntakeCheckVerdict): IntakeProposalKind | undefined {
  if (verdict === '없음') return '추가';
  if (verdict === '판단 필요' || verdict === '있음') return '보강';
  return undefined;
}

/** 호출자 JSON 을 제안으로 읽는다. 못 쟀다 전용 종류는 만들지 않는다. */
export function parseCompareCallerText(text: string): IntakeCompareProposal[] {
  const raw = extractJsonBlock(text);
  if (!raw || typeof raw !== 'object') {
    const fallback = skeletonFallback({ rawText: text || 'compare' });
    void fallback;
    return [];
  }
  const rows = (raw as { proposals?: unknown }).proposals;
  if (!Array.isArray(rows)) return [];
  const out: IntakeCompareProposal[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const proposal = row as { kind?: unknown; fact?: unknown; contrast?: unknown; surfaces?: unknown };
    const kind = proposal.kind;
    if (kind !== '추가' && kind !== '보강' && kind !== '시너지') continue;
    const fact = typeof proposal.fact === 'string' ? proposal.fact.trim() : '';
    const contrast = typeof proposal.contrast === 'string' ? proposal.contrast.trim() : '';
    if (!fact || !contrast) continue;
    const surfaces = Array.isArray(proposal.surfaces)
      ? proposal.surfaces.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
      : undefined;
    out.push({ kind, fact, contrast, ...(surfaces && surfaces.length > 0 ? { surfaces } : {}) });
  }
  return out;
}

/**
 * 제안은 대조가 낸 path:line 을 대고, 시너지는 자에 있는 이름 둘 이상을 댄다.
 * 아니면 「근거 없음」. 판정 「못 쟀다」에서 종류를 만들지 않는다.
 */
export function groundProposals(
  proposals: readonly IntakeCompareProposal[],
  items: readonly IntakeCheckItem[],
  ruler: IntakeCheckRuler,
): IntakeCompareProposal[] {
  const names = new Set([...ruler.capabilities.map((row) => row.id), ...ruler.surfaces.map((row) => row.name)]);
  const byFact = new Map(items.map((item) => [factKey(item.fact), item]));
  return proposals.map((proposal) => {
    const item = byFact.get(factKey(proposal.fact));
    const refs = item ? contrastRefs(item) : [];
    const cited = refs.includes(proposal.contrast);
    const expected = item ? kindForVerdict(item.verdict) : undefined;
    if (!item || !cited || !expected) return { ...proposal, ungrounded: '근거 없음' as const };
    if (proposal.kind === '시너지') {
      const surfaces = proposal.surfaces ?? [];
      const known = surfaces.filter((name) => names.has(name));
      if (surfaces.length < 2 || known.length !== surfaces.length) {
        return { ...proposal, ungrounded: '근거 없음' as const };
      }
      return proposal;
    }
    if (proposal.kind !== expected) return { ...proposal, ungrounded: '근거 없음' as const };
    return proposal;
  });
}

/** 비교·시너지 제안의 후처리 — 근거 검증 · 근거 있는 제안만 초안 · 관측. 동기·문서 모드가 함께 쓴다. */
function finishCompare(
  parsed: readonly IntakeCompareProposal[],
  items: readonly IntakeCheckItem[],
  ruler: IntakeCheckRuler,
  draftDir: string,
  now: string,
  log: (event: string, data: Record<string, unknown>) => void,
): { proposals: IntakeCompareProposal[]; drafts: string[] } {
  const drafts: string[] = [];
  const proposals = groundProposals([...parsed], [...items], ruler).map((proposal) => {
    if (proposal.ungrounded) return proposal;
    const draftPath = writeProposalDraft(draftDir, proposal, now);
    drafts.push(draftPath);
    return { ...proposal, draftPath };
  });
  log('compare', {
    proposalCount: proposals.length,
    grounded: proposals.filter((row) => !row.ungrounded).length,
    ungrounded: proposals.filter((row) => row.ungrounded === '근거 없음').length,
  });
  return { proposals, drafts };
}

function writeProposalDraft(dir: string, proposal: IntakeCompareProposal, now: string): string {
  mkdirSync(dir, { recursive: true });
  const slug = proposal.fact.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 48) || 'proposal';
  const path = join(dir, `GOAL-intake-check-${proposal.kind}-${slug}.md`);
  const body = [
    '대상 경로:',
    '',
    `# 골 초안 — ${proposal.kind}`,
    '',
    `- 사실: ${proposal.fact}`,
    `- 종류: ${proposal.kind}`,
    `- 대조: ${proposal.contrast}`,
    ...(proposal.surfaces ? [`- 결합: ${proposal.surfaces.join(' · ')}`] : []),
    `- 시각: ${now}`,
    '',
    '발사는 사람이 한다. 이 파일은 초안이다.',
    '',
  ].join('\n');
  writeFileSync(path, body, 'utf8');
  return path;
}

function writeGoalDraft(dir: string, item: IntakeCheckItem, now: string): string {
  mkdirSync(dir, { recursive: true });
  const slug = item.fact.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 48) || 'fact';
  const id = slug || 'fact';
  const path = join(dir, `GOAL-intake-check-${id}.md`);
  const body = [
    '대상 경로:',
    '',
    `# 골 초안 — ${item.verdict}`,
    '',
    `- 사실: ${item.fact}`,
    `- 판정: ${item.verdict}`,
    `- 현재: ${item.current}`,
    `- 시각: ${now}`,
    '',
    '발사는 사람이 한다. 이 파일은 초안이다.',
    '',
  ].join('\n');
  writeFileSync(path, body, 'utf8');
  return path;
}

export interface IntakeCheckRunOptions {
  /**
   * 문서 원문. 있으면 선가공을 거친 주장만 대조한다.
   * `--fact` 는 이 칸을 비운다 — 선가공 호출 횟수 0.
   */
  readonly document?: string;
  /** 원문 불릿 수. 로그가 남긴 주장 수와 비교할 때 쓴다. */
  readonly sourceBulletCount?: number;
  /** 이미 만든 자 — 문서 모드가 한 번 만들어 선가공·대조·비교에 함께 쓴다. */
  readonly ruler?: IntakeCheckRuler;
}

export function runIntakeCheck(
  facts: readonly IntakeCheckFact[],
  deps: IntakeCheckDeps,
  options: IntakeCheckRunOptions = {},
): IntakeCheckReport {
  const log = deps.log ?? ((event, data) => { debug.log('intake.check', event, data); });
  const tree = deps.root;
  const commit = commitOf(deps);
  log('start', {
    tree,
    commit: commit.sha,
    facts: facts.length,
    document: Boolean(options.document),
    ...(commit.failure ? { failure: commit.failure } : {}),
  });

  const documentMode = typeof options.document === 'string';
  let working = facts;
  let keptClaims: number | undefined;
  let unnamedClaims: number | undefined;
  let discardedFacts: number | undefined;
  let discards: readonly IntakePreprocessDiscard[] | undefined;
  if (documentMode) {
    if (!deps.preprocess) {
      const reason = '선가공 호출자가 없다';
      log('end', {
        tree,
        commit: commit.sha,
        items: 0,
        drafts: 0,
        verdict: '못 쟀다(선가공 실패)',
        reason,
        keptClaims: 0,
        discardedFacts: 0,
        proposalCount: 0,
      });
      return {
        mode: INTAKE_CHECK_MODE,
        tree,
        commit: commit.sha,
        items: [{
          fact: options.document ?? '',
          quotes: [],
          verdict: '못 쟀다',
          line: `${options.document ?? ''} → ${reason} → 못 쟀다(선가공 실패)`,
          current: `못 쟀다(선가공 실패): ${reason}`,
          evidence: [],
          patterns: [],
          failures: [reason],
        }],
        goalDraftPaths: [],
        harnessLaunches: 0,
        keptClaims: 0,
        discardedFacts: 0,
        discards: [],
        proposalCount: 0,
        proposals: [],
      };
    }
    let pre: IntakePreprocessResult;
    try {
      const called = deps.preprocess({ document: options.document ?? '', lenses: PREPROCESS_LENSES });
      if (called && typeof (called as Promise<string>).then === 'function') {
        throw new Error('선가공 호출자가 비동기다 — runIntakeCheckDocument 를 쓴다');
      }
      pre = parsePreprocessCallerText(called as string, options.document ?? '');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        mode: INTAKE_CHECK_MODE,
        tree,
        commit: commit.sha,
        items: [{
          fact: options.document ?? '',
          quotes: [],
          verdict: '못 쟀다',
          line: `${options.document ?? ''} → ${reason} → 못 쟀다(선가공 실패)`,
          current: `못 쟀다(선가공 실패): ${reason}`,
          evidence: [{ axis: 'repo', summary: '선가공 실패', failure: reason }],
          patterns: [],
          failures: [reason],
        }],
        goalDraftPaths: [],
        harnessLaunches: 0,
        keptClaims: 0,
        discardedFacts: 0,
        discards: [],
        proposalCount: 0,
        proposals: [],
      };
    }
    keptClaims = pre.claims.length;
    unnamedClaims = pre.claims.filter((claim) => tokensOf(claim.text).length === 0).length;
    discardedFacts = pre.discards.length;
    discards = pre.discards;
    working = pre.claims.map((claim) => ({
      text: claim.text,
      quote: `${claim.quote} [${claim.lens}]`,
      ...(claim.originalText ? { originalClaim: claim.originalText } : {}),
    }));
    log('preprocess', {
      keptClaims,
      unnamedClaims,
      discardedFacts,
      sourceBulletCount: options.sourceBulletCount ?? facts.length,
      discards: pre.discards.map((row) => ({ quote: row.quote, reason: row.reason })),
    });
  }

  const ruler = options.ruler ?? deriveRuler(deps);
  const merged = new Map<string, IntakeCheckItem>();
  const order: string[] = [];

  for (const fact of working) {
    const key = factKey(fact.text);
    const quote = fact.quote?.trim() || fact.text;
    const existing = merged.get(key);
    if (existing) {
      merged.set(key, {
        ...existing,
        quotes: [...existing.quotes, quote],
        ...(fact.originalClaim ? { originalClaims: [...(existing.originalClaims ?? []), fact.originalClaim] } : {}),
      });
      log('item', { fact: fact.text, verdict: existing.verdict, duplicate: true });
      continue;
    }
    // src/index.ts intake check .action → runIntakeCheck / runIntakeCheckDocument → runIntakeCheck → judgeFact.
    const judged = judgeFact(fact, ruler, deps);
    const candidate = replacementCandidate(fact.text);
    const verdict = candidate && judged.verdict !== '못 쟀다' ? '판단 필요' : judged.verdict;
    const current = candidate && judged.verdict !== '못 쟀다'
      ? `${judged.current} · 대체 후보 ${candidate.tool} → ${candidate.paidDependency}: 설치·샘플 실행·라이선스·유지보수 상태 현장 시험 필요`
      : judged.current;
    const item: IntakeCheckItem = {
      ...judged,
      verdict,
      current,
      line: `${fact.text} → ${current} → ${verdict}`,
      ...(candidate ? { replacementCandidate: candidate } : {}),
      quotes: [quote],
      ...(fact.sourceRef ? { sourceRef: fact.sourceRef } : {}),
      ...(fact.originalClaim ? { originalClaims: [fact.originalClaim] } : {}),
    };
    merged.set(key, item);
    order.push(key);
    log('item', {
      fact: item.fact,
      verdict: item.verdict,
      failures: item.failures,
      patterns: item.patterns,
    });
  }

  const draftDir = deps.draftDir ?? join(tmpdir(), 'elanous-intake-check-drafts');
  const now = deps.now?.() ?? new Date().toISOString();
  const items = order.map((key) => {
    const item = merged.get(key)!;
    if (!GAP_VERDICTS.includes(item.verdict)) return item;
    const goalDraftPath = writeGoalDraft(draftDir, item, now);
    return { ...item, goalDraftPath };
  });

  let proposals: IntakeCompareProposal[] | undefined;
  const proposalDrafts: string[] = [];
  if (deps.compare && (documentMode || facts.length > 0)) {
    const names = rulerNames(ruler);
    let parsed: IntakeCompareProposal[] = [];
    try {
      const called = deps.compare({ items, ruler: names });
      if (called && typeof (called as Promise<string>).then === 'function') {
        throw new Error('비교 호출자가 비동기다 — runIntakeCheckDocument 를 쓴다');
      }
      parsed = parseCompareCallerText(called as string);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log('compare-failed', { reason });
      parsed = [];
    }
    const finished = finishCompare(parsed, items, ruler, draftDir, now, log);
    proposals = finished.proposals;
    proposalDrafts.push(...finished.drafts);
  }

  const contrastDrafts = items.map((item) => item.goalDraftPath).filter((path): path is string => !!path);
  const report: IntakeCheckReport = {
    mode: INTAKE_CHECK_MODE,
    tree,
    commit: commit.sha,
    items,
    goalDraftPaths: [...contrastDrafts, ...proposalDrafts],
    harnessLaunches: 0,
    ...(keptClaims !== undefined ? { keptClaims, unnamedClaims, discardedFacts, discards } : {}),
    ...(proposals ? { proposalCount: proposals.length, proposals } : {}),
  };
  log('end', {
    tree: report.tree,
    commit: report.commit,
    items: report.items.length,
    drafts: report.goalDraftPaths.length,
    ...(keptClaims !== undefined ? { keptClaims, unnamedClaims, discardedFacts, sourceBulletCount: options.sourceBulletCount ?? facts.length } : {}),
    ...(proposals ? { proposalCount: proposals.length } : {}),
  });
  return report;
}

/** 문서 모드. 선가공이 비동기여도 기다린다. `--fact` 는 document 를 넘기지 않는다. */
export async function runIntakeCheckDocument(
  facts: readonly IntakeCheckFact[],
  deps: IntakeCheckDeps,
  options: IntakeCheckRunOptions,
): Promise<IntakeCheckReport> {
  if (typeof options.document !== 'string') return runIntakeCheck(facts, deps, options);
  const log = deps.log ?? ((event, data) => { debug.log('intake.check', event, data); });
  const commit = commitOf(deps);
  if (!deps.preprocess) {
    return {
      mode: INTAKE_CHECK_MODE,
      tree: deps.root,
      commit: commit.sha,
      items: [{
        fact: options.document,
        quotes: [],
        verdict: '못 쟀다',
        line: `${options.document} → 선가공 호출자가 없다 → 못 쟀다(선가공 실패)`,
        current: '못 쟀다(선가공 실패): 선가공 호출자가 없다',
        evidence: [],
        patterns: [],
        failures: ['선가공 호출자가 없다'],
      }],
      goalDraftPaths: [],
      harnessLaunches: 0,
      keptClaims: 0,
      discardedFacts: 0,
      discards: [],
      proposalCount: 0,
      proposals: [],
    };
  }
  // 자를 한 번 만들어 선가공(대응 이름) · 대조 · 비교에 함께 쓴다.
  const ruler = deriveRuler(deps);
  let pre: IntakePreprocessResult;
  try {
    pre = await runPreprocess(options.document, deps.preprocess, intakeAnchorNames(ruler));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log('end', {
      tree: deps.root,
      commit: commit.sha,
      verdict: '못 쟀다(선가공 실패)',
      reason,
      keptClaims: 0,
      discardedFacts: 0,
      proposalCount: 0,
      drafts: 0,
    });
    return {
      mode: INTAKE_CHECK_MODE,
      tree: deps.root,
      commit: commit.sha,
      items: [{
        fact: options.document,
        quotes: [],
        verdict: '못 쟀다',
        line: `${options.document} → ${reason} → 못 쟀다(선가공 실패)`,
        current: `못 쟀다(선가공 실패): ${reason}`,
        evidence: [{ axis: 'repo', summary: '선가공 실패', failure: reason }],
        patterns: [],
        failures: [reason],
      }],
      goalDraftPaths: [],
      harnessLaunches: 0,
      keptClaims: 0,
      discardedFacts: 0,
      discards: [],
      proposalCount: 0,
      proposals: [],
    };
  }
  const claims = pre.claims.map((claim) => ({
    text: claim.text,
    quote: `${claim.quote} [${claim.lens}]`,
    ...(claim.originalText ? { originalClaim: claim.originalText } : {}),
  }));
  log('preprocess', {
    keptClaims: pre.claims.length,
    unnamedClaims: pre.claims.filter((claim) => tokensOf(claim.text).length === 0).length,
    discardedFacts: pre.discards.length,
    sourceBulletCount: options.sourceBulletCount ?? facts.length,
  });
  // 비교 호출자는 운영에서 비동기(LLM)다 — 동기 대조에는 넘기지 않고, 대조가 끝난 뒤 여기서 기다린다.
  const syncDeps: IntakeCheckDeps = { ...deps, preprocess: undefined, compare: undefined };
  const report = runIntakeCheck(claims, syncDeps, { ruler });
  let compared: { proposals: IntakeCompareProposal[]; drafts: string[] } | undefined;
  if (deps.compare) {
    const draftDir = deps.draftDir ?? join(tmpdir(), 'elanous-intake-check-drafts');
    const now = deps.now?.() ?? new Date().toISOString();
    let parsed: IntakeCompareProposal[] = [];
    try {
      parsed = parseCompareCallerText(await deps.compare({ items: report.items, ruler: rulerNames(ruler) }));
    } catch (error) {
      log('compare-failed', { reason: error instanceof Error ? error.message : String(error) });
    }
    compared = finishCompare(parsed, report.items, ruler, draftDir, now, log);
  }
  const withCounts: IntakeCheckReport = {
    ...report,
    goalDraftPaths: [...report.goalDraftPaths, ...(compared?.drafts ?? [])],
    keptClaims: pre.claims.length,
    unnamedClaims: pre.claims.filter((claim) => tokensOf(claim.text).length === 0).length,
    discardedFacts: pre.discards.length,
    discards: pre.discards,
    ...(compared ? { proposalCount: compared.proposals.length, proposals: compared.proposals } : {}),
  };
  log('end', {
    tree: withCounts.tree,
    commit: withCounts.commit,
    items: withCounts.items.length,
    drafts: withCounts.goalDraftPaths.length,
    keptClaims: withCounts.keptClaims,
    unnamedClaims: withCounts.unnamedClaims,
    discardedFacts: withCounts.discardedFacts,
    proposalCount: withCounts.proposalCount ?? 0,
    sourceBulletCount: options.sourceBulletCount ?? facts.length,
  });
  return withCounts;
}

export interface ParsedIntakeCheckInput {
  readonly facts: IntakeCheckFact[];
  /** 출처 식별자 — 파일 경로 · URL. 원문이 아니다. */
  readonly document?: string;
  /** 문서 원문(파일·URL 본문). 선가공은 이것을 읽는다. */
  readonly text?: string;
}

/**
 * 문서 모드에서 선가공에 넘길 «원문»을 고른다. `--fact` 면 undefined(선가공 0회).
 * ⛔ `loaded.document` 는 경로·URL 식별자라 원문 자리에 쓰면 선가공이 파일 이름만 읽는다.
 */
export function documentTextForCheck(
  loaded: ParsedIntakeCheckInput,
  opts: { readonly factMode: boolean; readonly stdin?: string },
): string | undefined {
  if (opts.factMode) return undefined;
  if (loaded.text !== undefined) return loaded.text;
  return opts.stdin?.trim() ? opts.stdin : undefined;
}

const FACT_LINE = /^(?:[-*]|\d+[.)])\s+(.+)$/;

/** 사실 목록(텍스트) 또는 문서에서 `- ` 사실 줄을 읽는다. 품질 판단은 하지 않고 인용만 남긴다. */
export function parseFactList(text: string, sourceRef?: string): IntakeCheckFact[] {
  const facts: IntakeCheckFact[] = [];
  for (const raw of text.split('\n')) {
    const match = raw.match(FACT_LINE);
    const line = (match?.[1] ?? '').trim();
    if (!line) continue;
    facts.push({ text: line, quote: raw.trim(), ...(sourceRef ? { sourceRef } : {}) });
  }
  return facts;
}

export function loadIntakeCheckInput(opts: {
  file?: string;
  url?: string;
  stdin?: string;
  fact?: string;
  facts?: readonly string[];
  root: string;
  fetchText?: (url: string) => string;
}): ParsedIntakeCheckInput {
  const given = [...(opts.facts ?? []), ...(opts.fact ? [opts.fact] : [])]
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  if (given.length > 0) {
    return { facts: given.map((text) => ({ text, quote: text })) };
  }
  if (opts.stdin?.trim()) {
    const listed = parseFactList(opts.stdin, 'stdin');
    if (listed.length > 0) return { facts: listed };
    return { facts: [{ text: opts.stdin.trim(), quote: opts.stdin.trim(), sourceRef: 'stdin' }] };
  }
  if (opts.url?.trim()) {
    const fetchText = opts.fetchText;
    if (!fetchText) throw new Error('url fetch is not configured');
    const body = fetchText(opts.url.trim());
    return { document: opts.url.trim(), text: body, facts: parseFactList(body, opts.url.trim()) };
  }
  if (opts.file?.trim()) {
    const abs = isAbsolute(opts.file) ? opts.file : resolve(opts.root, opts.file);
    if (!existsSync(abs)) throw new Error(`document not found: ${opts.file}`);
    const body = readFileSync(abs, 'utf8');
    return { document: abs, text: body, facts: parseFactList(body, abs) };
  }
  throw new Error('fact input required: --file, --url, --fact, or stdin');
}

/** 기억 축 — surface-events FTS. 코드·문서 판정과 다른 칸. 실패해도 판정을 「없음」으로 접지 않는다. */
export function recallIntakeMemory(query: string): readonly string[] | { error: string } {
  try {
    const db = openSurfaceEventsDb();
    try {
      const hits = recallEvents(db, { query, bump: false, limit: 5 });
      return hits.map((hit) => (hit.summary ?? hit.text ?? '').slice(0, 180)).filter((row) => row.length > 0);
    } finally {
      db.close();
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function defaultIntakeCheckDeps(root: string, extra: Partial<IntakeCheckDeps> = {}): IntakeCheckDeps {
  return {
    root,
    readFile: (abs) => readFileSync(abs, 'utf8'),
    recall: recallIntakeMemory,
    launchHarness: (_goalPath: string) => {
      throw new Error('intake check does not launch a harness run');
    },
    ...extra,
  };
}

export function renderIntakeCheckReport(report: IntakeCheckReport): string {
  const lines = [
    `intake check`,
    `tree: ${report.tree}`,
    `commit: ${report.commit || '(none)'}`,
    `harnessLaunches: ${report.harnessLaunches}`,
  ];
  for (const item of report.items) {
    lines.push(item.line);
    lines.push(`  판정: ${item.verdict}`);
    if (item.replacementCandidate) {
      const candidate = item.replacementCandidate;
      lines.push(`  대체 후보: ${candidate.tool} → 유료 의존성 ${candidate.paidDependency} (${candidate.status})`);
      lines.push('  현장 시험: 설치 미검증 · 샘플 실행 미검증 · 라이선스 미검증 · 유지보수 상태 미검증');
    }
    if (item.goalDraftPath) lines.push(`  골 초안: ${item.goalDraftPath}`);
    for (const quote of item.quotes) lines.push(`  인용: ${quote}`);
    for (const original of item.originalClaims ?? []) lines.push(`  원 주장: ${original}`);
    for (const row of item.evidence) {
      const at = row.path ? `${row.path}${row.line ? `:${row.line}` : ''}` : '';
      lines.push(`  근거[${row.axis}] ${row.summary}${at ? ` (${at})` : ''}${row.failure ? ` 실패: ${row.failure}` : ''}`);
    }
  }
  if (typeof report.keptClaims === 'number') {
    lines.push(`keptClaims: ${report.keptClaims}`);
    if (typeof report.unnamedClaims === 'number') lines.push(`unnamedClaims: ${report.unnamedClaims}`);
    lines.push(`discardedFacts: ${report.discardedFacts ?? 0}`);
    for (const discard of report.discards ?? []) lines.push(`  버림: ${discard.quote} — ${discard.reason}`);
  }
  if (typeof report.proposalCount === 'number') {
    lines.push(`proposalCount: ${report.proposalCount}`);
    for (const proposal of report.proposals ?? []) {
      lines.push(`  제안[${proposal.kind}] ${proposal.fact} @ ${proposal.contrast}${proposal.ungrounded ? ` ${proposal.ungrounded}` : ''}${proposal.draftPath ? ` 초안: ${proposal.draftPath}` : ''}`);
    }
  }
  return lines.join('\n');
}

export function intakeCheckReportJson(report: IntakeCheckReport): Record<string, unknown> {
  return {
    mode: report.mode,
    tree: report.tree,
    commit: report.commit,
    harnessLaunches: report.harnessLaunches,
    items: report.items.map((item) => ({
      fact: item.fact,
      ...(item.originalClaims ? { originalClaims: item.originalClaims } : {}),
      current: item.current,
      verdict: item.verdict,
      line: item.line,
      ...(item.replacementCandidate ? { replacementCandidate: item.replacementCandidate } : {}),
      quotes: item.quotes,
      evidence: item.evidence,
      patterns: item.patterns,
      failures: item.failures,
      ...(item.goalDraftPath ? { goalDraftPath: item.goalDraftPath } : {}),
    })),
    goalDraftPaths: report.goalDraftPaths,
    ...(typeof report.keptClaims === 'number' ? {
      keptClaims: report.keptClaims,
      ...(typeof report.unnamedClaims === 'number' ? { unnamedClaims: report.unnamedClaims } : {}),
      discardedFacts: report.discardedFacts,
      discards: report.discards,
    } : {}),
    ...(typeof report.proposalCount === 'number' ? {
      proposalCount: report.proposalCount,
      proposals: report.proposals,
    } : {}),
  };
}

/** 상대 경로가 루트 밖을 가리키면 초안을 쓰지 못하게 막는다. */
export function draftPathInside(root: string, draft: string): boolean {
  const rel = relative(resolve(root), resolve(draft));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function assertDraftDir(root: string, draftDir: string): string {
  const abs = isAbsolute(draftDir) ? draftDir : resolve(root, draftDir);
  if (!draftPathInside(root, abs) && !abs.startsWith(root)) {
    // 테스트 임시 루트는 repo 밖이다. draftDir 를 명시했으면 그 디렉터리만 허용한다.
    mkdirSync(abs, { recursive: true });
  }
  mkdirSync(dirname(abs), { recursive: true });
  return abs;
}
