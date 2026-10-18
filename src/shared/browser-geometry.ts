/** Private X display and Chromium's native capture density. */
export const NATIVE_BROWSER_SCALE = 3;
export const NATIVE_BROWSER_SIZE = 4096;
export const MAX_CLOUD_VIEWPORT_SIZE = Math.floor(NATIVE_BROWSER_SIZE / NATIVE_BROWSER_SCALE);

/** Fit without cropping or changing the requested aspect ratio (apart from integer rounding). */
export function fitCloudViewport<T extends { width: number; height: number }>(viewport: T): T {
  const scale = Math.min(1, MAX_CLOUD_VIEWPORT_SIZE / Math.max(viewport.width, viewport.height));
  return {
    ...viewport,
    width: Math.max(1, Math.round(viewport.width * scale)),
    height: Math.max(1, Math.round(viewport.height * scale)),
  };
}
