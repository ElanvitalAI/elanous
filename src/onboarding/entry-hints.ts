export const UNATTENDED_SETUP_COMMAND = 'elanous onboarding --non-interactive --config <answers.json>';
export const SKILLS_STEP_COMMAND = 'elanous onboarding skills';

export function unattendedSetupHint(): string {
  return `unattended: \`${UNATTENDED_SETUP_COMMAND}\``;
}

/** One-line next step printed after a non-TTY onboarding refusal (FIRST-CHAT-NONTTY). */
export function unattendedNextStepLine(): string {
  return `next: ${unattendedSetupHint()}`;
}

export const SKILLS_LIST_DESCRIPTION = 'List elanous skills from configured skill directories (skills.activeSet / skills.dirs and packaged skills): subdirectories and the first non-heading line of each SKILL.md. Read-only.';
