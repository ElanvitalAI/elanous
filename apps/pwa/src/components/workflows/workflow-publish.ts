import { parse } from 'yaml';

interface PublishEntry {
  kind: 'webhook' | 'chat';
  nodeId: string;
  method: string;
  url: string;
  auth: 'open' | 'hmac' | 'bearer';
  curl: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function publishEntries(yamlText: string, baseUrl: string): PublishEntry[] {
  try {
    const definition: unknown = parse(yamlText);
    if (!record(definition) || !Array.isArray(definition.nodes)) return [];
    const entries: PublishEntry[] = [];
    const root = baseUrl.replace(/\/+$/, '');
    for (const rawNode of definition.nodes) {
      if (!record(rawNode) || typeof rawNode.id !== 'string') continue;
      for (const kind of ['webhook', 'chat'] as const) {
        const trigger = rawNode[kind === 'webhook' ? 'webhookTrigger' : 'chatTrigger'];
        if (!record(trigger) || typeof trigger.path !== 'string' || !trigger.path.startsWith('/')) continue;
        const method = kind === 'chat' ? 'POST' : trigger.method;
        if (typeof method !== 'string' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) continue;
        const auth = record(trigger.auth) && trigger.auth.type === 'hmac' ? 'hmac'
          : record(trigger.auth) && trigger.auth.type === 'bearer' ? 'bearer' : 'open';
        const url = `${root}/v1/workflows/${kind === 'chat' ? 'chat' : 'webhooks'}${trigger.path}`;
        let curl = `curl -X ${method} ${quoted(url)}`;
        if (kind === 'chat' || ['POST', 'PUT', 'PATCH'].includes(method)) {
          curl += " -H 'content-type: application/json'";
          curl += kind === 'chat' ? ` -d '${JSON.stringify({ message: '안녕하세요' })}'` : " -d '{}'";
        }
        if (auth === 'bearer') curl += " -H 'authorization: Bearer <토큰>'";
        if (auth === 'hmac') curl += ' # 서명 헤더 필요';
        entries.push({ kind, nodeId: rawNode.id, method, url, auth, curl });
      }
    }
    return entries;
  } catch {
    return [];
  }
}
