/** Count attachments that cannot be forwarded because the daemon requires a non-empty path. */
export function countDroppedAttachments(attached: readonly { path?: string }[]): number {
  return attached.filter((entry) => !(typeof entry.path === 'string' && entry.path.length > 0)).length;
}
