import { debug } from './debug/log.js';
import { getProject, listProjects, type Project } from './project/project-store.js';
import { findSessionByTelegramChat, updateSessionMeta } from './session/index.js';
import type { TgSlashCommand } from './telegram-commands.js';

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
    handler: async (args, ctx) => {
      const session = deps.findSession(ctx.chatId, ctx.threadId, ctx.botId);
      if (!session) {
        debug.log('telegram.project', 'rejected', { projects: [], reason: 'no-session' });
        return '아직 이 채팅에 대화가 없습니다 — 한 마디 보낸 뒤 다시';
      }

      if (args.length === 0) {
        const current = session.projectId ? deps.find(session.projectId) : null;
        const projects = deps.list().sort((a, b) => a.name.localeCompare(b.name)).slice(0, 20);
        debug.log('telegram.project', 'listed', { projects: projects.map(p => ({ id: p.id, name: p.name })) });
        return [
          `지금 대화의 프로젝트: ${current?.name ?? '받은 대화(프로젝트 없음)'}`,
          '',
          '프로젝트 목록:',
          ...projects.map(p => `• ${p.name}`),
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
