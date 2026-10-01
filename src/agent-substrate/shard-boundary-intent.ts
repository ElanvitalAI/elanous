interface ShardIdentity {
  readonly shardId: string;
  readonly totalShards: number;
  readonly position: number;
  readonly summary: string;
  readonly siblings: readonly { readonly shardId: string; readonly summary: string }[];
}

const SHARD_IDENTITY_SUFFIX = /(?:^|\n)## Shard identity\r?\n([\s\S]+?)\s*$/;
const MAX_BLOCK_CHARS = 800;

/** Read the JSON footer emitted by shardIdentityFeature, without treating other goal text as identity. */
export function parseShardIdentity(goalText: string): ShardIdentity | undefined {
  const match = SHARD_IDENTITY_SUFFIX.exec(goalText);
  if (!match) return undefined;
  try {
    const value: unknown = JSON.parse(match[1]!);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
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
      })) return undefined;
    return identity as unknown as ShardIdentity;
  } catch {
    return undefined;
  }
}

/** Remove only a successfully parsed footer; malformed metadata remains ordinary goal text. */
export function withoutShardIdentity(goalText: string): string {
  return parseShardIdentity(goalText) ? goalText.replace(SHARD_IDENTITY_SUFFIX, '') : goalText;
}

function oneLine(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

/** Keep the sibling contract ahead of the goal body, with an explicit omission count. */
export function shardBoundaryBlock(identity: ShardIdentity): string {
  const prefix = [
    `이 PR 은 조각 ${oneLine(String(identity.position), 20)}/${oneLine(String(identity.totalShards), 20)}(${oneLine(identity.shardId, 80)}): ${oneLine(identity.summary, 240)}.`,
    '형제 조각이 맡는 일(예: 등록·배선·화면)이 이 PR 에 없다는 이유로 must-fix 를 내지 말 것. 없어서 이 조각이 동작하지 않으면 should-fix 로 «형제 조각 <id> 에 의존» 한 줄.',
    '형제 조각이 맡는 일:',
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
