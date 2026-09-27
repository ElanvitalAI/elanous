import { debugLog } from '@/lib/debug';

type TerminalInput = (data: string) => void;

const senders = new Map<string, { sender: TerminalInput }>();

/** Returns a cleanup that only removes this registration, even when callbacks are reused. */
export function registerTerminalInput(terminalId: string, sender: TerminalInput): () => void {
  const registration = { sender };
  senders.set(terminalId, registration);
  return () => {
    if (senders.get(terminalId) === registration) senders.delete(terminalId);
  };
}

/** Routes through the terminal's input sender, including its pre-connection queue. */
export function sendToTerminal(terminalId: string, data: string): boolean {
  const sender = senders.get(terminalId);
  if (!sender) {
    debugLog('webterm.input.no-sender', { terminalId, bytes: new TextEncoder().encode(data).length });
    return false;
  }
  sender.sender(data);
  return true;
}
