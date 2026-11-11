export type BashApprovalMode = 'dangerous' | 'all';

export const DEFAULT_BASH_APPROVAL: BashApprovalMode = 'dangerous';

/** Unknown or absent values keep the conservative destructive-command gate. */
export function parseBashApprovalMode(raw: unknown): BashApprovalMode {
  return raw === 'all' ? 'all' : DEFAULT_BASH_APPROVAL;
}
