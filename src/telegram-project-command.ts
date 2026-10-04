import { debug } from './debug/log.js';
import { getProject, listProjects, type Project } from './project/project-store.js';
import { findSessionByTelegramChat, updateSessionMeta } from './session/index.js';
import { telegramDecisionOwner } from './decisions/telegram-decision-cards.js';
import type { TelegramBot } from './telegram.js';
import type { TgSlashCommand } from './telegram-commands.js';
import type { UserConfig } from './user-config.js';

export interface TelegramProjectCommandDeps {
  list: () => Project[];
  find: (id: string) => Project | null;
  update: typeof updateSessionMeta;
  findSession: typeof findSessionByTelegramChat;
}

export function projectCommand(deps: TelegramProjectCommandDeps = {
  list: listProjects,
  find: getProject,
  update: updateSessionMeta,
  findSession: findSessionByTelegramChat,
}): TgSlashCommand {
  return {
    name: 'project',
    description: '이 대화의 프로젝트 보기·옮기기',
    handler: async (args, ctx, ctxOptions) => {
      const session = deps.findSession(ctx.chatId, ctx.threadId, ctx.botId);
      if (!session) {
        debug.log('telegram.project', 'rejected', { projects: [], reason: 'no-session' });
        return '아직 이 채팅에 대화가 없습니다 — 한 마디 보낸 뒤 다시';
      }

      if (args.length === 0) {
        const current = session.projectId ? deps.find(session.projectId) : null;
        const projects = deps.list().sort((a, b) => a.name.localeCompare(b.name));
        debug.log('telegram.project', 'listed', { projects: projects.slice(0, 20).map(p => ({ id: p.id, name: p.name })) });
        if (ctx.isDm && ctx.chatId === ctx.userId
          && String(ctx.userId) === telegramDecisionOwner(ctxOptions.userConfig) && ctxOptions.sendButtons) {
          const eligible = projects.filter(p => {
            const bytes = Buffer.byteLength(`prj:${p.id}`, 'utf8');
            if (bytes <= 64) return true;
            debug.log('telegram.project', 'button-rejected', { reason: 'callback-data-too-long', projectId: p.id, bytes });
            return false;
          });
          const visible = eligible.slice(0, 7);
          if (current && eligible.some(p => p.id === current.id) && !visible.some(p => p.id === current.id)) {
            visible[visible.length - 1] = current;
          }
          const buttons = visible.map(p => ({ text: `${p.id === current?.id ? '✓ ' : ''}${p.name}`, data: `prj:${p.id}` }));
          buttons.push({ text: `${session.projectId ? '' : '✓ '}받은 대화로`, data: 'prj:-' });
          const rows: Array<Array<{ text: string; data: string }>> = [];
          for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
          try {
            await ctxOptions.sendButtons('프로젝트를 선택하세요', rows);
            return;
          } catch (err) {
            debug.log('telegram.project', 'button-rejected', {
              reason: 'send-failed', error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return [
          `지금 대화의 프로젝트: ${current?.name ?? '받은 대화(프로젝트 없음)'}`,
          '',
          '프로젝트 목록:',
          ...projects.slice(0, 20).map(p => `• ${p.name}`),
          '',
          '옮기려면 /project <이름>',
        ].join('\n');
      }

      const name = args.join(' ').trim();
      if (name === '-') {
        deps.update(session.id, m => { delete m.projectId; });
        debug.log('telegram.project', 'cleared', { projects: [] });
        return '받은 대화로 옮겼습니다';
      }

      const projects = deps.list();
      const normalized = name.toLocaleLowerCase();
      const exact = projects.filter(p => p.name.toLocaleLowerCase() === normalized);
      const matches = exact.length ? exact : projects.filter(p => p.name.toLocaleLowerCase().startsWith(normalized));
      if (matches.length === 0) {
        debug.log('telegram.project', 'rejected', { projects: [], reason: 'not-found' });
        return '그 이름의 프로젝트가 없습니다 — /project 로 목록 보기';
      }
      if (matches.length > 1) {
        debug.log('telegram.project', 'rejected', {
          projects: matches.map(p => ({ id: p.id, name: p.name })), reason: 'ambiguous',
        });
        return `여러 프로젝트가 맞습니다 — 이름을 골라 주세요:\n${matches.map(p => `• ${p.name}`).join('\n')}`;
      }

      const project = matches[0]!;
      deps.update(session.id, m => { m.projectId = project.id; });
      debug.log('telegram.project', 'moved', { projects: [{ id: project.id, name: project.name }] });
      return `이 대화를 ${project.name} 프로젝트로 옮겼습니다`;
    },
  };
}

export function attachTelegramProjectButtons(
  bot: Pick<TelegramBot, 'botId' | 'onCallbackQuery' | 'sendMessage' | 'answerCallbackQuery'>,
  cfg: UserConfig,
  deps: TelegramProjectCommandDeps = {
    list: listProjects,
    find: getProject,
    update: updateSessionMeta,
    findSession: findSessionByTelegramChat,
  },
): () => void {
  const owner = telegramDecisionOwner(cfg);
  return bot.onCallbackQuery(async q => {
    if (!q.data.startsWith('prj:')) return;
    if (!owner || String(q.userId) !== owner) {
      debug.log('telegram.project', 'button-rejected', { reason: 'not-owner', userId: q.userId, chatId: q.chatId });
      await bot.answerCallbackQuery(q.id, { text: '권한이 없습니다' });
      return;
    }
    if (q.chatId === undefined || q.chatId !== q.userId || q.threadId !== undefined) {
      debug.log('telegram.project', 'button-rejected', { reason: 'not-private-chat', userId: q.userId, chatId: q.chatId });
      await bot.answerCallbackQuery(q.id, { text: '개인 대화에서만 고를 수 있습니다' });
      return;
    }
    const chatId = q.chatId;
    const session = deps.findSession(chatId, q.threadId, bot.botId);
    if (!session) {
      debug.log('telegram.project', 'button-rejected', { reason: 'no-session', chatId });
      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(chatId, '아직 이 채팅에 대화가 없습니다 — 한 마디 보낸 뒤 다시');
      return;
    }
    if (q.data === 'prj:-') {
      deps.update(session.id, m => { delete m.projectId; });
      debug.log('telegram.project', 'button-cleared', { chatId, sessionId: session.id });
      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(chatId, '받은 대화로 옮겼습니다');
      return;
    }
    const project = deps.find(q.data.slice(4));
    if (!project) {
      debug.log('telegram.project', 'button-rejected', { reason: 'not-found', chatId, projectId: q.data.slice(4) });
      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(chatId, '그 이름의 프로젝트가 없습니다 — /project 로 목록 보기');
      return;
    }
    deps.update(session.id, m => { m.projectId = project.id; });
    debug.log('telegram.project', 'button-moved', { chatId, sessionId: session.id, projectId: project.id });
    await bot.answerCallbackQuery(q.id);
    await bot.sendMessage(chatId, `지금 프로젝트: ${project.name}`);
  });
}
