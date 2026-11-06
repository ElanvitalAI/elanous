import { createHash } from 'node:crypto';
import type { FakeDelay } from './fake-elevenlabs.js';

export type FakeSttLanguage = 'ko' | 'en';
export interface FakeSttTranscript {
  text: string;
  language?: FakeSttLanguage;
}
export interface FakeSttInput {
  audio: Buffer;
  language?: FakeSttLanguage;
  variation?: 'failure' | 'empty';
}
export interface FakeSttOutput extends FakeSttTranscript {
  fingerprint: string;
}
export interface FakeSttRequestRecord {
  fingerprint: string;
  language?: FakeSttLanguage;
  variation?: 'failure' | 'empty';
}
export interface FakeSttOptions {
  transcripts?: Record<string, FakeSttTranscript>;
  failure?: { code: string; message: string };
  delayMs?: number;
  delay?: FakeDelay;
  emptyTranscript?: boolean;
}
export interface FakeSttPort {
  transcribe(input: FakeSttInput): Promise<FakeSttOutput>;
}

const matchingAudio = Buffer.from('fake-stt-contract-audio');
const matchingFingerprint = createHash('sha256').update(matchingAudio).digest('hex');
export const FAKE_STT_CONTRACT_CASES = [
  { name: 'matching-fingerprint', input: { audio: matchingAudio, language: 'ko' as const }, expected: { text: '안녕하세요', language: 'ko' as const } },
  { name: 'language-ko-en', input: { audio: Buffer.from('fake-stt-language-audio'), language: 'en' as const }, expected: { language: 'en' as const } },
  { name: 'empty-transcript', input: { audio: Buffer.from('fake-stt-empty-audio'), variation: 'empty' as const }, expected: { text: '', language: undefined } },
  { name: 'failure-code', input: { audio: Buffer.from('fake-stt-failure-audio'), language: 'en' as const, variation: 'failure' as const }, expected: { errorCode: 'FAKE_STT_UNAVAILABLE' } },
] as const;

export class FakeSttError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'FakeSttError';
  }
}

function realDelay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function createFakeStt(options: FakeSttOptions = {}): FakeSttPort & { requests(): FakeSttRequestRecord[] } {
  if (options.delayMs !== undefined && (!Number.isFinite(options.delayMs) || options.delayMs < 0)) {
    throw new Error('fake STT delayMs must be a nonnegative finite number');
  }
  const wait = options.delay ?? realDelay;
  const transcripts: Record<string, FakeSttTranscript> = {
    [matchingFingerprint]: { text: '안녕하세요', language: 'ko' },
    [createHash('sha256').update('fake-stt-language-audio').digest('hex')]: { text: 'hello', language: 'en' },
    ...options.transcripts,
  };
  const calls: FakeSttRequestRecord[] = [];
  return {
    async transcribe(input) {
      const fingerprint = createHash('sha256').update(input.audio).digest('hex');
      calls.push({ fingerprint, ...(input.language ? { language: input.language } : {}), ...(input.variation ? { variation: input.variation } : {}) });
      if (options.delayMs) await wait(options.delayMs);
      if (input.variation === 'failure' || (options.failure && !input.variation)) {
        const failure = options.failure ?? { code: 'FAKE_STT_UNAVAILABLE', message: 'simulated transcription failure' };
        throw new FakeSttError(failure.code, failure.message);
      }
      if (input.variation === 'empty' || options.emptyTranscript) {
        return { fingerprint, text: '', ...(input.language ? { language: input.language } : {}) };
      }
      const transcript = transcripts[fingerprint];
      if (!transcript) throw new FakeSttError('FAKE_STT_UNKNOWN_RECORDING', `no transcript fixture for sha256:${fingerprint}`);
      return { fingerprint, text: transcript.text, language: input.language ?? transcript.language };
    },
    requests: () => calls.map(call => ({ ...call })),
  };
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export async function runFakeSttContractMatrix(port: FakeSttPort): Promise<void> {
  for (const row of FAKE_STT_CONTRACT_CASES) {
    try {
      const result = await port.transcribe(row.input);
      if ('errorCode' in row.expected) throw new Error(`${row.name}: expected error ${row.expected.errorCode}`);
      if ('text' in row.expected && result.text !== row.expected.text) throw new Error(`${row.name}: expected transcript ${JSON.stringify(row.expected.text)}, received ${JSON.stringify(result.text)}`);
      if ('language' in row.expected && result.language !== row.expected.language) throw new Error(`${row.name}: expected language ${row.expected.language}, received ${result.language}`);
      if (row.name === 'matching-fingerprint' && result.fingerprint !== matchingFingerprint) throw new Error('matching-fingerprint: sha256 fingerprint mismatch');
    } catch (error) {
      if (!('errorCode' in row.expected) || errorCode(error) !== row.expected.errorCode) throw error;
    }
  }
}
