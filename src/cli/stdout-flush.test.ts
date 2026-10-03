import { setDefaultTimeout, expect, test } from 'bun:test';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const size = 128 * 1024;
const moduleUrl = new URL('./stdout-flush.ts', import.meta.url).href;

async function receive(script: string): Promise<{ bytes: number; text: string; status: number }> {
  const child = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stdout.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    await Bun.sleep(3); // consumer intentionally lags behind the producer
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return { bytes: Buffer.byteLength(text), text, status: await child.exited };
}

test('fully flushed 128KB stdout reaches a slow pipe and preserves exactly one terminal newline', async () => {
  const { bytes, text, status } = await receive(`import { writeStdoutFully } from '${moduleUrl}'; await writeStdoutFully('x'.repeat(${size}));`);
  expect(status).toBe(0);
  expect(bytes).toBe(size + 1);
  expect(text).toBe('x'.repeat(size) + '\n');
  const alreadyTerminated = await receive(`import { writeStdoutFully } from '${moduleUrl}'; await writeStdoutFully('x'.repeat(${size})+'\\n');`);
  expect(alreadyTerminated.bytes).toBe(size + 1);
});

test('stderr helper also waits for its callback and appends a newline only when missing', async () => {
  const result = await receive(`
    import { writeStderrFully } from '${moduleUrl}';
    const original = process.stderr.write;
    const writes = [];
    let finish;
    process.stderr.write = (text, callback) => { writes.push(text); finish = callback; return false; };
    let settled = false;
    const pending = writeStderrFully('first').then(() => { settled = true; });
    await Promise.resolve();
    if (settled || writes[0] !== 'first\\n') throw new Error('stderr did not wait for callback');
    finish();
    await pending;
    if (!settled) throw new Error('stderr callback did not settle');
    const second = writeStderrFully('second\\n');
    finish();
    await second;
    process.stderr.write = original;
    if (writes.join('|') !== 'first\\n|second\\n') throw new Error('stderr newline changed');
    process.stdout.write('ok');
  `);
  expect(result.status).toBe(0);
  expect(result.text).toBe('ok');
});

test('stdout callback is awaited rather than the write return value', async () => {
  const result = await receive(`
    import { writeStdoutFully } from '${moduleUrl}';
    const original = process.stdout.write;
    let finish;
    process.stdout.write = (text, callback) => { if (text !== 'ok\\n') throw new Error('stdout newline changed'); finish = callback; return false; };
    let settled = false;
    const pending = writeStdoutFully('ok').then(() => { settled = true; });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    if (settled || !finish) throw new Error('stdout did not wait for callback');
    finish();
    await pending;
    if (!settled) throw new Error('stdout callback did not settle');
    process.stdout.write = original;
    process.stdout.write('ok');
  `);
  expect(result.status).toBe(0);
  expect(result.text).toBe('ok');
});

test('immediate exit control can truncate the same large payload', async () => {
  const controlSize = size * 64;
  const samples = await Promise.all(Array.from({ length: 5 }, () => receive(`process.stdout.write('x'.repeat(${controlSize})+'\\n'); process.exit(0);`)));
  expect(samples.some(sample => sample.bytes < controlSize + 1)).toBe(true);
});
