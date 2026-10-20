import { expect, test } from 'bun:test';
import { buildWorkOrder } from './work-order-build.js';

test('ENTRANCE-WORK-ORDER-BUILD core fills the nine fields and lists unknown values', () => {
  const order = buildWorkOrder({ cellId: 'ENTRANCE-WORK-ORDER-BUILD', version: '0.2.35' });
  expect(order).toMatchObject({
    cellId: 'ENTRANCE-WORK-ORDER-BUILD',
    lifeId: '모름',
    version: '0.2.35',
    priority: '모름',
    peers: '모름',
  });
  expect(order).toMatchObject({
    landBy: '모름', identityTags: '모름', verdictSignal: '모름', contract: '모름',
    boundary: '모름', budget: '모름', precedents: '모름', escalation: '모름',
  });
  expect(order.unknownFields).toEqual(['lifeId', 'landBy', 'identityTags', 'priority', 'verdictSignal', 'contract', 'boundary', 'budget', 'peers', 'precedents', 'escalation']);
  expect(Object.keys(order)).toEqual(['cellId', 'lifeId', 'version', 'landBy', 'identityTags', 'priority', 'verdictSignal', 'contract', 'boundary', 'budget', 'peers', 'precedents', 'escalation', 'unknownFields']);
});

test('ENTRANCE-WORK-ORDER-BUILD core preserves caller supplied life identity', () => {
  const order = buildWorkOrder({ cellId: 'CELL', version: '0.2.35', lifeId: 'life-17', priority: 'P0', peers: 'PARENT-A' });
  expect(order).toMatchObject({ lifeId: 'life-17', priority: 'P0', peers: 'PARENT-A' });
  expect(order.unknownFields).not.toContain('lifeId');
  expect(order.unknownFields).not.toContain('priority');
  expect(order.unknownFields).not.toContain('peers');
});
