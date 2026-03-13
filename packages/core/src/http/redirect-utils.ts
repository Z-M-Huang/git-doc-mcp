/**
 * Redirect utilities for cross-origin header stripping.
 * @module http/redirect-utils
 */

/**
 * Accepted header input formats (equivalent to the Fetch API HeadersInit type).
 * Covers all forms accepted by the Headers constructor:
 * - Plain object (string values or readonly string arrays)
 * - Array of [key, value] pairs
 * - Headers instance
 */
type HeadersInput =
  | Record<string, string | ReadonlyArray<string>>
  | string[][]
  | Headers;

/**
 * Headers that MUST be stripped on cross-origin redirects.
 * These contain credentials that should not leak to untrusted origins.
 * Matching is case-insensitive (see stripCrossOriginHeaders).
 */
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/**
 * Normalize HeadersInput to a plain Record<string, string>.
 * Handles Headers instances, [key, value] tuples, and plain objects.
 */
function normalizeHeaders(headers: HeadersInput): Record<string, string> {
  if (headers instanceof Headers) {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => { result[key] = value; });
    return result;
  }
  if (Array.isArray(headers)) {
    const result: Record<string, string> = {};
    for (const pair of headers) {
      const key = pair[0];
      const value = pair[1];
      if (key !== undefined && value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  }
  // Plain object: may have string or ReadonlyArray<string> values
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (typeof val === 'string') {
      result[key] = val;
    } else if (Array.isArray(val) && val.length > 0) {
      // For multi-value headers, join with comma (per HTTP spec)
      result[key] = val.join(', ');
    }
  }
  return result;
}

/**
 * Strip sensitive headers when a redirect crosses origins.
 *
 * Per RFC 9110 and browser security best practices, credentials
 * (Authorization, Cookie, Proxy-Authorization) must not follow
 * redirects to a different origin (scheme + host + port).
 *
 * @param headers - Current request headers
 * @param originalUrl - URL of the request that triggered the redirect
 * @param redirectUrl - URL the redirect points to
 * @returns Headers with sensitive entries removed if cross-origin, or unchanged if same-origin
 */
export function stripCrossOriginHeaders(
  headers: HeadersInput,
  originalUrl: string,
  redirectUrl: string
): Record<string, string> {
  const normalized = normalizeHeaders(headers);
  const originalOrigin = new URL(originalUrl).origin;
  const redirectOrigin = new URL(redirectUrl).origin;

  if (originalOrigin === redirectOrigin) {
    return normalized;
  }

  // Cross-origin: strip sensitive headers (case-insensitive)
  const stripped: Record<string, string> = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (!SENSITIVE_HEADERS.includes(key.toLowerCase())) {
      stripped[key] = value;
    }
  }
  return stripped;
}
