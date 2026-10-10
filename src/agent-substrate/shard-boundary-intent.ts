interface ShardIdentity {
  readonly shardId: string;
  readonly totalShards: number;
  readonly position: number;
  readonly summary: string;
  readonly siblings: readonly { readonly shardId: string; readonly summary: string }[];
}

const SHARD_IDENTITY_SUFFIX = /(?:^|\n)## Shard identity\r?\n([\s\S]+?)\s*$/;
const SHARD_IDENTITY_HEADING = /(?:^|\n)## Shard identity\r?\n/g;
const ORIGINAL_ASK_FENCE = /(?:^|\n)Original ask \(verbatim, unmodified\):\r?\n(`{3,}|~{3,})[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*(?=\r?\n|$)/g;
const isInsideVerbatimAsk = (goalText: string, index: number): boolean =>
  [...goalText.matchAll(ORIGINAL_ASK_FENCE)].some((match) => index > match.index! && index < match.index! + match[0].length);
const MAX_BLOCK_CHARS = 800;
const MAX_CONTRACT_CHARS = 1400;

/** Read the emitted footer, including when a goal author preserved the entire ask in a fence. */
export function parseShardIdentity(goalText: string): ShardIdentity | undefined {
  // A suffix may start inside a verbatim-ask fence but consume the closing fence and later
  // goal sections. Try that intact suffix first; fall back only to authored ask fences.
  const suffix = [...goalText.matchAll(SHARD_IDENTITY_HEADING)].at(-1);
  const suffixText = suffix && !isInsideVerbatimAsk(goalText, suffix.index!)
    ? goalText.slice(suffix.index! + suffix[0].length).trim() : undefined;
  // A top-level footer is authoritative: if it is present but invalid, the identity is unknown —
  // never fall back to an older identity quoted in the original ask (wrong shard ownership).
  const candidates = suffixText !== undefined
    ? [suffixText]
    : [...goalText.matchAll(ORIGINAL_ASK_FENCE)].map((fence) => SHARD_IDENTITY_SUFFIX.exec(fence[2]!)?.[1]);
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const identity = value as Record<string, unknown>;
      if (typeof identity.shardId !== 'string' || !identity.shardId.trim()
        || typeof identity.summary !== 'string'
        || !Number.isInteger(identity.totalShards) || (identity.totalShards as number) < 1
        || !Number.isInteger(identity.position) || (identity.position as number) < 1
        || (identity.position as number) > (identity.totalShards as number)
        || !Array.isArray(identity.siblings)
        || !identity.siblings.every((sibling: unknown) => {
          if (!sibling || typeof sibling !== 'object' || Array.isArray(sibling)) return false;
          const item = sibling as Record<string, unknown>;
          return typeof item.shardId === 'string' && !!item.shardId.trim() && typeof item.summary === 'string';
        })) continue;
      return identity as unknown as ShardIdentity;
    } catch { /* Try the next authored identity source. */ }
  }
  return undefined;
}

/** Remove only a successfully parsed top-level suffix; never edit the verbatim original ask. */
export function withoutShardIdentity(goalText: string): string {
  const suffix = [...goalText.matchAll(SHARD_IDENTITY_HEADING)].at(-1);
  if (!suffix || isInsideVerbatimAsk(goalText, suffix.index!)) return goalText;
  const suffixText = goalText.slice(suffix.index! + suffix[0].length).trim();
  return parseShardIdentity(`## Shard identity\n${suffixText}`) ? goalText.slice(0, suffix.index) : goalText;
}

function oneLine(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

/** Keep the sibling contract ahead of the goal body, with an explicit omission count. */
export function shardBoundaryBlock(identity: ShardIdentity, opts: { handoff?: 'should-fix' | 'out-of-scope' } = {}): string {
  const prefix = [
    `이 PR 은 조각 ${oneLine(String(identity.position), 20)}/${oneLine(String(identity.totalShards), 20)}(${oneLine(identity.shardId, 80)}): ${oneLine(identity.summary, 240)}.`,
    opts.handoff === 'out-of-scope'
      // The review contract has one classification for sibling-owned work: out-of-scope → owner.
      ? '형제 조각이 맡는 일(예: 등록·배선·화면)이 이 PR 에 없다는 이유로 must-fix 를 내지 말 것 — 아래 out-of-scope 규칙으로 담당 형제에 넘긴다.'
      : '형제 조각이 맡는 일(예: 등록·배선·화면)이 이 PR 에 없다는 이유로 must-fix 를 내지 말 것. 없어서 이 조각이 동작하지 않으면 should-fix 로 «형제 조각 <id> 에 의존» 한 줄.',
    identity.siblings.length ? '형제 조각이 맡는 일:' : '형제 샤드: 없음(단일 조각). 다른 담당을 추측하지 말 것.',
  ];
  const items = identity.siblings.map((sibling) => `- ${oneLine(sibling.shardId, 80)}: ${oneLine(sibling.summary, 240)}`);
  const header = prefix.join('\n');
  if (header.length > MAX_BLOCK_CHARS) return header.slice(0, MAX_BLOCK_CHARS);
  const kept: string[] = [];
  for (const [index, item] of items.entries()) {
    const omitted = items.length - index - 1;
    const marker = omitted ? `…외 ${omitted}` : '';
    if ([...prefix, ...kept, item, ...(marker ? [marker] : [])].join('\n').length > MAX_BLOCK_CHARS) break;
    kept.push(item);
  }
  const omitted = items.length - kept.length;
  const marker = omitted ? `…외 ${omitted}` : '';
  if (marker && header.length + marker.length + 1 > MAX_BLOCK_CHARS) {
    return `${header.slice(0, MAX_BLOCK_CHARS - marker.length - 1)}\n${marker}`;
  }
  return [...prefix, ...kept, ...(marker ? [marker] : [])].join('\n');
}

/** A review-only contract: use declared scope, not guessed ownership from filenames. */
export function shardReviewContractBlock(
  goalText: string,
  identity: ShardIdentity,
  boundaries: readonly string[],
  changedFiles?: readonly string[],
): string {
  const verbatimAsk = [...goalText.matchAll(ORIGINAL_ASK_FENCE)].at(-1)?.[2];
  const declarations = (verbatimAsk ?? goalText).split(/\r?\n/);
  const targetLine = declarations.find((line) => /^대상 경로:\s*\S/.test(line));
  const preservationLine = declarations.find((line) => /^보존 계약:\s*\S/.test(line));
  const target = targetLine ?? (changedFiles?.length ? `대상 경로(변경 파일 관측 · 골 선언 아님): ${changedFiles.join(' · ')}` : '대상 경로: 골에 명시되지 않음');
  const preservation = preservationLine ?? '보존 계약: 골에 명시되지 않음';
  const fixed = [
    '샤드 계약 — 리뷰 범위',
    shardBoundaryBlock(identity, { handoff: 'out-of-scope' }),
    '범위 밖 지적은 must-fix가 아니라 out-of-scope → 담당 형제 조각 <id>로 넘긴다. 담당을 특정할 수 없으면 미지정으로 적고 추측하지 말 것.',
    'must-fix마다 이 조각의 대상 경로·수용기준 위반 근거와 반증 확인 한 줄(재현 명령 또는 확인 방법·결과)을 반드시 적을 것.',
  ];
  // Reserve the rules and sibling owners before allocating the remaining space to goal text.
  const available = Math.max(0, MAX_CONTRACT_CHARS - fixed.join('\n').length - 3);
  const scope = [target, preservation, `의도적 경계: ${boundaries.length ? boundaries.map((boundary) => boundary.replace(/^의도적 경계:\s*/, '')).join(' · ') : '골에 명시되지 않음'}`];
  // Water-fill: short lines keep their full text and hand their unused share to longer ones,
  // so a long boundary cannot truncate the declared target paths when space remains.
  const normalized = scope.map((line) => line.replace(/\s+/g, ' ').trim());
  const limits = new Array<number>(scope.length).fill(0);
  let remaining = available;
  let open = normalized.map((_, index) => index);
  while (open.length && remaining > 0) {
    const share = Math.floor(remaining / open.length);
    if (share <= 0) break;
    const next: number[] = [];
    for (const index of open) {
      const need = normalized[index]!.length - limits[index]!;
      const give = Math.min(need, share);
      limits[index]! += give;
      remaining -= give;
      if (normalized[index]!.length > limits[index]!) next.push(index);
    }
    open = next;
  }
  const scoped = normalized.map((line, index) => oneLine(line, limits[index]!));
  return [fixed[0], ...scoped, ...fixed.slice(1)].join('\n');
}
