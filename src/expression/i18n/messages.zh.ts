// Simplified Chinese (zh-CN) message bundle.

import type { Messages } from './types.js';

export const messagesZh: Messages = {
  // Action labels
  ok: '确定',
  cancel: '取消',
  confirm: '确认',
  yes: '是',
  no: '否',
  back: '返回',
  next: '下一步',
  done: '完成',
  edit: '编辑',
  retry: '重试',
  skip: '跳过',
  close: '关闭',

  // Picker / select
  search: '搜索',
  noResults: '无结果',
  selected: '已选',
  multiSelectHint: '空格切换 · 回车确认',

  // Wizard step
  stepLabel: '第 {n} 步 / 共 {total} 步',
  required: '必填',
  optional: '可选',
  fieldLabel: '{label}',

  // Validation
  invalidEmail: '请输入有效的邮箱地址。',
  invalidUrl: '请输入有效的 URL。',
  invalidNumber: '请输入数字。',
  invalidPath: '路径无效或不存在。',
  invalidPort: '端口必须在 1 到 65535 之间。',
  invalidJson: '输入不是有效的 JSON。',
  rangeError: '值必须在 {min} 到 {max} 之间。',
  patternError: '"{value}" 不符合预期格式。',

  // Chat fallback
  chatNoSynthesisLead: '未能写完回答 — 在使用工具 {n} 次之后，整理的时间已用完。请缩小问题范围后再问一次(例如：只问一件事)。',
  chatFoldedInternalTail: '● 内部记录已折叠 · {n} 行 · 按 f 展开',

  // Async + status
  loading: '加载中…',
  saving: '保存中…',
  saved: '已保存。',
  failed: '失败。',
  retryingIn: '{n} 秒后重试…',

  // Help / discovery
  pressForHelp: '按 ? 查看帮助',
  topics: '主题',
  more: '更多',

  // Modal hints
  pressKeyToAction: '按 {key} 键 {action}',
  pressEnter: '按回车',
  pressEsc: '按 Esc 取消',

  // Markdown surface
  noContent: '无内容。',
  contentLoadFailed: '内容加载失败。',

  // A11y descriptors
  ariaProgress: '进度 {percent} %。',
  ariaSpinner: '加载中: {label}',
  ariaTable: '表格,{cols} 列 {rows} 行。',
  ariaPicker: '从 {count} 个选项中选择一个。',
  ariaModal: '对话框已打开。',
  ariaWizard: '向导已打开。',
  ariaMarkdown: 'Markdown 内容。',
  notificationLevelInfo: '通知',
  notificationLevelWarning: '警告',
  notificationLevelError: '错误',

  // Setup wizard — banner + completion (PR α/3 of setup-tui-overhaul)
  setupBanner: 'elanous — 设置向导',
  setupWritingTo: '保存到: {path}',
  setupComplete: '设置完成',
  setupErrorReportNotice: '出错时，elanous 会自动向运营团队报告错误(错误内容、版本和随机安装 ID — 不包含姓名或邮箱)。关闭方法: elanous config set errorReports.enabled false',
  setupRerunHint: '重新运行: {cmd}',

  // Setup wizard — Step 1 (LLM provider)
  setupStepLLMTitle: 'LLM 提供商',
  setupStepLLMExcerpt: '选择 elanous 使用的 LLM 提供商。每个提供商需要 API 密钥 (或 Codex 的 OAuth)。',

  // Setup wizard — Step 2 (Skill directories)
  setupStepSkillsTitle: '技能目录',
  setupStepSkillsExcerpt: '选择主要使用的代理技能预设。可以通过「custom」添加自己的路径。',

  // Setup wizard — Step 3 (Obsidian vault)
  setupStepObsidianTitle: 'Obsidian 仓库',
  setupStepObsidianExcerpt: 'Obsidian 仓库根目录的绝对路径。供 Obsidian 浏览器面板和 vault-save 技能使用。',
  setupStepObsidianSkipBehavior: '跳过 → vault-save / obsidian-browser 技能禁用。稍后添加: `elanous setup obsidian`。',

  // Setup wizard — Step 4 (Telegram bot)
  setupStepTelegramTitle: 'Telegram 机器人 (可选)',
  setupStepTelegramExcerpt: '通过 Telegram 机器人在手机上与代理对话。',
  setupStepTelegramSkipBehavior: '跳过 → 移动聊天不可用。稍后添加: `elanous setup telegram`。',

  // Setup wizard — Step 5 (Discord bot)
  setupStepDiscordTitle: 'Discord 机器人 (可选)',
  setupStepDiscordExcerpt: '在任意 Discord 服务器 / 私信中与代理对话。',
  setupStepDiscordSkipBehavior: '跳过 → Discord 聊天不可用。稍后添加: `elanous setup discord`。',

  // Setup wizard — Step 6 (Wrap-up · Sprint 12)
  setupWrapUpTitle: '设置完成 — 检查并保存',
  setupWrapUpExcerpt: '请检查下面的配置。按 Y / Enter 保存,或输入分节名称以编辑该步骤。',
  setupWrapUpReviewHelp: 'Y / Enter ↵ 保存 · n 取消 · 或分节名称 (llm/skills/obsidian/telegram/discord/control)',
};
