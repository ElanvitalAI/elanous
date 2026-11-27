// NEXUS · /v1/llm/policy panel routes (NEXUS-LLM-POLICY-PANEL · 0.3.33 · UX)
//
// 넥서스 한 화면: LLM 정책(policy/llm.yaml) 보기·고치기.
//   GET  /v1/llm/policy → { valid, errors, warnings, filePresent, path, policy, sources }
//   PUT  /v1/llm/policy → 같은 스키마 검증(validateLlmPolicy 재사용). 틀리면 400 +
//                         거부 사유(errors 배열). 이전 정책 파일은 그대로 유지.
//                         owner 전용(authorizeOwner 콜백 — http-server 배선 시
//                         checkAuth + setupBearerScopeDenied 조합).
//
// 정책 SoT 는 src/policy/llm-policy.ts (loadLlmPolicy). 이 모듈은 thin wire:
// 읽기·검증·거부 사유·원자적 원본 보존만 담당하고 스키마 해석을 중복하지 않는다.
// (feedback_llm-cdb607e3c81563ab: 이전 정책 유지 = 검증 실패 시 write 금지.)
//
// 도입 경위: OP ROSTER-0333-60 #15 (UX P0).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { getElanousConfigDir } from '../../elanous-config-dir.js';
import { loadLlmPolicy, validateLlmPolicy } from '../../policy/llm-policy.js';

export interface LlmPolicyPanelOptions {
  /** Owner gate — nexus 배선에서 checkAuth(+scope) 조합으로 공급. */
  authorizeOwner: (request: Request) => boolean;
  /** 파일 IO 루트 — 기본 getElanousConfigDir(). 시험은 임시 디렉터리. */
  configDir?: string;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, PUT, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '600',
    },
  });
}

function policyPath(configDir: string): string {
  return join(configDir, 'policy', 'llm.yaml');
}

/** GET — 항상 전체 loadLlmPolicy 결과(병합 정책 + 출처 + 검증)를 그대로 노출. */
export async function handleLlmPolicyGet(request: Request, opts: LlmPolicyPanelOptions): Promise<Response> {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (!opts.authorizeOwner(request)) return jsonResponse({ error: 'unauthorized' }, 401);
  const loaded = loadLlmPolicy(opts.configDir ? { configDir: opts.configDir } : {});
  return jsonResponse(loaded, 200);
}

/**
 * PUT — 본문 전체를 새 정책 YAML 원문으로 취급(부분 문서도 validateLlmPolicy
 * 스키마에 정의된 필드만 통과). 검증 실패 = 400 + errors 원문 배열, 파일 무변경.
 * 성공 = 원자적 write(임시 → rename 아님, 단일 writeFileSync — 넥서스 데몬
 * 프로세스에서만 쓰므로 단일 writer). 응답은 재로드한 loadLlmPolicy 결과.
 */
export async function handleLlmPolicyPut(request: Request, opts: LlmPolicyPanelOptions): Promise<Response> {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (!opts.authorizeOwner(request)) return jsonResponse({ error: 'unauthorized' }, 401);
  const raw = await request.text();
  const validation = validateLlmPolicy(parseOrUndefined(raw));
  if (!validation.valid) {
    return jsonResponse({ error: 'invalid-policy', errors: validation.errors, warnings: validation.warnings }, 400);
  }
  const path = policyPath(opts.configDir ?? getElanousConfigDir());
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw, 'utf8');
  const loaded = loadLlmPolicy(opts.configDir ? { configDir: opts.configDir } : {});
  return jsonResponse(loaded, 200);
}

function parseOrUndefined(raw: string): unknown {
  try {
    // yaml 파싱은 loadLlmPolicy 내부와 동일 라이브러리·동일 옵션으로.
    const doc = parseDocument(raw, { uniqueKeys: true });
    if (doc.errors.length) return undefined;
    return doc.toJS();
  } catch {
    return undefined;
  }
}
