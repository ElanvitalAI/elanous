import { ChatErrorBoundary } from '@/components/chat/ChatErrorBoundary';
import { ChatPanel } from '@/components/chat/ChatPanel';

export default function ChatPage() {
  return (
    <ChatErrorBoundary>
      <ChatPanel showConversationList mobileSimple />
    </ChatErrorBoundary>
  );
}
