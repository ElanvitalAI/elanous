import { afterEach, describe, expect, test } from 'bun:test';
import { externalWriteProvenance, forgetExternalWriteProvenance, noteExternalWrite, notePtyAccessMode, ptyWriteControlState } from './pty-write-provenance.js';

describe('PTY write control provenance', () => {
  const ptyId = 'pty:sidetab-control-provenance';

  afterEach(() => forgetExternalWriteProvenance(ptyId));

  test('preserves the access mode and updates the actor only for recorded successful writes', () => {
    notePtyAccessMode(ptyId, 'auto');
    expect(ptyWriteControlState(ptyId)).toEqual({ accessMode: 'auto', lastWriter: null });
    expect(externalWriteProvenance(ptyId)).toBeUndefined();

    noteExternalWrite(ptyId, 'agent', 100);
    expect(ptyWriteControlState(ptyId)).toEqual({ accessMode: 'auto', lastWriter: 'agent' });
    expect(externalWriteProvenance(ptyId, 150)).toEqual({
      externalWrites: 1,
      externalWriteAgoMs: 50,
      externalWriteActor: 'agent',
    });

    notePtyAccessMode(ptyId, 'write');
    expect(ptyWriteControlState(ptyId)).toEqual({ accessMode: 'write', lastWriter: 'agent' });
    noteExternalWrite(ptyId, 'human', 200);
    expect(ptyWriteControlState(ptyId)).toEqual({ accessMode: 'write', lastWriter: 'human' });
  });
});
