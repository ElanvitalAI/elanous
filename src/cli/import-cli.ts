// EN4 — `elanous import`: one read-only plan over the agents you already use. Applying stays with the sub-commands each item names.
import type { Command } from 'commander';
import { homedir } from 'node:os';
import { debug } from '../debug/log.js';
import { formatImportPlan, planImport, type ImportPlan } from '../import/plan.js';
import { applyImport, formatApplied, IMPORT_MODES, undoImport, type ImportMode } from '../import/apply.js';
import { dirname, join } from 'node:path';

export async function buildImportPlan(home = homedir()): Promise<ImportPlan> {
  const { defaultSkillDirs, getUserConfig } = await import('../user-config.js');
  const cfg = getUserConfig();
  const plan = planImport({
    home,
    ...(process.env.CODEX_HOME ? { codexHome: process.env.CODEX_HOME } : {}),
    activeSkillDirs: defaultSkillDirs(cfg),
    mcpServerIds: (cfg.mcp?.servers ?? []).map((server) => server.id),
  });
  for (const item of plan.items) debug.log('import.plan', 'item', { source: item.source, kind: item.kind, status: item.status });
  debug.log('import.plan', 'planned', { sources: plan.sources.filter((s) => s.detected).map((s) => s.id), items: plan.items.length });
  return plan;
}

export function registerImportCommand(program: Command): void {
  program.command('import')
    .description('Show what elanous can bring over from Claude Code, Codex, ~/.agents, OpenClaw and Hermes — a plan first; `--apply` registers skills in place and adds MCP switched off, `--undo` puts everything back')
    .option('--json', 'Print the plan (or the apply result) as JSON')
    .option('--apply', 'Apply the plan: skills in place (ref) or as link/copy · MCP switched off · secrets and hooks only listed')
    .option('--mode <mode>', `How skills come over: ${IMPORT_MODES.join('|')} (default ref — nothing copied)`)
    .option('--pick <ids>', 'Only these item ids (comma-separated, see --json)')
    .option('--undo', 'Undo the last --apply: restore the config bytes and remove links/copies')
    .action(async (opts: { json?: boolean; apply?: boolean; mode?: string; pick?: string; undo?: boolean }) => {
      const { userConfigPath } = await import('../user-config.js');
      const importRoot = join(dirname(userConfigPath()), 'import');
      if (opts.undo) {
        const undone = undoImport(importRoot);
        const { resetSkillIndex } = await import('../skills/index.js');
        resetSkillIndex();
        debug.log('import.apply', 'undone', { found: undone !== null, created: undone?.created.length ?? 0 });
        if (opts.json) console.log(JSON.stringify({ undone: undone !== null }));
        else console.log(undone ? `되돌렸습니다 — 설정을 ${undone.at} 이전으로 돌리고, 만든 것 ${undone.created.length}개를 지웠습니다.` : '되돌릴 가져오기가 없습니다.');
        return;
      }
      const plan = await buildImportPlan();
      if (!opts.apply) { console.log(opts.json ? JSON.stringify(plan, null, 2) : formatImportPlan(plan)); return; }
      if (opts.mode !== undefined && !IMPORT_MODES.includes(opts.mode as ImportMode)) throw new Error(`--mode 는 ${IMPORT_MODES.join('|')} 중 하나다(받은 값: ${opts.mode})`);
      const { getUserConfig, saveUserConfig } = await import('../user-config.js');
      const cfg = getUserConfig();
      const rawMcp = (cfg.raw.mcp && typeof cfg.raw.mcp === 'object' && !Array.isArray(cfg.raw.mcp) ? cfg.raw.mcp : {}) as Record<string, unknown>;
      const manifest = applyImport(plan, { ...(opts.mode ? { mode: opts.mode as ImportMode } : {}), ...(opts.pick ? { pick: opts.pick.split(',').map((id) => id.trim()).filter(Boolean) } : {}) }, {
        home: homedir(), configPath: userConfigPath(), importRoot,
        sources: cfg.skills.sources ?? [],
        rawMcpServers: (Array.isArray(rawMcp.servers) ? rawMcp.servers : []) as Array<Record<string, unknown>>,
        save: (sources, servers) => saveUserConfig({ ...cfg, raw: { ...cfg.raw, mcp: { ...rawMcp, servers } }, skills: { ...cfg.skills, sources } }),
      });
      const { resetSkillIndex } = await import('../skills/index.js');
      resetSkillIndex();
      debug.log('import.apply', 'applied', { mode: manifest.mode, applied: manifest.applied.length, kept: manifest.kept.length, created: manifest.created.length });
      console.log(opts.json ? JSON.stringify({ mode: manifest.mode, applied: manifest.applied, kept: manifest.kept, created: manifest.created.length }, null, 2) : formatApplied(manifest));
    });
}
