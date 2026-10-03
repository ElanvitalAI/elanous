export const CHAT_QUEUE_LIMIT = 5;

export interface ChatQueueEntry {
  id: number;
  text: string;
}

export function enqueueChat(queue: readonly ChatQueueEntry[], entry: ChatQueueEntry): { queue: ChatQueueEntry[]; error?: string } {
  if (!entry.text.trim()) return { queue: [...queue] };
  if (queue.length >= CHAT_QUEUE_LIMIT) return { queue: [...queue], error: '줄이 찼습니다' };
  return { queue: [...queue, { ...entry, text: entry.text.trim() }] };
}

export function dequeueChat(queue: readonly ChatQueueEntry[]): { entry: ChatQueueEntry | undefined; queue: ChatQueueEntry[] } {
  return { entry: queue[0], queue: queue.slice(1) };
}

export function removeChat(queue: readonly ChatQueueEntry[], id: number): ChatQueueEntry[] {
  return queue.filter((entry) => entry.id !== id);
}

export function clearChatQueue(): ChatQueueEntry[] {
  return [];
}
