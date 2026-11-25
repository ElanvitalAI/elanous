// DEMO-FIXTURE-HEADLINE-CURATE: the stage event list carries only neutral news/market headlines. Literal cases.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { curateStageHeadlines, isStageSafeHeadline, tickerHeadlines } from './headline-curate.js';

const FIXTURE = join(import.meta.dir, '../../graphs/demo/invest-orch/fixtures/event-shock.json');

test('the recorded event-shock fixture has no tabloid, social or video item and every item is stage-safe', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { items: { title: string; url: string }[] };
  const text = JSON.stringify(fixture);
  expect(text).not.toContain('futurism.com');
  expect(text).not.toContain('Sleeping With Subordinates');
  expect(text).not.toContain('reddit.com');
  expect(text).not.toContain('youtube.com');
  expect(fixture.items.length).toBe(6);
  expect(fixture.items.every(isStageSafeHeadline)).toBe(true);
});

test('live crawl items are filtered by host and by gossip wording', () => {
  const items = [
    { title: 'Nvidia stock soars more than 31% after board reinstates Jensen Huang as CEO', url: 'https://finance.yahoo.com/a' },
    { title: 'Nvidia Decides That Profits Are More Important Than Not Sleeping With Subordinates', url: 'https://futurism.com/b' },
    { title: 'Jensen Huang Reinstated As Nvidia CEO—Stock Jumps 30%', url: 'https://www.reddit.com/r/x' },
    { title: 'Tech stocks soar', url: 'https://m.youtube.com/watch?v=1' },
    { title: 'Spy scandal threatens Nvidia CEO', url: 'https://www.example-news.com/c' },
    { title: 'Memory Is the New Bottleneck in AI Semiconductors', url: 'https://www.globalxetfs.com/d' },
    { title: 'no url', url: 'not a url' },
  ];
  expect(curateStageHeadlines(items).map((i) => i.url)).toEqual(['https://finance.yahoo.com/a', 'https://www.globalxetfs.com/d']);
});

test('demo P0 11-25: the Samsung card leads with Samsung headlines from the recorded fixtures, not Nvidia', () => {
  const read = (n: string) => (JSON.parse(readFileSync(join(import.meta.dir, `../../graphs/demo/invest-orch/fixtures/${n}.json`), 'utf8')) as { items: { title: string; url: string }[] }).items;
  const top = tickerHeadlines('005930.KO', [read('news'), read('event-shock')]).slice(0, 2).map((i) => i.title);
  expect(top).toEqual(['[RISE 인사이트] 코스피 7000시대의 예고: 삼전·닉스가 쏘아 올린 역대급 ...', '이번에는 증권가 “SK하이닉스 300만원, 삼성전자 50만원” 전망']);
  expect(tickerHeadlines('XYZ', [[{ title: 'a', url: 'u' }, { title: 'a2', url: 'u' }]]).map((i) => i.title)).toEqual(['a']);
});
