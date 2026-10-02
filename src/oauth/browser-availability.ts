// OB5d — 브라우저를 열 수 없는 세션이면 «왜 못 여는지 ⊕ 대안»을 한 줄로 말한다(대표 10-01 node-c 실측: ssh 에서 아무 말 없이 기기 코드로 갔다).
// null = 이 세션에서 브라우저 로그인을 먼저 시도해도 된다.
export function browserUnavailableReason(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const ssh = !!(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
  if (platform === 'darwin' || platform === 'win32') {
    if (!ssh) return null;
    const where = platform === 'darwin' ? '이 Mac' : '이 PC';
    return `원격(ssh) 접속이라 브라우저 로그인을 마칠 수 없습니다 — ${where} 화면의 터미널에서 같은 명령을 실행하면 브라우저가 바로 열립니다(붙여넣기 없이). 지금은 아래 코드로 로그인합니다.`;
  }
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return null;
  return ssh
    ? '원격(ssh) 접속이고 화면이 없어 브라우저를 열 수 없습니다 — 아무 기기의 브라우저에서 아래 주소를 열고 코드를 넣으세요.'
    : '화면(디스플레이)이 없는 세션이라 브라우저를 열 수 없습니다 — 아무 기기의 브라우저에서 아래 주소를 열고 코드를 넣으세요.';
}
