// KPACK6 — 선택 실행 운영 스모크 (읽기 전용)
//
// #25780 으로 두 공개 표본 팩의 서명 설치·CLI KnowledgeQuery·그래프 검색 인용은 착지했다.
// 이 스크립트는 그 다음 칸이다: 설치된 두 팩에 대해 실제 CLI 채팅 LLM 답변이
// 팩 출처(`slug@version#cardId`)를 인용하는지 확인한다.
//
//   팩 미설치 / LLM 호출 불가 / 스토어 오류  → 미측정 (실패 아님)
//   답변은 왔으나 팩 출처 인용 없음          → 실패
//   두 팩 모두 인용 답변 실물 확보 전까지    → green 금지
//
// 실행: KPACK6_LIVE=1 bun scripts/verify-kpack6-live.ts
// CLI 명령은 KPACK6_AGENT_CMD 로 바꿀 수 있다(기본 `bun bin/elanous.mjs agent --new --json`).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInstalledPacks, queryInstalledPack } from '../src/knowledge/query.js';

export const KPACK6_TARGET_SLUGS = ['semiconductor-process-public', 'b2b-sales-public'] as const;

export type Kpack6PackStatus =
  | 'pack-not-installed'
  | 'pack-unreadable'
  | 'llm-unavailable'
  | 'llm-timeout'
  | 'cli-contract-error'
  | 'citation-missing'
  | 'cited';

export type Kpack6PackResult = {
  slug: string;
  packId: string | null;
  status: Kpack6PackStatus;
  measured: boolean;
  question?: string;
  reply?: string;
  ref?: string;
  reason?: string;
};

export type Kpack6SmokeStatus = 'green' | 'fail' | 'not-measured' | 'skipped';

export type Kpack6SmokeReport = {
  status: Kpack6SmokeStatus;
  reason?: string;
  packs: Kpack6PackResult[];
  generatedAt: string;
};

export type Kpack6Deps = {
  installedPacks?: () => Array<{ id: string; title: string }>;
  queryTopCard?: (packId: string) => { id: string; title: string; ref: string };
  ask?: (question: string) => Promise<{ reply: string }>;
  env?: Record<string, string | undefined>;
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 설치된 팩에서 조회한 바로 그 카드의 ref만 인용으로 인정한다. */
export function packCitationIn(reply: string, expectedRef: string): string | null {
  const exactRef = new RegExp(`(?<![\\w./@#-])${escapeRegExp(expectedRef)}(?=$|[^\\w./@#-])`);
  return exactRef.test(reply) ? expectedRef : null;
}

function defaultQueryTopCard(packId: string): { id: string; title: string; ref: string } {
  const hits = queryInstalledPack(packId, '');
  if (hits.length === 0) throw new Error(`팩에 카드가 없다: ${packId}`);
  return { id: hits[0].id, title: hits[0].title, ref: hits[0].ref };
}

export class Kpack6CliContractError extends Error {}
export class Kpack6LlmTimeoutError extends Error {}

function isProviderUnavailable(stderr: string): boolean {
  return /No LLM provider available|usage_limit_reached|(?:^|\W)429(?:\W|$)/i.test(stderr);
}

export async function askViaCli(question: string, env: Record<string, string | undefined>): Promise<{ reply: string }> {
  const argv = (env.KPACK6_AGENT_CMD ?? 'bun bin/elanous.mjs agent --new --json').split(/\s+/);
  const timeoutMs = Number(env.KPACK6_TIMEOUT_MS ?? 180_000);
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0], [...argv.slice(1), question], {
      cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Kpack6CliContractError(`agent CLI 실행 실패 — ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Kpack6LlmTimeoutError(`agent CLI LLM 응답 시간 초과 (${timeoutMs}ms)`));
        return;
      }
      const jsonLine = stdout.split('\n').filter((line) => line.trim().startsWith('{')).pop();
      if (code !== 0) {
        const message = `agent CLI exit=${code} stderr=${stderr.slice(0, 300)}`;
        reject(isProviderUnavailable(stderr) ? new Error(message) : new Kpack6CliContractError(message));
        return;
      }
      if (!jsonLine) {
        reject(new Kpack6CliContractError('agent CLI 성공 출력에 JSON 객체가 없다'));
        return;
      }
      try {
        const parsed = JSON.parse(jsonLine) as { reply?: unknown };
        if (typeof parsed.reply !== 'string' || parsed.reply.trim() === '') {
          reject(new Kpack6CliContractError('agent CLI 응답에 reply 문자열이 없다'));
          return;
        }
        resolve({ reply: parsed.reply });
      } catch (err) {
        reject(err instanceof Kpack6CliContractError
          ? err : new Kpack6CliContractError(`agent CLI 출력 JSON 파싱 실패 — ${(err as Error).message}`));
      }
    });
  });
}

export function kpack6ExitCode(report: Kpack6SmokeReport): number {
  switch (report.status) {
    case 'green': return 0;
    case 'fail': return 1;
    case 'skipped': return 3;
    default: return 4;
  }
}

export async function runKpack6LiveSmoke(deps: Kpack6Deps = {}): Promise<Kpack6SmokeReport> {
  const env = deps.env ?? process.env;
  const generatedAt = new Date().toISOString();

  if (env.KPACK6_LIVE !== '1') {
    return {
      status: 'skipped',
      reason: '선택 실행 스모크다: KPACK6_LIVE=1 없이는 돌지 않는다 (두 팩 인용 답변 실물 1회 전까지 green 금지)',
      packs: [],
      generatedAt,
    };
  }

  const ask = deps.ask ?? ((question: string) => askViaCli(question, env));
  let installed: Array<{ id: string; title: string }>;
  try {
    installed = deps.installedPacks?.() ?? listInstalledPacks();
  } catch (err) {
    return {
      status: 'not-measured',
      reason: `KGS 스토어 조회 불가 — ${(err as Error).message}`,
      packs: KPACK6_TARGET_SLUGS.map((slug) => ({
        slug, packId: null, status: 'pack-unreadable' as const, measured: false,
        reason: `스토어 오류: ${(err as Error).message}`,
      })),
      generatedAt,
    };
  }

  const packs: Kpack6PackResult[] = [];
  for (const slug of KPACK6_TARGET_SLUGS) {
    const match = installed.find((pack) => pack.id === slug || pack.id.startsWith(`${slug}@`));
    if (!match) {
      packs.push({
        slug, packId: null, status: 'pack-not-installed', measured: false,
        reason: 'KGS 스토어에 설치된 팩이 없다 (미측정)',
      });
      continue;
    }
    const packId = match.id;

    let top: { id: string; title: string; ref: string };
    try {
      top = deps.queryTopCard?.(packId) ?? defaultQueryTopCard(packId);
    } catch (err) {
      packs.push({
        slug, packId, status: 'pack-unreadable', measured: false,
        reason: `설치됐으나 카드 조회 불가 — ${(err as Error).message}`,
      });
      continue;
    }

    const question = `설치된 ${packId} (${match.title}) 팩의 «${top.title}» 카드를 지식 조회 도구로 읽고 요약하라. 답변에 카드 제목을 쓰고, 도구가 반환한 출처를 그대로 인용해 붙여라. 출처를 추측하지 마라.`;
    let reply: string;
    try {
      reply = (await ask(question)).reply;
    } catch (err) {
      const contractError = err instanceof Kpack6CliContractError;
      const timeoutError = err instanceof Kpack6LlmTimeoutError;
      packs.push({
        slug, packId, status: contractError ? 'cli-contract-error' : timeoutError ? 'llm-timeout' : 'llm-unavailable',
        measured: false, question,
        reason: `${contractError ? 'CLI JSON 계약 오류' : timeoutError ? 'LLM 응답 시간 초과' : 'CLI 채팅 LLM 호출 불가'} — ${(err as Error).message}`,
      });
      continue;
    }

    const ref = packCitationIn(reply, top.ref);
    if (ref && reply.includes(top.title)) {
      packs.push({ slug, packId, status: 'cited', measured: true, question, reply, ref });
    } else {
      packs.push({
        slug, packId, status: 'citation-missing', measured: true, question, reply,
        reason: '답변은 왔으나 조회한 설치 카드의 제목과 정확한 출처 인용이 함께 없다 — 실패',
      });
    }
  }

  const failed = packs.some((pack) => pack.status === 'citation-missing' || pack.status === 'cli-contract-error');
  const allCited = packs.length > 0 && packs.every((pack) => pack.status === 'cited');
  const status: Kpack6SmokeStatus = failed ? 'fail' : allCited ? 'green' : 'not-measured';
  return { status, packs, generatedAt };
}

if (import.meta.main) {
  const report = await runKpack6LiveSmoke();
  console.log(JSON.stringify(report, null, 2));
  process.exit(kpack6ExitCode(report));
}
