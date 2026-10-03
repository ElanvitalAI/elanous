// Sticky-session REPL — multi-turn CLI conversation in one process.
//
// `elanous repl` keeps the boot cost (LLM SDK init, session load, debug
// log open, anchor + tree precompute) to one paid hit instead of N×
// the per-turn cost of `elanous chat`. The same session id threads
// through every turn so history accumulates, provider rotation
// between turns is fine, and tool dispatchers stay warm.
//
// Two input modes — both reach the same dispatch:
//   - **interactive** (TTY) — readline prompts the human turn by turn
//   - **scripted** (--scenario / stdin pipe) — a YAML file or JSONL
//     stream feeds prompts in sequence. CI / regression / LLM-driven
//     self-spawn all use this path.
//
// Meta-commands (lines starting with `:`) implement attach / provider
// switch / fork / save / exit etc. so the human keeps the affordances
// the dashboard's TUI surface offers, but inside a plain terminal
// REPL that pipes through ssh / tmux / VS Code terminal alike.

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath, isAbsolute, basename } from 'node:path';
import * as ui from '../ui.js';
import { suggestProjectForFolder } from '../project/project-store.js';
import { runTurn } from '../session/chat.js';
import {
  ensureCliSession,
  sessionBudget,
} from '../session/chat.js';
import {
  resolveSessionId,
  loadSession,
  setActiveSessionId,
  getActiveSessionId,
} from '../session/index.js';
import {
  reloadUserConfig,
  saveUserConfig,
  jumpToRotationEntry,
  type UserConfig,
} from '../user-config.js';
import { setAmbientSessionId, debug } from '../debug/log.js';
import { decideSigintAction } from './sigint.js';
import { buildReplayTurnsFromSession } from './replay.js';
import type { LLMToolSpec, ContentBlock } from '../llm.js';
import { inspectActiveProvider } from '../provider-summary.js';
import { parse as parseYaml } from 'yaml';

/** REPL public entry — wires whichever input source the caller chose
 *  to the shared turn dispatcher. The CLI command (in src/index.ts)
 *  resolves config + flags then hands off here. */
export interface ReplOpts {
  /** Initial user-config snapshot. Reloaded inside REPL on `:reload`
   *  or after `:provider <label>`. */
  cfg: UserConfig;
  /** Resume an explicit session (id or unique prefix). When omitted,
   *  REPL creates a fresh session at boot. */
  initialSessionId: string | undefined;
  /** Force a fresh session even if active marker exists. */
  forceNew: boolean;
  /** Enable the tool loop (Read/Grep/Bash/...). Default true — REPL
   *  is the agent surface; users opt out with --no-tools. */
  enableTools: boolean;
  /** Path to a YAML scenario file. Each `turns` entry runs as one
   *  REPL turn before the loop hands control back to stdin (or
   *  exits when --exit-after-scenario is set). */
  scenarioPath: string | undefined;
  /** Resume the user prompts from a previous session as a fresh
   *  scenario run (BACKLOG #5). Mutually exclusive with `scenarioPath`.
   *  When set, the REPL loads the named session, extracts its user
   *  prompts via `buildReplayTurnsFromSession`, and runs them through
   *  the same dispatcher as a YAML scenario. Use case: bug repro
   *  automation, provider comparison, fix verification. */
  replaySessionId?: string | undefined;
  /** Read JSONL turns from stdin (one JSON object per line; shape
   *  matches a single scenario turn). Mutually exclusive with TTY
   *  interactive mode — when stdin is not a TTY and no scenario is
   *  given, default to JSONL. */
  scriptedFromStdin: boolean;
  /** Emit one JSON line per turn instead of streaming text. Useful
   *  when REPL is driven from a parent process. */
  jsonOutput: boolean;
  /** Exit after the last scripted turn finishes. Default true for
   *  pure scenario runs, false when stdin is a TTY (the human
   *  expects the prompt to come back). */
  exitAfterScenario: boolean;
}

/** One scripted turn — used by both YAML scenarios and JSONL stdin
 *  streams. Schema designed to match the existing `repro --scenario`
 *  prompts entry where applicable. */
export interface ScenarioTurn {
  id?: string;
  prompt: string;
  /** Switch provider before this turn. Resolves through
   *  `rotationEntryLabel` (e.g. "opus" / "codex" / "gemini"). */
  rotate?: string;
  /** File paths to attach as image content blocks. Resolved
   *  relative to the scenario file (or cwd for stdin). */
  attachments?: string[];
  /** Per-turn assertion overrides — mirrors the eval-prompt
   *  `text_min_chars` / `reply_contains` style for forward-compat
   *  with regression scenarios. */
  asserts?: {
    text_min_chars?: number;
    reply_contains?: string[];
    reply_not_contains?: string[];
  };
}

interface ScenarioFile {
  description?: string;
  defaults?: { asserts?: ScenarioTurn['asserts'] };
  turns: ScenarioTurn[];
}

interface PendingAttachment {
  path: string;
  block: ContentBlock;
}

/** Build the REPL's tool catalog + dispatcher. Mirrors
 *  `buildCliAgentTools` in src/index.ts but lives here so the REPL
 *  module is self-contained when consumed in tests. */
function buildReplTools(): {
  specs: LLMToolSpec[];
  dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>;
} {
  const specs: LLMToolSpec[] = [];
  const dispatchByName = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const sr = require('../session-runtime/index.js') as typeof import('../session-runtime/index.js');
  const surface = sr.resolveSessionSurfaceProfile({ preferredSurfaceId: 'coding/turn' });
  for (const spec of sr.resolveDynamicSessionNativeToolSpecs({
    userText: '',
    defaultFamilyIds: surface.defaultNativeFamilyIds,
    surfaceId: surface.id,
  })) {
    specs.push(spec);
  }
  const bashMod = require('../skills/tools/index.js') as typeof import('../skills/tools/index.js');
  specs.push(bashMod.buildBashTool());
  dispatchByName.set('Bash', async (args) => bashMod.dispatchBash(args, { cwd: process.cwd() }));
  const planner = sr.createSearchPlannerState({ maxAutoNarrowCandidates: 2 });
  const dispatch = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      const direct = dispatchByName.get(name);
      if (direct) return await direct(args);
      return await sr.dispatchSessionRuntimeTool(name, args, {
        signal: undefined,
        userText: '',
        modelFamily: undefined,
        searchPlannerState: planner,
        turnIndex: undefined,
        ptyDashboardOn: false,
        getToolRuntime: () => undefined,
        dispatchToolRuntime: async (n) => ({ error: `runtime unavailable in REPL: ${n}` }),
        dispatchPluginTool: async (n) => ({ ok: false as const, error: `plugin unavailable in REPL: ${n}` }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `dispatch failed: ${msg}` };
    }
  };
  return { specs, dispatch };
}

function buildAgentSystemPrompt(
  cfg: UserConfig,
  enabledToolNames: readonly string[],
): string | undefined {
  try {
    const ulMod = require('../prompt-library/universal-preamble.js') as typeof import('../prompt-library/universal-preamble.js');
    const modelsMod = require('../models/prompts.js') as typeof import('../models/prompts.js');
    const modelId = cfg.llm.model;
    const modelFamily = modelId ? modelsMod.getModelFamily(modelId) : undefined;
    const universal = ulMod.buildUniversalPreamble({
      cwd: process.cwd(),
      ...(modelFamily !== undefined ? { modelFamily } : {}),
      enabledTools: [...enabledToolNames],
    });
    const joined = universal
      .map(m => (typeof m.content === 'string' ? m.content : ''))
      .filter(s => s.length > 0)
      .join('\n\n');
    return joined.length > 0 ? joined : undefined;
  } catch {
    return undefined;
  }
}

function loadAttachment(rawPath: string, baseDir: string): PendingAttachment | null {
  const resolved = isAbsolute(rawPath) ? rawPath : resolvePath(baseDir, rawPath);
  if (!existsSync(resolved)) {
    ui.error(`attach failed — not found: ${resolved}`);
    return null;
  }
  const ext = resolved.toLowerCase().split('.').pop() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    const base64 = readFileSync(resolved).toString('base64');
    const mediaType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const block: ContentBlock = { type: 'image', mediaType, base64 };
    return { path: resolved, block };
  }
  // Non-image — feed as text content for now (LLM treats inlined text
  // as part of the user message). Future: handle PDF/audio via the
  // ACP NormalizedAttachment pipeline.
  const text = readFileSync(resolved, 'utf-8');
  const block: ContentBlock = {
    type: 'text',
    text: `[attached: ${basename(resolved)}]\n\n\`\`\`\n${text}\n\`\`\``,
  };
  return { path: resolved, block };
}

async function runOneTurn(
  cfg: UserConfig,
  sessionId: string,
  userText: string,
  pendingAttachments: PendingAttachment[],
  tools: ReturnType<typeof buildReplTools> | undefined,
  systemPrompt: string | undefined,
  jsonOutput: boolean,
): Promise<{ reply: string; provider: string; model: string | null; durationMs: number; logPath: string | null }> {
  const startedAt = Date.now();
  const replyChunks: string[] = [];
  const userImages = pendingAttachments.length > 0 ? pendingAttachments.map(a => a.block) : undefined;
  if (!jsonOutput) {
    process.stdout.write('  ');
  }
  // Archon-port T1.2 (2026-05-08) — apply user-config `chat.toolDeny`
  // to the REPL tool roster. Pre-T1.2 the REPL ignored toolDeny.
  let replToolSpecs = tools?.specs;
  if (replToolSpecs && cfg.chat.toolDeny.length > 0) {
    const { applyToolPolicy } = require('../tool-runtime/tool-policy.js') as typeof import('../tool-runtime/tool-policy.js');
    replToolSpecs = applyToolPolicy(replToolSpecs, { deny: cfg.chat.toolDeny }) ?? replToolSpecs;
  }
  const result = await runTurn({
    userConfig: cfg,
    sessionId,
    userText,
    systemPrompt,
    userImages,
    onDelta: (d) => {
      if (jsonOutput) replyChunks.push(d);
      else process.stdout.write(d);
    },
    tools: replToolSpecs,
    dispatchTool: tools?.dispatch,
    onToolCall: (call) => {
      if (!jsonOutput) {
        const args = JSON.stringify(call.args);
        const argsPreview = args.length > 100 ? args.slice(0, 100) + '…' : args;
        process.stdout.write(`\n  ⏺ ${call.name}(${argsPreview})\n  `);
      }
    },
    onToolResult: (call) => {
      if (!jsonOutput) {
        let preview: string;
        if (typeof call.result === 'string') preview = call.result;
        else if (call.result && typeof call.result === 'object' && 'output' in call.result) {
          preview = String((call.result as { output: unknown }).output);
        } else {
          preview = JSON.stringify(call.result);
        }
        preview = preview.replace(/\s+/g, ' ').trim();
        if (preview.length > 160) preview = preview.slice(0, 160) + '…';
        process.stdout.write(`     ↳ ${preview}\n  `);
      }
    },
  });
  const reply = jsonOutput ? replyChunks.join('') : '';
  const logPath = (() => {
    try {
      const status = debug.status?.();
      return status?.path ?? null;
    } catch { return null; }
  })();
  if (!jsonOutput) {
    process.stdout.write('\n');
    ui.info(`[turn done · ${result.provider}${result.model ? '/' + result.model : ''} · ${sessionBudget(sessionId)}]`);
  }
  return {
    reply: reply || result.text,
    provider: result.provider,
    model: result.model ?? null,
    durationMs: Date.now() - startedAt,
    logPath,
  };
}

function loadScenarioFromYaml(path: string): ScenarioFile {
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw) as Partial<ScenarioFile>;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.turns)) {
    throw new Error(`scenario file lacks 'turns' array: ${path}`);
  }
  return {
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    defaults: parsed.defaults,
    turns: parsed.turns,
  };
}

function applyAsserts(
  reply: string,
  asserts: ScenarioTurn['asserts'] | undefined,
  defaults: ScenarioTurn['asserts'] | undefined,
  turnId: string,
): string[] {
  const failures: string[] = [];
  const merged = { ...(defaults ?? {}), ...(asserts ?? {}) };
  if (typeof merged.text_min_chars === 'number' && reply.length < merged.text_min_chars) {
    failures.push(`${turnId}: text ${reply.length} < ${merged.text_min_chars}`);
  }
  for (const needle of merged.reply_contains ?? []) {
    if (!reply.includes(needle)) failures.push(`${turnId}: reply missing "${needle}"`);
  }
  for (const needle of merged.reply_not_contains ?? []) {
    if (reply.includes(needle)) failures.push(`${turnId}: reply unexpectedly contains "${needle}"`);
  }
  return failures;
}

/** Apply meta-commands. Returns true when the line was consumed (no
 *  prompt to dispatch); false when the line is an ordinary prompt. */
async function handleMetaCommand(
  line: string,
  ctx: {
    cfg: UserConfig;
    sessionIdRef: { current: string };
    pendingAttachments: PendingAttachment[];
    rl: ReadlineInterface;
    cwd: string;
    onExit: () => void;
  },
): Promise<{ consumed: boolean; cfgUpdate?: UserConfig }> {
  if (!line.startsWith(':')) return { consumed: false };
  const [cmd, ...args] = line.slice(1).trim().split(/\s+/);
  switch (cmd) {
    case 'help':
    case '?': {
      ui.info([
        ':help  ·  :provider <label>  ·  :budget  ·  :session  ·  :history',
        ':attach <path>  ·  :clear-attachments  ·  :reload  ·  :fork  ·  :exit',
      ].join('\n'));
      return { consumed: true };
    }
    case 'exit':
    case 'quit':
    case 'q': {
      ctx.onExit();
      return { consumed: true };
    }
    case 'budget': {
      ui.info(`session ${ctx.sessionIdRef.current.slice(0, 8)}  ${sessionBudget(ctx.sessionIdRef.current)}`);
      return { consumed: true };
    }
    case 'session': {
      ui.info(`active session: ${ctx.sessionIdRef.current}`);
      return { consumed: true };
    }
    case 'attach': {
      if (args.length === 0) {
        ui.error('usage: :attach <path>');
        return { consumed: true };
      }
      const att = loadAttachment(args.join(' '), ctx.cwd);
      if (att) {
        ctx.pendingAttachments.push(att);
        ui.info(`attached ${basename(att.path)} (queued for next turn — ${ctx.pendingAttachments.length} total)`);
      }
      return { consumed: true };
    }
    case 'clear-attachments': {
      const n = ctx.pendingAttachments.length;
      ctx.pendingAttachments.length = 0;
      ui.info(`cleared ${n} attachment(s)`);
      return { consumed: true };
    }
    case 'provider': {
      if (args.length === 0) {
        const p = inspectActiveProvider(ctx.cfg);
        ui.info(`current: ${p.provider}/${p.model ?? '?'}`);
        return { consumed: true };
      }
      const label = args[0]!;
      const { cfg: nextCfg, entry } = jumpToRotationEntry(ctx.cfg, label);
      if (!entry) {
        ui.error(`no rotation entry matching "${label}"`);
        return { consumed: true };
      }
      // Persist so the next REPL turn (and any elanous subprocess the
      // LLM might spawn for self-debug) sees the same active provider.
      try { saveUserConfig(nextCfg); } catch { /* best-effort */ }
      const p = inspectActiveProvider(nextCfg);
      ui.info(`provider → ${p.provider}/${p.model ?? '?'} (label "${label}")`);
      return { consumed: true, cfgUpdate: nextCfg };
    }
    case 'reload': {
      const refreshed = reloadUserConfig();
      ui.info(`reloaded ~/.config/elanous/config.json`);
      return { consumed: true, cfgUpdate: refreshed };
    }
    case 'history': {
      const loaded = loadSession(ctx.sessionIdRef.current);
      if (!loaded) {
        ui.error('no history (session not found)');
        return { consumed: true };
      }
      ui.info(`${loaded.meta.messageCount} message(s) — last 3:`);
      for (const m of loaded.messages.slice(-3)) {
        const head = m.content.slice(0, 80).replace(/\s+/g, ' ');
        console.log(`  [${m.role}] ${head}${m.content.length > 80 ? '…' : ''}`);
      }
      return { consumed: true };
    }
    case 'fork': {
      // Spawn a fresh session that shares no history with the
      // current one. Useful when the human wants to try the same
      // prompt with a different framing without polluting history.
      const next = ensureCliSession(ctx.cfg);
      setActiveSessionId(next.id);
      setAmbientSessionId(next.id);
      ctx.sessionIdRef.current = next.id;
      ui.info(`forked → fresh session ${next.id.slice(0, 8)}`);
      return { consumed: true };
    }
    default: {
      ui.error(`unknown command: :${cmd}  (try :help)`);
      return { consumed: true };
    }
  }
}

/** Runs the REPL until stdin EOF or an explicit `:exit`. Top-level
 *  entry from src/index.ts. */
export async function runRepl(opts: ReplOpts): Promise<number> {
  // Resolve initial session.
  let cfg = opts.cfg;
  let initialId: string | undefined;
  if (opts.initialSessionId) {
    const id = resolveSessionId(opts.initialSessionId);
    if (!id) {
      ui.error(`no session matching "${opts.initialSessionId}"`);
      return 1;
    }
    initialId = id;
  } else if (!opts.forceNew) {
    initialId = getActiveSessionId() ?? undefined;
  }
  const session = ensureCliSession(cfg, initialId);
  setActiveSessionId(session.id);
  setAmbientSessionId(session.id);
  if (!opts.jsonOutput && (!initialId || session.id !== initialId)) {
    try {
      const project = suggestProjectForFolder(process.cwd());
      if (project) ui.info(`Project suggestion: ${project.name} (${project.id})`);
    } catch { /* suggestions must not interrupt the REPL */ }
  }
  const sessionIdRef = { current: session.id };

  const tools = opts.enableTools ? buildReplTools() : undefined;
  const systemPrompt = tools
    ? buildAgentSystemPrompt(cfg, tools.specs.map(s => s.name))
    : undefined;
  const pendingAttachments: PendingAttachment[] = [];

  if (!opts.jsonOutput) {
    const p = inspectActiveProvider(cfg);
    ui.header(`elanous repl — session ${session.id.slice(0, 8)}`);
    ui.info(`provider: ${p.provider}/${p.model ?? '?'} · tools: ${tools ? tools.specs.length : 0} · :help for commands · :exit to quit`);
  }

  // Phase A — scripted scenario file or session replay (if any).
  // Replay (BACKLOG #5) uses the same loop body as YAML scenarios — we
  // synthesize a ScenarioFile from the source session's user prompts.
  let scriptedScenario: ScenarioFile | null = null;
  let scenarioBaseDir = process.cwd();
  if (opts.scenarioPath) {
    scriptedScenario = loadScenarioFromYaml(opts.scenarioPath);
    scenarioBaseDir = resolvePath(opts.scenarioPath, '..');
  } else if (opts.replaySessionId) {
    const replayId = resolveSessionId(opts.replaySessionId);
    if (!replayId) {
      ui.error(`--replay: no session matching "${opts.replaySessionId}"`);
      return 1;
    }
    const loaded = loadSession(replayId);
    if (!loaded) {
      ui.error(`--replay: failed to load session ${replayId}`);
      return 1;
    }
    const conv = buildReplayTurnsFromSession(loaded);
    if (conv.turns.length === 0) {
      ui.error(`--replay: session ${replayId.slice(0, 8)} has no replayable user prompts`);
      return 1;
    }
    if (!opts.jsonOutput) {
      ui.info(`replay: ${conv.extractedCount} prompt(s) from session ${replayId.slice(0, 8)} · skipped ${conv.skippedCount} non-user${conv.droppedAttachmentCount > 0 ? ` · ${conv.droppedAttachmentCount} with attachments dropped` : ''}`);
    }
    if (debug.enabled) {
      debug.log('repl.replay', 'session-loaded', {
        replaySessionId: replayId,
        ...conv,
      });
    }
    scriptedScenario = { turns: conv.turns };
  }

  if (scriptedScenario) {
    const sc = scriptedScenario;
    const baseDir = scenarioBaseDir;
    let assertFailures = 0;
    for (const turn of sc.turns) {
      const turnId = turn.id ?? `t${sc.turns.indexOf(turn) + 1}`;
      if (turn.rotate) {
        const { cfg: nextCfg, entry } = jumpToRotationEntry(cfg, turn.rotate);
        if (!entry) {
          ui.error(`turn ${turnId}: rotate "${turn.rotate}" not found in rotation`);
          continue;
        }
        cfg = nextCfg;
      }
      const turnAttachments: PendingAttachment[] = [];
      for (const ap of turn.attachments ?? []) {
        const att = loadAttachment(ap, baseDir);
        if (att) turnAttachments.push(att);
      }
      if (!opts.jsonOutput) {
        ui.header(`turn ${turnId}${turn.rotate ? ` · ${turn.rotate}` : ''}`);
        console.log(`  ❯ ${turn.prompt}`);
      }
      const result = await runOneTurn(
        cfg,
        sessionIdRef.current,
        turn.prompt,
        turnAttachments,
        tools,
        systemPrompt,
        opts.jsonOutput,
      );
      const failures = applyAsserts(result.reply, turn.asserts, sc.defaults?.asserts, turnId);
      if (opts.jsonOutput) {
        const out = {
          turnId,
          sessionId: sessionIdRef.current,
          provider: result.provider,
          model: result.model,
          reply: result.reply,
          durationMs: result.durationMs,
          logPath: result.logPath,
          assertFailures: failures,
        };
        console.log(JSON.stringify(out));
      } else {
        if (failures.length > 0) {
          for (const f of failures) ui.error(`assert: ${f}`);
        }
      }
      assertFailures += failures.length;
    }
    if (opts.exitAfterScenario) return assertFailures > 0 ? 2 : 0;
  } // end if (scriptedScenario)

  // Phase B — interactive (TTY) or JSONL stdin (pipe).
  const isTty = process.stdin.isTTY === true;
  if (!isTty || opts.scriptedFromStdin) {
    // JSONL stream — one turn per line.
    const lines = readStdinLines();
    for await (const raw of lines) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      let turn: ScenarioTurn;
      try {
        turn = JSON.parse(trimmed) as ScenarioTurn;
      } catch {
        // Non-JSON line — treat as a plain prompt for forward-compat.
        turn = { prompt: trimmed };
      }
      if (turn.rotate) {
        const { cfg: nextCfg, entry } = jumpToRotationEntry(cfg, turn.rotate);
        if (!entry) {
          ui.error(`turn rotate "${turn.rotate}" not found in rotation`);
          continue;
        }
        cfg = nextCfg;
      }
      const turnAttachments: PendingAttachment[] = [];
      for (const ap of turn.attachments ?? []) {
        const att = loadAttachment(ap, process.cwd());
        if (att) turnAttachments.push(att);
      }
      const result = await runOneTurn(
        cfg,
        sessionIdRef.current,
        turn.prompt,
        turnAttachments,
        tools,
        systemPrompt,
        true, // JSONL stream → always JSON output
      );
      const failures = applyAsserts(result.reply, turn.asserts, undefined, turn.id ?? 't?');
      const out = {
        turnId: turn.id ?? null,
        sessionId: sessionIdRef.current,
        provider: result.provider,
        model: result.model,
        reply: result.reply,
        durationMs: result.durationMs,
        logPath: result.logPath,
        assertFailures: failures,
      };
      console.log(JSON.stringify(out));
    }
    return 0;
  }

  // TTY — readline loop.
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '❯ ',
    terminal: true,
    historySize: 200,
  });
  let exitRequested = false;
  const onExit = () => { exitRequested = true; rl.close(); };

  // BACKLOG #3 — Ctrl-C double-tap to exit + ambient cleanup on close.
  // Default node SIGINT during a bare readline prompt would just kill
  // the process without flushing logs or clearing the ambient session
  // id (next process inheriting the same shell would see a stale id
  // via the env / registry path). Mirror the familiar shell pattern:
  // first Ctrl-C clears the input buffer + prints a hint, second
  // within ~1.5 s closes gracefully. During an in-flight turn we
  // can't abort the streaming yet (runOneTurn doesn't take an abort
  // signal), so the hint also tells the user to press again to
  // force-quit.
  let lastSigintAt = 0;
  rl.on('SIGINT', () => {
    const now = Date.now();
    const action = decideSigintAction(lastSigintAt, now);
    if (debug.enabled) {
      debug.log('repl.tty', 'sigint', {
        sessionId: sessionIdRef.current,
        action,
      });
    }
    if (action === 'exit') {
      ui.info('exiting (Ctrl-C twice)');
      exitRequested = true;
      rl.close();
      return;
    }
    lastSigintAt = now;
    process.stdout.write('\n');
    ui.info('press Ctrl-C again to exit (or :exit). Mid-turn streaming cannot be aborted yet.');
    rl.prompt();
  });

  // Best-effort ambient cleanup: clear the session id so a sibling
  // process inheriting the same shell does not pick up a stale value
  // through `getAmbientSessionId()`.
  rl.on('close', () => {
    if (debug.enabled) {
      debug.log('repl.tty', 'close', { sessionId: sessionIdRef.current });
    }
    setAmbientSessionId(null);
  });

  rl.prompt();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      rl.prompt();
      continue;
    }
    const meta = await handleMetaCommand(trimmed, {
      cfg,
      sessionIdRef,
      pendingAttachments,
      rl,
      cwd: process.cwd(),
      onExit,
    });
    if (meta.cfgUpdate) cfg = meta.cfgUpdate;
    if (meta.consumed) {
      if (exitRequested) break;
      rl.prompt();
      continue;
    }
    // Ordinary prompt.
    const turnAttachments = pendingAttachments.splice(0);
    await runOneTurn(
      cfg,
      sessionIdRef.current,
      trimmed,
      turnAttachments,
      tools,
      systemPrompt,
      opts.jsonOutput,
    );
    if (exitRequested) break;
    rl.prompt();
  }
  return 0;
}

async function* readStdinLines(): AsyncGenerator<string, void, unknown> {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) yield line;
}
