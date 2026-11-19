import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { bunSpawnPty, writeTerminalFully } from './bun-native-pty.js';

test('verified Bun PTY write delivers every UTF-8 byte to a real raw terminal', async () => {
  const text = `\x1b[200~${'긴 입력\n'.repeat(16000)}\x1b[201~\r`;
  const bytes = Buffer.from(text);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const script = 'import os,sys,tty,hashlib; tty.setraw(0); os.write(1,b"READY\\n"); n=int(sys.argv[1]); b=b""\nwhile len(b)<n:\n c=os.read(0,min(8192,n-len(b)))\n if not c: break\n b+=c\nos.write(1,("SHA="+hashlib.sha256(b).hexdigest()+"\\n").encode())';
  const pty = bunSpawnPty('python3', ['-u', '-c', script, String(bytes.length)], { cols: 80, rows: 24 });
  let output = '';
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`PTY timed out: ${output}`)), 10000);
    pty.onData(chunk => {
      output += chunk;
      if (output.includes(`SHA=${digest}`)) { clearTimeout(timer); resolve(); }
    });
    pty.onExit(() => { if (!output.includes(`SHA=${digest}`)) { clearTimeout(timer); reject(new Error(`PTY exited: ${output}`)); } });
  });
  try {
    const readyUntil = Date.now() + 3000;
    while (!output.includes('READY') && Date.now() < readyUntil) await Bun.sleep(10);
    expect(output).toContain('READY');
    if (!pty.writeAll) throw new Error('checked write missing');
    await pty.writeAll(text);
    await done;
    expect(output).toContain(`SHA=${digest}`);
  } finally { pty.kill(); }
}, 15000);


test('partial writes preserve UTF-8 byte boundaries and fail on terminal errors', async () => {
  const received: number[] = [];
  const terminal = { closed: false, write(data: Uint8Array) { const count = Math.min(2, data.length); received.push(...data.subarray(0, count)); return count; } };
  await writeTerminalFully(terminal, '한글🙂');
  expect(Buffer.from(received).toString()).toBe('한글🙂');
  await expect(writeTerminalFully({ closed: false, write: () => -1 }, 'x')).rejects.toThrow('PTY write returned -1');
});
