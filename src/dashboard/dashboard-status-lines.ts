export interface DashboardStatusLinesInput {
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly reasoning?: string | null;
  readonly daemonAddress?: string | null;
  readonly daemonConnected: boolean;
  readonly accountName?: string | null;
  readonly seatsNow?: string | null;
  readonly sessionSurfaceLines: readonly string[];
  readonly view: string;
  readonly focus: string;
  readonly cwd: string;
  readonly preview: string;
  readonly starterClosed: string;
  readonly chatOnly: string;
  readonly acp: string;
}

/** Detail block marker — everything from the blank line before it on is shown only with `/status --debug`. */
export const DASHBOARD_STATUS_DETAIL_HEADING = '자세히';

// F5 (TUI-COMFORT) — «연결: 데몬 모름 안 붙음» read as broken. Say what is true in plain words.
function connectionLine(address: string | null, connected: boolean): string {
  if (address) return `연결: 데몬 ${address} ${connected ? '붙음' : '안 붙음'}`;
  return connected ? '연결: 데몬 붙음' : '연결: 혼자 돎(데몬 없음)';
}

/**
 * `/status` default view: the three human lines (⊕ the seats line) only. Internal fields
 * (`surface`·`acp`·`chatOnly`…) stay behind `/status --debug`. Lines without a detail block pass through.
 */
export function dashboardStatusSummaryLines(lines: readonly string[]): string[] {
  const detail = lines.indexOf(DASHBOARD_STATUS_DETAIL_HEADING);
  if (detail < 0) return [...lines];
  const end = detail > 0 && lines[detail - 1] === '' ? detail - 1 : detail;
  return [...lines.slice(0, end), '  자세히: /status --debug'];
}

export function buildDashboardStatusLines(input: DashboardStatusLinesInput): string[] {
  const known = (value?: string | null): string => value?.trim() || '모름';
  // A remote URL can contain credentials or query parameters. Neither belongs in /status.
  let address: string | null = null;
  if (input.daemonAddress?.trim()) {
    try {
      const url = new URL(input.daemonAddress);
      address = `${url.protocol}//${url.host}`;
    } catch {
      address = null;
    }
  }
  return [
    `모델: ${known(input.provider)}/${known(input.model)} (${known(input.reasoning)})`,
    connectionLine(address, input.daemonConnected),
    `계정: ${input.accountName?.trim() === 'default' ? '기본' : known(input.accountName)}`,
    ...(input.seatsNow ? [input.seatsNow] : []),
    '',
    DASHBOARD_STATUS_DETAIL_HEADING,
    ...input.sessionSurfaceLines.map(line => `  ${line}`),
    `  view: ${input.view}`,
    `  focus: ${input.focus}`,
    `  cwd: ${input.cwd}`,
    `  preview: ${input.preview}`,
    `  starterClosed: ${input.starterClosed}`,
    `  chatOnly: ${input.chatOnly}`,
    `  acp: ${input.acp}`,
  ];
}
