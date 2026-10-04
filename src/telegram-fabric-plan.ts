import { defaultBaseUrl, defaultToken } from './telegram-dispatch-forward.js';
import type { FabricPlan } from './self-dev/fabric-plan-core.js';
import type { TelegramBot, TgIncoming } from './telegram.js';

export interface TelegramFabricPlanDeps {
  fetchImpl?: typeof fetch;
  baseUrl?: () => string | null;
  token?: () => string | null;
}

/** Only a successful daemon draft is offered for approval; no execution endpoint is called here. */
export function attachTelegramFabricPlan(
  bot: Pick<TelegramBot, 'isOwnerAllowed' | 'sendMessage' | 'sendInlineKeyboard' | 'onCallbackQuery' | 'answerCallbackQuery'>,
  deps: TelegramFabricPlanDeps = {},
): (ctx: TgIncoming) => Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const pending = new Map<string, { chatId: number; userId: number; threadId?: number; messageId: number }>();
  const endpoint = (path: string): { url: string; token: string | null } => {
    const base = (deps.baseUrl ?? defaultBaseUrl)();
    if (!base) throw new Error('데몬에 연결할 수 없습니다');
    return { url: `${base}${path}`, token: (deps.token ?? defaultToken)() };
  };
  const post = async (path: string, body?: unknown): Promise<unknown> => {
    const { url, token } = endpoint(path);
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`데몬 응답 ${response.status}`);
    return response.json();
  };

  bot.onCallbackQuery(async (q) => {
    const match = /^fabric:(approve|edit):([a-f0-9-]{36})$/i.exec(q.data);
    if (!match) return;
    const planId = match[2]!;
    const original = pending.get(planId);
    if (!original || !bot.isOwnerAllowed(q.userId) || q.userId !== original.userId
      || q.chatId !== original.chatId || q.threadId !== original.threadId || q.messageId !== original.messageId) {
      await bot.answerCallbackQuery(q.id, { text: '이 초안의 요청자만 선택할 수 있습니다' });
      return;
    }
    if (match[1] === 'edit') {
      pending.delete(planId);
      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(original.chatId, '고칠 내용을 반영해 «아크: <복합 문장>»으로 다시 보내세요. 이 초안은 승인되지 않았습니다.', { threadId: original.threadId });
      return;
    }
    try {
      await post(`/v1/fabric/plans/${planId}/approve`);
      pending.delete(planId);
      await bot.answerCallbackQuery(q.id, { text: '승인되었습니다' });
      await bot.sendMessage(original.chatId, `아크 초안 ${planId} 승인됨 — 실행은 별도 단계입니다.`, { threadId: original.threadId });
    } catch (error) {
      await bot.answerCallbackQuery(q.id, { text: `승인 실패: ${error instanceof Error ? error.message : String(error)}` });
    }
  });

  return async (ctx) => {
    if (ctx.attachments.length || ctx.video || !ctx.text.startsWith('아크:')) return false;
    const request = ctx.text.slice('아크:'.length).trim();
    if (!request || request.includes('\n')) {
      await bot.sendMessage(ctx.chatId, '«아크: <복합 문장>» 한 줄로 보내세요.', { replyTo: ctx.messageId, threadId: ctx.threadId });
      return true;
    }
    try {
      const body = await post('/v1/fabric/decompose', { request }) as { plan?: FabricPlan };
      const plan = body.plan;
      if (!plan || plan.status !== 'draft' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(plan.id)
        || !Array.isArray(plan.nodes) || plan.nodes.length === 0) throw new Error('초안 형식 오류');
      const steps = plan.nodes.map((node, i) => `${i + 1}. ${node.title}`).join('\n');
      const preview = `아크 초안 · 실행 전 검토\n${steps}`;
      const reply = { replyTo: ctx.messageId, threadId: ctx.threadId };
      for (let offset = 0; offset + 4000 < preview.length; offset += 4000) {
        const sent = await bot.sendMessage(ctx.chatId, preview.slice(offset, offset + 4000), reply);
        if (sent?.messageId === undefined) throw new Error('단계 미리보기를 전부 전달하지 못했습니다 — 승인 불가');
      }
      const finalOffset = Math.floor((preview.length - 1) / 4000) * 4000;
      const sent = await bot.sendInlineKeyboard(ctx.chatId, preview.slice(finalOffset), [[
        { text: '승인', data: `fabric:approve:${plan.id}` },
        { text: '고치기', data: `fabric:edit:${plan.id}` },
      ]], reply);
      if (sent?.messageId !== undefined) pending.set(plan.id, { chatId: ctx.chatId, userId: ctx.userId, threadId: ctx.threadId, messageId: sent.messageId });
    } catch (error) {
      await bot.sendMessage(ctx.chatId, `아크 초안 생성 실패: ${error instanceof Error ? error.message : String(error)}`, { replyTo: ctx.messageId, threadId: ctx.threadId });
    }
    return true;
  };
}
