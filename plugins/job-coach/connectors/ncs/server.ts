import { createInterface } from 'node:readline';

// Public Data Portal: 한국산업인력공단_NCS 기준정보 조회, data.go.kr/data/15128213/openapi.do.
const BASE = 'https://apis.data.go.kr/B490007/hrdkapi/';
type Fetch = typeof fetch;
type Arguments = Record<string, unknown>;
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string' };
export const tools = [
  { name: 'ncs_search_units', description: 'Search NCS competency units by keyword (NCS007).', inputSchema: schema({ keyword: text }, ['keyword']) },
  { name: 'ncs_unit', description: 'Look up a competency unit by its NCS_COMPE_UNIT_CD (NCS005).', inputSchema: schema({ code: text }, ['code']) },
  { name: 'ncs_classification', description: 'List NCS classifications at major, middle, minor or detailed level (NCS001–004). Parent codes are required below major.', inputSchema: schema({ level: { type: 'string', enum: ['major', 'middle', 'minor', 'detailed'] }, code: text }, ['level']) },
];

function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

export async function callNcsTool(name: string, args: Arguments, options: { key?: string; fetch?: Fetch } = {}): Promise<unknown> {
  const key = options.key ?? process.env.NCS_SERVICE_KEY;
  if (!key?.trim()) throw new Error('NCS_SERVICE_KEY 키 없음 — 공공데이터포털 serviceKey를 설정하세요');
  const params = new URLSearchParams({ serviceKey: key, pageNo: '1', numOfRows: '20' });
  let operation: string;
  if (name === 'ncs_search_units') {
    operation = 'NCS007';
    params.set('LVL', '5');
    params.set('SWRD', required(args.keyword, 'keyword'));
    params.set('SNUM', '1');
    params.set('ENUM', '20');
  } else if (name === 'ncs_unit') {
    operation = 'NCS005';
    const code = required(args.code, 'code');
    if (!/^\d{8,}$/.test(code)) throw new Error('code must contain the complete numeric NCS competency unit code');
    for (const [field, start, end] of [['NCS_LCLAS_CD', 0, 2], ['NCS_MCLAS_CD', 2, 4], ['NCS_SCLAS_CD', 4, 6], ['NCS_SUBD_CD', 6, 8]] as const) params.set(field, code.slice(start, end));
    params.set('NCS_CL_CD', code.slice(0, 8));
    params.set('NCS_COMPE_UNIT_CD', code);
  } else if (name === 'ncs_classification') {
    const levels = { major: 1, middle: 2, minor: 3, detailed: 4 } as const;
    if (typeof args.level !== 'string' || !Object.hasOwn(levels, args.level)) throw new Error('level must be major, middle, minor or detailed');
    const level = levels[args.level as keyof typeof levels];
    operation = `NCS00${level}`;
    if (level > 1) {
      const code = required(args.code, 'parent code');
      if (!/^\d+$/.test(code) || code.length < (level - 1) * 2) throw new Error('parent code must contain the numeric NCS ancestor codes');
      ['NCS_LCLAS_CD', 'NCS_MCLAS_CD', 'NCS_SCLAS_CD'].slice(0, level - 1).forEach((field, index) => params.set(field, code.slice(index * 2, index * 2 + 2)));
    }
  } else throw new Error(`Unknown NCS tool: ${name}`);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${BASE}${operation}?${params}`, { signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error('NCS API connection failed (serviceKey redacted)');
  }
  if (!response.ok) throw new Error(`NCS API HTTP ${response.status}`);
  const data: unknown = await response.json();
  const envelope = data as { response?: { header?: { resultCode?: string; resultMsg?: string }; body?: unknown }; header?: { resultCode?: string; resultMsg?: string }; body?: unknown };
  const result = envelope.response ?? envelope;
  if (result.header?.resultCode && !['00', '0', '200'].includes(result.header.resultCode)) throw new Error(`NCS API rejected request (${result.header.resultCode})`);
  if (!result.body) throw new Error('NCS API response has no body');
  return { source: `https://www.data.go.kr/data/15128213/openapi.do#${operation}`, body: result.body };
}

export async function handleRequest(req: { jsonrpc?: string; id?: number | string; method?: string; params?: { name?: string; arguments?: Arguments; protocolVersion?: string } }, options: { key?: string; fetch?: Fetch } = {}) {
  const id = req.id ?? null;
  if (req.method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: req.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'job-coach-ncs', version: '0.1.0' } } };
  if (req.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools } };
  if (req.method === 'tools/call') {
    try {
      const result = await callNcsTool(req.params?.name ?? '', req.params?.arguments ?? {}, options);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
    } catch (error) {
      return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'NCS request failed' }] } };
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
}

if (import.meta.main) {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    try {
      const request = JSON.parse(line);
      if (request.id === undefined) continue;
      process.stdout.write(JSON.stringify(await handleRequest(request)) + '\n');
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
    }
  }
}
