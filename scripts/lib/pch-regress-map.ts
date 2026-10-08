// Paths are relative to apps/pwa, the cwd of each bun test invocation.
// Empty lists mean no existing PWA test was identified for that document slot.
export const PCH_REGRESS_MAP: Record<string, readonly string[]> = {
  'PCH-1': ['src/components/chat/ChatLayout.test.tsx', 'src/lib/chat-runtime.meta.test.ts'],
  'PCH-2': [], // Parent slot: PCH-2a (live observation) and PCH-2b (approval UI) are distinct.
  'PCH-2a': [], // Live write/approval observation is not a PWA unit test.
  'PCH-2b': ['src/components/tool-approval/use-tool-approval.test.ts', 'src/components/chat/ChatApprovalsChip.test.tsx'],
  'PCH-3': ['src/lib/chat-model-commands.test.ts'],
  'PCH-4': [], // Parent slot: daemon usage endpoint is outside apps/pwa.
  'PCH-4a': [], // Daemon usage endpoint, not a PWA test.
  'PCH-4b': ['src/lib/chat-status.test.ts', 'src/lib/chat-runtime.meta.test.ts'],
  'PCH-5': ['src/lib/chat-paste-drop.test.ts', 'src/components/chat/ChatLayout.test.tsx'],
  'PCH-6': ['src/lib/chat-queue.test.ts', 'src/components/chat/ChatLayout.test.tsx'],
  'PCH-7': ['src/lib/chat-session-commands.test.ts'],
  'PCH-8': ['src/lib/chat-harness-ask.test.ts', 'src/components/chat/HarnessAskCard.test.tsx'],
  'PCH-9': ['src/components/chat/ChatPendingDecision.test.tsx', 'src/components/chat/ChatDecisionsChip.test.tsx'],
  'PCH-10': ['src/lib/chat-runtime.meta.test.ts'], // /rewind · /undo meta commands.
  // Full fork and turn-bearing rewind/undo branches; live PWA behavior still needs observation.
  'PCH-11': ['src/lib/chat-fork.test.ts', 'src/lib/chat-branch.test.ts'],
  'PCH-12': ['src/lib/chat-runtime.run-skill.test.ts'],
  'PCH-13': ['src/components/chat/ChatConversationList.test.tsx'], // Chat search; export has no identified PWA test.
  'PCH-14': ['src/lib/compact-mode.test.ts'], // Compact; plan toggle has no identified PWA test.
  'PCH-15': ['src/components/terminal/TerminalChatDock.test.tsx'],
};
