import { describe, expect, test } from 'bun:test';
import { killCorpusProcessGroup } from './corpus-process-group.js';

const signalError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

describe('corpus process group cleanup', () => {
  test('EPERM kills descendants before leader and rescans for a late child', () => {
    const calls: number[] = [];
    const snapshots = [[40, 41, 42], [43], []];
    const result = killCorpusProcessGroup(40, 'SIGKILL', {
      listMembers: () => snapshots.shift() ?? [],
      kill: (pid) => { calls.push(pid); if (pid === -40) throw signalError('EPERM'); },
    });
    expect(result).toBe('members');
    expect(calls).toEqual([-40, 41, 42, 40, 43]);
  });

  test('orphaned leader kills descendants before signaling itself', () => {
    const calls: number[] = [];
    const snapshots = [[70, 71, 72], [70]];
    const result = killCorpusProcessGroup(70, 'SIGKILL', {
      selfPid: 70,
      listMembers: () => snapshots.shift() ?? [70],
      kill: (pid) => { calls.push(pid); if (pid === -70) throw signalError('EPERM'); },
    });
    expect(result).toBe('members');
    expect(calls).toEqual([-70, 71, 72, 70]);
  });

  test('ESRCH never signals an unverified reused PID', () => {
    const calls: number[] = [];
    const result = killCorpusProcessGroup(50, 'SIGKILL', {
      kill: (pid) => { calls.push(pid); throw signalError('ESRCH'); },
    });
    expect(result).toBe('absent');
    expect(calls).toEqual([-50]);
  });

  test('unexpected group errors remain visible', () => {
    expect(() => killCorpusProcessGroup(60, 'SIGKILL', {
      kill: () => { throw signalError('EACCES'); },
    })).toThrow('EACCES');
  });
});
