import { debug } from '../debug/log.js';
import { createHash } from 'node:crypto';
import { loadMemory, memoryRoot, saveMemory } from '../memory.js';
import { findRememberRequestClause } from '../memory-intent.js';

const USER_NAME_MEMORY_ID = 'tui-user-name';

/** Persist an explicit user request before the model can promise to remember it. */
export function rememberExplicitTuiUserFact(userText: string, root: string = memoryRoot(), onFailure?: () => void): boolean {
  const statement = findRememberRequestClause(userText);
  if (!statement) return false;
  const rawName = /^(?:참고로\s+)?내\s*이름은\s+([^\n,.;!?。，！？]{1,40})/u.exec(statement)?.[1]
    ?? /^my\s+name\s+is\s+([^\n,.;!?]{1,40})/i.exec(statement)?.[1];
  const name = rawName?.trim().replace(/\s*(?:기억해(?:\s*줘)?|remember).*$/iu, '')
    .replace(/(?:이야|이에요|입니다)$/u, '').trim();
  if (!name || name.length > 40 || /[<>{}\[\]\\/]/u.test(name)) {
    // Explicit instructions in either order are stored without asking the
    // model to discover a CLI command. Questions and quoted examples are not.
    const rawFact = /^([^\n]{4,500}?)[,，]?\s+(?:기억해(?:\s*줘)?|remember this)$/iu.exec(statement)?.[1];
    const fact = rawFact?.trim().replace(/[,，.!。]+$/u, '').trim();
    if (!fact || fact.length < 4) return false;
    const id = `tui-explicit-${createHash('sha256').update(fact).digest('hex').slice(0, 16)}`;
    try {
      if (loadMemory(id, root)?.body.trim() !== fact) {
        saveMemory({ id, type: 'user', name: '명시적 사용자 기억',
          description: fact.slice(0, 80), body: fact, pinned: true }, root);
        debug.log('memory.persist', 'saved', { id, source: 'explicit-tui-request' });
      } else {
        debug.log('memory.persist', 'unchanged', { id, source: 'explicit-tui-request' });
      }
      return true;
    } catch (error) {
      debug.log('memory.persist', 'failed', { id, error: String(error) });
      onFailure?.();
      return false;
    }
  }
  const body = `사용자가 직접 알려준 이름: ${name}`;
  try {
    if (loadMemory(USER_NAME_MEMORY_ID, root)?.body.trim() === body) {
      debug.log('memory.persist', 'unchanged', { id: USER_NAME_MEMORY_ID, source: 'explicit-tui-request' });
      return true;
    }
    saveMemory({ id: USER_NAME_MEMORY_ID, type: 'user', name: '사용자 이름',
      description: '사용자가 직접 알려준 이름', body, pinned: true }, root);
    debug.log('memory.persist', 'saved', { id: USER_NAME_MEMORY_ID, source: 'explicit-tui-request' });
    return true;
  } catch (error) {
    debug.log('memory.persist', 'failed', { id: USER_NAME_MEMORY_ID, error: String(error) });
    onFailure?.();
    return false;
  }
}
