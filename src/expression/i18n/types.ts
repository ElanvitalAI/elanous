// Localized message contract — pure data, no rendering.
//
// Each `Messages` bundle is a frozen string record + a
// pluralization helper. Renderers / hosts pick the bundle via
// `getMessages(locale)` and then call `format(template, vars)` to fill
// `{name}`-style placeholders.
//
// Add a key here once you have a real consumer in mind. Resist the
// urge to predeclare — unused keys rot faster than missing ones get
// reported.

export interface Messages {
  // ── Action labels ────────────────────────────────────────────────
  ok: string;
  cancel: string;
  confirm: string;
  yes: string;
  no: string;
  back: string;
  next: string;
  done: string;
  edit: string;
  retry: string;
  skip: string;
  close: string;

  // ── Picker / select ──────────────────────────────────────────────
  search: string;
  noResults: string;
  selected: string;
  multiSelectHint: string;

  // ── Wizard step ──────────────────────────────────────────────────
  /** Template — supplies `{n}` and `{total}`. */
  stepLabel: string;
  required: string;
  optional: string;
  /** Template — supplies `{label}`. */
  fieldLabel: string;

  // ── Validation messages ──────────────────────────────────────────
  invalidEmail: string;
  invalidUrl: string;
  invalidNumber: string;
  invalidPath: string;
  invalidPort: string;
  invalidJson: string;
  /** Template — supplies `{min}` and `{max}`. */
  rangeError: string;
  /** Template — supplies `{value}`. */
  patternError: string;

  // ── Chat fallback ────────────────────────────────────────────────
  /** Template — supplies `{n}`. Optional for older locale bundles. */
  chatNoSynthesisLead?: string;
  /** Template — supplies `{n}`. Optional for older locale bundles. */
  chatFoldedInternalTail?: string;

  // ── Async + status ───────────────────────────────────────────────
  loading: string;
  saving: string;
  saved: string;
  failed: string;
  /** Template — supplies `{n}`. */
  retryingIn: string;

  // ── Help / discovery ─────────────────────────────────────────────
  pressForHelp: string;
  topics: string;
  more: string;

  // ── Modal hints ──────────────────────────────────────────────────
  /** Template — supplies `{key}` and `{action}`. */
  pressKeyToAction: string;
  pressEnter: string;
  pressEsc: string;

  // ── Markdown / docs surface ──────────────────────────────────────
  noContent: string;
  contentLoadFailed: string;

  // ── A11y descriptors ─────────────────────────────────────────────
  /** Template — supplies `{percent}`. */
  ariaProgress: string;
  /** Template — supplies `{label}`. */
  ariaSpinner: string;
  /** Template — supplies `{cols}` and `{rows}`. */
  ariaTable: string;
  /** Template — supplies `{count}`. */
  ariaPicker: string;
  ariaModal: string;
  ariaWizard: string;
  ariaMarkdown: string;
  /** Notification severity labels — used by `describeNotificationEvent`
   *  when the host asks for a localized severity word. Mapping from
   *  `NotificationKind` (8 values) to one of these 3 macro-categories
   *  lives in `expression/a11y.ts` (`notificationLevelLabel`). */
  notificationLevelInfo: string;
  notificationLevelWarning: string;
  notificationLevelError: string;

  // ── Setup wizard — banner + completion ───────────────────────────
  /** Setup wizard banner shown above the first step. */
  setupBanner: string;
  /** Template — supplies `{path}` to the on-disk config destination. */
  setupWritingTo: string;
  /** Banner shown after the wizard saves the config. */
  setupComplete: string;
  /** First-run notice that error reports are on by default — what is sent and how to turn it off. Keep the command untranslated. Optional so older bundles fall back to English. */
  setupErrorReportNotice?: string;
  /** Template — supplies `{cmd}` (typically `elanous setup`). */
  setupRerunHint: string;

  // ── Setup wizard — Step 1 (LLM provider) ─────────────────────────
  setupStepLLMTitle: string;
  setupStepLLMExcerpt: string;

  // ── Setup wizard — Step 2 (Skill directories) ────────────────────
  setupStepSkillsTitle: string;
  setupStepSkillsExcerpt: string;

  // ── Setup wizard — Step 3 (Obsidian vault) ───────────────────────
  setupStepObsidianTitle: string;
  setupStepObsidianExcerpt: string;
  /** PR-Δ4 (2026-04-28) — what happens when the user skips this step. */
  setupStepObsidianSkipBehavior: string;

  // ── Setup wizard — Step 4 (Telegram bot) ─────────────────────────
  setupStepTelegramTitle: string;
  setupStepTelegramExcerpt: string;
  setupStepTelegramSkipBehavior: string;

  // ── Setup wizard — Step 5 (Discord bot) ──────────────────────────
  setupStepDiscordTitle: string;
  setupStepDiscordExcerpt: string;
  setupStepDiscordSkipBehavior: string;

  // ── Setup wizard — Step 6 (Wrap-up · Sprint 12) ──────────────────
  /** Title of the dedicated review/save step (was inline at end of
   *  Step 6 prior to Sprint 12). */
  setupWrapUpTitle: string;
  /** Excerpt shown above the summary recap. */
  setupWrapUpExcerpt: string;
  /** Help line under the summary recap explaining the keys. */
  setupWrapUpReviewHelp: string;
}
