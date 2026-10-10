// SK2 — `elanous skills repair`: 색인이 못 읽은 스킬을 보여 주고, 확인([y/N])한 것만 그 자리에서 고친다.
import type { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { getSkillIndex, resetSkillIndex, skillIndexProblems } from '../skills/index.js';
import { applySkillRepair, planSkillRepair, skillRepairNotice } from '../skills/repair.js';
import { CONNECT_AGENTS, connectPrompt, connectSkillRoot, planConnect, withConnectedSource, withoutSources, type ConnectAgent } from '../skills/connect.js';
import { debug } from '../debug/log.js';
import { resolve } from 'node:path';
import { claudePluginPrompt, isClaudePluginDir, mcpEnableHint, planClaudePlugin, readClaudePlugin } from '../skills/connect-claude-plugin.js';

async function ask(question: string, defaultYes = false): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim();
    return answer === '' ? defaultYes : /^(y|yes|예|네)$/i.test(answer);
  }
  finally { rl.close(); }
}

/** EN9 — `elanous connect <claude|codex>`: find the skills that agent already uses and register their folder (no copy). */
export function registerConnectCommand(program: Command): void {
  program.command('connect <agent>')
    .description(`Use the skills you already have in another agent (${CONNECT_AGENTS.join(' | ')}) or a Claude Code plugin folder — registers in place, never copies; plugin MCP servers are added switched off`)
    .option('--yes', 'Register without asking')
    .option('--json', 'Print the plan as JSON and change nothing')
    .option('--undo', 'Stop using that folder (the files stay where they are)')
    .action(async (agentArg: string, opts: { yes?: boolean; json?: boolean; undo?: boolean }) => {
      const agent = agentArg.toLowerCase() as ConnectAgent;
      if (!CONNECT_AGENTS.includes(agent) && isClaudePluginDir(resolve(agentArg))) {
        await connectClaudePlugin(resolve(agentArg), opts);
        return;
      }
      if (!CONNECT_AGENTS.includes(agent)) {
        console.error(`지원하는 에이전트: ${CONNECT_AGENTS.join(', ')} · 또는 Claude 플러그인 폴더(.claude-plugin/plugin.json) (받은 값: ${agentArg})`);
        process.exitCode = 2;
        return;
      }
      const { defaultSkillDirs, getUserConfig, saveUserConfig } = await import('../user-config.js');
      const cfg = getUserConfig();
      if (opts.undo) {
        const root = connectSkillRoot(agent);
        const sources = withoutSources(cfg.skills.sources, [root]);
        if (sources.length === (cfg.skills.sources ?? []).length) { console.log(`연결된 적이 없습니다(${root}).`); return; }
        saveUserConfig({ ...cfg, skills: { ...cfg.skills, sources } });
        resetSkillIndex();
        debug.log('skills.connect', 'undone', { agent });
        console.log(`연결을 끊었습니다. 파일은 그대로 있습니다(${root}).`);
        return;
      }
      const plan = planConnect(agent, defaultSkillDirs(cfg));
      debug.log('skills.connect', 'plan', { agent, state: plan.state, count: 'skills' in plan ? plan.skills.length : 0 });
      if (opts.json) { console.log(JSON.stringify(plan, null, 2)); return; }
      const prompt = connectPrompt(plan);
      if (plan.state !== 'new') { console.log(prompt); return; }
      if (!opts.yes) {
        if (!process.stdin.isTTY) { console.log(`${prompt.split('\n')[0]}\n가져오려면: elanous connect ${agent} --yes`); return; }
        if (!(await ask(prompt, true))) { console.log('가져오지 않았습니다. 나중에: elanous connect ' + agent); return; }
      } else {
        console.log(prompt.split('\n')[0]);
      }
      const next = { ...cfg, skills: { ...cfg.skills, sources: withConnectedSource(cfg.skills.sources, plan.root, agent) } };
      saveUserConfig(next);
      resetSkillIndex();
      const index = getSkillIndex(defaultSkillDirs(next));
      const problems = skillIndexProblems().filter((p) => p.dir === plan.root);
      const usable = plan.skills.length - problems.length;
      debug.log('skills.connect', 'registered', { agent, found: plan.skills.length, problems: problems.length, indexed: index.length });
      console.log(`연결했습니다 — ${usable}개를 바로 쓸 수 있습니다. 끊으려면: elanous connect ${agent} --undo`);
      const notice = skillRepairNotice(problems);
      if (notice) console.log(notice);
    });
}

export function registerSkillsCommands(program: Command): void {
  const skills = program.command('skills').description('Check, install and repair skills');
  skills.command('install <pack>')
    .description('Install a gift skill pack from a code or a signed knowledge pack from a configured market')
    .option('--code <code>', 'Gift code')
    .option('--email <address>', 'Email for gift delivery')
    .option('--agree', 'Agree to email collection and retention')
    .option('--endpoint <url>', 'Gift API origin (overrides skills.giftEndpoint)')
    .option('--market <name>', 'Install a signed knowledge pack from a configured market instead of redeeming a gift')
    .option('--enterprise <id>', 'Authorized enterprise for an internal knowledge market')
    .option('--json', 'Print the install result as JSON')
    .action(async (pack: string, opts: { code?: string; email?: string; agree?: boolean; endpoint?: string; market?: string; enterprise?: string; json?: boolean }) => {
      const { getUserConfig } = await import('../user-config.js');
      const { installGiftPack, installMarketKnowledgePack } = await import('../skills/gift-install.js');
      if (opts.market) {
        const result = await installMarketKnowledgePack({ pack, market: opts.market, enterpriseId: opts.enterprise });
        if (opts.json) console.log(JSON.stringify(result));
        else console.log(result.ok ? `설치한 지식 팩: ${result.packId}` : `지식 팩 설치 실패: ${result.reason}`);
        if (!result.ok) process.exitCode = 1;
        return;
      }
      const result = await installGiftPack({ pack, code: opts.code, email: opts.email, agree: opts.agree,
        endpoint: opts.endpoint ?? getUserConfig().skills.giftEndpoint });
      if (opts.json) console.log(JSON.stringify(result));
      else console.log(result.message);
      if (!result.ok) process.exitCode = 1;
    });
  skills.command('sources')
    .description('List every skill folder elanous reads, in order (preset · shared · connected · package)')
    .option('--json', 'JSON output')
    .action(async (opts: { json?: boolean }) => {
      const { resolveSkillSources } = await import('../user-config.js');
      const { existsSync } = await import('node:fs');
      const sources = resolveSkillSources().map((source) => ({ ...source, exists: existsSync(source.path) }));
      debug.log('skills.sources', 'listed', { count: sources.length, kinds: sources.map((source) => source.kind) });
      if (opts.json) { console.log(JSON.stringify(sources, null, 2)); return; }
      const width = Math.max(10, ...sources.map((source) => source.id.length));
      for (const source of sources) {
        console.log(`${source.enabled ? '●' : '○'} ${source.id.padEnd(width)}  ${source.kind.padEnd(9)} ${source.path}${source.exists ? '' : '  (없음)'}`);
      }
      console.log('묶음 스킬(패키지 skills/)은 늘 마지막에 읽습니다. 다른 에이전트 스킬 더하기: elanous connect claude|codex|<플러그인 폴더>');
    });
  skills.command('repair')
    .description('List skills that could not be read and repair the ones that can be fixed (asks first)')
    .option('--yes', 'Repair every fixable skill without asking')
    .action(async (opts: { yes?: boolean }) => {
      getSkillIndex();
      const problems = skillIndexProblems();
      if (!problems.length) { console.log('모든 스킬을 읽었습니다. 고칠 것이 없습니다.'); return; }
      console.log(`스킬 ${problems.length}개를 읽지 못했습니다.`);
      // ER1 — operations hears about it too (consented · scrubbed).
      try {
        const { reportError } = await import('../error-report/report.js');
        for (const p of problems.slice(0, 3)) await reportError({ code: 'skill-index', message: `${p.name}: ${p.code ?? ''} ${p.error}`.trim(), surface: 'cli' });
      } catch { /* reporting is advisory */ }
      let fixed = 0;
      for (const problem of problems) {
        const plan = planSkillRepair(problem);
        console.log(`\n· ${problem.name} — ${problem.error.split('\n')[0]}`);
        if (plan.kind === 'permission' || plan.kind === 'manual') { console.log(`  ${plan.hint}`); continue; }
        const what = plan.kind === 'fixable-permission' ? '읽기 권한을 켭니다' : `${plan.keys.join(', ')} 를 한 줄로 고칩니다(원본은 .bak 으로 남김)`;
        if (!opts.yes && !(await ask(`  ${what}. 고칠까요? [y/N] `))) { console.log('  건너뜀'); continue; }
        const result = applySkillRepair(plan);
        if (result.ok) { fixed += 1; console.log(`  고쳤습니다 — ${result.path}`); }
        else console.log(`  고치지 못했습니다(${result.reason}) — 원래대로 되돌렸습니다.`);
      }
      console.log(`\n${fixed}개를 고쳤습니다.`);
      if (fixed < problems.length) process.exitCode = 1;
    });
}

/** EN8 — a Claude Code plugin folder: skills join `skills.sources[]` (kind connected) in place, `.mcp.json` servers join `mcp.servers[]` switched off. */
async function connectClaudePlugin(dir: string, opts: { yes?: boolean; json?: boolean; undo?: boolean }): Promise<void> {
  const { defaultSkillDirs, getUserConfig, saveUserConfig } = await import('../user-config.js');
  const cfg = getUserConfig();
  let plugin;
  try { plugin = readClaudePlugin(dir); }
  catch (error) {
    console.error(`플러그인 정보를 읽지 못했습니다(.claude-plugin/plugin.json): ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  const rawMcp = (cfg.raw.mcp && typeof cfg.raw.mcp === 'object' && !Array.isArray(cfg.raw.mcp) ? cfg.raw.mcp : {}) as Record<string, unknown>;
  const rawServers = (Array.isArray(rawMcp.servers) ? rawMcp.servers : []) as Array<Record<string, unknown>>;
  const writeServers = (servers: Array<Record<string, unknown>>) => ({ ...cfg.raw, mcp: { ...rawMcp, servers } });
  if (opts.undo) {
    const ids = new Set(plugin.mcp.map((server) => server.id));
    const sources = withoutSources(cfg.skills.sources, plugin.skillRoots);
    const servers = rawServers.filter((row) => !ids.has(row.id as string));
    if (sources.length === (cfg.skills.sources ?? []).length && servers.length === rawServers.length) { console.log(`연결된 적이 없습니다(${plugin.name}).`); return; }
    saveUserConfig({ ...cfg, raw: writeServers(servers), skills: { ...cfg.skills, sources } });
    resetSkillIndex();
    debug.log('skills.connect', 'undone', { plugin: plugin.name });
    console.log(`«${plugin.name}» 연결을 끊었습니다. 파일은 그대로 있습니다(${plugin.root}).`);
    return;
  }
  const plan = planClaudePlugin(plugin, defaultSkillDirs(cfg), rawServers.map((row) => row.id as string));
  debug.log('skills.connect', 'plan', { plugin: plugin.name, state: plan.state, skills: plugin.skills.length, mcp: plugin.mcp.length, skipped: plugin.skipped.length });
  if (opts.json) { console.log(JSON.stringify(plan, null, 2)); return; }
  const prompt = claudePluginPrompt(plan);
  if (plan.state !== 'new') { console.log(prompt); return; }
  const firstLines = prompt.slice(0, prompt.lastIndexOf('\n'));
  if (!opts.yes) {
    if (!process.stdin.isTTY) { console.log(`${firstLines}\n가져오려면: elanous connect ${plugin.root} --yes`); return; }
    if (!(await ask(prompt, true))) { console.log(`가져오지 않았습니다. 나중에: elanous connect ${plugin.root}`); return; }
  } else {
    console.log(firstLines);
  }
  const sources = plan.newSkillRoots.reduce((list, root, i) => withConnectedSource(list, root, `plugin:${plugin.name}${i ? `:${i + 1}` : ''}`), cfg.skills.sources ?? []);
  const servers = [...rawServers, ...plan.newMcp];
  saveUserConfig({ ...cfg, raw: writeServers(servers), skills: { ...cfg.skills, sources } });
  resetSkillIndex();
  const next = { ...cfg, skills: { ...cfg.skills, sources } };
  getSkillIndex(defaultSkillDirs(next));
  const problems = skillIndexProblems().filter((p) => plugin.skillRoots.includes(p.dir));
  debug.log('skills.connect', 'registered', { plugin: plugin.name, skills: plugin.skills.length, problems: problems.length, mcp: plan.newMcp.length });
  console.log(`연결했습니다 — 스킬 ${plugin.skills.length - problems.length}개를 바로 쓸 수 있습니다. 끊으려면: elanous connect ${plugin.root} --undo`);
  const notice = skillRepairNotice(problems);
  if (notice) console.log(notice);
  if (plan.newMcp.length) {
    console.log(`MCP 서버 ${plan.newMcp.length}개를 꺼진 채로 등록했습니다. 믿을 수 있는 것만 켜 주세요(켠 뒤 데몬 재시작):`);
    for (const line of mcpEnableHint(plan.newMcp, servers)) console.log(line);
  }
}
