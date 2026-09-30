import { debug } from '../../debug/log.js';
import { credentialStatus, setPluginCredentials } from '../../plugins/install/plugin-credentials.js';
import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { jsonResponse } from './json-response.js';

const NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;

function failure(error: unknown): Response {
  if (error instanceof Error && error.message.startsWith('plugin not installed:')) return jsonResponse({ error: 'not_found' }, 404);
  if (error instanceof Error && (error.message === 'invalid plugin name' || error.message === 'invalid plugin credential field'
    || error.message === 'invalid plugin credential fields')) {
    return jsonResponse({ error: 'bad_request' }, 400);
  }
  return jsonResponse({ error: 'credential_error' }, 500);
}

export function handlePluginsCredentialsGet(req: Request, name: string, opts: MetaApiOpts, root?: string): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!NAME.test(name)) return jsonResponse({ error: 'bad_request' }, 400);
  try { return jsonResponse(credentialStatus(name, root), 200); }
  catch (error) { return failure(error); }
}

/** `reload` re-spawns the daemon's MCP clients so a running plugin server picks up the new values
 *  (the spawn reads `pluginEnv` fresh). A failed reload never fails the write — the reply says so. */
export async function handlePluginsCredentialsPut(req: Request, name: string, opts: MetaApiOpts, root?: string, reload?: () => Promise<unknown>): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!NAME.test(name)) return jsonResponse({ error: 'bad_request' }, 400);
  let body: unknown;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: 'bad_request' }, 400); }
  const fields = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).fields : undefined;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)
    || Object.values(fields).some(value => typeof value !== 'string' && value !== null)) {
    return jsonResponse({ error: 'bad_request' }, 400);
  }
  try {
    const result = setPluginCredentials(name, fields as Record<string, string | null>, root);
    debug.log('plugin.credentials', 'set', { plugin: name, fields: Object.keys(fields), count: Object.keys(fields).length });
    let reloaded = false;
    if (reload) {
      try { await reload(); reloaded = true; }
      catch { debug.log('plugin.credentials', 'reload-failed', { plugin: name }, { level: 'warn' }); }
    }
    return jsonResponse({ ...result, reloaded }, 200);
  } catch (error) { return failure(error); }
}
