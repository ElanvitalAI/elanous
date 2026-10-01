export interface ImageLoadState {
  complete: boolean;
  naturalWidth: number;
  loading: string;
  inViewport: boolean;
}

/** Shared by Node tests and the injected browser expression. */
export function classifyImages(images: ImageLoadState[]): { broken: number; pendingLazy: number } {
  let broken = 0;
  let pendingLazy = 0;
  for (const image of images) {
    if (image.complete && image.naturalWidth === 0) broken++;
    else if (!image.complete && image.loading === 'lazy' && !image.inViewport) pendingLazy++;
    else if (!image.complete) broken++;
  }
  return { broken, pendingLazy };
}

/** Executable function source for CDP and aside, without a module import in the page. */
export const IMAGE_LOAD_STATE_SOURCE = classifyImages.toString();
