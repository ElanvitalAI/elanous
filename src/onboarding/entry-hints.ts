export const UNATTENDED_SETUP_COMMAND = 'elanous onboarding --non-interactive --config <answers.json>';
export const SKILLS_STEP_COMMAND = 'elanous onboarding skills';

export function unattendedSetupHint(): string {
  return `unattended: \`${UNATTENDED_SETUP_COMMAND}\``;
}

export const SKILLS_LIST_DESCRIPTION = 'List elanous skills from configured skill directories (skills.activeSet / skills.dirs and packaged skills): subdirectories and the first non-heading line of each SKILL.md. Read-only.';
