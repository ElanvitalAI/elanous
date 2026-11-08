import { expect, test } from 'bun:test';
import marketingSchema from './fixtures/marketing-studio-video.schema.json';
import seedanceSchema from './fixtures/seedance-2-0.schema.json';
import { createHiggsfieldBackend } from './higgsfield-backend.js';
import { buildProductVideoCommand } from './product-video-command.js';
import { createFakeHiggsfieldRunner } from '../ux-sim/fake-higgsfield.js';

const paramNames = (schema: typeof marketingSchema | typeof seedanceSchema) => new Set(schema.params.map(param => param.name));

test('official Higgsfield CLI schema fixtures keep the product-video parameter contract', () => {
  expect(marketingSchema.job_type).toBe('marketing_studio_video');
  expect(paramNames(marketingSchema)).toEqual(new Set([
    'ad_reference_id', 'aspect_ratio', 'avatar_ids', 'avatars', 'duration', 'end_image', 'generate_audio',
    'hook_id', 'image_references', 'mode', 'product_ids', 'prompt', 'resolution', 'setting_id',
    'specific_mode', 'start_image', 'storyboard_id', 'web_product_ids', 'web_product_type',
  ]));
  expect(seedanceSchema.job_type).toBe('seedance_2_0');
  expect(paramNames(seedanceSchema)).toContain('start_image');
  expect(paramNames(seedanceSchema)).toContain('prompt');
});

test('product photo uses Marketing Studio first and Seedance start-image as the alternative through fake Higgsfield only', async () => {
  const runner = createFakeHiggsfieldRunner({ seed: 'product-video-contract', deviceOptIn: true });
  const backend = createHiggsfieldBackend({ runner, allowSpend: true });
  const primary = buildProductVideoCommand({ prompt: 'Show the product in a clean studio', productId: 'fake-product-42', sourceImageId: 'fake-upload-42' });
  const fallback = buildProductVideoCommand({ prompt: 'Show the product in a clean studio', productId: 'fake-product-42', sourceImageId: 'fake-upload-42', fallbackToSeedance: true });

  expect([primary.jobType, fallback.jobType]).toEqual(['marketing_studio_video', 'seedance_2_0']);
  await backend.submit(primary);
  await backend.submit(fallback);
  expect(runner.ledger.calls.map(call => call.argv.slice(0, 4))).toEqual([
    ['higgsfield', 'generate', 'create', 'marketing_studio_video'],
    ['higgsfield', 'generate', 'create', 'seedance_2_0'],
  ]);
  expect(runner.ledger.calls[0]?.argv).toContain('--product-ids');
  expect(runner.ledger.calls[0]?.argv).toContain('fake-product-42');
  expect(runner.ledger.calls[1]?.argv).toContain('--start-image');
  expect(runner.ledger.calls[1]?.argv).toContain('fake-upload-42');
  expect(runner.ledger.calls.flatMap(call => call.argv)).not.toContain('--duration');
});
