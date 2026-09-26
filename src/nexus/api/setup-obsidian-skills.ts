import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { SKILL_PRESETS } from '../../onboarding.js';
import { debug } from '../../debug/log.js';
import { resolveObsidianRoot } from '../../acp/fs-roots.js';
import { getUserConfig, saveUserConfig, type SkillSetName } from '../../user-config.js';

export interface ObsidianSkillsState {
  obsidian: { vault: string; exists: boolean; looksLikeVault: boolean };
  skills: {
    activeSet: SkillSetName;
    dirs: string[];
    presets: Array<{ key: SkillSetName; label: string; dir: string | null; exists: boolean }>;
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  } });
}

function directoryExists(dir: string): boolean {
  try { return statSync(dir).isDirectory(); } catch { return false; }
}

function pathError(dir: unknown): string | null {
  if (typeof dir !== 'string' || !isAbsolute(dir)) return 'absolute-directory-path-required';
  if (!directoryExists(dir)) return 'directory-does-not-exist';
  return null;
}

async function parseBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await req.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** GET /v1/setup/obsidian-skills */
export function handleObsidianSkillsGet(): Response {
  const cfg = getUserConfig();
  const vault = cfg.obsidian.vault;
  const state: ObsidianSkillsState = {
    obsidian: { vault, exists: directoryExists(vault), looksLikeVault: directoryExists(vault) && directoryExists(join(vault, '.obsidian')) },
    skills: {
      activeSet: cfg.skills.activeSet,
      dirs: cfg.skills.dirs,
      presets: SKILL_PRESETS.map(({ key, label, dir }) => ({ key, label, dir, exists: dir !== null && directoryExists(dir) })),
    },
  };
  return json(state);
}

/** POST /v1/setup/obsidian */
export async function handleObsidianSet(req: Request): Promise<Response> {
  const body = await parseBody(req);
  if (!body) return json({ error: 'invalid-json' }, 400);
  const error = pathError(body.vault);
  if (error) return json({ error, reason: 'vault must be an existing absolute directory' }, 400);
  const vault = body.vault as string;
  const warning = directoryExists(join(vault, '.obsidian')) ? undefined : 'No .obsidian directory found in this vault.';
  const cfg = getUserConfig();
  saveUserConfig({ ...cfg, obsidian: { ...cfg.obsidian, vault } });
  // 볼트 해석은 프로세스에 캐시된다 — 다시 풀지 않으면 도는 데몬이 재시작 전까지 «옛 볼트»에 읽고 쓴다(🅞 2026-09-26 격리 데몬 실측).
  const now = resolveObsidianRoot({ forceRefresh: true });
  debug.log('pwa.settings', 'obsidian-set', { vault, resolvedRoot: now.root, source: now.source });
  return json({ ok: true, obsidian: { vault }, ...(warning ? { warning } : {}) });
}

/** POST /v1/setup/skills — either one preset or explicitly selected directories. */
export async function handleSkillsSet(req: Request): Promise<Response> {
  const body = await parseBody(req);
  if (!body) return json({ error: 'invalid-json' }, 400);
  const preset = typeof body.activeSet === 'string' && !('dirs' in body)
    ? SKILL_PRESETS.find((item) => item.key === body.activeSet)
    : undefined;
  if (!preset && (!Array.isArray(body.dirs) || 'activeSet' in body)) {
    return json({ error: 'invalid-skills-selection', reason: 'choose a known activeSet or a dirs array' }, 400);
  }
  const dirs: string[] = preset ? (preset.dir ? [preset.dir] : []) : body.dirs as string[];
  for (const dir of dirs) {
    const error = pathError(dir);
    if (error) return json({ error, reason: 'each skill path must be an existing absolute directory', path: dir }, 400);
  }
  const cfg = getUserConfig();
  const skills = { ...cfg.skills, activeSet: preset?.key ?? 'custom' as SkillSetName, dirs };
  saveUserConfig({ ...cfg, skills });
  debug.log('pwa.settings', 'skills-set', { dirs });
  return json({ ok: true, skills: { activeSet: skills.activeSet, dirs: skills.dirs } });
}
