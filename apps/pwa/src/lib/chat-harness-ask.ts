export function harnessAskText(line: string): string | null {
  const trimmed = line.trim();
  if (/^\/harness(?:[ \t]|$)/.test(trimmed)) {
    const text = trimmed.slice('/harness'.length).trim();
    return /[\r\n]/.test(text) ? null : text;
  }
  if (/^하니스로\s/.test(trimmed)) return line;
  return null;
}

export function harnessPhaseLabel(phase: string): string {
  switch (phase) {
    case 'accepted': return '접수됨';
    case 'flow-settled': return '골 저작 끝';
    case 'launch-started': return '런 도는 중';
    case 'launch-settled': return '런 끝';
    case 'launch-failed': return '발사 실패';
    default: return '알 수 없는 단계';
  }
}

export function harnessAskSettled(phase: string): boolean {
  return phase === 'launch-settled' || phase === 'launch-failed';
}
