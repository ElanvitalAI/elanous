import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** Hidden one-line secret input, or a hidden multi-line .env paste terminated by a blank line. */
export function createSecretPrompt(input: Readable = process.stdin, output: Writable = process.stdout) {
  return async (message: string): Promise<string | undefined> => {
    const rl = createInterface({ input, output });
    const writable = rl as unknown as { _writeToOutput?: (value: string) => void };
    const original = writable._writeToOutput;
    output.write(message);
    writable._writeToOutput = () => {};
    try {
      if (!message.includes('.env')) return await new Promise((resolve) => rl.question('', resolve));
      return await new Promise<string | undefined>((resolve) => {
        const lines: string[] = [];
        let settled = false;
        const finish = (value: string | undefined) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        rl.on('line', (line) => {
          if (line.length === 0) {
            finish(lines.length > 0 ? lines.join('\n') : undefined);
            return;
          }
          lines.push(line);
        });
        rl.on('close', () => finish(lines.length > 0 ? lines.join('\n') : undefined));
      });
    } finally {
      writable._writeToOutput = original;
      rl.close();
      output.write('\n');
    }
  };
}
