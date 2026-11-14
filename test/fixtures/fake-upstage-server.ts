import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeUpstageRequest {
  path: string;
  body: string;
  authorized: boolean;
}

export interface FakeUpstageServer {
  baseUrl: string;
  requests: FakeUpstageRequest[];
  close: () => Promise<void>;
}

const reply = (response: import('node:http').ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};

async function bodyOf(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(Buffer.from(part));
  return Buffer.concat(parts).toString('utf8');
}

/** One deterministic loopback fixture for the U-0 consumer plugins. No real API calls. */
export async function startFakeUpstageServer(): Promise<FakeUpstageServer> {
  const requests: FakeUpstageRequest[] = [];
  const server = createServer(async (request, response) => {
    const path = request.url?.split('?')[0] ?? '';
    const body = await bodyOf(request);
    const authorized = request.headers.authorization === 'Bearer fake-upstage-key';
    requests.push({ path, body, authorized });
    if (request.method !== 'POST' || !authorized) {
      reply(response, 401, { error: { message: 'synthetic authorization required' } });
      return;
    }
    if (path === '/v1/document-digitization' || path === '/v1/document-digitization/async') {
      if (!request.headers['content-type']?.startsWith('multipart/form-data')) {
        reply(response, 400, { error: { message: 'multipart required' } });
      } else if (body.includes('FAKE_OVER_100_PAGES')) {
        reply(response, 413, { error: { message: 'sync page limit' } });
      } else if (path.endsWith('/async')) {
        reply(response, 200, { request_id: 'fake-parse-job-1', status: 'processing' });
      } else {
        reply(response, 200, { text: 'Synthetic document', content: { text: 'Synthetic document', markdown: '# Synthetic document', html: '<h1>Synthetic document</h1>' }, elements: [{ category: 'heading', content: 'Synthetic document' }] });
      }
    } else if (path === '/v1/chat/completions') {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(body) as Record<string, unknown>; } catch { /* default response */ }
      if (payload.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"choices":[{"delta":{"content":"Synthetic Solar answer"}}]}\n\ndata: [DONE]\n\n');
      } else {
        const message = Array.isArray(payload.tools) && payload.tools.length > 0
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'fake-tool-1', type: 'function', function: { name: 'synthetic_tool', arguments: '{}' } }] }
          : { role: 'assistant', content: 'Synthetic Solar answer' };
        reply(response, 200, { id: 'fake-solar-1', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: 'stop' }] });
      }
    } else if (path === '/v1/information-extraction') {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(body) as Record<string, unknown>; } catch { /* rejected below */ }
      const format = payload.response_format as { type?: string; json_schema?: unknown } | undefined;
      if (format?.type !== 'json_schema' || !format.json_schema) reply(response, 400, { error: { message: 'response_format.json_schema required' } });
      else if (payload.fakeCase === 'invalid-json') reply(response, 200, { choices: [{ message: { role: 'assistant', content: '{invalid' } }] });
      else if (payload.fakeCase === 'schema-mismatch') reply(response, 200, { choices: [{ message: { role: 'assistant', content: '{}' } }] });
      else reply(response, 200, { choices: [{ message: { role: 'assistant', content: JSON.stringify({ reference: 'SYNTHETIC-1' }) } }] });
    } else if (path === '/v1/embeddings') {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(body) as Record<string, unknown>; } catch { /* rejected below */ }
      if (payload.model === 'embedding-query') reply(response, 400, { error: { message: 'legacy embedding alias unsupported' } });
      else reply(response, 200, { object: 'list', data: [{ object: 'embedding', index: 0, embedding: Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0) }] });
    } else if (path === '/v1/systemone') {
      // P6 fixture-only calibration value; not an upstream response-field contract.
      reply(response, 200, { id: 'fake-decide-1', choice: 'synthetic-option', fixture_probability: 0.875, reason: 'synthetic only' });
    } else {
      reply(response, 404, { error: { message: 'unknown synthetic route' } });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
