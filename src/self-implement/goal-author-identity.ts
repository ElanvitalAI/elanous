const IDENTITY_LINE = /^(agent|track|session|submitted):\s*(.*?)\s*$/i;

export function repositoryIdentifiers(ask: string): string[] {
  const lines = ask.split(/\r?\n/);
  const metadata = leadingIdentityMetadata(ask);
  const body = metadata.size
    ? (lines[0]?.trim() === '---' ? lines.slice(lines.slice(1).findIndex((line) => line.trim() === '---') + 2) : lines.slice(lines.findIndex((line) => !IDENTITY_LINE.test(line))))
    : lines;
  return body
    .filter((line) => !line.startsWith('Checkable requested criterion:'))
    .join('\n')
    .match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g) ?? [];
}

function leadingIdentityMetadata(ask: string): Map<string, string> {
  const lines = ask.split(/\r?\n/);
  let candidates: string[] = [];
  if (lines[0]?.trim() === '---') {
    const end = lines.slice(1).findIndex((line) => line.trim() === '---');
    if (end < 0) return new Map();
    candidates = lines.slice(1, end + 1);
  } else if (IDENTITY_LINE.test(lines[0] ?? '')) {
    candidates = lines.slice(0, lines.findIndex((line) => !IDENTITY_LINE.test(line)) === -1
      ? lines.length
      : lines.findIndex((line) => !IDENTITY_LINE.test(line)));
  }

  const metadata = new Map<string, string>();
  for (const line of candidates) {
    const match = IDENTITY_LINE.exec(line);
    const value = match?.[2].trim();
    if (match && value && !metadata.has(match[1].toLowerCase())) metadata.set(match[1].toLowerCase(), value);
  }
  return metadata;
}

/** `submitted` 는 KST 로 적는다 — 두 트랙이 같은 벽시계를 인용해야 이력이 정렬된다. */
export function formatSubmittedAt(at: Date): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(at);
  return `${parts.replace(' ', ' ')} KST`;
}

/**
 * 신원 머리말 — **값이 있는 줄만** 낸다.
 *
 * ⛔ 빈 값·`unknown` 을 찍지 않는다: 부재와 미지가 같은 값이 되면 조회가 거짓을 생산한다.
 *    *"모르면 비워라"* 가 아니라 **"없으면 줄을 쓰지 마라"** 다.
 * ⭐ 우선순위는 **ask 에 이미 적힌 값 > 환경/시계 유도**다(호출자가 명시한 것이 이긴다).
 */
export function identityLines(ask: string, cwd: string, env: NodeJS.ProcessEnv, at: Date): string[] {
  const metadata = leadingIdentityMetadata(ask);
  const tree = /[/\\](pilot|axon)[/\\]/i.exec(cwd)?.[1]?.toLowerCase();
  const track = metadata.get('track') ?? (tree === 'pilot' ? 'S' : tree === 'axon' ? 'T' : undefined);
  const agent = metadata.get('agent') ?? env.AI_AGENT?.trim();
  const session = metadata.get('session') ?? env.CLAUDE_CODE_SESSION_ID?.trim();
  const submitted = metadata.get('submitted') ?? formatSubmittedAt(at);
  return [
    agent && `agent: ${agent}`,
    track && `track: ${track}`,
    session && `session: ${session}`,
    submitted && `submitted: ${submitted}`,
  ].filter((line): line is string => Boolean(line));
}
