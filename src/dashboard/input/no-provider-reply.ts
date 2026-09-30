export function noProviderReply(text: string): {
  lines: Array<{ tone: 'warning' | 'muted'; text: string }>;
  prefill: string;
} {
  const prefill = text.trim();
  return {
    lines: [
      { tone: 'warning', text: 'No LLM provider available. Run `elanous setup` or `elanous codex setup`.' },
      { tone: 'muted', text: '보내지 않았다 — 입력칸에 그대로 두었다 · setup 뒤 Enter' },
    ],
    prefill,
  };
}
