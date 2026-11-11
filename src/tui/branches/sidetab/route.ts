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
  sendSelectedAgent(input: string): Promise<boolean>;
  readSelectedAgent(): Promise<string | undefined>;
  addHelp(...lines: string[]): void;
  setStatus(message: string): void;
}

/** The route registry points here; the entry only supplies generic screen operations. */
export async function runNextTuiBranchRoute(input: string, host: SidetabRouteHost): Promise<void> {
  const parts = input.slice(1).trim().split(/\s+/);
  const action = parts[1]?.toLowerCase();
  if (action === 'help') {
    host.addHelp('/side [open|close|off|on|all|workspaces|new|kill|help]', '/side agent codex|claude|hermes · /side send 내용 · /side read');
    host.setStatus('Enter 전송');
  } else if (action === 'agent') {
    const agent = parts[2]?.toLowerCase() ?? '';
    if (!isSidetabAgent(agent)) { host.setStatus('에이전트 선택: codex · claude · hermes'); return; }
    host.setEnabled(true);
    if (!host.state().open) await host.toggle();
    const id = await host.spawnSideAgent(agent);
    host.refreshRows();
    host.setStatus(id ? `${agent} 사이드탭 PTY 실행 · ${id}` : `${agent} PTY 실행 실패`);
  } else if (action === 'send') {
    const message = input.trim().replace(/^\/[\w-]+\s+send\s*/i, '');
    host.setStatus(message && await host.sendSelectedAgent(message) ? '선택한 에이전트에 입력 전송' : '에이전트 PTY 입력 실패 · 선택·실행 상태 확인');
  } else if (action === 'read') {
    const screen = await host.readSelectedAgent();
    if (screen === undefined) host.setStatus('읽을 에이전트 PTY가 없습니다');
    else { host.addHelp(...screen.split(/\r?\n/)); host.setStatus('선택한 에이전트 PTY 화면'); }
  } else if (action === 'off') {
    const wasOpen = host.state().open;
    if (wasOpen) await host.toggle();
    host.setEnabled(false);
    if (wasOpen) host.rememberOpen();
    host.setStatus('사이드탭 off · /side on 으로 이 세션에서 켜기');
  } else if (action === 'on') {
    host.setEnabled(true);
    if (host.state().rememberedOpen && !host.state().open) await host.toggle();
    host.setStatus(host.state().open ? '사이드탭 on · 열림' : '사이드탭 on · /side open 으로 열기');
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
    host.setStatus(next === 'all' ? '사이드탭 전체 목록' : next === 'workspaces' ? '사이드탭 미션·하니스 워크스페이스' : '사이드탭 현재 세션 목록');
  } else if (action === 'kill') {
    if (!await host.killSelected()) host.setStatus('종료할 PTY가 없습니다');
  } else if (action === 'new') {
    host.setEnabled(true);
    if (!host.state().open) await host.toggle();
    if (host.state().open) host.setNewMode();
  } else {
    await host.toggle();
  }
}
