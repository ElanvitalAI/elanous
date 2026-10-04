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

export function buildDashboardStatusLines(input: DashboardStatusLinesInput): string[] {
  const known = (value?: string | null): string => value?.trim() || '모름';
  // A remote URL can contain credentials or query parameters. Neither belongs in /status.
  let address = '모름';
  if (input.daemonAddress?.trim()) {
    try {
      const url = new URL(input.daemonAddress);
      address = `${url.protocol}//${url.host}`;
    } catch {
      address = '모름';
    }
  }
  return [
    `모델: ${known(input.provider)}/${known(input.model)} (${known(input.reasoning)})`,
    `연결: 데몬 ${address} ${input.daemonConnected ? '붙음' : '안 붙음'}`,
    `계정: ${input.accountName?.trim() === 'default' ? '기본' : known(input.accountName)}`,
    ...(input.seatsNow ? [input.seatsNow] : []),
    '',
    '자세히',
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
