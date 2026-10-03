import { MAX_CHAT_FILES } from '@/lib/chat-paste-drop';

export function ChatDropOverlay() {
  return (
    <div
      role="status"
      aria-label="여기에 놓으면 첨부"
      data-elanous-chat-drop-overlay=""
      className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-background/80 backdrop-blur-sm"
    >
      <div className="mx-4 rounded-2xl border-2 border-dashed border-primary/60 bg-card/90 px-8 py-6 text-center shadow-lg">
        <p className="text-lg font-semibold text-foreground">여기에 놓으면 첨부</p>
        <p className="mt-2 text-sm text-muted-foreground">파일 {MAX_CHAT_FILES}개까지 · 큰 파일은 빠집니다</p>
      </div>
    </div>
  );
}
