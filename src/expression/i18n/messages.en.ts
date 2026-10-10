// English message bundle.

import type { Messages } from './types.js';

export const messagesEn: Messages = {
  // Action labels
  ok: 'OK',
  cancel: 'Cancel',
  confirm: 'Confirm',
  yes: 'Yes',
  no: 'No',
  back: 'Back',
  next: 'Next',
  done: 'Done',
  edit: 'Edit',
  retry: 'Retry',
  skip: 'Skip',
  close: 'Close',

  // Picker / select
  search: 'Search',
  noResults: 'No results',
  selected: 'selected',
  multiSelectHint: 'Space to toggle · Enter to confirm',

  // Wizard step
  stepLabel: 'Step {n} of {total}',
  required: 'required',
  optional: 'optional',
  fieldLabel: '{label}',

  // Validation
  invalidEmail: 'Please enter a valid email address.',
  invalidUrl: 'Please enter a valid URL.',
  invalidNumber: 'Please enter a number.',
  invalidPath: 'Path is invalid or does not exist.',
  invalidPort: 'Port must be between 1 and 65535.',
  invalidJson: 'Input is not valid JSON.',
  rangeError: 'Value must be between {min} and {max}.',
  patternError: '"{value}" does not match the expected pattern.',

  // Chat fallback
  chatNoSynthesisLead: 'I could not finish the answer — the time to summarize ran out after {n} tool calls. Please ask a narrower question (for example, just one thing).',
  chatFoldedInternalTail: '● Internal notes folded · {n} lines · press f to expand',

  // Async + status
  loading: 'Loading…',
  saving: 'Saving…',
  saved: 'Saved.',
  failed: 'Failed.',
  retryingIn: 'Retrying in {n}s…',

  // Help / discovery
  pressForHelp: 'Press ? for help',
  topics: 'Topics',
  more: 'more',

  // Modal hints
  pressKeyToAction: 'Press {key} to {action}',
  pressEnter: 'Press Enter',
  pressEsc: 'Press Esc to cancel',

  // Markdown surface
  noContent: 'No content.',
  contentLoadFailed: 'Failed to load content.',

  // A11y descriptors
  ariaProgress: 'Progress: {percent} percent.',
  ariaSpinner: 'Loading: {label}',
  ariaTable: 'Table with {cols} columns and {rows} rows.',
  ariaPicker: 'Choose one of {count} options.',
  ariaModal: 'Dialog opened.',
  ariaWizard: 'Wizard opened.',
  ariaMarkdown: 'Markdown content.',
  notificationLevelInfo: 'info',
  notificationLevelWarning: 'warning',
  notificationLevelError: 'error',

  // Setup wizard — banner + completion
  setupBanner: 'elanous — setup wizard',
  setupWritingTo: 'Writing to: {path}',
  setupComplete: 'Setup complete',
  setupErrorReportNotice: 'If something breaks, elanous reports the error to our team automatically (error details, version and a random install ID — never your name or email). To turn it off: elanous config set errorReports.enabled false',
  setupRerunHint: 'Re-run: {cmd}',

  // Setup wizard — Step 1 (LLM provider)
  setupStepLLMTitle: 'LLM provider',
  setupStepLLMExcerpt: 'Pick the LLM provider elanous will route turns to. Each provider needs an API key (or OAuth for Codex).',

  // Setup wizard — Step 2 (Skill directories)
  setupStepSkillsTitle: 'Skill directories',
  setupStepSkillsExcerpt: 'Pick the agent whose skills you mainly use — this becomes the active preset. You can add more dirs (or pick "custom" for your own paths) afterwards.',

  // Setup wizard — Step 3 (Obsidian vault)
  setupStepObsidianTitle: 'Obsidian vault',
  setupStepObsidianExcerpt: 'Absolute path to your Obsidian vault root. Used by the Obsidian browser pane and vault-save skills.',
  setupStepObsidianSkipBehavior: 'Skip → vault-save / obsidian-browser skills disabled. Add later: `elanous setup obsidian`.',

  // Setup wizard — Step 4 (Telegram bot)
  setupStepTelegramTitle: 'Telegram bot (optional)',
  setupStepTelegramExcerpt: 'Chat with your agent from your phone via a Telegram bot.',
  setupStepTelegramSkipBehavior: 'Skip → mobile chat unavailable. Add later: `elanous setup telegram`.',

  // Setup wizard — Step 5 (Discord bot)
  setupStepDiscordTitle: 'Discord bot (optional)',
  setupStepDiscordExcerpt: 'Chat with your agent in any Discord server / DM.',
  setupStepDiscordSkipBehavior: 'Skip → Discord chat unavailable. Add later: `elanous setup discord`.',

  // Setup wizard — Step 6 (Wrap-up · Sprint 12)
  setupWrapUpTitle: 'Setup Complete — Review & Save',
  setupWrapUpExcerpt: 'Review your config below. Press Y / Enter to save, or type a section name to edit just that step.',
  setupWrapUpReviewHelp: 'Y / Enter ↵ save · n cancel · or section name (llm/skills/obsidian/telegram/discord/control)',
};
