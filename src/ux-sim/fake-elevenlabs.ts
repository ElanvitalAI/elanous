import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export type ElevenLabsFakeMode = 'ok' | 'rate-limited';
export type FakeDelay = (milliseconds: number) => Promise<void>;

export interface ElevenLabsRequestRecord {
  method: string;
  path: string;
  text: string;
  status: number;
}

export interface FakeElevenLabsOptions {
  apiKey: string;
  mode?: ElevenLabsFakeMode;
  delayMs?: number;
  retryAfterSeconds?: number;
  delay?: FakeDelay;
}

export interface FakeElevenLabsServer {
  baseUrl: string;
  requests(): ElevenLabsRequestRecord[];
  close(): Promise<void>;
}

export interface ElevenLabsTtsInput {
  apiKey: string;
  text: string;
  mode?: ElevenLabsFakeMode;
}

export interface ElevenLabsTtsOutput {
  status: number;
  retryAfter?: string;
  bytes: Buffer;
}

export interface ElevenLabsTtsPort {
  synthesize(input: ElevenLabsTtsInput): Promise<ElevenLabsTtsOutput>;
}

// Shared contract rows: any ElevenLabs-compatible TTS port (fake or real) can satisfy these.
// Exact byte equality is fake-only and lives behind the `exactAudioBytes` option below.
export const ELEVENLABS_TTS_CONTRACT_CASES = [
  { name: 'valid-key', input: { apiKey: 'sim-key', text: 'hello' }, expected: { status: 200, audio: 'non-empty' } },
  { name: 'same-text-deterministic', input: { apiKey: 'sim-key', text: 'hello' }, expected: { status: 200, audio: 'same-as-valid-key' } },
  { name: 'invalid-key', input: { apiKey: 'wrong-key', text: 'hello' }, expected: { status: 401 } },
  { name: 'rate-limited', input: { apiKey: 'sim-key', text: 'hello', mode: 'rate-limited' }, expected: { status: 429, retryAfter: '1' } },
] as const;

export interface ElevenLabsTtsContractOptions {
  /** Fake-only stricter check: the exact bytes a successful synthesis must return for a text. */
  exactAudioBytes?: (text: string) => Buffer;
}

/** The deterministic audio bytes the fake server returns for a text (fake-specific contract). */
export function fakeElevenLabsAudioBytes(text: string): Buffer {
  return audioBytes(text);
}

function audioBytes(text: string): Buffer {
  return createHash('sha256').update(text).digest().subarray(0, 32);
}

function realDelay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function startFakeElevenLabs(options: FakeElevenLabsOptions): Promise<FakeElevenLabsServer> {
  if (!options.apiKey) throw new Error('fake ElevenLabs requires a non-empty API key');
  if (options.delayMs !== undefined && (!Number.isFinite(options.delayMs) || options.delayMs < 0)) {
    throw new Error('fake ElevenLabs delayMs must be a nonnegative finite number');
  }
  const mode = options.mode ?? 'ok';
  const delayMs = options.delayMs ?? 0;
  const wait = options.delay ?? realDelay;
  const retryAfterSeconds = options.retryAfterSeconds ?? 1;
  const calls: ElevenLabsRequestRecord[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      let text = '';
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { text?: unknown };
        if (typeof body.text === 'string') text = body.text;
      } catch {
        response.writeHead(400).end();
        return;
      }
      const status = request.headers['xi-api-key'] !== options.apiKey ? 401 : mode === 'rate-limited' ? 429 : 200;
      const record: ElevenLabsRequestRecord = { method: request.method ?? '', path: request.url ?? '', text, status };
      calls.push(record);
      void wait(delayMs).then(() => {
        if (response.destroyed) return;
        if (status === 401) response.writeHead(401, { 'content-type': 'application/json' }).end('{"detail":"invalid API key"}');
        else if (status === 429) response.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) }).end('{"detail":"rate limited"}');
        else response.writeHead(200, { 'content-type': 'audio/pcm' }).end(audioBytes(text));
      }).catch(() => {
        // The delay failed, so the client receives 500 — record the status actually sent.
        record.status = 500;
        if (!response.destroyed) response.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake ElevenLabs did not bind a loopback TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests: () => calls.map(call => ({ ...call })),
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

export async function runElevenLabsTTSContractMatrix(port: ElevenLabsTtsPort, options: ElevenLabsTtsContractOptions = {}): Promise<void> {
  let validKeyBytes: Buffer | undefined;
  for (const row of ELEVENLABS_TTS_CONTRACT_CASES) {
    const result = await port.synthesize(row.input);
    if (result.status !== row.expected.status) throw new Error(`${row.name}: expected status ${row.expected.status}, received ${result.status}`);
    if ('retryAfter' in row.expected && result.retryAfter !== row.expected.retryAfter) {
      throw new Error(`${row.name}: expected Retry-After ${row.expected.retryAfter}, received ${result.retryAfter}`);
    }
    if ('audio' in row.expected) {
      if (result.bytes.byteLength === 0) throw new Error(`${row.name}: expected non-empty audio bytes`);
      // Snapshot: a port may reuse and overwrite the same Buffer between calls.
      if (row.expected.audio === 'non-empty') validKeyBytes = Buffer.from(result.bytes);
      if (row.expected.audio === 'same-as-valid-key' && (!validKeyBytes || !result.bytes.equals(validKeyBytes))) {
        throw new Error(`${row.name}: same text did not return the same audio bytes`);
      }
      if (options.exactAudioBytes && !result.bytes.equals(options.exactAudioBytes(row.input.text))) {
        throw new Error(`${row.name}: audio bytes do not match the expected exact bytes`);
      }
    }
  }
}
