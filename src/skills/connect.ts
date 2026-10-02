// EN9 — `elanous connect <claude|codex>`: 쓰던 에이전트의 스킬을 찾아 «복사가 아니라 등록»한다(대표 «기존 플러그인을 그대로 쓸 수 있다»).
// 등록 = `skills.sources[]`(EN5 한 모델)에 kind `connected` 로 원본 경로를 더한다 · 원본은 읽기만 하고 고치지 않는다 · 읽지 못한 스킬은 SK2(`skills repair`)로 안내한다.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { skillSourceId, type SkillSource } from '../user-config.js';

export type ConnectAgent = 'claude' | 'codex';
export const CONNECT_AGENTS: readonly ConnectAgent[] = ['claude', 'codex'];

const AGENT_LABEL: Record<ConnectAgent, string> = { claude: 'Claude Code', codex: 'Codex' };

export function connectSkillRoot(agent: ConnectAgent, home = homedir()): string {
  return agent === 'claude' ? join(home, '.claude', 'skills') : join(home, '.codex', 'skills');
}

/** Folders that hold a SKILL.md (one level, like the skill index). Hidden folders such as `.system` are skipped. */
export function findSkillFolders(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((name) => !name.startsWith('.'))
      .filter((name) => {
        try { return statSync(join(root, name)).isDirectory() && existsSync(join(root, name, 'SKILL.md')); }
        catch { return false; }
      })
      .sort();
  } catch { return []; }
}

export type ConnectPlan =
  | { agent: ConnectAgent; root: string; state: 'missing' }
  | { agent: ConnectAgent; root: string; state: 'empty' }
  | { agent: ConnectAgent; root: string; state: 'already'; skills: string[] }
  | { agent: ConnectAgent; root: string; state: 'new'; skills: string[] };

/** `activeDirs` = the skill directories elanous reads today (defaultSkillDirs). */
export function planConnect(agent: ConnectAgent, activeDirs: readonly string[], home = homedir()): ConnectPlan {
  const root = connectSkillRoot(agent, home);
  if (!existsSync(root)) return { agent, root, state: 'missing' };
  const skills = findSkillFolders(root);
  if (!skills.length) return { agent, root, state: 'empty' };
  return activeDirs.includes(root) ? { agent, root, state: 'already', skills } : { agent, root, state: 'new', skills };
}

function sample(skills: readonly string[]): string {
  const head = skills.slice(0, 5).join(', ');
  return skills.length > 5 ? `${head} 외 ${skills.length - 5}개` : head;
}

/** The first screen — one question, or one line saying why there is nothing to ask. */
export function connectPrompt(plan: ConnectPlan): string {
  const who = AGENT_LABEL[plan.agent];
  switch (plan.state) {
    case 'missing': return `${who} 스킬 폴더가 없습니다(${plan.root}). 가져올 것이 없습니다.`;
    case 'empty': return `${who} 스킬 폴더에 스킬이 없습니다(${plan.root}).`;
    case 'already': return `${who}에서 쓰던 스킬 ${plan.skills.length}개는 이미 연결돼 있습니다 — ${sample(plan.skills)}`;
    case 'new': return `${who}에서 쓰던 스킬 ${plan.skills.length}개를 찾았습니다 — ${sample(plan.skills)}\n복사하지 않고 그 자리(${plan.root})를 그대로 씁니다. 가져올까요? [Y/n] `;
  }
}

/** Returns the new connected-source list (unchanged when the path is already there). */
export function withConnectedSource(sources: readonly SkillSource[] | undefined, path: string, id = skillSourceId(path)): SkillSource[] {
  const list = [...(sources ?? [])];
  if (!list.some((source) => source.path === path)) list.push({ id, path, kind: 'connected', enabled: true });
  return list;
}

export function withoutSources(sources: readonly SkillSource[] | undefined, paths: readonly string[]): SkillSource[] {
  return (sources ?? []).filter((source) => !paths.includes(source.path));
}
