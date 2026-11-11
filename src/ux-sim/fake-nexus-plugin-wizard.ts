export interface FakePluginWizardProposal {
  readonly ok: true;
  readonly id: string;
  readonly yaml: string;
  readonly summary: string;
}

export interface FakeNexusPluginWizardReceipt {
  readonly requests: Array<{ method: string; path: string; body: unknown }>;
  readonly saved: Array<{ id: string; yaml: string }>;
  readonly fetch: typeof fetch;
}

/** Fake the two Nexus boundaries used by a TUI graph/plugin wizard; no socket or provider call. */
export function createFakeNexusPluginWizard(
  proposal: FakePluginWizardProposal = {
    ok: true,
    id: 'csv-export',
    yaml: 'graph_id: csv-export\nversion: 1\nentry_node: start\nterminal_nodes: [done]\nnodes: []\nedges: []\n',
    summary: 'CSV 내보내기 · 입력을 받아 파일로 내보냅니다.',
  },
): FakeNexusPluginWizardReceipt {
  const requests: FakeNexusPluginWizardReceipt['requests'] = [];
  const saved: FakeNexusPluginWizardReceipt['saved'] = [];
  const fakeFetch = (async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let body: unknown;
    const rawBody = init.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    if (typeof rawBody === 'string' && rawBody.length > 0) {
      try { body = JSON.parse(rawBody); } catch { body = rawBody; }
    }
    requests.push({ method, path: url.pathname, body });

    if (method === 'POST' && url.pathname === '/v1/graphs/wizard') return Response.json(proposal);
    if (method === 'POST' && url.pathname === '/v1/graphs') {
      const record = body as { id?: unknown; yaml?: unknown } | undefined;
      if (typeof record?.id !== 'string' || typeof record.yaml !== 'string') {
        return Response.json({ error: 'bad_request' }, { status: 400 });
      }
      saved.push({ id: record.id, yaml: record.yaml });
      return Response.json({ id: record.id, source: 'mine', editable: true, saved: true, version: 'v1', previous: null }, { status: 201 });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  }) as typeof fetch;
  return { requests, saved, fetch: fakeFetch };
}
