// Round 3 PR1 (β-3) — PWA Settings Pushcut card backend (2026-05-08).
//
// Two endpoints:
//   GET  /v1/hitl/audit/recent   → recent audit entries (default 50)
//                                  for the Settings card to derive
//                                  "last delivery" metadata.
//   POST /v1/hitl/test-pushcut   → fires a stub Pushcut notification
//                                  via the wired PushcutClient. Body
//                                  `{prompt?: string}` (optional).
//
// Designed to be self-contained — no metaApi dependency. Both
// handlers call the singleton `getPushcutClient()` / read the
// default audit log path. Tests inject a custom client + path.

import { jsonResponse } from './json-response.js';
import { getPushcutClient, type PushcutClient } from '../../pushcut/client.js';
import {
  readAuditLog,
  defaultAuditLogPath,
  type HitlAuditEntry,
} from '../../hitl/audit-log.js';

export interface HitlAuditRecentOpts {
  /** Override the audit log path (tests). */
  auditPath?: string;
  /** Override the default tail size (default 50). */
  defaultLimit?: number;
}

export async function handleHitlAuditRecent(
  req: Request,
  opts: HitlAuditRecentOpts = {},
): Promise<Response> {
  const url = new URL(req.url);
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Number.parseInt(limitParam, 10) : (opts.defaultLimit ?? 50);
  const channel = url.searchParams.get('channel');     // optional filter

  const path = opts.auditPath ?? defaultAuditLogPath();
  let entries: HitlAuditEntry[];
  try {
    entries = await readAuditLog({
      path,
      limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
      includeRotated: true,
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, 500);
  }

  if (channel) {
    entries = entries.filter((e) => e.channel === channel);
  }

  return jsonResponse({
    ok: true,
    path,
    count: entries.length,
    entries,
  }, 200);
}

export interface HitlTestPushcutOpts {
  /** Override the Pushcut client (tests). Defaults to the singleton. */
  client?: PushcutClient;
  /** Override the notification name. Defaults to env / 'monad-confirm'. */
  notificationName?: string;
}

interface TestPushcutBody {
  prompt?: unknown;
}

export async function handleHitlTestPushcut(
  req: Request,
  opts: HitlTestPushcutOpts = {},
): Promise<Response> {
  const client = opts.client ?? getPushcutClient();
  const notificationName = opts.notificationName
    ?? process.env['ELANOUS_HITL_NOTIFY']
    ?? 'monad-confirm';

  if (!client.configured) {
    return jsonResponse({
      ok: false,
      reason: 'pushcut-not-configured',
      hint: 'Set PUSHCUT_API_KEY (or use the PWA Pushcut binding wizard) to enable.',
      notificationName,
    }, 503);
  }

  let body: TestPushcutBody = {};
  try {
    const text = await req.text();
    if (text.trim().length > 0) body = JSON.parse(text) as TestPushcutBody;
  } catch {
    return jsonResponse({ ok: false, error: 'invalid JSON body' }, 400);
  }

  const promptRaw = typeof body.prompt === 'string' && body.prompt.trim().length > 0
    ? body.prompt.trim()
    : 'elanous β-3 test notification';
  // Pushcut payload caps individual fields around ~256 chars in the
  // 'title' slot; 200 is a safe ceiling that still carries a useful
  // human prompt.
  const prompt = promptRaw.length > 200 ? promptRaw.slice(0, 200) : promptRaw;

  const sentAt = Date.now();
  const r = await client.notify(notificationName, {
    title: prompt,
    text: 'Test fired from PWA Settings · Pushcut card',
  });

  if (!r.ok) {
    return jsonResponse({
      ok: false,
      reason: r.reason ?? 'pushcut-send-failed',
      notificationName,
      sentAt,
    }, 502);
  }

  return jsonResponse({
    ok: true,
    notificationName,
    sentAt,
    prompt,
  }, 200);
}
