// Webhook trigger HMAC signature auth — provider webhooks (Linear · GitHub · Asana)
// sign the raw body; the router verifies before any workflow runs (RFC external tasks §A8).

import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { validateWorkflow } from '../src/workflow-runtime/schema';
import type { WebhookHmacAuth } from '../src/workflow-runtime/types';
import type { WebhookEntry } from '../src/workflow-runtime/triggers/registry';
import { buildWebhookRouter, checkHmac } from '../src/workflow-runtime/triggers/webhook-router';
import { createWebhookSource } from '../src/workflow-runtime/triggers/webhook-source';

const SECRET = 'whsec-test';
const BODY = '{"action":"create","data":{"id":"ELA-1","title":"한글 제목"}}';
const sign = (body: string, alg = 'sha256', enc: 'hex' | 'base64' = 'hex') =>
  createHmac(alg, SECRET).update(body, 'utf8').digest(enc);

const linear: WebhookHmacAuth = { type: 'hmac', header: 'Linear-Signature', secretRef: 'linear_webhook' };

describe('checkHmac', () => {
  test('accepts the provider signature over the raw body (header name is case-insensitive)', () => {
    expect(checkHmac(linear, { 'linear-signature': sign(BODY) }, BODY, SECRET)).toBeNull();
  });

  test('rejects a signature over a different body, a missing header, and a wrong-length value', () => {
    expect(checkHmac(linear, { 'linear-signature': sign(`${BODY} `) }, BODY, SECRET)?.status).toBe(401);
    expect(checkHmac(linear, {}, BODY, SECRET)).toEqual({ status: 401, body: 'Signature required' });
    expect(checkHmac(linear, { 'linear-signature': 'abc' }, BODY, SECRET)?.status).toBe(401);
  });

  test('a missing secret is a server fault naming the ref, never the value', () => {
    const res = checkHmac(linear, { 'linear-signature': sign(BODY) }, BODY, undefined);
    expect(res?.status).toBe(500);
    expect(res?.body).toContain("'linear_webhook'");
  });

  test('GitHub prefix form and base64 encoding', () => {
    const github: WebhookHmacAuth = { type: 'hmac', header: 'x-hub-signature-256', secretRef: 'gh', prefix: 'sha256=' };
    expect(checkHmac(github, { 'x-hub-signature-256': `sha256=${sign(BODY)}` }, BODY, SECRET)).toBeNull();
    expect(checkHmac(github, { 'x-hub-signature-256': sign(BODY) }, BODY, SECRET)?.status).toBe(401);
    const b64: WebhookHmacAuth = { type: 'hmac', header: 'x-sig', secretRef: 's', algorithm: 'sha1', encoding: 'base64' };
    expect(checkHmac(b64, { 'x-sig': sign(BODY, 'sha1', 'base64') }, BODY, SECRET)).toBeNull();
  });
});

describe('webhook router with hmac auth', () => {
  const entry: WebhookEntry = {
    workflowName: 'linear-intake',
    nodeId: 'hook',
    trigger: { method: 'POST', path: '/linear', auth: linear },
  };

  function router(resolveSecret: (ref: string) => string | undefined | Promise<string | undefined>) {
    const runs: string[] = [];
    const r = buildWebhookRouter({
      registry: [entry],
      resolveSecret,
      runWorkflow: async (_entry, body) => { runs.push(body); return { ok: true, runId: 'run-1' }; },
    });
    return { r, runs };
  }

  test('a valid signature runs the workflow with the raw body; an invalid one never runs it', async () => {
    const seen: string[] = [];
    const { r, runs } = router(async (ref) => { seen.push(ref); return SECRET; });
    const ok = await r({ method: 'POST', path: '/linear', headers: { 'linear-signature': sign(BODY) }, body: BODY });
    expect(ok.status).toBe(202);
    expect(runs).toEqual([BODY]);
    expect(seen).toEqual(['linear_webhook']);
    const bad = await r({ method: 'POST', path: '/linear', headers: { 'linear-signature': sign('{}') }, body: BODY });
    expect(bad.status).toBe(401);
    expect(runs).toHaveLength(1);
  });

  test('a secret lookup that throws or finds nothing answers 500 and runs nothing', async () => {
    for (const resolve of [() => { throw new Error('store locked'); }, () => undefined]) {
      const { r, runs } = router(resolve as () => undefined);
      const res = await r({ method: 'POST', path: '/linear', headers: { 'linear-signature': sign(BODY) }, body: BODY });
      expect(res.status).toBe(500);
      expect(runs).toHaveLength(0);
    }
  });

  test('auth refusals are reported; a workflow failure after auth passes is not', async () => {
    const rejected: number[] = [];
    const r = buildWebhookRouter({
      registry: [entry],
      resolveSecret: () => SECRET,
      onAuthRejected: (_e, res) => rejected.push(res.status),
      runWorkflow: async () => ({ ok: false, error: 'workflow failed' }),
    });
    expect((await r({ method: 'POST', path: '/linear', headers: { 'linear-signature': 'x' }, body: BODY })).status).toBe(401);
    expect((await r({ method: 'POST', path: '/linear', headers: { 'linear-signature': sign(BODY) }, body: BODY })).status).toBe(500);
    expect(rejected).toEqual([401]);
  });

  test('bearer routes keep working without a secret resolver', async () => {
    const bearer = buildWebhookRouter({
      registry: [{ workflowName: 'b', nodeId: 'n', trigger: { method: 'POST', path: '/b', auth: { type: 'bearer', token: 't' } } }],
      runWorkflow: async () => ({ ok: true, runId: 'r' }),
    });
    expect((await bearer({ method: 'POST', path: '/b', headers: { authorization: 'Bearer t' }, body: '' })).status).toBe(202);
    expect((await bearer({ method: 'POST', path: '/b', headers: { authorization: 'Bearer x' }, body: '' })).status).toBe(401);
  });
});

describe('webhook source wires the secret resolver', () => {
  test('a subscribed hmac workflow verifies through the injected resolver', async () => {
    const source = createWebhookSource({ resolveSecret: () => SECRET });
    const emitted: string[] = [];
    source.subscribe(
      { definition: { name: 'linear-intake', nodes: [{ id: 'hook', webhookTrigger: { method: 'POST', path: '/linear', auth: linear } }] } } as never,
      async (_wf, _node, payload) => { emitted.push((payload as { body: string }).body); return { ok: true, runId: 'run-9' }; },
    );
    await source.start();
    const good = await source.dispatch({ method: 'POST', path: '/linear', headers: { 'linear-signature': sign(BODY) }, body: BODY });
    const bad = await source.dispatch({ method: 'POST', path: '/linear', headers: { 'linear-signature': 'x' }, body: BODY });
    expect(good?.status).toBe(202);
    expect(bad?.status).toBe(401);
    expect(emitted).toEqual([BODY]);
    await source.stop();
  });
});

describe('workflow schema — webhookTrigger.auth hmac', () => {
  const wf = (auth: unknown) => validateWorkflow({
    name: 'linear-intake', description: 't',
    nodes: [{ id: 'hook', webhookTrigger: { method: 'POST', path: '/linear', auth } }],
  });

  test('accepts header + secretRef with optional algorithm, encoding, prefix', () => {
    expect(wf({ type: 'hmac', header: 'linear-signature', secretRef: 'linear_webhook' }).ok).toBe(true);
    expect(wf({ type: 'hmac', header: 'x-hub-signature-256', secretRef: 'gh', algorithm: 'sha256', encoding: 'hex', prefix: 'sha256=' }).ok).toBe(true);
  });

  test('rejects a missing secretRef, an unknown algorithm, and an unknown type', () => {
    expect(wf({ type: 'hmac', header: 'linear-signature' }).ok).toBe(false);
    expect(wf({ type: 'hmac', header: 'h', secretRef: 's', algorithm: 'md5' }).ok).toBe(false);
    expect(wf({ type: 'oauth' }).ok).toBe(false);
  });
});
