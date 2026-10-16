// C3 — TesseractProvider contract.
//
// The provider wraps tesseract.js's recognize() so tests inject a
// stub via `opts.recognize` and never need the WASM module installed.
// Coverage:
//   - capability declaration (offline + free + multilingual strengths)
//   - run(): happy path returns text + markdown identical
//   - run(): unsupported mime → unsupported failure
//   - run(): missing recognizer (module not installed) → unavailable
//   - run(): recognizer throws → parse failure
//   - language hint mapping (2-letter → 3-letter ISO codes)
//   - registry pick prefers Tesseract when `strengths:['offline']`
//
// Cross-ref:
//   src/ocr/tesseract.ts (SUT)
//   src/ocr/provider.ts (OcrProvider base + matchScore)

import { afterEach, describe, expect, test } from 'bun:test';

import {
  OcrRegistry,
  TESSERACT_CAPABILITIES,
  TesseractProvider,
  UpstageProvider,
  LLMVisionProvider,
  type TesseractRecognizer,
} from '../src/ocr/index.js';
import { __resetTesseractCacheForTests } from '../src/ocr/tesseract.js';

/** LLM Vision whose availability is fixed to true — the registry scoring under test, not the host's LLM config. */
class AvailableLLMVisionProvider extends LLMVisionProvider {
  override isAvailable(): boolean {
    return true;
  }
}

const samplePngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);  // PNG magic

afterEach(() => {
  __resetTesseractCacheForTests();
});

describe('TesseractProvider · capability declaration', () => {
  test('declares offline + free + multilingual strengths (C3 contract)', () => {
    expect(TESSERACT_CAPABILITIES.strengths).toContain('offline');
    expect(TESSERACT_CAPABILITIES.strengths).toContain('free');
    expect(TESSERACT_CAPABILITIES.strengths).toContain('multilingual');
  });

  test('costPerPageUsd is zero (free)', () => {
    expect(TESSERACT_CAPABILITIES.costPerPageUsd).toBe(0);
  });

  test('emits text + confidence (no html / markdown native)', () => {
    expect(TESSERACT_CAPABILITIES.outputs).toContain('text');
    expect(TESSERACT_CAPABILITIES.outputs).toContain('confidence');
    expect(TESSERACT_CAPABILITIES.outputs).not.toContain('html');
  });

  test('image inputs only (no PDF)', () => {
    expect(TESSERACT_CAPABILITIES.inputs).toEqual(['image/*']);
  });

  test('declares common languages (eng/kor/jpn/zh)', () => {
    expect(TESSERACT_CAPABILITIES.languages).toContain('eng');
    expect(TESSERACT_CAPABILITIES.languages).toContain('kor');
    expect(TESSERACT_CAPABILITIES.languages).toContain('jpn');
    expect(TESSERACT_CAPABILITIES.languages).toContain('chi_sim');
  });
});

describe('TesseractProvider.run', () => {
  test('happy path · stubbed recognizer returns text + markdown', async () => {
    const recognize: TesseractRecognizer = async () => ({
      text: '  recognized body\n',
      confidence: 92.5,
    });
    const provider = new TesseractProvider({ recognize });

    const result = await provider.run({
      file: samplePngBytes,
      filename: 'note.png',
      mimeType: 'image/png',
    });

    if (!result.ok) throw new Error(`expected ok, got ${result.message}`);
    expect(result.provider).toBe('tesseract');
    expect(result.text).toBe('recognized body');     // trimmed
    expect(result.markdown).toBe('recognized body'); // markdown == text
    expect(result.html).toBe('');
    expect(result.raw.confidence).toBe(92.5);
  });

  test('rejects non-image mime with unsupported stage', async () => {
    const recognize: TesseractRecognizer = async () => ({ text: 'should not run' });
    const provider = new TesseractProvider({ recognize });

    const result = await provider.run({
      file: samplePngBytes,
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('unsupported');
      expect(result.message).toMatch(/only accepts image/);
    }
  });

  test('returns unavailable when tesseract.js is not installed', async () => {
    // No injected recognizer + tesseract.js is not in deps → load fails.
    const provider = new TesseractProvider();

    const available = await provider.isAvailable();
    expect(available).toBe(false);

    const result = await provider.run({
      file: samplePngBytes,
      filename: 'note.png',
      mimeType: 'image/png',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('unavailable');
      expect(result.message).toMatch(/tesseract\.js is not installed/);
    }
  });

  test('recognizer throw → parse failure with provider message', async () => {
    const recognize: TesseractRecognizer = async () => {
      throw new Error('WASM oom');
    };
    const provider = new TesseractProvider({ recognize });

    const result = await provider.run({
      file: samplePngBytes,
      filename: 'note.png',
      mimeType: 'image/png',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('parse');
      expect(result.message).toMatch(/WASM oom/);
    }
  });

  test('languageHint maps 2-letter → 3-letter (ko → kor)', async () => {
    const captured: { lang: string | null } = { lang: null };
    const recognize: TesseractRecognizer = async (_input, lang) => {
      captured.lang = lang;
      return { text: '한글' };
    };
    const provider = new TesseractProvider({ recognize });

    await provider.run({
      file: samplePngBytes,
      filename: 'note.png',
      mimeType: 'image/png',
      languageHint: 'ko',
    });

    expect(captured.lang).toBe('kor');
  });

  test('omitted languageHint uses constructor default (eng+kor)', async () => {
    const captured: { lang: string | null } = { lang: null };
    const recognize: TesseractRecognizer = async (_input, lang) => {
      captured.lang = lang;
      return { text: '' };
    };
    const provider = new TesseractProvider({ recognize });

    await provider.run({
      file: samplePngBytes,
      filename: 'note.png',
      mimeType: 'image/png',
    });

    expect(captured.lang).toBe('eng+kor');
  });

  test('3-letter languageHint passes through verbatim', async () => {
    const captured: { lang: string | null } = { lang: null };
    const recognize: TesseractRecognizer = async (_input, lang) => {
      captured.lang = lang;
      return { text: '' };
    };
    const provider = new TesseractProvider({ recognize });

    await provider.run({
      file: samplePngBytes,
      filename: 'note.png',
      mimeType: 'image/png',
      languageHint: 'chi_sim',
    });

    expect(captured.lang).toBe('chi_sim');
  });
});

describe('OcrRegistry · Tesseract picker behaviour', () => {
  test('strengths:["offline"] picks Tesseract over Upstage + LLM Vision', async () => {
    const reg = new OcrRegistry();
    reg.register(new UpstageProvider());
    reg.register(new LLMVisionProvider());
    reg.register(new TesseractProvider({
      recognize: async () => ({ text: 'offline' }),
    }));

    const pick = await reg.pick({ strengths: ['offline'], outputs: ['text'] });
    expect(pick).not.toBeNull();
    expect(pick!.provider.name).toBe('tesseract');
  });

  test('strengths:["free"] picks Tesseract (cost penalty + strength boost)', async () => {
    const reg = new OcrRegistry();
    reg.register(new UpstageProvider());
    reg.register(new TesseractProvider({
      recognize: async () => ({ text: 'free' }),
    }));

    const pick = await reg.pick({ strengths: ['free'] });
    expect(pick!.provider.name).toBe('tesseract');
  });

  test('strengths:["context-aware"] still picks LLM Vision (Tesseract loses)', async () => {
    // Scoring contract, not host capability: without an image-capable default LLM (a gate Pod
    // has none) LLM Vision drops out at the availability filter and Tesseract wins by default.
    const reg = new OcrRegistry();
    reg.register(new AvailableLLMVisionProvider());
    reg.register(new TesseractProvider({
      recognize: async () => ({ text: 'should not win' }),
    }));

    const pick = await reg.pick({ strengths: ['context-aware'] });
    expect(pick!.provider.name).toBe('llm-vision');
  });
});
