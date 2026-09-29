import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentMission, codexBackend } from './driver.js';
import { installPluginInsideAgent, parsePluginRef, type PluginDeps } from './in-agent-plugin.js';
import { runAgentMissionCliCommand } from './mission-cli.js';
import { planDevPipeline, toAgentMissionSpec, type DevPipelineSpec, type ResolvedDevPlan } from '../self-dev/dev-pipeline.js';
import type { PtyHandle } from '../pty-shell/registry.js';

const req = { agent: 'codex' as const, plugin: 'job-coach', marketplace: 'elanous-test' };
const ready = 'Codex\n› Ask a question';
function fixture(frames: string[]) {
  const keys: string[] = [];
  let index = 0;
  const pty = {
    renderScreen: async () => frames[Math.min(index, frames.length - 1)]!,
    write: (key: string) => { keys.push(key); index++; },
    isAlive: () => true,
  } as Pick<PtyHandle, 'renderScreen' | 'write' | 'isAlive'>;
  const events: string[] = [];
  const deps: PluginDeps = {
    sleep: async () => { if (keys.at(-1) === '\r' && index === 4) index++; },
    brain: async () => 'unknown',
    decide: (event) => { events.push(event.kind); },
    log: () => {},
  };
  return { pty, keys, events, deps };
}

describe('agent UI plugin installation', () => {
  // 🩸 09-29 실물(🅣 v4 녹화): a late «Trust this folder?» menu in front of the prompt is answered, then install proceeds.
  test('late folder-trust menu is answered by the backend handler before the plugin menu', async () => {
    const trust = ['Folder access', '/tmp/wt', 'Trust this folder? Codex can read, edit, and run files here.', '› 1. Trust and continue', '  2. Quit', 'enter continue · esc quit'].join('\n');
    const f = fixture([trust, ready, 'Browse plugins\n> job-coach@elanous-test', 'Installing job-coach@elanous-test ...', 'job-coach@elanous-test ✓ Installed', ready]);
    f.deps.handleTrust = (screen, write) => { if (/Trust this folder\?/.test(screen)) { write('1\r'); return true; } return false; };
    const result = await installPluginInsideAgent(req, f.pty, f.deps);
    expect(f.keys[0]).toBe('1\r');
    expect(f.keys[1]).toBe('/plugins\r');
    expect(result).not.toEqual({ outcome: 'escalate', reason: 'unknown-menu' });
  });
  // 🩸 09-29 실물(codex 0.157 · tmux 캡처): tabbed menu with a search box → type name → details header «name · status · market».
  const sreq = { agent: 'codex' as const, plugin: 'pdfsift', marketplace: 'sift-demo' };
  const home = ['>_ OpenAI Codex (v0.157.0)', '› Ask Codex to do anything', '~/wt · main · Context 100% left · GPT-6-Sol medium', '? for shortcuts ⚠ 3 warnings · f2 to view'].join('\n');
  const menu = ['Plugins', 'Browse plugins from available marketplaces.', 'Installed 18 of 5251 available plugins.', ' All Plugins   Installed (18)   OpenAI Curated   Workspace   anthropic-agent-skills  ›', 'Type to search plugins', '› [*] Asana    Installed   Space to disable; Enter …', '←/→ tabs · enter details · space toggle · esc close'].join('\n');
  const filtered = (status: string) => ['Plugins', ' All Plugins   Installed (18)', 'pdfsift', `› [-] pdfsift      ${status}   Press Enter to install or view plugin details`, '←/→ tabs · enter details · space toggle · esc close'].join('\n');
  const details = (status: string, market: string, sel: 1 | 2) => ['Plugins', `pdfsift · ${status} · ${market}`, 'Make a folder of PDFs searchable.', `${sel === 1 ? '›' : ' '} 1. Back to plugins  Return to the plugin list`, `${sel === 2 ? '›' : ' '} 2. ${status === 'Installed' ? 'Uninstall' : 'Install'} plugin   Install this plugin now`, '   Source  Local', 'esc close'].join('\n');
  const done = ['• Installed pdfsift plugin. No additional app authentication is required.', 'Plugins', 'Type to search plugins', '› [*] Asana  Installed'].join('\n');
  function seq(frames: string[]) {
    const keys: string[] = [];
    let i = 0;
    const pty = { renderScreen: async () => frames[Math.min(i, frames.length - 1)]!, write: (k: string) => { keys.push(k); i++; }, isAlive: () => true } as Pick<PtyHandle, 'renderScreen' | 'write' | 'isAlive'>;
    const events: string[] = [];
    const deps: PluginDeps = { sleep: async () => {}, brain: async () => 'unknown', decide: (e) => { events.push(e.kind); }, log: () => {} };
    return { pty, keys, events, deps };
  }
  test('codex 0.157 search path: /plugins → name → details(market ok) → Install → «Installed … plugin» → Esc', async () => {
    const f = seq([home, menu, filtered('Available'), details('Can be installed', 'sift-demo', 1), details('Can be installed', 'sift-demo', 2), done, home]);
    expect(await installPluginInsideAgent(sreq, f.pty, f.deps)).toEqual({ outcome: 'installed' });
    expect(f.keys).toEqual(['/plugins\r', 'pdfsift', '\r', '\x1b[B', '\r', '\x1b']);
    expect(f.events).toContain('VERIFY');
  });
  test('codex 0.157 search path: already installed → no install key, close to prompt', async () => {
    const f = seq([home, menu, filtered('Installed'), details('Installed', 'sift-demo', 1), home]);
    expect(await installPluginInsideAgent(sreq, f.pty, f.deps)).toEqual({ outcome: 'installed' });
    expect(f.keys).toEqual(['/plugins\r', 'pdfsift', '\r', '\x1b']);
  });
  test('codex 0.157 search path: same name from another marketplace is never installed', async () => {
    const f = seq([home, menu, filtered('Available'), details('Can be installed', 'other-market', 1), filtered('Available')]);
    expect(await installPluginInsideAgent(sreq, f.pty, f.deps)).toEqual({ outcome: 'escalate', reason: 'wrong-target' });
    expect(f.keys).not.toContain('\x1b[B');
  });
  // 🩸 09-29 실물(🅣 3/3): right after typing, the input box still shows «› /plugins» and the menu is not open yet.
  test('codex: /plugins still in the input box → one more Enter, then the menu opens and install proceeds', async () => {
    const typed = ['>_ OpenAI Codex (v0.157.0)', '› /plugins', '~/wt · demo · Context 100% left ·…', '? for shortcuts ⚠ 3 warnings · f2 to view'].join('\n');
    const f = fixture([
      ready,
      typed,
      'Browse plugins\n> job-coach@elanous-test',
      'Installing job-coach@elanous-test ...',
      'job-coach@elanous-test ✓ Installed',
      ready,
    ]);
    f.deps.brain = async () => 'enter';
    const result = await installPluginInsideAgent(req, f.pty, f.deps);
    expect(f.keys.slice(0, 2)).toEqual(['/plugins\r', '\r']);
    expect(result).not.toEqual({ outcome: 'escalate', reason: 'unknown-menu' });
  });
  test('codex: a menu that never opens still escalates after the grace frames', async () => {
    const f = fixture([ready, 'Codex\n› /plugins']);
    expect(await installPluginInsideAgent(req, f.pty, f.deps)).toEqual({ outcome: 'escalate', reason: 'unknown-menu' });
    expect(f.keys).toEqual(['/plugins\r', '\r']);
  });
  // 🩸 09-29 실물(codex 0.157 · T 티저 녹화 2/2 unknown-menu): the placeholder rotates and two footer lines follow it.
  const realHome = [
    '>_ OpenAI Codex (v0.157.0)',
    'model: GPT-6-Sol medium /model to change',
    'directory: ~/…/work.worktrees/demo-pdfsift-rec1',
    'permissions: YOLO mode',
    'Tip: Use /permissions to control when Codex asks for confirmation.',
    '› Ask Codex to do anything',
    '~/.elanous/worktrees/v3-79a461f7/work.worktrees/demo-pdfsift-rec1 · demo/pdfsift-rec1 · Context 100% left ·…',
    '? for shortcuts ⚠ 3 warnings · f2 to view',
  ].join('\n');
  for (const [name, home] of [['real codex 0.157 home with footer', realHome], ['another rotating placeholder', realHome.replace('Ask Codex to do anything', 'Explain this codebase')]] as const) {
    test(`${name}: /plugins is typed instead of escalating unknown-menu`, async () => {
      const f = fixture([
        home,
        'Browse plugins\n> job-coach@elanous-test',
        'Installing job-coach@elanous-test ...',
        'job-coach@elanous-test ✓ Installed',
        home,
      ]);
      f.deps.sleep = async () => { if (f.keys.at(-1) === '\r' && f.keys.length === 2) { /* installing frame */ } };
      const result = await installPluginInsideAgent(req, f.pty, f.deps);
      expect(f.keys[0]).toBe('/plugins\r');
      expect(result).not.toEqual({ outcome: 'escalate', reason: 'unknown-menu' });
    });
  }
  test('codex selected third row: slash → down twice → Enter → loading → installed → Esc', async () => {
    const f = fixture([
      ready,
      'Browse plugins\n> helper@elanous-test\n  build@elanous-test\n  job-coach@elanous-test',
      'Browse plugins\n  helper@elanous-test\n> build@elanous-test\n  job-coach@elanous-test',
      'Browse plugins\n  helper@elanous-test\n  build@elanous-test\n> job-coach@elanous-test',
      'Installing job-coach@elanous-test ...',
      'job-coach@elanous-test ✓ Installed',
      ready,
    ]);
    expect(await installPluginInsideAgent(req, f.pty, f.deps)).toEqual({ outcome: 'installed' });
    expect(f.keys).toEqual(['/plugins\r', '\x1b[B', '\x1b[B', '\r', '\x1b']);
    expect(f.events).toContain('VERIFY');
  });

  test('a stale Ask a question above the menu never becomes the selected plugin row', async () => {
    const f = fixture([
      ready,
      'Codex\n› Ask a question\nBrowse plugins\n> helper@elanous-test\n  build@elanous-test\n  job-coach@elanous-test',
      'Codex\n› Ask a question\nBrowse plugins\n  helper@elanous-test\n> build@elanous-test\n  job-coach@elanous-test',
      'Codex\n› Ask a question\nBrowse plugins\n  helper@elanous-test\n  build@elanous-test\n> job-coach@elanous-test',
      'Installing job-coach@elanous-test ...',
      'job-coach@elanous-test ✓ Installed',
      ready,
    ]);
    expect(await installPluginInsideAgent(req, f.pty, f.deps)).toEqual({ outcome: 'installed' });
    expect(f.keys).toEqual(['/plugins\r', '\x1b[B', '\x1b[B', '\r', '\x1b']);
  });

  test('an installed menu still open after Esc is not a conversation prompt', async () => {
    const f = fixture([
      ready,
      'Browse plugins\n> helper@elanous-test\n  build@elanous-test\n  job-coach@elanous-test',
      'Browse plugins\n  helper@elanous-test\n> build@elanous-test\n  job-coach@elanous-test',
      'Browse plugins\n  helper@elanous-test\n  build@elanous-test\n> job-coach@elanous-test',
      'Installing job-coach@elanous-test ...',
      'Plugins\n> job-coach@elanous-test ✓ Installed',
      'Plugins\n> job-coach@elanous-test ✓ Installed',
    ]);
    expect(await installPluginInsideAgent(req, f.pty, f.deps)).toEqual({ outcome: 'escalate', reason: 'unknown-menu' });
    expect(f.keys).toEqual(['/plugins\r', '\x1b[B', '\x1b[B', '\r', '\x1b']);
    expect(f.events).toContain('ESCALATE');
  });

  test('marketplace tabs switch before selecting matching plugin', async () => {
    const f = fixture([
      ready,
      'Browse plugins\nMarketplaces: [default]  elanous-test\n> helper',
      'Browse plugins\nMarketplaces: default  [elanous-test]\n> job-coach',
      'job-coach@elanous-test ✓ Installed', ready,
    ]);
    expect(await installPluginInsideAgent(req, f.pty, f.deps)).toEqual({ outcome: 'installed' });
    expect(f.keys).toEqual(['/plugins\r', '\t', '\r', '\x1b']);
  });

  test('disabled screen escalates without pressing menu keys or credentials', async () => {
    const f = fixture([ready, 'Plugins are disabled. Enable the plugins feature to use /plugins.']);
    expect(await installPluginInsideAgent(req, f.pty, f.deps)).toEqual({ outcome: 'escalate', reason: 'plugins-disabled' });
    expect(f.keys).toEqual(['/plugins\r']);
    expect(f.events).toContain('ESCALATE');
  });

  test('unknown menu escalates with bounded screen tail', async () => {
    const f = fixture([ready, 'A different panel\nwhat next?']);
    const logs: unknown[] = [];
    f.deps.log = (event, data) => { if (event === 'escalated') logs.push(data); };
    expect(await installPluginInsideAgent(req, f.pty, f.deps)).toEqual({ outcome: 'escalate', reason: 'unknown-menu' });
    expect(logs).toEqual([{ reason: 'unknown-menu', tail: ['A different panel', 'what next?'] }]);
  });

  test('never presses Enter on wrong plugin even when brain requests it', async () => {
    const f = fixture([ready, 'Browse plugins\n> other@elanous-test']);
    f.deps.brain = async () => 'enter';
    expect(await installPluginInsideAgent(req, f.pty, f.deps)).toEqual({ outcome: 'escalate', reason: 'wrong-target' });
    expect(f.keys).toEqual(['/plugins\r']);
  });

  test('rechecks a changed confirmation screen: another selected plugin marked Not installed never gets Enter', async () => {
    const keys: string[] = [];
    let reads = 0;
    const pty = {
      renderScreen: async () => {
        reads++;
        if (reads === 1) return ready;
        if (reads === 2 || reads === 3) return 'Browse plugins\n> job-coach@elanous-test';
        if (reads === 4) return 'Browse plugins\n  job-coach@elanous-test\n> Install';
        return 'Browse plugins\n  job-coach@elanous-test\n> other@elanous-test Not installed';
      },
      write: (key: string) => { keys.push(key); },
      isAlive: () => true,
    } as Pick<PtyHandle, 'renderScreen' | 'write' | 'isAlive'>;
    const events: string[] = [];
    expect(await installPluginInsideAgent(req, pty, {
      sleep: async () => {}, brain: async () => 'unknown', log: () => {},
      decide: event => { events.push(event.kind); },
    })).toEqual({ outcome: 'escalate', reason: 'wrong-target' });
    expect(keys).toEqual(['/plugins\r', '\r']);
    expect(events).toContain('ESCALATE');
  });

  test('selected standalone Install button for the sole target confirms then returns to prompt', async () => {
    const keys: string[] = [];
    let loadingRead = false;
    const pty = {
      renderScreen: async () => {
        if (keys.length === 0) return ready;
        if (keys.length === 1) return 'Browse plugins\n> job-coach@elanous-test';
        if (keys.length === 2) return 'Browse plugins\n  job-coach@elanous-test\n> Install';
        if (keys.length === 3 && !loadingRead) { loadingRead = true; return 'Installing job-coach@elanous-test ...'; }
        if (keys.length === 3) return 'job-coach@elanous-test ✓ Installed';
        return ready;
      },
      write: (key: string) => { keys.push(key); },
      isAlive: () => true,
    } as Pick<PtyHandle, 'renderScreen' | 'write' | 'isAlive'>;
    expect(await installPluginInsideAgent(req, pty, { sleep: async () => {}, log: () => {}, decide: () => {} }))
      .toEqual({ outcome: 'installed' });
    expect(keys).toEqual(['/plugins\r', '\r', '\r', '\x1b']);
  });

  test('a selected confirmation button must be a standalone action, not a Not installed status', async () => {
    const f = fixture([ready, 'Browse plugins\n> job-coach@elanous-test',
      'Browse plugins\n  job-coach@elanous-test\n> other@elanous-test Not installed']);
    f.deps.brain = async () => 'enter';
    expect(await installPluginInsideAgent(req, f.pty, f.deps)).toEqual({ outcome: 'escalate', reason: 'timeout' });
    expect(f.keys.slice(0, 2)).toEqual(['/plugins\r', '\r']);
    expect(f.keys.slice(2)).not.toContain('\r');
    expect(f.events).toContain('ESCALATE');
  });

  test('a same-name plugin from a different marketplace cannot be installed', async () => {
    const f = fixture([ready, 'Browse plugins\n> job-coach@other-market']);
    expect(await installPluginInsideAgent(req, f.pty, f.deps)).toEqual({ outcome: 'escalate', reason: 'unknown-menu' });
    expect(f.keys).toEqual(['/plugins\r']);
  });

  test('login screen never receives a password or token', async () => {
    const f = fixture([ready, 'Sign in with password to continue']);
    expect(await installPluginInsideAgent(req, f.pty, f.deps)).toEqual({ outcome: 'escalate', reason: 'credentials' });
    expect(f.keys).toEqual(['/plugins\r']);
  });

  test('real isolated Codex 0.156.1 login screen is not mistaken for an agent prompt', async () => {
    // Captured with PtyHandle.renderScreen() using a fresh CODEX_HOME; no slash commands are sent to login.
    const login = '[screen 80x24 cursor=(row 14, col 25, visible false)]\n  Welcome to Codex, OpenAI\'s command-line coding agent\n\n  Sign in with ChatGPT to use Codex as part of your paid plan\n  or connect an API key for usage-based billing\n\n> 1. Sign in with ChatGPT\n     Usage included with Plus, Pro, Business, and Enterprise plans\n\n  2. Sign in with Device Code\n     Sign in from another device with a one-time code\n\n  3. Provide your own API key\n     Pay for what you use\n\n  Press enter to continue';
    const f = fixture([login]);
    expect(await installPluginInsideAgent(req, f.pty, f.deps)).toEqual({ outcome: 'escalate', reason: 'credentials' });
    expect(f.keys).toEqual([]);
  });

  test('real Claude 2.1.283 login selection after Esc is not an agent conversation prompt', async () => {
    // PtyHandle.renderScreen() on isolated Claude 2.1.283: Esc from login method selection leaves this screen visible.
    // A post-install Esc screen requires a logged-in Claude CLI; this is the observed unauthenticated alternative.
    const afterEsc = '[screen 80x24 cursor=(row 7, col 1, visible false)]\nWelcome to Claude Code v2.1.283\n\n Claude Code can be used with your Claude subscription or billed based on API \n usage through your Console account.\n\n Select login method:\n\n ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise\n   2. Anthropic Console account · API usage billing\n   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI';
    const f = fixture([afterEsc]);
    expect(await installPluginInsideAgent({ ...req, agent: 'claude' }, f.pty, f.deps)).toEqual({ outcome: 'escalate', reason: 'credentials' });
    expect(f.keys).toEqual([]);
  });

  test('not-installed listing is navigable; failed installation followed by a prompt does not send a mission', async () => {
    const f = fixture([ready, 'Browse plugins\n> job-coach@elanous-test Not installed', 'job-coach@elanous-test Not installed\n› Ask a question']);
    expect(await installPluginInsideAgent(req, f.pty, f.deps)).toEqual({ outcome: 'escalate', reason: 'unknown-menu' });
    expect(f.keys).toEqual(['/plugins\r', '\r']);
    expect(f.events).not.toContain('VERIFY');
  });

  test('a loading row containing installed is not a completed installation', async () => {
    const f = fixture([ready, 'Browse plugins\n> job-coach@elanous-test', 'Installing job-coach@elanous-test ... Installed 0%']);
    expect(await installPluginInsideAgent(req, f.pty, f.deps)).toEqual({ outcome: 'escalate', reason: 'timeout' });
    expect(f.keys).toEqual(['/plugins\r', '\r']);
    expect(f.events).not.toContain('VERIFY');
  });

  test('claude /plugin install uses exact target and confirms installed before Esc (synthetic success frame)', async () => {
    // Not a real post-install renderScreen capture: this isolated Claude CLI is unauthenticated.
    const claudeReady = 'Claude Code\n❯';
    const f = fixture([claudeReady, 'Claude Code\n❯ /plugin install job-coach@elanous-test\njob-coach@elanous-test Installed', claudeReady]);
    expect(await installPluginInsideAgent({ ...req, agent: 'claude' }, f.pty, f.deps)).toEqual({ outcome: 'installed' });
    expect(f.keys).toEqual(['/plugin install job-coach@elanous-test\r', '\x1b']);
  });

  test('codex: a target already Installed is confirmed and the menu closed, not escalated', async () => {
    const f = fixture([
      ready,
      'Browse plugins\n> helper@elanous-test\n  job-coach@elanous-test ✓ Installed',
      ready,
    ]);
    expect(await installPluginInsideAgent(req, f.pty, f.deps)).toEqual({ outcome: 'installed' });
    expect(f.keys).toEqual(['/plugins\r', '\x1b']);
    expect(f.events).toContain('VERIFY');
  });

  test('claude: a stale Installed row above this install command is not success', async () => {
    const claudeReady = 'Claude Code\n❯';
    const stale = 'Claude Code\njob-coach@elanous-test Installed\n❯ /plugin install job-coach@elanous-test\nInstalling…';
    const f = fixture([claudeReady, stale]);
    const result = await installPluginInsideAgent({ ...req, agent: 'claude' }, f.pty, f.deps);
    expect(result).not.toEqual({ outcome: 'installed' });
    expect(f.keys).toEqual(['/plugin install job-coach@elanous-test\r']);
  });

  test('codex: if the selected target turns Installed between decision and key, Enter is not sent', async () => {
    const frames = [
      ready,
      'Browse plugins\n  helper@elanous-test\n> job-coach@elanous-test',
      'Browse plugins\n  helper@elanous-test\n> job-coach@elanous-test ✓ Installed',
      ready,
    ];
    let call = 0;
    const keys: string[] = [];
    const pty = { renderScreen: async () => frames[Math.min(call++, frames.length - 1)]!, write: (k: string) => { keys.push(k); }, isAlive: () => true } as Pick<PtyHandle, 'renderScreen' | 'write' | 'isAlive'>;
    const result = await installPluginInsideAgent(req, pty, { sleep: async () => {}, brain: async () => 'unknown', decide: () => {}, log: () => {} });
    expect(result).toEqual({ outcome: 'installed' });
    expect(keys).not.toContain('\r');
    expect(keys).toEqual(['/plugins\r', '\x1b']);
  });

  test('claude does not accept a Codex prompt after Esc', async () => {
    const f = fixture(['Claude Code\n❯', 'Claude Code\n❯ /plugin install job-coach@elanous-test\njob-coach@elanous-test Installed', ready]);
    expect(await installPluginInsideAgent({ ...req, agent: 'claude' }, f.pty, f.deps)).toEqual({ outcome: 'escalate', reason: 'unknown-menu' });
    expect(f.keys).toEqual(['/plugin install job-coach@elanous-test\r', '\x1b']);
  });

  test('claude also rejects a Codex prompt even if a stale Claude header remains', async () => {
    const f = fixture(['Claude Code\n❯', 'Claude Code\n❯ /plugin install job-coach@elanous-test\njob-coach@elanous-test Installed', `${ready}\nClaude Code\n❯`]);
    expect(await installPluginInsideAgent({ ...req, agent: 'claude' }, f.pty, f.deps)).toEqual({ outcome: 'escalate', reason: 'unknown-menu' });
    expect(f.keys).toEqual(['/plugin install job-coach@elanous-test\r', '\x1b']);
  });

  test('claude does not accept a negative installation row as confirmation', async () => {
    const f = fixture(['Claude Code\n❯', 'Claude Code\njob-coach@elanous-test Not installed\n❯']);
    expect(await installPluginInsideAgent({ ...req, agent: 'claude' }, f.pty, f.deps)).toEqual({ outcome: 'escalate', reason: 'unknown-menu' });
    expect(f.keys).toEqual(['/plugin install job-coach@elanous-test\r']);
    expect(f.events).not.toContain('VERIFY');
  });

  test('CLI plugin flows through unified pipeline to mission spec without changing mission ask', async () => {
    let captured: DevPipelineSpec | undefined;
    const backend = { name: 'codex' as const, cmd: 'codex', args: [] };
    const outcome = await runAgentMissionCliCommand(['Use the skill'], { branch: 'plugin-test', maxRounds: '2', plugin: 'job-coach@elanous-test' }, {
      resolveBackend: () => backend,
      runDevPipeline: (async (spec: DevPipelineSpec) => { captured = spec; return { kind: 'agent-mission', plan: {} as ResolvedDevPlan,
        result: { ok: true, branch: 'plugin-test', worktree: '/wt', rounds: 1, evidencePath: '/doc', committed: false, usedOmniCrawl: false, detail: 'ok' } }; }) as never,
    });
    expect(outcome.ok).toBe(true);
    expect(captured!.input).toEqual({ text: 'Use the skill' });
    expect(captured!.mission!.plugin).toEqual({ plugin: 'job-coach', marketplace: 'elanous-test' });
    expect(toAgentMissionSpec('Use the skill', planDevPipeline(captured!), () => backend).plugin).toEqual(captured!.mission!.plugin);
    expect(parsePluginRef('wrong;command@market')).toBeNull();
    const rejected = await runAgentMissionCliCommand(['M'], { branch: 'b', maxRounds: '2', backend: 'claude', headless: true, plugin: 'job-coach@elanous-test' }, {
      resolveBackend: () => ({ ...backend, name: 'claude' }),
    });
    expect(rejected.ok).toBe(false);
  });

  test('driver installs after trust, before mission send; failure never sends the mission', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inside-plugin-driver-'));
    const sent: string[] = [];
    let killed = false;
    let loopCalled = false;
    let failedInstallScreen = false;
    const pty = { id: 'codex-test', kind: 'codex', nickname: 'test', accessMode: 'auto',
      isAlive: () => true, canWrite: () => true, drainDelta: () => '',
      renderScreen: async () => failedInstallScreen && sent.length > 0
        ? sent.length === 1 ? 'Browse plugins\n> job-coach@elanous-test Not installed' : 'job-coach@elanous-test Not installed\n› Ask a question'
        : ready,
      renderScreenPng: async () => null, write: (key: string) => { sent.push(key); }, kill: () => { killed = true; },
    } as unknown as PtyHandle;
    try {
      const base = { mission: 'Write the document', repo: dir, branch: 'fixture', agent: codexBackend,
        plugin: { plugin: 'job-coach', marketplace: 'elanous-test' },
        evidence: { kind: 'doc' as const, dirRel: 'docs', glob: /result/ },
        memory: false, commit: false, screensDir: join(dir, 'screens'),
      };
      const deps = { createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
        recordWorktreeProvenance: () => {}, startPty: (() => pty) as never,
        resolvePtyWebAddress: (() => ({ webUrl: null })) as never,
        runControlLoop: (async () => { loopCalled = true; return { termination: { kind: 'success' }, steps: 1 } as never; }) as never,
      };
      failedInstallScreen = true;
      const failed = await runAgentMission(base, { ...deps,
        installPlugin: (request, handle, pluginDeps) => installPluginInsideAgent(request, handle, {
          ...pluginDeps, sleep: async () => {}, brain: async () => 'unknown', decide: () => {}, log: () => {},
        }),
      });
      expect(failed.ok).toBe(false);
      expect(failed.detail).toContain('ESCALATE (unknown-menu)');
      expect(sent).toEqual(['/plugins\r', '\r']);
      expect(killed).toBe(true);
      expect(loopCalled).toBe(false);

      failedInstallScreen = false;
      sent.length = 0;
      mkdirSync(join(dir, 'docs'));
      writeFileSync(join(dir, 'docs/result.md'), 'verified');
      const success = await runAgentMission(base, { ...deps, installPlugin: async (_req, _pty, pluginDeps) => {
        expect(sent).toEqual([]);
        pluginDeps?.write!('/plugins\r');
        return { outcome: 'installed' };
      } });
      expect(sent[0]).toBe('/plugins\r');
      expect(sent.slice(1).join('')).toContain('.mission-prompt.md');
      expect(readFileSync(join(dir, '.mission-prompt.md'), 'utf8')).toContain('job-coach:<skill>');
      expect(success.ok).toBe(false); // the document predates this mission; the existing evidence gate remains unchanged
      expect(loopCalled).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
