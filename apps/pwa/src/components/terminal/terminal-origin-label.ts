export interface TerminalOriginInfo {
  terminalOriginCategory?: 'direct-human' | 'elanous' | 'external-tool' | 'unknown';
  terminalOriginReason?: string;
  externalToolName?: string;
}

export function terminalOriginLabel(info: TerminalOriginInfo | undefined): string {
  if (info?.terminalOriginCategory === 'direct-human') return '사람';
  if (info?.terminalOriginCategory === 'elanous') return 'elanous';
  if (info?.terminalOriginCategory === 'external-tool') return info.externalToolName ? `외부 도구: ${info.externalToolName}` : '외부 도구';
  return info?.terminalOriginReason ? `이 행에서는 알 수 없음: ${info.terminalOriginReason}` : '이 행에서는 알 수 없음';
}

export function originChipText(info: TerminalOriginInfo | undefined): string {
  return info?.terminalOriginCategory && info.terminalOriginCategory !== 'unknown'
    ? terminalOriginLabel(info)
    : '';
}

export function originTooltipText(info: TerminalOriginInfo | undefined): string {
  return `출처: ${terminalOriginLabel(info)}`;
}
