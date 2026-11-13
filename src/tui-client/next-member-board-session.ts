/** A Next REPL child asks its host for the existing authenticated member session. */
const CALL = 'elanous.member-board-session.call';
const RESULT = 'elanous.member-board-session.result';

export type MemberBoardSession = { nexusUrl: string; sessionToken: string };
export type MemberBoardSessionSource = () => MemberBoardSession | undefined;
export type MemberBoardSessionCall = { type: typeof CALL; callId: string };
export type MemberBoardSessionResult = { type: typeof RESULT; callId: string; session?: MemberBoardSession };

export function isMemberBoardSessionCall(value: unknown): value is MemberBoardSessionCall {
  const row = value as Partial<MemberBoardSessionCall> | null;
  return !!row && row.type === CALL && typeof row.callId === 'string';
}

export function answerMemberBoardSessionCall(source: MemberBoardSessionSource | null, call: MemberBoardSessionCall): MemberBoardSessionResult {
  let session: MemberBoardSession | undefined;
  try { session = source?.(); } catch { /* missing host identity stays anonymous */ }
  return { type: RESULT, callId: call.callId,
    ...(session?.nexusUrl && session.sessionToken ? { session } : {}) };
}

export function requestMemberBoardSession(
  proc: Pick<NodeJS.Process, 'send' | 'on' | 'off'> = process,
  timeoutMs = 2_000,
): Promise<MemberBoardSession | undefined> {
  if (typeof proc.send !== 'function') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const callId = crypto.randomUUID();
    const done = (session?: MemberBoardSession) => {
      clearTimeout(timer);
      proc.off('message', onMessage);
      resolve(session);
    };
    const onMessage = (value: unknown) => {
      const row = value as Partial<MemberBoardSessionResult> | null;
      if (!row || row.type !== RESULT || row.callId !== callId) return;
      const session = row.session;
      done(session && typeof session.nexusUrl === 'string' && typeof session.sessionToken === 'string'
        && session.nexusUrl && session.sessionToken ? session : undefined);
    };
    const timer = setTimeout(() => done(), timeoutMs);
    proc.on('message', onMessage);
    try { proc.send!({ type: CALL, callId } satisfies MemberBoardSessionCall); }
    catch { done(); }
  });
}
