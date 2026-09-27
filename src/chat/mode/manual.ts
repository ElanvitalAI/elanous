// Dashboard Control Manual generator — T6-K2.
//
// When control mode is active, the LLM's turn gets this
// manual injected as an extra system message. The goal: tell the
// model exactly what it can do (tools + slashes + widgets) and
// what conventions apply (approval gates, @term/@pane refs,
// Ctrl+B chord table).
//
// The manual is assembled from live inventories:
//
//   • Native tools → native-tool-catalog (promptSummary field)
//   • Slash commands → SLASH_COMMANDS in chat.ts
//   • Widgets → supplied by the dashboard at call time
//
// That way adding a new tool / slash / widget doesn't require
// updating this file — the change propagates automatically.

import { nativeToolCatalog, type NativeToolCatalogEntry } from '../../native-tool-catalog.js';
import { SLASH_COMMANDS, type SlashCommand } from '../index.js';
import {
  buildSessionSurfaceManualSections,
  type SessionSurfaceProfile,
} from '../../session-runtime/index.js';

export interface LiveToolSummary {
  name: string;
  description: string;
}

export interface BuildControlManualOpts {
  /** Active widget ids, rendered as a one-line summary. */
  widgetIds?: string[];
  /** Current dashboard view (1-4) + active plugin name if any. */
  view?: { id: number; plugin?: string | null };
  /** Working-dir cwd (local) or "remote:/path" when remote mode is active. */
  cwdLabel?: string;
  /** User's free-text intent from `/control <intent>`. */
  intent?: string | null;
  /** Resolved live surface for this turn. */
  surface?: SessionSurfaceProfile;
  /** Whether the surface was fixed explicitly or auto-resolved. */
  surfaceSelectionMode?: 'auto' | 'fixed';
  /** Preferred fixed surface id when present. */
  preferredSurfaceId?: string | null;
  /** Live callable tools for this turn when available. */
  liveTools?: readonly LiveToolSummary[];
  /** Override catalog + slashes (tests). */
  catalog?: readonly NativeToolCatalogEntry[];
  slashes?: readonly SlashCommand[];
}

export function buildDashboardControlManual(opts: BuildControlManualOpts = {}): string {
  const catalog = opts.catalog ?? nativeToolCatalog;
  const slashes = opts.slashes ?? SLASH_COMMANDS;

  const sections: string[] = [];

  sections.push('# Dashboard Control Manual');
  sections.push('');
  sections.push(
    'You are now the **dashboard operator**. The user is talking to you not as a general chat ' +
    'assistant but as a **controller** for the Elanous Agent dashboard. Translate their ' +
    'natural-language requests into **tool calls** or **slash-command invocations**. Be ' +
    'concise — a short confirmation + the action, not an essay.',
  );
  sections.push('');

  if (opts.intent) {
    sections.push(`## Active intent`);
    sections.push(`> ${opts.intent}`);
    sections.push('');
  }

  // ── Environment snapshot ─────────────────────────────────────────
  sections.push('## Environment');
  const envLines: string[] = [];
  if (opts.cwdLabel) envLines.push(`- cwd: \`${opts.cwdLabel}\``);
  if (opts.view) envLines.push(`- view: \`${opts.view.id}\`${opts.view.plugin ? ` (plugin: ${opts.view.plugin})` : ''}`);
  if (opts.surface) envLines.push(`- surface: \`${opts.surface.id}\``);
  if (opts.surfaceSelectionMode) envLines.push(`- surface selection: \`${opts.surfaceSelectionMode}\``);
  if (opts.preferredSurfaceId) envLines.push(`- preferred surface: \`${opts.preferredSurfaceId}\``);
  if (opts.widgetIds && opts.widgetIds.length > 0) {
    envLines.push(`- widgets: ${opts.widgetIds.map(id => `\`${id}\``).join(', ')}`);
  }
  sections.push(envLines.length ? envLines.join('\n') : '- (no environment snapshot provided)');
  sections.push('');

  if (opts.surface) {
    sections.push(...buildSessionSurfaceManualSections({
      surface: opts.surface,
      surfaceSelectionMode: opts.surfaceSelectionMode,
      preferredSurfaceId: opts.preferredSurfaceId,
    }));
  }

  // ── Native tools ─────────────────────────────────────────────────
  if (opts.liveTools && opts.liveTools.length > 0) {
    sections.push(`## Live tools (${opts.liveTools.length})`);
    sections.push(
      'These are the tools callable on this turn for the current live surface. Prefer these over ' +
      'assumptions about the broader catalog.',
    );
    sections.push('');
    for (const tool of opts.liveTools) {
      sections.push(`- **${tool.name}** — ${tool.description}`);
    }
    sections.push('');
  } else if (!opts.surface) {
    sections.push(`## Native tools (${catalog.length})`);
    sections.push(
      'These are the LLM-callable primitives. Arg schemas travel with each tool call — ' +
      'use the description + promptSummary to pick the right one.',
    );
    sections.push('');
    const groups = groupToolsByHost(catalog);
    for (const [host, entries] of groups) {
      sections.push(`### ${host}`);
      for (const entry of entries) {
        const summary = entry.promptSummary ?? entry.description;
        sections.push(`- **${entry.displayName}** — ${summary}`);
      }
      sections.push('');
    }
  }

  // ── Slash commands ───────────────────────────────────────────────
  sections.push(`## Slash commands (${slashes.length})`);
  sections.push(
    'Invoke with `DashboardSlashExecute({name, args})` or — for commands that need user ' +
    'follow-up (e.g. /term spawn drops into a live PTY) — hand the command back to the ' +
    'user as a suggestion.',
  );
  sections.push('');
  for (const s of slashes) {
    const aliases = s.aliases && s.aliases.length ? ` (aliases: ${s.aliases.map(a => `/${a}`).join(', ')})` : '';
    const subs = s.subcommands && s.subcommands.length ? ` [${s.subcommands.join('|')}]` : '';
    sections.push(`- \`/${s.name}${subs}\`${aliases} — ${s.description}`);
  }
  sections.push('');

  // ── Conventions ──────────────────────────────────────────────────
  sections.push('## Conventions');
  sections.push([
    '- **Approval**: mutating tools (PaneInject, BroadcastPanes, TerminalModalInject,',
    '  DashboardConfigSet) pop a Y/N modal before write. Tell the user what you will do;',
    '  they confirm.',
    '- **References**: embed `@term:<id>` in your response to have the expander',
    '  inline the referenced session output for the LLM.',
    '- **Terminal sessions**: `/term spawn <cmd>` + `TerminalModalInject` + OSC 9/99/777',
    '  drive long-running CLI workflows.',
    '- **SSH remote mode**: Ctrl+K host picker; the browser pane then reads/writes over',
    '  ssh-fs. Transfer (scp) via the browser pane `t` chord.',
    '- **Exit control mode**: run `/control off` or `/default`. Never do this unless the',
    '  user asks — control mode persists across turns.',
  ].join('\n'));
  sections.push('');

  // ── Exit instruction ─────────────────────────────────────────────
  sections.push('## Your response shape');
  sections.push([
    '1. Interpret the user\'s command.',
    '2. Pick ONE or MORE tools / slashes to execute. Prefer tools over slashes when both',
    '   are available (tools give you structured results).',
    '3. Confirm in one sentence. Then the tool call.',
    '4. After the tool responds, surface any relevant state change or failure to the user',
    '   — again, in one sentence.',
  ].join('\n'));

  return sections.join('\n');
}

function groupToolsByHost(
  catalog: readonly NativeToolCatalogEntry[],
): Array<[string, readonly NativeToolCatalogEntry[]]> {
  const buckets = new Map<string, NativeToolCatalogEntry[]>();
  for (const entry of catalog) {
    if (!entry.defaultEnabled) continue;
    const host = entry.host[0] ?? 'all';
    const cur = buckets.get(host) ?? [];
    cur.push(entry);
    buckets.set(host, cur);
  }
  // Stable order: skill → all → other
  const order = ['skill', 'all'];
  const out: Array<[string, readonly NativeToolCatalogEntry[]]> = [];
  for (const key of order) {
    const list = buckets.get(key);
    if (list) out.push([key, list]);
    buckets.delete(key);
  }
  for (const [key, list] of buckets) out.push([key, list]);
  return out;
}
