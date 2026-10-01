export function recommendedSetup(state: { chat: { fastPath: boolean } }): [string, string] {
  return [
    '고칠 것 고치기 — 권한·PATH·서비스 파일·파이썬 환경 등 고칠 수 있는 항목을 고칩니다(로그인·서비스 재시작은 별도): `elanous doctor --fix --yes`',
    state.chat.fastPath
      ? '짧은 물음은 빠르게 — 켜져 있음(chat.fastPath=true): 짧은 물음에 도구 없이 먼저 답합니다. 끄기: `elanous config set chat.fastPath false`'
      : '짧은 물음은 빠르게 — 꺼져 있음(chat.fastPath=false): 켜면 짧은 물음에 도구 없이 먼저 답합니다. 켜기: `elanous config set chat.fastPath true`',
  ];
}
