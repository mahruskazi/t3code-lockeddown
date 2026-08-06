/**
 * Favicon helpers for the preview tab strip.
 *
 * The locked-down build never fetches favicons from a third-party service, so
 * callers always fall back to the local `<Globe />` icon.
 */
export function faviconUrlForOrigin(
  _rawUrl: string | null | undefined,
  _size = 32,
): string | null {
  return null;
}
