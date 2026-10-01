import { buildUserConfig, saveUserConfig, userConfigPath } from '../../user-config.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** GET/PUT /v1/config/chat-fast-path. Authentication is enforced by the HTTP dispatcher. */
export async function handleChatFastPathConfig(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    return json({ enabled: buildUserConfig(userConfigPath()).chat.fastPath });
  }
  if (req.method !== 'PUT') return json({ error: 'method-not-allowed' }, 405);

  let body: unknown;
  try { body = await req.json(); }
  catch { return json({ error: 'invalid-json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || typeof (body as { enabled?: unknown }).enabled !== 'boolean') {
    return json({ error: 'invalid-shape' }, 400);
  }
  const path = userConfigPath();
  const cfg = buildUserConfig(path);
  saveUserConfig({ ...cfg, chat: { ...cfg.chat, fastPath: (body as { enabled: boolean }).enabled } }, path);
  return json({ enabled: buildUserConfig(path).chat.fastPath });
}
