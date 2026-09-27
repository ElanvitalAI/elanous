import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { displayedSlashCommandNames } from '../src/chat/index.js';
import { defaultTelegramCommands, dispatchTelegramSlash, type TgCommandContext } from '../src/telegram-commands.js';
import { classifyIntake } from '../src/ad-pipeline/intake.js';
import { createAdPipelineDeps, runAdPipeline, type AdPipelinePlan } from '../src/ad-pipeline/run.js';
import { formatAdProductionWarnings } from '../src/index.js';
import { buildDashboardSlashRegistry } from '../src/dashboard/slash-runtime/index.js';

const incoming = (text: string) => ({ text, chatId: 1, userId: 2, botId: 'bot' }) as any;
const gates = ['BRIEF_OK', 'MASTER_PICK', 'PACK_OK', 'VIDEO_OK'];

function commandContext(overrides: Partial<TgCommandContext> = {}): TgCommandContext {
  return {
    userConfig: { llm: {}, skills: {}, acp: {} } as any,
    allCommands: defaultTelegramCommands(),
    ...overrides,
  };
}

type ApprovalRequest = { prompt: string; detail?: string; yesLabel?: string; noLabel?: string };

function approvalChannel(answers: readonly boolean[], seen: ApprovalRequest[]) {
  let index = 0;
  return {
    name: 'telegram',
    request: async (request: { prompt: string; detail?: string }) => {
      seen.push(request);
      return answers[index++] ?? false;
    },
    cancel: () => {},
  };
}

async function dispatchAd(input: string, answers: readonly boolean[], opts: Partial<TgCommandContext> = {}) {
  const requests: ApprovalRequest[] = [];
  const result = await dispatchTelegramSlash(incoming(input), commandContext({
    hitlConfirmChannel: approvalChannel(answers, requests),
    ...opts,
  }));
  return { result, requests };
}

describe('/ad surface wiring', () => {
  test('terminal warning names every unwired production step before JSON output', () => {
    const warnings = formatAdProductionWarnings({ unwiredProduction: ['ground', 'render'] } as Pick<AdPipelinePlan, 'unwiredProduction'>);

    expect(warnings).toEqual(['⚠️ 이 실행은 마스터를 만들 수 없습니다 — 미배선 제작 단계: ground, render']);
  });

  test('terminal warning is absent when all production steps are wired', () => {
    expect(formatAdProductionWarnings({ unwiredProduction: [] } as Pick<AdPipelinePlan, 'unwiredProduction'>)).toEqual([]);
  });

  test('TUI catalog exposes ad and the dashboard dispatcher consumes the same catalog name', () => {
    expect(displayedSlashCommandNames()).toContain('ad');
    const registry = buildDashboardSlashRegistry();
    expect(registry.names()).toContain('ad');
  });

  test('Telegram dispatcher forwards the exact text brief to the shared intake boundary', async () => {
    const brief = 'summer launch brief — keep  two  spaces';
    const { result, requests } = await dispatchAd(`/ad ${brief}`, [false]);

    expect(result).toEqual({ handled: true, reply: 'Advertising pipeline stopped at BRIEF_OK.' });
    expect(requests).toEqual([{ prompt: 'Approve advertising gate BRIEF_OK?', detail: 'Input: text', yesLabel: 'Approve', noLabel: 'Reject' }]);
  });

  test('Telegram dispatcher preserves a standalone URL as URL intake before fail-closed grounding', async () => {
    const url = 'https://example.com/product';
    const { result, requests } = await dispatchAd(`/ad ${url}`, [true, true, true, true]);

    expect(result).toEqual({ handled: true, reply: expect.stringContaining('blocked') });
    expect(requests).toEqual([]);
  });

  test('Telegram attachment dispatch selects image intake without writing into the repository', async () => {
    const { result, requests } = await dispatchAd('/ad', [false], {
      downloadAttachments: async () => [{ kind: 'photo', localPath: '/tmp/product.jpg', name: 'product.jpg' }],
    });

    expect(result).toEqual({ handled: true, reply: 'Advertising pipeline stopped at BRIEF_OK.' });
    expect(requests).toEqual([{ prompt: 'Approve advertising gate BRIEF_OK?', detail: 'Input: image', yesLabel: 'Approve', noLabel: 'Reject' }]);
  });

  test('approved Telegram pipeline reports readiness from the shared result', async () => {
    const input = '/ad launch brief';
    const classified = classifyIntake({ values: ['launch brief'], imagePaths: [] });
    expect(classified.ok).toBe(true);
    if (!classified.ok) return;

    const expected = await runAdPipeline(classified.intake, createAdPipelineDeps({
      ask: async () => true,
      report: () => {},
    }));
    expect(expected.status).toBe('gates-approved');
    if (expected.status !== 'gates-approved') return;

    const needsInput = expected.productionReadiness
      .filter((step) => step.status === 'needs-input')
      .map((step) => `${step.step} (${step.missing})`);
    const unwired = expected.productionReadiness
      .filter((step) => step.status === 'unwired')
      .map((step) => step.step);
    const reply = `Advertising gates approved; ${[
      needsInput.length ? `production incomplete: ${needsInput.join(', ')}` : '',
      unwired.length ? `not yet implemented: ${unwired.join(', ')}` : '',
    ].filter(Boolean).join('; ') || 'production ready'}.`;

    const { result } = await dispatchAd(input, gates.map(() => true));
    expect(result).toEqual({ handled: true, reply });
    expect(reply).not.toContain('production remains unwired');
    expect(needsInput.map((step) => step.slice(step.indexOf('(') + 1, -1))).toEqual(
      expect.arrayContaining(['page facts', 'shoot backend', 'render command runner']),
    );
    expect(unwired).toContain('expand');
    expect(reply).toContain('not yet implemented: expand');
    expect(reply.length).toBeLessThanOrEqual(600);
  });

  test('missing approval channel fails closed before any approved stage', async () => {
    const result = await dispatchTelegramSlash(incoming('/ad launch brief'), commandContext());
    expect(result).toEqual({ handled: true, reply: 'Advertising pipeline stopped at BRIEF_OK.' });
  });

  for (const [rejectedIndex, rejectedGate] of gates.entries()) {
    test(`Telegram rejection at ${rejectedGate} stops after only prior approvals`, async () => {
      const { result, requests } = await dispatchAd('/ad launch brief', gates.map((_, index) => index !== rejectedIndex));
      expect(result).toEqual({ handled: true, reply: `Advertising pipeline stopped at ${rejectedGate}.` });
      expect(requests.map((request) => request.prompt)).toEqual(
        gates.slice(0, rejectedIndex + 1).map((gate) => `Approve advertising gate ${gate}?`),
      );
    });
  }

  test('surface modules call the shared entrypoint without duplicating pipeline constants', () => {
    const telegram = readFileSync(new URL('../src/telegram-commands.ts', import.meta.url), 'utf8');
    const chat = readFileSync(new URL('../src/chat/index.ts', import.meta.url), 'utf8');
    expect(telegram).toContain("import { createAdPipelineDeps, runAdPipeline } from './ad-pipeline/run.js'");
    expect(telegram).toContain('runAdPipeline(classified.intake, createAdPipelineDeps({');
    for (const gate of gates) {
      expect(telegram).not.toContain(`'${gate}'`);
      expect(chat).not.toContain(`'${gate}'`);
    }
    expect(telegram).not.toContain('failOpen');
    expect(chat).not.toContain('failOpen');
  });
});
