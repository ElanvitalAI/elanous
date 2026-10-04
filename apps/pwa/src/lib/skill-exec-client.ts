import type { DaemonHttpConfig } from './model-tier-sync';

export type SkillExecResult =
  | { kind: 'done'; ok: boolean; output: string }
  | { kind: 'rejected' }
  | { kind: 'failed'; error: string };

export async function runSkillExec(
  daemon: DaemonHttpConfig | undefined,
  skill: string,
  task: string,
  options: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; fetch?: typeof fetch } = {},
): Promise<SkillExecResult> {
  if (!daemon?.baseUrl) return { kind: 'failed', error: '데몬 연결이 없습니다' };
  const { intervalMs = 3000, timeoutMs = 600_000, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)), fetch: fetchFn = globalThis.fetch } = options;
  const base = `${daemon.baseUrl.replace(/\/$/, '')}/v1/skills/exec`;
  const headers = { 'content-type': 'application/json', ...(daemon.token ? { authorization: `Bearer ${daemon.token}` } : {}) };
  const deadline = Date.now() + timeoutMs;
  const read = async (url: string, init?: RequestInit, expectedStatus?: number): Promise<unknown> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('timeout');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let response: Response;
    try {
      response = await fetchFn(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new Error('timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok || (expectedStatus !== undefined && response.status !== expectedStatus)) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  try {
    const posted = await read(base, { method: 'POST', headers, body: JSON.stringify({ skill, task }) }, 202);
    if (!posted || typeof posted !== 'object' || !('id' in posted) || typeof posted.id !== 'string' || !posted.id) throw new Error('잘못된 응답');
    for (;;) {
      if (Date.now() >= deadline) return { kind: 'failed', error: 'timeout' };
      const body = await read(`${base}/${encodeURIComponent(posted.id)}`, { headers: daemon.token ? { authorization: `Bearer ${daemon.token}` } : {} });
      if (!body || typeof body !== 'object' || !('status' in body)) throw new Error('잘못된 응답');
      if (body.status === 'done' && 'ok' in body && typeof body.ok === 'boolean' && 'output' in body && typeof body.output === 'string') return { kind: 'done', ok: body.ok, output: body.output };
      if (body.status === 'rejected') return { kind: 'rejected' };
      if (body.status === 'failed') return { kind: 'failed', error: 'error' in body && typeof body.error === 'string' ? body.error : '잘못된 응답' };
      if (body.status !== 'running') throw new Error('잘못된 응답');
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { kind: 'failed', error: 'timeout' };
      await sleep(Math.min(intervalMs, remaining));
    }
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
