// Japanese message bundle.

import type { Messages } from './types.js';

export const messagesJa: Messages = {
  // Action labels
  ok: 'OK',
  cancel: 'キャンセル',
  confirm: '確認',
  yes: 'はい',
  no: 'いいえ',
  back: '戻る',
  next: '次へ',
  done: '完了',
  edit: '編集',
  retry: '再試行',
  skip: 'スキップ',
  close: '閉じる',

  // Picker / select
  search: '検索',
  noResults: '結果なし',
  selected: '選択中',
  multiSelectHint: 'スペース: 切替 · Enter: 確定',

  // Wizard step
  stepLabel: 'ステップ {n} / {total}',
  required: '必須',
  optional: '任意',
  fieldLabel: '{label}',

  // Validation
  invalidEmail: '有効なメールアドレスを入力してください。',
  invalidUrl: '有効な URL を入力してください。',
  invalidNumber: '数値を入力してください。',
  invalidPath: 'パスが無効か、存在しません。',
  invalidPort: 'ポートは 1 から 65535 の範囲で指定してください。',
  invalidJson: '入力が有効な JSON ではありません。',
  rangeError: '値は {min} から {max} の範囲で指定してください。',
  patternError: '"{value}" は想定された形式と一致しません。',

  // Chat fallback
  chatNoSynthesisLead: '回答を最後まで書けませんでした — ツールを {n} 回使ううちに、まとめる時間が尽きました。質問を絞ってもう一度聞いてください(例: ひとつだけ)。',
  chatFoldedInternalTail: '● 内部記録を折りたたみ · {n} 行 · f で展開',

  // Async + status
  loading: '読み込み中…',
  saving: '保存中…',
  saved: '保存しました。',
  failed: '失敗しました。',
  retryingIn: '{n} 秒後に再試行…',

  // Help / discovery
  pressForHelp: '? キーでヘルプ',
  topics: 'トピック',
  more: 'もっと見る',

  // Modal hints
  pressKeyToAction: '{key} キーで {action}',
  pressEnter: 'Enter を押す',
  pressEsc: 'Esc でキャンセル',

  // Markdown surface
  noContent: 'コンテンツがありません。',
  contentLoadFailed: 'コンテンツの読み込みに失敗しました。',

  // A11y descriptors
  ariaProgress: '進捗 {percent} パーセント。',
  ariaSpinner: '読み込み中: {label}',
  ariaTable: '{cols} 列 {rows} 行の表。',
  ariaPicker: '{count} 個のオプションから 1 つ選択してください。',
  ariaModal: 'ダイアログを開きました。',
  ariaWizard: 'ウィザードを開きました。',
  ariaMarkdown: 'マークダウンコンテンツ。',
  notificationLevelInfo: 'お知らせ',
  notificationLevelWarning: '警告',
  notificationLevelError: 'エラー',

  // Setup wizard — banner + completion (PR α/3 of setup-tui-overhaul)
  setupBanner: 'elanous — セットアップウィザード',
  setupWritingTo: '保存先: {path}',
  setupComplete: 'セットアップ完了',
  setupErrorReportNotice: '問題が起きると、elanous はエラーを運営チームに自動で報告します(エラー内容・バージョン・ランダムなインストール ID — 名前やメールは送りません)。オフにするには: elanous config set errorReports.enabled false',
  setupRerunHint: '再実行: {cmd}',

  // Setup wizard — Step 1 (LLM provider)
  setupStepLLMTitle: 'LLM プロバイダー',
  setupStepLLMExcerpt: 'elanous が使用する LLM プロバイダーを選択してください。各プロバイダーに API キー (または Codex の OAuth) が必要です。',

  // Setup wizard — Step 2 (Skill directories)
  setupStepSkillsTitle: 'スキルディレクトリ',
  setupStepSkillsExcerpt: '主に使用するエージェントのスキルプリセットを選択してください。「custom」で独自のパスを追加することもできます。',

  // Setup wizard — Step 3 (Obsidian vault)
  setupStepObsidianTitle: 'Obsidian ボルト',
  setupStepObsidianExcerpt: 'Obsidian ボルトのルート絶対パス。Obsidian ブラウザペインと vault-save スキルで使用されます。',
  setupStepObsidianSkipBehavior: 'スキップ → vault-save / obsidian-browser スキル無効。後で追加: `elanous setup obsidian`。',

  // Setup wizard — Step 4 (Telegram bot)
  setupStepTelegramTitle: 'Telegram ボット (オプション)',
  setupStepTelegramExcerpt: 'Telegram ボット経由で携帯電話からエージェントとチャット。',
  setupStepTelegramSkipBehavior: 'スキップ → モバイルチャット利用不可。後で追加: `elanous setup telegram`。',

  // Setup wizard — Step 5 (Discord bot)
  setupStepDiscordTitle: 'Discord ボット (オプション)',
  setupStepDiscordExcerpt: '任意の Discord サーバー / DM でエージェントとチャット。',
  setupStepDiscordSkipBehavior: 'スキップ → Discord チャット利用不可。後で追加: `elanous setup discord`。',

  // Setup wizard — Step 6 (Wrap-up · Sprint 12)
  setupWrapUpTitle: 'セットアップ完了 — 確認と保存',
  setupWrapUpExcerpt: '以下の設定を確認してください。Y / Enter で保存、またはセクション名を入力してそのステップを編集。',
  setupWrapUpReviewHelp: 'Y / Enter ↵ 保存 · n キャンセル · またはセクション名 (llm/skills/obsidian/telegram/discord/control)',
};
