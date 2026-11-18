// els nesting rule (ELS-NESTING-RULE, 내부 문서 `SIDETAB-ONE-SPACE` «겹침 규칙»): a program running INSIDE an els pane
// is told so by its environment (`ELANOUS_ELS_SOCKET` = the socket of the server that owns the pane). A second full screen
// inside that pane would draw a frame in a frame, so bare `els` there says why and stops. Subcommands are socket requests
// and work anywhere. A shell reached over ssh has no such variable and is the outermost frame.

/** True when `env` says this process runs in a pane of the server listening on `socketPath`. */
export function insideElsPane(env: Readonly<Record<string, string | undefined>>, socketPath: string): boolean {
  const mine = env.ELANOUS_ELS_SOCKET;
  return mine !== undefined && mine !== '' && mine === socketPath;
}

export const NESTED_ELS_MESSAGE =
  'els: 이미 els 안입니다(이 pane 은 els 서버가 소유합니다) — 바깥 els 에서 ctrl+b 로 이동하세요 · `els --list` 와 하위 명령(`els new` · `els pane read` …)은 여기서도 됩니다';
