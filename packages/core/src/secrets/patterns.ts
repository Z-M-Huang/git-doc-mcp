/**
 * URL pattern matching for secret scopes.
 * @module secrets/patterns
 */

/**
 * Check if a URL matches a scope pattern.
 *
 * Pattern syntax:
 * - `https://api.github.com/*` matches all paths under api.github.com
 * - `https://api.github.com/repos/*` matches only /repos/* paths
 * - `https://raw.githubusercontent.com` matches exact origin only
 *
 * Matching rules:
 * - Pattern must match the FULL URL (origin + path)
 * - `*` in path matches any path segment(s), including nested paths
 * - No subdomain matching: `https://api.github.com/*` does NOT match `https://api.github.com.evil.com/`
 * - Query strings and fragments are stripped before matching
 */
export function matchScopePattern(url: string, pattern: string): boolean {
  try {
    const urlObj = new URL(url);

    // Strip query and fragment
    urlObj.search = '';
    urlObj.hash = '';

    // Handle wildcard pattern
    if (pattern.endsWith('/*')) {
      const basePattern = pattern.slice(0, -2);
      const patternObj = new URL(basePattern);

      // Exact origin match required
      if (urlObj.origin !== patternObj.origin) {
        return false;
      }

      // Path must be exactly the base path or start with base path + '/'
      // This prevents /repos-private matching a /repos/* scope
      const basePath = patternObj.pathname;
      if (basePath === '/') {
        // Root wildcard (/*): matches any path on this origin
        return true;
      }
      return urlObj.pathname === basePath || urlObj.pathname.startsWith(basePath + '/');
    }

    // Exact match (no wildcard)
    const patternObj = new URL(pattern);
    return urlObj.origin === patternObj.origin && urlObj.pathname === patternObj.pathname;
  } catch {
    return false;
  }
}

/**
 * Check if a URL matches any of the scope patterns.
 */
export function matchAnyScopePattern(url: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchScopePattern(url, pattern));
}

/**
 * Validate that a URL is within the allowed scopes.
 * @throws Error if URL doesn't match any scope
 */
export function validateUrlScope(url: string, patterns: string[]): void {
  if (!matchAnyScopePattern(url, patterns)) {
    throw new Error(
      `URL "${url}" is not within allowed scopes: ${patterns.join(', ')}`
    );
  }
}

/**
 * Normalize scope patterns to an array.
 */
export function normalizeScopes(scopes: string | string[]): string[] {
  return Array.isArray(scopes) ? scopes : [scopes];
}