// H6 P4 · /agent-room slash command.
//
// Surface:
//   /agent-room <N> [brand1] [brand2] ... [brandN]   # N ∈ {2,3,4}
//   /agent-room preset <name> [brands...]             # explicit preset
//   /agent-room list                                   # show live rooms
//   /agent-room close <roomId>                         # dispose 1 room
//   /agent-room help                                   # this help
//   /showroom [--focus <idx>]                          # codex + claude showroom
//
// Brand tokens:
//   codex | claude | gemini | elanous                   # literal
//   cas | clc | gem | mac                             # aliases
//   lll:<model>                                        # local-llm (H6 P2 future)
//   auto                                               # PolicyDecide (role by pane index)
//   auto:plan | auto:exec | auto:review | auto:reflect # PolicyDecide + explicit role

import { debug } from '../../debug/log.js';
import { getPolicyRouter } from '../../policy/router.js';
import { buildAgentRoom } from '../../agent-room/room-builder.js';
import {
  getDefaultAgentRoomRegistry,
  type AgentRoomRegistry,
} from '../../agent-room/registry.js';
import {
  DEFAULT_ROLE_HINT_BY_INDEX,
  isAgentRoomPresetName,
  isAgentRoomRoleHint,
  presetArityFor,
  presetForArity,
  type AgentRoomMember,
  type AgentRoomPresetName,
  type AgentRoomRoleHint,
  type AgentRoomSpec,
} from '../../agent-room/types.js';
import type { PolicyDecideFn } from '../../agent-room/brand-resolver.js';
import type {
  SlashExecuteRequest,
  SlashExecuteResult,
} from './dashboard-slash.js';
import { parseLaneTokens } from '../../showroom/lane-parser.js';
import { toRoleHint, type LaneSpec } from '../../showroom/lane-spec.js';
import { formatLaneBadge } from '../../showroom/badge-title.js';

export interface AgentRoomSlashResult extends SlashExecuteResult {
  ok: boolean;
  logLines: string[];
}

interface AgentRoomSlashDeps {
  buildRoom?: typeof buildAgentRoom;
  policyDecide?: PolicyDecideFn;
}

/** Shared PolicyDecide adapter — maps the full router API onto the
 *  minimal `PolicyDecideFn` shape the agent-room resolver expects.
 *  Exported so the LLM-tool module can reuse it. */
export function createDefaultPolicyDecide(): PolicyDecideFn {
  return ({ task, strengths }) => {
    const router = getPolicyRouter();
    const decision = router.decide({
      task,
      ...(strengths && strengths.length > 0
        ? { strengths: strengths as readonly ('code' | 'research' | 'chat' | 'reasoning' | 'vision' | 'long-context')[] }
        : {}),
    });
    return {
      brand: decision.brand,
      ...(decision.model ? { model: decision.model } : {}),
    };
  };
}

export async function executeAgentRoomSlash(
  req: SlashExecuteRequest,
  registry: AgentRoomRegistry = getDefaultAgentRoomRegistry(),
  deps: AgentRoomSlashDeps = {},
): Promise<AgentRoomSlashResult | null> {
  const buildRoom = deps.buildRoom ?? buildAgentRoom;
  const policyDecide = deps.policyDecide ?? createDefaultPolicyDecide();
  if (req.name === 'showroom') {
    const first = (req.args[0] ?? '').toLowerCase();
    if (first === 'help' || first === '?') {
      return showroomHelpOutput();
    }
    const parsedLanes = parseLaneTokens(req.args);
    if (parsedLanes.error) return errorOutput(parsedLanes.error);
    const lanes = parsedLanes.lanes.length > 0
      ? parsedLanes.lanes
      : DEFAULT_SHOWROOM_LANES;
    return composeFromLanes(lanes, registry, {
      buildRoom,
      policyDecide,
      sourceArgs: req.args,
      ...(parsedLanes.focusIndex !== undefined ? { focusIndex: parsedLanes.focusIndex } : {}),
      ...(parsedLanes.autoRelay ? { autoRelay: true } : {}),
    });
  }
  if (req.name !== 'agent-room') return null;
  const [sub, ...rest] = req.args;
  const norm = (sub ?? '').toLowerCase();
  try {
    switch (norm) {
      case '':
      case 'help':
      case '?':
        return helpOutput();
      case 'list':
        return listAction(registry);
      case 'close':
        return closeAction(registry, rest[0]);
      case 'preset': {
        const presetName = (rest[0] ?? '').toLowerCase();
        if (!isAgentRoomPresetName(presetName)) {
          return errorOutput(
            `/agent-room preset: unknown preset '${presetName}' · use two-split · three-split · four-quad`,
          );
        }
        const brandTokens = rest.slice(1);
        return await composeAction(presetName, brandTokens, registry, {
          buildRoom,
          policyDecide,
        });
      }
      default: {
        // Numeric N form: `/agent-room 3 codex claude gemini`
        const n = Number(norm);
        if (Number.isInteger(n) && n >= 2 && n <= 4) {
          const preset = presetForArity(n);
          const brandTokens = rest;
          return await composeAction(preset, brandTokens, registry, {
            buildRoom,
            policyDecide,
          });
        }
        return errorOutput(
          `/agent-room: unknown subcommand '${norm}' · try /agent-room help`,
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (debug.enabled) {
      debug.log('agent-room.slash.error', norm, { error: msg, args: req.args }, { level: 'error' });
    }
    return {
      ok: false,
      name: req.name,
      args: req.args,
      logLines: [`/agent-room ${norm}: ${msg}`],
      message: msg,
    };
  }
}

// ─── Showroom v2 · lane composer ─────────────────────────────────────

/** Default lanes when `/showroom` runs with no token arguments — keeps
 *  the original 2-pane codex+claude experience untouched (PR D3). */
const DEFAULT_SHOWROOM_LANES: readonly LaneSpec[] = [
  { brandRef: 'codex' },
  { brandRef: 'claude' },
];

const SHOWROOM_ARITY_TO_PRESET: Record<2 | 3 | 4, AgentRoomPresetName> = {
  2: 'two-split',
  3: 'three-split',
  4: 'four-quad',
};

async function composeFromLanes(
  lanes: readonly LaneSpec[],
  registry: AgentRoomRegistry,
  opts: {
    buildRoom?: typeof buildAgentRoom;
    policyDecide?: PolicyDecideFn;
    sourceArgs?: readonly string[];
    focusIndex?: number;
    /** Arc 4 (2026-04-28) · `--auto-relay` flag — auto-start the
     *  auto-relay watcher on the freshly-spawned room. */
    autoRelay?: boolean;
    /** Test seam · override the orchestrator (Arc 4 tests). */
    autoRelayOrchestrator?: { start(roomId: string): Promise<{ ok: boolean; message: string }> };
  } = {},
): Promise<AgentRoomSlashResult> {
  if (lanes.length < 2 || lanes.length > 4) {
    return errorOutput(
      `/showroom: ${lanes.length} lane(s) given · supported arity 2/3/4`,
    );
  }
  const arity = lanes.length as 2 | 3 | 4;
  const preset = SHOWROOM_ARITY_TO_PRESET[arity];
  const members: AgentRoomMember[] = lanes.map((lane, i) => {
    const roleHint: AgentRoomRoleHint | undefined =
      toRoleHint(lane.role) ?? (lane.brandRef.toLowerCase() === 'auto'
        ? DEFAULT_ROLE_HINT_BY_INDEX[i] ?? 'exec'
        : undefined);
    const transportLabel = lane.transportPref ?? 'auto';
    const title = formatLaneBadge({
      role: roleHint,
      provider: lane.brandRef,
      transport: transportLabel,
    });
    const member: AgentRoomMember = {
      brandRef: lane.brandRef,
      ...(roleHint ? { roleHint } : {}),
      title,
      // Arc 2 (2026-04-28) · pipe explicit transport hints into the
      // member spec so room-builder can validate (brand, transportPref)
      // compatibility before spawn. Bare 'auto' / undefined stays
      // undefined so the brand-driven adapter pick is unambiguous.
      ...(lane.transportPref && lane.transportPref !== 'auto'
        ? { transportPref: lane.transportPref }
        : {}),
    };
    return member;
  });
  if (debug.enabled) {
    debug.log('showroom.lane.compose', `arity=${arity}`, {
      preset,
      members: members.map((m) => ({
        brandRef: m.brandRef, roleHint: m.roleHint, title: m.title,
      })),
      focusIndex: opts.focusIndex,
    });
  }
  const spec: AgentRoomSpec = {
    preset,
    members,
    layoutMode: 'single-vw',
    roomTitle: 'showroom',
    ...(opts.focusIndex !== undefined ? { focusIndex: opts.focusIndex } : {}),
  };
  const result = await (opts.buildRoom ?? buildAgentRoom)(spec, {
    registry,
    policyDecide: opts.policyDecide ?? createDefaultPolicyDecide(),
  });
  const lines: string[] = [];
  lines.push(
    `showroom ${result.room.id} · window ${result.room.windowId} · ${arity}-pane ready`,
  );
  for (const m of result.room.members) {
    const hint = m.roleHint ? ` [${m.roleHint}]` : '';
    lines.push(`  ${m.brand}${hint} · session ${m.sessionId} · pane ${m.paneId}`);
  }
  if (result.warnings.length > 0) {
    lines.push('');
    lines.push('— warnings —');
    for (const w of result.warnings) lines.push(`  ${w}`);
  }
  lines.push('');
  if (opts.focusIndex !== undefined) {
    const focused = result.room.members[opts.focusIndex];
    const focusName = focused ? `${focused.brand}` : 'custom';
    lines.push(`focus: pane ${opts.focusIndex} (${focusName})`);
  }
  lines.push(
    'Tip: /lane <from> <to> · /relay plan-build-review · /relay watch start (auto-propose handoffs)',
  );

  // Arc 4 · auto-start the watcher when --auto-relay was passed.
  if (opts.autoRelay) {
    const orchestrator = opts.autoRelayOrchestrator
      ?? (await import('../../showroom/auto-relay/orchestrator.js'))
        .getDefaultAutoRelayOrchestrator();
    const watchResult = await orchestrator.start(result.room.id);
    lines.push('');
    lines.push(`auto-relay: ${watchResult.message}`);
  }

  return {
    ok: true,
    name: 'showroom',
    args: [...(opts.sourceArgs ?? [])],
    logLines: lines,
  };
}

// ─── Subcommands ─────────────────────────────────────────────────────

async function composeAction(
  preset: AgentRoomPresetName,
  rawTokens: readonly string[],
  registry: AgentRoomRegistry,
  opts: {
    buildRoom?: typeof buildAgentRoom;
    policyDecide?: PolicyDecideFn;
    sourceName?: string;
    sourceArgs?: readonly string[];
    roomTitle?: string;
    focusIndex?: number;
    outputStyle?: 'agent-room' | 'showroom';
  } = {},
): Promise<AgentRoomSlashResult> {
  const arity = presetArityFor(preset);
  const parsed = parseComposeTokens(rawTokens, arity);
  if (parsed.error) return errorOutput(parsed.error);
  const { brandTokens } = parsed;
  const focusIndex = opts.focusIndex ?? parsed.focusIndex;
  if (brandTokens.length === 0) {
    return errorOutput(
      `/agent-room ${arity === 2 ? '2' : arity === 3 ? '3' : '4'} <brand1> ... <brand${arity}> · got no brands`,
    );
  }
  if (brandTokens.length !== arity) {
    return errorOutput(
      `/agent-room ${preset}: expected ${arity} brands · got ${brandTokens.length}`,
    );
  }
  const members: AgentRoomMember[] = brandTokens.map((tok, i) => {
    // `auto:plan` shape — split off the role suffix so the resolver
    // gets a clean `auto` brandRef with explicit roleHint.
    const colonIdx = tok.indexOf(':');
    if (colonIdx > 0 && tok.slice(0, colonIdx).toLowerCase() === 'auto') {
      const roleRaw = tok.slice(colonIdx + 1).toLowerCase();
      const roleHint: AgentRoomRoleHint | undefined = isAgentRoomRoleHint(roleRaw)
        ? roleRaw
        : undefined;
      return {
        brandRef: 'auto',
        ...(roleHint ? { roleHint } : { roleHint: DEFAULT_ROLE_HINT_BY_INDEX[i] ?? 'exec' }),
      };
    }
    // Non-explicit: if `auto`, apply pane-index default hint; else no hint.
    if (tok.toLowerCase() === 'auto') {
      const hint = DEFAULT_ROLE_HINT_BY_INDEX[i];
      return hint ? { brandRef: 'auto', roleHint: hint } : { brandRef: 'auto' };
    }
    return { brandRef: tok };
  });
  const spec: AgentRoomSpec = {
    preset,
    members,
    layoutMode: 'single-vw',
    ...(opts.roomTitle ? { roomTitle: opts.roomTitle } : {}),
    ...(focusIndex !== undefined ? { focusIndex } : {}),
  };
  const result = await (opts.buildRoom ?? buildAgentRoom)(spec, {
    registry,
    policyDecide: opts.policyDecide ?? createDefaultPolicyDecide(),
  });
  const lines: string[] = [];
  if (opts.outputStyle === 'showroom') {
    lines.push(
      `showroom ${result.room.id} · window ${result.room.windowId} · codex + claude ready`,
    );
  } else {
    lines.push(
      `agent-room ${result.room.id} · window ${result.room.windowId} · preset ${preset} · ${result.room.members.length} agent`,
    );
  }
  for (const m of result.room.members) {
    const hint = m.roleHint ? ` [${m.roleHint}]` : '';
    lines.push(`  ${m.brand}${hint} · session ${m.sessionId} · pane ${m.paneId}`);
  }
  if (result.warnings.length > 0) {
    lines.push('');
    lines.push('— warnings —');
    for (const w of result.warnings) lines.push(`  ${w}`);
  }
  lines.push('');
  if (focusIndex !== undefined) {
    lines.push(
      opts.outputStyle === 'showroom'
        ? `focus: pane ${focusIndex} (${focusIndex === 0 ? 'codex' : focusIndex === 1 ? 'claude' : 'custom'})`
        : `focus: pane index ${focusIndex}`,
    );
  }
  lines.push(
    opts.outputStyle === 'showroom'
      ? 'Tip: use /reply <session-id> ... to steer one side, or /budget to inspect concurrent cost.'
      : `Note: ${result.room.members.length} agents running concurrently · turn cost ~${result.room.members.length}x · /budget to check usage`,
  );
  return {
    ok: true,
    name: opts.sourceName ?? 'agent-room',
    args: [...(opts.sourceArgs ?? [String(arity), ...brandTokens])],
    logLines: lines,
  };
}

function listAction(registry: AgentRoomRegistry): AgentRoomSlashResult {
  const rooms = registry.list();
  if (rooms.length === 0) {
    return {
      ok: true,
      name: 'agent-room',
      args: ['list'],
      logLines: ['no live agent rooms'],
    };
  }
  const lines: string[] = [`${rooms.length} live agent room(s):`];
  for (const r of rooms) {
    lines.push(
      `  ${r.id} · window ${r.windowId} · ${r.preset} · ${r.members.length} member(s)`,
    );
    for (const m of r.members) {
      const hint = m.roleHint ? ` [${m.roleHint}]` : '';
      lines.push(`      ${m.brand}${hint} (session ${m.sessionId})`);
    }
  }
  return { ok: true, name: 'agent-room', args: ['list'], logLines: lines };
}

async function closeAction(
  registry: AgentRoomRegistry,
  roomId: string | undefined,
): Promise<AgentRoomSlashResult> {
  if (!roomId) {
    return errorOutput('/agent-room close <roomId> · try /agent-room list');
  }
  const result = await registry.dispose(roomId);
  if (!result.closed) {
    return errorOutput(`/agent-room close: no room with id '${roomId}'`);
  }
  return {
    ok: true,
    name: 'agent-room',
    args: ['close', roomId],
    logLines: [`closed ${roomId} · disposed ${result.disposedSessions} agent session(s)`],
  };
}

function helpOutput(): AgentRoomSlashResult {
  return {
    ok: true,
    name: 'agent-room',
    args: [],
    logLines: [
      '/agent-room — unsupported: agent rooms need the removed rich TUI (virtual windows)',
      '  /agent-room <N> <brand1> ... <brandN> [--focus <idx>]   N ∈ {2,3,4} · side-by-side',
      '  /showroom [--focus <idx>]            codex + claude 2-pane showroom',
      '  /agent-room preset <name> <brands...> [--focus <idx>]   name = two-split · three-split · four-quad',
      '  /agent-room list                         show live rooms + members',
      '  /agent-room close <roomId>               dispose all agents + VW',
      '  /agent-room help                         this text',
      '',
      '  Brands: codex · claude · gemini · elanous',
      '  Aliases: cas · clc · gem · mac',
      '  Local LLM: lll:<model> (H6 P2 future · adapter required)',
      '  Auto: auto (pane-index role) · auto:plan · auto:exec · auto:review · auto:reflect',
      '',
      '  Example: /agent-room 3 codex claude gemini',
      '  Example: /agent-room 3 auto auto auto',
      '  Example: /agent-room 3 auto:plan auto:exec auto:review',
      '  Example: /agent-room 3 codex claude gemini --focus 2',
      '',
      '  Note: N agents run concurrently → turn cost ~Nx · /budget first.',
      '  Bundle 2 (planned): save/load user presets · multi-vw layout · swap',
    ],
  };
}

function showroomHelpOutput(): AgentRoomSlashResult {
  return {
    ok: true,
    name: 'showroom',
    args: [],
    logLines: [
      '/showroom — multi-LLM lane composer (v2 · 2026-04-28)',
      '  /showroom                                   default 2-pane codex + claude',
      '  /showroom <lane1> <lane2> [<lane3> [<lane4>]]   N ∈ {2,3,4}',
      '  /showroom <lanes...> --focus <idx>          choose initial focus',
      '  /showroom help                              this text',
      '  Room composition is unsupported: agent rooms need the removed rich TUI (virtual windows).',
      '',
      '  Lane token grammar:',
      '    role:provider[:transport]            full triple',
      '    provider[:transport]                 role inferred',
      '    auto[:role]                          policy-routed',
      '',
      '  Roles:     plan · build · exec · review · reflect',
      '  Providers: codex · claude · gemini · elanous · lll:<model>',
      '  Aliases:   cas · clc · gem · mac',
      '  Transport: pty · acp · auto (default)',
      '',
      '  Examples:',
      '    /showroom                                       2-pane (codex + claude)',
      '    /showroom plan:claude build:codex review:gemini  3-pane plan/build/review',
      '    /showroom build:lll:llama3 review:gemini         local LLM + remote review',
      '    /showroom auto:plan auto:exec auto:review --focus 1',
      '',
      '  After spawn:',
      '    /handoff <from> <to>          cross-lane context inject (HITL)',
      '    /relay plan-build-review      sequential macro (HITL each step)',
      '    /relay broadcast              fan-out from active lane',
      '    /budget                       N agents = ~Nx turn cost',
    ],
  };
}

interface ParsedComposeTokens {
  brandTokens: readonly string[];
  focusIndex?: number;
  error?: string;
}

export function parseComposeTokens(
  rawTokens: readonly string[],
  arity: number,
): ParsedComposeTokens {
  if (rawTokens.length === 0) return { brandTokens: [] };
  const focusFlagIdx = rawTokens.findIndex((tok) => tok === '--focus');
  if (focusFlagIdx === -1) return { brandTokens: [...rawTokens] };
  if (focusFlagIdx < arity) {
    return {
      brandTokens: [],
      error: `/agent-room: --focus <idx> must come after all ${arity} brand token(s)`,
    };
  }
  if (rawTokens.length !== focusFlagIdx + 2) {
    return {
      brandTokens: [],
      error: '/agent-room: use `--focus <idx>` once at the end',
    };
  }
  const focusRaw = rawTokens[focusFlagIdx + 1];
  const focusIndex = Number(focusRaw);
  if (!Number.isInteger(focusIndex)) {
    return {
      brandTokens: [],
      error: `/agent-room: focus index must be an integer · got '${String(focusRaw ?? '')}'`,
    };
  }
  return {
    brandTokens: rawTokens.slice(0, focusFlagIdx),
    focusIndex,
  };
}

function errorOutput(msg: string): AgentRoomSlashResult {
  return {
    ok: false,
    name: 'agent-room',
    args: [],
    logLines: [msg],
    message: msg,
  };
}
