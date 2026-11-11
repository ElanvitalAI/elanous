/** Whether the current host can provide an interactive terminal. */
export function dashboardCanUseTty(stdin: { isTTY?: boolean } = process.stdin): boolean {
  return stdin.isTTY === true;
}

/** Preserve the established refusal text while callers migrate off the dashboard path. */
export function dashboardTtyRefusalMessage(): string {
  return [
    'elanous 대시보드는 stdin TTY가 있는 자리에서만 뜰 수 있다.',
    '  지금 stdin 이 TTY 가 아니다(파이프·리다이렉트·비대화형 실행).',
    '  ⛔ 그대로 띄우면 키를 못 읽고 화면만 초당 수백 번 다시 그린다.',
    '  ✅ 한 줄 물어보기 :  elanous ask "<질문>"',
    '  ✅ 이어서 대화하기:  elanous repl',
    '  ✅ 터미널에서 직접 :  elanous        (파이프 없이)',
  ].join('\n');
}
