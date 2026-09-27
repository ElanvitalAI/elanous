/** Environment interruptions have a resumable branch, not a human draft decision. */
export function blockedDraftDisposition(classification: string | undefined): 'open-draft' | 'preserve-branch' {
  return classification === 'provider-error' || classification === 'quota-exhausted' || classification === 'credential-failure'
    ? 'preserve-branch'
    : 'open-draft';
}
