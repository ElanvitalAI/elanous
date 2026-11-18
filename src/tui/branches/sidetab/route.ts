import { isSidetabAgent, type SidetabAgent } from '../../../tui-client/sidetab-agent-pty.js';

export interface SidetabRouteHost {
  state(): { open: boolean; viewMode: 'current' | 'all' | 'workspaces'; rememberedOpen: boolean };
  setEnabled(enabled: boolean): void;
  rememberOpen(): void;
  setViewMode(mode: 'current' | 'all' | 'workspaces'): void;
  setNewMode(): void;
  clearExpandedWorkspaces(): void;
  toggle(): Promise<void>;
  refreshRows(): void;
  killSelected(): Promise<boolean>;
  spawnSideAgent(agent: SidetabAgent): Promise<string | undefined>;
  /** A boolean for PTY rows; an els row answers with the reason (queued · busy · refused) so it is shown, not swallowed. */
  sendSelectedAgent(input: string): Promise<boolean | { readonly ok: boolean; readonly message: string; readonly outcome?: 'delivered' | 'queued' | 'refused' | 'unknown' }>;
  readSelectedAgent(): Promise<string | undefined>;
  /** herdr «keys»: named keys (enter esc tab backspace up down left right ctrl-c ctrl-d) to the selected agent PTY. */
  sendSelectedAgentKeys(names: readonly string[]): Promise<boolean>;
  /** herdr «status»: working · idle · blocked · waiting · done · unknown — undefined when no agent PTY is selected. */
  selectedAgentStatus(): Promise<string | undefined>;
  bindWorkspaceSelected(): Promise<boolean>;
  submitWorkspace(mode: 'terminal' | 'sidechat', text: string): Promise<{ sent: boolean; reply?: string }>;
  broadcastWorkspace(rowIds: readonly string[], text: string): Promise<{ sent: number; total: number; outcome: 'complete' | 'rejected' | 'unknown' }>;
  addHelp(...lines: string[]): void;
  setStatus(message: string): void;
}

/** The route registry points here; the entry only supplies generic screen operations. */
export async function runNextTuiBranchRoute(input: string, host: SidetabRouteHost): Promise<void> {
  const parts = input.slice(1).trim().split(/\s+/);
  const action = parts[1]?.toLowerCase();
  if (action === 'help') {
    // One command family per line: a single long line was cut at 140 columns and hid /side status.
    host.addHelp('/side [open|close|off|on|all|workspaces|new|kill|help]', '/side agent codex|claude|hermes · /side send text · /side read · /side status',
      '/side keys enter|esc|tab|up|down|left|right|backspace|ctrl-c|ctrl-d …',
      '/side bind · /side chat text · /side terminal text · /side broadcast rowIds -- text');
    host.setStatus('Enter sends');
  } else if (action === 'bind') {
    host.setStatus(await host.bindWorkspaceSelected() ? 'Workspace PTY bound' : 'Select a running PTY row of the workspace');
  } else if (action === 'chat' || action === 'terminal') {
    const text = input.trim().replace(/^\/[\w-]+\s+(?:chat|terminal)\s*/i, '');
    if (!text) { host.setStatus('Workspace input is empty'); return; }
    try {
      const result = await host.submitWorkspace(action === 'chat' ? 'sidechat' : 'terminal', text);
      if (result.reply) host.addHelp(result.reply);
      host.setStatus(result.sent ? (action === 'chat' ? 'Workspace side-chat reply' : 'Workspace PTY sent') : 'Workspace PTY send refused · check target');
    } catch (error) {
      host.setStatus(error instanceof Error && 'code' in error && error.code === 'WORKSPACE_TERMINAL_OUTCOME_UNKNOWN'
        ? 'Workspace PTY send unconfirmed · do not retry before checking target screen and history'
        : `Workspace input stopped · ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (action === 'broadcast') {
    const match = /^\/side\s+broadcast\s+([^\s]+)\s+--\s+([\s\S]+)$/i.exec(input.trim());
    if (!match) { host.setStatus('Usage: /side broadcast rowIds -- text'); return; }
    try {
      const result = await host.broadcastWorkspace(match[1]!.split(',').filter(Boolean), match[2]!);
      host.setStatus(result.outcome === 'unknown'
        ? `Workspace sent ${result.sent}/${result.total} · last send unconfirmed, no retry before PTY check`
        : `Workspace sent ${result.sent}/${result.total} · ${result.outcome === 'complete' ? 'complete' : 're-check refused targets'}`);
    } catch (error) { host.setStatus(`Workspace broadcast stopped · ${error instanceof Error ? error.message : String(error)}`); }
  } else if (action === 'agent') {
    const agent = parts[2]?.toLowerCase() ?? '';
    if (!isSidetabAgent(agent)) { host.setStatus('Agent choice: codex · claude · hermes'); return; }
    host.setEnabled(true);
    if (!host.state().open) await host.toggle();
    const id = await host.spawnSideAgent(agent);
    host.refreshRows();
    host.setStatus(id ? `${agent} sidetab PTY started · ${id}` : `${agent} PTY start failed`);
  } else if (action === 'send') {
    const message = input.trim().replace(/^\/[\w-]+\s+send\s*/i, '');
    const sent = message ? await host.sendSelectedAgent(message) : false;
    if (typeof sent === 'object') {
      // «unknown» is neither a success nor a failure: it is never worded as sent or queued.
      host.setStatus(sent.outcome === 'unknown' ? `Input status unknown · ${sent.message}`
        : sent.outcome === 'queued' ? `Input queued in the pane · ${sent.message}`
        : sent.ok ? `Input sent to selected agent · ${sent.message}` : `Input not sent · ${sent.message}`);
    }
    else host.setStatus(sent ? 'Input sent to selected agent' : 'Agent PTY input failed · check selection/run state');
  } else if (action === 'read') {
    const screen = await host.readSelectedAgent();
    if (screen === undefined) host.setStatus('No agent PTY to read');
    else { host.addHelp(...screen.split(/\r?\n/)); host.setStatus('Selected agent PTY screen'); }
  } else if (action === 'keys') {
    const names = parts.slice(2).filter(Boolean);
    if (names.length === 0) { host.setStatus('Keys: enter esc tab up down left right backspace ctrl-c ctrl-d'); return; }
    host.setStatus(await host.sendSelectedAgentKeys(names) ? `Keys sent to selected agent · ${names.join(' ')}`
      : 'Keys not sent · unknown key name, or no live agent PTY selected');
  } else if (action === 'status') {
    const status = await host.selectedAgentStatus();
    host.setStatus(status === undefined ? 'No agent PTY selected' : `Selected agent · ${status}`);
  } else if (action === 'off') {
    const wasOpen = host.state().open;
    if (wasOpen) await host.toggle();
    host.setEnabled(false);
    if (wasOpen) host.rememberOpen();
    host.setStatus('Sidetab off · /side on to enable for this session');
  } else if (action === 'on') {
    host.setEnabled(true);
    if (host.state().rememberedOpen && !host.state().open) await host.toggle();
    host.setStatus(host.state().open ? 'Sidetab on · open' : 'Sidetab on · /side open to open');
  } else if (action === 'open') {
    host.setEnabled(true);
    if (!host.state().open) await host.toggle();
  } else if (action === 'close') {
    if (host.state().open) await host.toggle();
  } else if (action === 'all' || action === 'workspaces') {
    host.clearExpandedWorkspaces();
    const mode = host.state().viewMode;
    const next = action === 'all' ? (mode === 'all' ? 'current' : 'all') : (mode === 'workspaces' ? 'current' : 'workspaces');
    host.setViewMode(next);
    host.setEnabled(true);
    if (!host.state().open) await host.toggle();
    else host.refreshRows();
    host.setStatus(next === 'all' ? 'Sidetab full list' : next === 'workspaces' ? 'Sidetab mission·harness workspaces' : 'Sidetab current-session list');
  } else if (action === 'kill') {
    if (!await host.killSelected()) host.setStatus('No PTY to kill');
  } else if (action === 'new') {
    host.setEnabled(true);
    if (!host.state().open) await host.toggle();
    if (host.state().open) host.setNewMode();
  } else {
    await host.toggle();
  }
}
