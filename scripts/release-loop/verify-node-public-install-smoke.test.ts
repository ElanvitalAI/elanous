import { expect, test } from 'bun:test';
import { runVerify } from './verify-node.js';

const validContext = {
  input: { version: '0.2.4', previousVersion: '0.2.3' },
  outputs: {
    'docs-land': { outcome: 'ok' },
    publish: { outcome: 'ok', tag: 'v0.2.4' },
  },
};

function withGraphContext(context: typeof validContext, run: () => void): void {
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify(context);
  try { run(); }
  finally {
    if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = prior;
  }
}

test('verify invokes the public install verifier with the published version and accepts its final JSON receipt', () => {
  withGraphContext(validContext, () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = runVerify((command, args) => {
      calls.push({ command, args });
      if (command === 'curl') return { status: 0, stdout: '{"name":"elanous","dist-tags":{"latest":"0.2.4","next":"0.2.4"}}', stderr: '' };
      expect(command).toBe('bun');
      expect(args).toEqual(['bin/elanous.mjs', 'release', 'verify', '--version', '0.2.4', '--json']);
      return { status: 0, stdout: `installer output\n${JSON.stringify({ ok: true, notesPage: 'ok' })}\n`, stderr: '' };
    });

    expect(calls.some(({ command }) => command === 'bun')).toBe(true);
    expect(result.outcome).toBe('ok');
    expect(result.verdict).toBe('pass');
  });
});

test('verify refuses to start before docs deployment or when the published tag differs', () => {
  const calls: string[] = [];
  withGraphContext({ ...validContext, outputs: { ...validContext.outputs, 'docs-land': { outcome: 'fail' } } }, () => {
    expect(() => runVerify((command) => { calls.push(command); throw new Error('must not run'); }))
      .toThrow('docs must land and deploy before verify');
  });
  withGraphContext({ ...validContext, outputs: { ...validContext.outputs, publish: { outcome: 'ok', tag: 'v0.2.5' } } }, () => {
    expect(() => runVerify((command) => { calls.push(command); throw new Error('must not run'); }))
      .toThrow('published tag/version mismatch');
  });
  expect(calls).toEqual([]);
});

test('verify reports a failed install receipt even when the verifier exits successfully', () => {
  withGraphContext(validContext, () => {
    const failed = runVerify(() => ({
      status: 0,
      stdout: JSON.stringify({ ok: false, error: 'installer smoke failed', notesPage: 'missing' }),
      stderr: '',
    }));
    expect(failed).toEqual({ outcome: 'fail', verdict: 'fail', summary: 'verify failed: installer smoke failed' });
  });
});

test('verify reports a nonzero process status with an otherwise-normal receipt', () => {
  withGraphContext(validContext, () => {
    const failed = runVerify(() => ({ status: 1, stdout: JSON.stringify({ ok: true, notesPage: 'ok' }), stderr: '' }));
    expect(failed.outcome).toBe('fail');
    expect(failed.verdict).toBe('fail');
  });
});

test('verify reports an otherwise-normal receipt with a missing notes page', () => {
  withGraphContext(validContext, () => {
    const failed = runVerify(() => ({ status: 0, stdout: JSON.stringify({ ok: true, notesPage: 'missing' }), stderr: '' }));
    expect(failed.outcome).toBe('fail');
    expect(failed.verdict).toBe('fail');
  });
});

test('verify rejects incomplete command results and malformed JSON', () => {
  withGraphContext(validContext, () => {
    expect(() => runVerify(() => ({ status: 2, stdout: '', stderr: '' })))
      .toThrow('release verify incomplete:');
    expect(() => runVerify(() => ({ status: 0, stdout: 'not-json', stderr: '' })))
      .toThrow('release verify incomplete:');
  });
});
