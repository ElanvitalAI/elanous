import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── PFC-S1 P4: TeamCreate / TeamDelete / SendMessage LLM tools ──
//
// Thin LLM-visible wrappers around TeamMailbox (P3). These tools let a
// parent LLM:
//   • Create a team to group related subagent spawns (TeamCreate)
//   • Dismantle a team after work is done (TeamDelete)
//   • Send one-shot messages between team members or to a named
//     recipient (SendMessage)
//
// Sender resolution for SendMessage (DD-PFC1-5) ──
//   1. opts.senderAgent  — caller-supplied explicit override
//   2. task registry     — look up the spawning task by parentCorrelationId
//   3. fallback          — 'user' (parent chat is writing directly)
// The resolution happens inside dispatchSendMessage so the LLM's tool
// call doesn't have to pass `from` — it's derived from invocation
// context.
//
// Validation / safety ──
//   • Recipients sanitized by TeamMailbox (alphanumeric + . _ -)
//   • Empty body rejected
//   • Cross-team sends are NOT blocked — sender may message any
//     recipient in any team. Roster membership is informational, not
//     enforced (PX-6 may tighten this).


import {
  globalTeamMailbox,
  type MailboxMessage,
  type TeamMailbox,
  type TeamRoster,
} from './mailbox.js';
import { globalAgentRegistry, type AgentRegistry } from '../agent/registry.js';

const DEFAULT_TEAM = 'global';

// ── Shared dispatch options ─────────────────────────────────────────

export interface TeamToolDispatchOpts {
  /** Explicit sender name — wins over registry lookup. */
  senderAgent?: string;
  /** Parent correlation ID — if set and senderAgent is absent, we
   *  look up the owning task in the registry and use its definition
   *  name as sender. */
  parentCorrelationId?: string;
  /** Mailbox override for tests. */
  mailbox?: TeamMailbox;
  /** Registry override for tests. */
  registry?: AgentRegistry;
}

function resolveSender(opts: TeamToolDispatchOpts): string {
  if (opts.senderAgent) return opts.senderAgent;
  if (opts.parentCorrelationId) {
    const reg = opts.registry ?? globalAgentRegistry;
    for (const t of reg.list()) {
      if (t.correlationId === opts.parentCorrelationId) {
        return t.definition.name;
      }
    }
  }
  return 'user';
}

// ── TeamCreate ──────────────────────────────────────────────────────

export interface TeamCreateArgs {
  name: string;
  members?: string[];
}

export interface TeamCreateResult extends Record<string, unknown> {
  output: string;
  team: string;
  roster: TeamRoster;
}

export function buildTeamCreateTool(): LLMToolSpec {
  return {
    name: 'TeamCreate',
    description:
      'Create a team directory so subsequent SendMessage calls can group related spawns. ' +
      'Idempotent — re-creating an existing team adds to its member list. ' +
      'Use when you plan to fan out N Agent spawns that should exchange findings.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Team name. Alphanumeric + . _ - (no leading dash, no slashes). ' +
            'Pick a short slug like "samsung-2026" or "refactor-kx".',
        },
        members: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional initial roster — agent names that belong to this team. ' +
            'Can be extended later by calling TeamCreate again with the same name.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  };
}

export function dispatchTeamCreate(
  args: Record<string, unknown>,
  opts: TeamToolDispatchOpts = {},
): TeamCreateResult {
  const name = typeof args.name === 'string' ? args.name : '';
  const members = Array.isArray(args.members)
    ? args.members.filter((m): m is string => typeof m === 'string')
    : [];
  const mbox = opts.mailbox ?? globalTeamMailbox;
  const roster = mbox.createTeam(name, members);
  return {
    output: `✓ team '${roster.name}' ready (${roster.members.length} members)`,
    team: roster.name,
    roster,
  };
}

// ── TeamDelete ──────────────────────────────────────────────────────

export interface TeamDeleteArgs {
  name: string;
}

export interface TeamDeleteResult extends Record<string, unknown> {
  output: string;
  team: string;
  deleted: boolean;
}

export function buildTeamDeleteTool(): LLMToolSpec {
  return {
    name: 'TeamDelete',
    description:
      'Remove a team directory + all its mailboxes. Destructive — message history is lost. ' +
      'Use after a team completes its mission. Safe on missing teams (returns deleted:false).',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Team name. Alphanumeric + . _ -',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  };
}

export function dispatchTeamDelete(
  args: Record<string, unknown>,
  opts: TeamToolDispatchOpts = {},
): TeamDeleteResult {
  const name = typeof args.name === 'string' ? args.name : '';
  const mbox = opts.mailbox ?? globalTeamMailbox;
  const deleted = mbox.deleteTeam(name);
  return {
    output: deleted ? `✓ team '${name}' deleted` : `(team '${name}' did not exist)`,
    team: name,
    deleted,
  };
}

// ── SendMessage ─────────────────────────────────────────────────────

export interface SendMessageArgs {
  to: string;
  body: string;
  subject?: string;
  team_name?: string;
  reply_to?: string;
}

export interface SendMessageResult extends Record<string, unknown> {
  output: string;
  message: MailboxMessage;
}

export function buildSendMessageTool(): LLMToolSpec {
  return {
    name: 'SendMessage',
    description:
      'Send a message to another agent (or the user) via the team mailbox. ' +
      'The recipient sees it on their next activation / tool-loop iteration. ' +
      'Use for agent-to-agent coordination (findings, hand-offs, questions). ' +
      'Sender is derived from invocation context — you do not pass `from`.',
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description:
            'Recipient name — an agent name or "user". Alphanumeric + . _ -',
        },
        body: {
          type: 'string',
          description:
            'Message body (markdown or mermaid). No hard cap but keep it focused — ' +
            'recipients pay the token cost when they read their mailbox.',
        },
        subject: {
          type: 'string',
          description:
            'Optional one-line subject for roster panes / compact display.',
        },
        team_name: {
          type: 'string',
          description:
            `Optional team scope. Defaults to '${DEFAULT_TEAM}' when omitted. ` +
            'Must match a TeamCreate-d team if you want the recipient to see it ' +
            'via team-scoped list calls.',
        },
        reply_to: {
          type: 'string',
          description:
            'Optional prior message id for conversational threading. The listener ' +
            'can traverse reply chains by following these ids.',
        },
      },
      required: ['to', 'body'],
      additionalProperties: false,
    },
  };
}

export function dispatchSendMessage(
  args: Record<string, unknown>,
  opts: TeamToolDispatchOpts = {},
): SendMessageResult {
  const to = typeof args.to === 'string' ? args.to.trim() : '';
  const body = typeof args.body === 'string' ? args.body : '';
  const subject = typeof args.subject === 'string' ? args.subject.trim() : undefined;
  const teamName = typeof args.team_name === 'string' && args.team_name.trim()
    ? args.team_name.trim()
    : DEFAULT_TEAM;
  const replyTo = typeof args.reply_to === 'string' && args.reply_to.trim()
    ? args.reply_to.trim()
    : undefined;

  if (!to) throw new Error('SendMessage: `to` is required');
  if (!body) throw new Error('SendMessage: `body` must be non-empty');

  const from = resolveSender(opts);
  const mbox = opts.mailbox ?? globalTeamMailbox;
  // Auto-create the team so the LLM doesn't need to TeamCreate first
  // for simple one-shot sends. Keep the roster empty — TeamCreate is
  // still the explicit way to set membership.
  if (!mbox.getRoster(teamName)) {
    mbox.createTeam(teamName, []);
  }
  const message = mbox.send({
    team: teamName,
    from,
    to,
    ...(subject ? { subject } : {}),
    body,
    ...(replyTo ? { replyTo } : {}),
  });
  return {
    output: `✓ sent ${message.id} → ${to} (team: ${teamName})`,
    message,
  };
}
