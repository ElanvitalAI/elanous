import type { ShootCommand } from './shoot-plan.js';

export interface ProductVideoInput {
  readonly prompt: string;
  readonly productId: string;
  readonly sourceImageId: string;
  readonly fallbackToSeedance?: boolean;
}

/** Builds a fakeable Higgsfield job command; callers supply the Marketing Studio product made from the photo. */
export function buildProductVideoCommand(input: ProductVideoInput): ShootCommand {
  if (!input.prompt.trim() || !input.productId.trim() || !input.sourceImageId.trim()) {
    throw new Error('prompt, productId, and sourceImageId are required');
  }
  if (input.fallbackToSeedance) {
    return {
      beatIndex: 0,
      jobType: 'seedance_2_0',
      args: ['--prompt', input.prompt, '--start-image', input.sourceImageId],
    };
  }
  return {
    beatIndex: 0,
    jobType: 'marketing_studio_video',
    args: ['--prompt', input.prompt, '--mode', 'product_showcase', '--product-ids', input.productId],
  };
}
