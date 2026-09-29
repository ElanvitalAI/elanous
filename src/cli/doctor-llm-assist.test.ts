import { expect, test } from 'bun:test';
import { adviseDoctorFixes } from './doctor-llm-assist.js';
import type { DoctorFixPlan } from './doctor-fix.js';

const report = { items: [
  { id: 'harness-tools', status: 'manual' as const, evidence: 'missing rg' },
  { id: 'service-file', status: 'fixable' as const, evidence: 'unstable path' },
  { id: 'gh-auth', status: 'manual' as const, evidence: 'git missing' },
] };
const plan: DoctorFixPlan = { items: [{ id: 'static-tools', status: 'fixable', path: '/bin', action: 'install pinned rg' }], manual: [] };

test('localizes prose instructions while preserving English JSON keys and repair ids', async () => {
  for (const [locale, language] of [['en', 'English'], ['ko', 'Korean'], ['ja', 'Japanese'], ['zh', 'Chinese']] as const) {
    let instruction = '';
    const result = await adviseDoctorFixes({ report, plan, locale, llm: async (prompt) => {
      instruction = JSON.parse(prompt).instruction;
      return JSON.stringify({ summary: 'summary', order: [{ readinessId: 'harness-tools', fixId: 'static-tools', why: 'why' }], manual: ['manual'] });
    } });
    expect(instruction).toContain(`Write summary, why and manual in ${language}.`);
    expect(instruction).toContain('Keep JSON keys and repair ids in English.');
    expect(result.order).toEqual([{ readinessId: 'harness-tools', fixId: 'static-tools', why: 'why' }]);
  }
  let fallback = '';
  await adviseDoctorFixes({ report, plan, llm: async (prompt) => { fallback = JSON.parse(prompt).instruction; return '{"summary":"ok","order":[],"manual":[]}'; } });
  expect(fallback).toContain('Write summary, why and manual in English.');
});

test('accepts only planned repairs and git-install, drops absent and unknown suggestions', async () => {
  const result = await adviseDoctorFixes({ report, plan, llm: async () => JSON.stringify({
    summary: 'fix the blocker', order: [
      { readinessId: 'harness-tools', fixId: 'static-tools', why: 'first' },
      { readinessId: 'service-file', fixId: 'service-file', why: 'not in plan' },
      { readinessId: 'service-file', fixId: 'rm-rf', why: 'unknown' },
      { readinessId: 'gh-auth', fixId: 'git-install', why: 'next' },
    ], manual: ['login manually'],
  }) });
  expect(result.order).toEqual([
    { readinessId: 'harness-tools', fixId: 'static-tools', why: 'first' },
    { readinessId: 'gh-auth', fixId: 'git-install', why: 'next' },
  ]);
  expect(result.dropped).toBe(2);
  expect(result.manual).toEqual(['login manually']);
});

test('a planned service-file repair is still outside the explicit advice allowlist', async () => {
  const servicePlan: DoctorFixPlan = { items: [{ id: 'service-file', status: 'fixable', path: '/unit.service', action: 'rewrite unit' }], manual: [] };
  const result = await adviseDoctorFixes({ report, plan: servicePlan, llm: async () => JSON.stringify({
    summary: 'rewrite', order: [{ readinessId: 'service-file', fixId: 'service-file', why: 'candidate' }], manual: [],
  }) });
  expect(result.order).toEqual([]);
  expect(result.dropped).toBe(1);
});

test('duplicate repair IDs and readiness IDs are discarded without executing anything', async () => {
  const result = await adviseDoctorFixes({ report, plan, llm: async () => JSON.stringify({ summary: 'ok', order: [
    { readinessId: 'harness-tools', fixId: 'static-tools', why: 'first' },
    { readinessId: 'service-file', fixId: 'static-tools', why: 'duplicate fix' },
    { readinessId: 'harness-tools', fixId: 'git-install', why: 'duplicate readiness' },
  ], manual: [] }) });
  expect(result.order).toHaveLength(1);
  expect(result.dropped).toBe(2);
});

test('redacts OpenRouter key values in readiness evidence and remedies before the LLM sees the prompt', async () => {
  const secret = `sk-or-v1-${'a'.repeat(64)}`;
  let prompt = '';
  const result = await adviseDoctorFixes({
    report: { items: [{ id: 'provider-decision', status: 'manual', evidence: `OPENROUTER_API_KEY=${secret}`, remedy: `check ${secret}` }] },
    plan, llm: async (text) => { prompt = text; return '{"summary":"ok","order":[],"manual":[]}'; },
  });
  expect(result.ok).toBe(true);
  expect(prompt).toContain('OPENROUTER_API_KEY');
  expect(prompt).not.toContain(secret);
  expect(prompt).not.toContain('a'.repeat(64));
});

test('redacts secret-shaped values in every prompt field, including the catalog action', async () => {
  const secret = `sk-or-v1-${'b'.repeat(64)}`;
  let prompt = '';
  const sensitivePlan: DoctorFixPlan = { items: [{ ...plan.items[0]!, action: `OPENROUTER_API_KEY=${secret}` }], manual: [] };
  await adviseDoctorFixes({ report, plan: sensitivePlan, llm: async (text) => { prompt = text; return '{"summary":"ok","order":[],"manual":[]}'; } });
  expect(prompt).not.toContain(secret);
});

test('unavailable, invalid JSON, failure and timeout fail closed', async () => {
  expect((await adviseDoctorFixes({ report, plan })).ok).toBe(false);
  expect((await adviseDoctorFixes({ report, plan, llm: async () => 'not JSON' })).ok).toBe(false);
  expect((await adviseDoctorFixes({ report, plan, llm: async () => { throw new Error('secret'); } })).reason).not.toContain('secret');
  expect((await adviseDoctorFixes({ report, plan, llm: (() => { throw new Error('sync secret'); }) as () => Promise<string> })).ok).toBe(false);
  expect((await adviseDoctorFixes({ report, plan, llm: () => new Promise(() => {}), timeoutMs: 1 })).ok).toBe(false);
});
