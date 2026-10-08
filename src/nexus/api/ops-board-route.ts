import { canonicalSeatId, openMsgStore, type Message, type MsgStore } from '../../msg/msg-store.js';
import { jsonResponse } from './json-response.js';

function ownerNotices(store: Pick<MsgStore, 'list'>): Message[] {
  const notices: Message[] = [];
  let after = 0;
  let batch: Message[];
  do {
    batch = store.list('CEO', after, 1000);
    notices.push(...batch.filter(message => message.from !== 'CEO'));
    if (batch.length) after = batch[batch.length - 1]!.id;
  } while (batch.length === 1000);
  return notices;
}

export const OPS_BOARD_PATH = '/v1/ops-board/notices';

export interface OpsBoardDeps {
  authorize: (request: Request) => boolean;
  openStore?: () => Pick<MsgStore, 'list' | 'post' | 'close'>;
}

/** Owner reads the CEO inbox without acknowledging it; replies are addressed to the original sender. */
export async function handleOpsBoard(req: Request, deps: OpsBoardDeps): Promise<Response> {
  if (!deps.authorize(req)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (req.method !== 'GET' && req.method !== 'POST') return jsonResponse({ error: 'method-not-allowed' }, 405);
  const store = (deps.openStore ?? openMsgStore)();
  try {
    if (req.method === 'GET') {
      const notices = ownerNotices(store);
      return jsonResponse({ notices });
    }
    let body: unknown;
    try { body = await req.json(); } catch { return jsonResponse({ error: 'bad_request' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse({ error: 'bad_request' }, 400);
    const input = body as Record<string, unknown>;
    if (!Number.isSafeInteger(input.noticeId) || (input.noticeId as number) < 1
      || typeof input.body !== 'string' || !input.body.trim() || input.body.length > 3000
      || Object.keys(input).some(key => key !== 'noticeId' && key !== 'body')) return jsonResponse({ error: 'bad_request' }, 400);
    const notice: Message | undefined = ownerNotices(store).find(message => message.id === input.noticeId);
    if (!notice) return jsonResponse({ error: 'not-found' }, 404);
    const recipient = canonicalSeatId(notice.from);
    const reply = store.post({ from: 'CEO', to: recipient, body: input.body.trim(), kind: 'reply' });
    return jsonResponse({ reply }, 201);
  } finally {
    store.close();
  }
}
