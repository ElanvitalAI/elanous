// POST /v1/design-system — URL 또는 팔레트로 라이브러리에 시스템을 하나 만든다.
// 소유자 인증은 디스패처가 본문을 읽기 전에 한다. 이 핸들러는 그 뒤에만 호출된다.
// 한 번에 하나만: 진행 중이면 429.

import { debug } from '../../debug/log.js';
import {
  createCustomSystemFromPalette,
  createCustomSystemFromUrl,
  type CustomSystemCreateDeps,
  type CustomSystemCreateResult,
} from '../../design/custom-system-create.js';
import { jsonResponse } from './json-response.js';

export interface DesignSystemCreateRouteDeps extends CustomSystemCreateDeps {
  readonly log?: (event: 'created' | 'refused', data: Record<string, unknown>) => void;
}

let inFlight = false;

export function designSystemCreateInFlight(): boolean {
  return inFlight;
}

/** 시험이 프로세스 전역 잠금을 비운다. */
export function resetDesignSystemCreateGate(): void {
  inFlight = false;
}

function hostOnly(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

function statusFor(result: Extract<CustomSystemCreateResult, { ok: false }>): number {
  switch (result.reason) {
    case 'id-taken': return 409;
    case 'extract-failed': return 502;
    default: return 400;
  }
}

function wire(result: CustomSystemCreateResult): Record<string, unknown> {
  if (!result.ok) {
    return { ok: false, reason: result.reason, ...(result.detail === undefined ? {} : { detail: result.detail }) };
  }
  return {
    ok: true,
    id: result.id,
    dir: result.dir,
    tokens: result.tokens,
    unread: result.unread,
    warnings: result.warnings,
    ...(result.extractDir === undefined ? {} : { extractDir: result.extractDir }),
  };
}

export async function handleDesignSystemCreate(
  req: Request,
  overrides: DesignSystemCreateRouteDeps = {},
): Promise<Response> {
  const log = overrides.log ?? ((event: 'created' | 'refused', data: Record<string, unknown>) => {
    debug.log('design.custom', event, data);
  });
  if (inFlight) {
    log('refused', { reason: 'busy' });
    return jsonResponse({ ok: false, reason: 'busy' }, 429);
  }
  inFlight = true;
  const started = Date.now();
  try {
    let body: unknown;
    try { body = await req.json(); }
    catch { return jsonResponse({ ok: false, reason: 'invalid-json' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse({ ok: false, reason: 'invalid-body' }, 400);
    }
    const record = body as { kind?: unknown; url?: unknown; colors?: unknown; id?: unknown; name?: unknown; base?: unknown };
    const id = typeof record.id === 'string' ? record.id : undefined;
    const name = typeof record.name === 'string' ? record.name : undefined;
    const base = typeof record.base === 'string' ? record.base : undefined;
    const deps: CustomSystemCreateDeps = overrides;

    let result: CustomSystemCreateResult;
    let kind: 'url' | 'palette';
    let host: string | undefined;
    if (record.kind === 'url') {
      kind = 'url';
      if (typeof record.url !== 'string' || !record.url.trim()) {
        log('refused', { kind, reason: 'bad-url', ms: Date.now() - started });
        return jsonResponse({ ok: false, reason: 'bad-url' }, 400);
      }
      host = hostOnly(record.url);
      result = await createCustomSystemFromUrl({ url: record.url, id, name, base }, deps);
    } else if (record.kind === 'palette') {
      kind = 'palette';
      if (!Array.isArray(record.colors) || record.colors.some((color) => typeof color !== 'string')) {
        log('refused', { kind, reason: 'no-colors', ms: Date.now() - started });
        return jsonResponse({ ok: false, reason: 'no-colors' }, 400);
      }
      if (typeof record.id !== 'string' || !record.id.trim()) {
        log('refused', { kind, reason: 'bad-id', ms: Date.now() - started });
        return jsonResponse({ ok: false, reason: 'bad-id' }, 400);
      }
      result = await createCustomSystemFromPalette({ colors: record.colors, id: record.id, name, base }, deps);
    } else {
      log('refused', { reason: 'bad-kind', ms: Date.now() - started });
      return jsonResponse({ ok: false, reason: 'bad-kind' }, 400);
    }

    const ms = Date.now() - started;
    if (!result.ok) {
      log('refused', { kind, ...(host ? { host } : {}), ...(result.detail && result.reason === 'id-taken' ? { id: result.detail } : {}), reason: result.reason, ms });
      return jsonResponse(wire(result), statusFor(result));
    }
    log('created', { kind, id: result.id, ...(host ? { host } : {}), ms });
    return jsonResponse(wire(result), 201);
  } finally {
    inFlight = false;
  }
}
