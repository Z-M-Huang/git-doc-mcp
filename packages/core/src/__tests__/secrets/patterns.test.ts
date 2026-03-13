/**
 * Unit tests for URL pattern matching (secret scopes).
 * @module __tests__/secrets/patterns.test
 */

import { describe, it, expect } from 'vitest';
import { matchScopePattern, matchAnyScopePattern } from '../../secrets/patterns.js';

// Alias for clearer test naming
const validateUrlAgainstScopes = matchAnyScopePattern;

describe('matchScopePattern', () => {
  describe('exact origin match', () => {
    it('should match exact origin without path', () => {
      expect(matchScopePattern('https://api.github.com', 'https://api.github.com')).toBe(true);
      expect(matchScopePattern('https://api.github.com/users', 'https://api.github.com')).toBe(false);
    });
  });

  describe('wildcard path matching', () => {
    it('should match any path with /*', () => {
      expect(matchScopePattern('https://api.github.com/users', 'https://api.github.com/*')).toBe(true);
      expect(matchScopePattern('https://api.github.com/repos/owner/repo', 'https://api.github.com/*')).toBe(true);
      expect(matchScopePattern('https://api.github.com/', 'https://api.github.com/*')).toBe(true);
    });

    it('should not match different origins', () => {
      expect(matchScopePattern('https://evil.com/users', 'https://api.github.com/*')).toBe(false);
      expect(matchScopePattern('https://api.github.com.evil.com/users', 'https://api.github.com/*')).toBe(false);
    });
  });

  describe('path prefix matching', () => {
    it('should match paths starting with pattern', () => {
      expect(matchScopePattern('https://api.github.com/repos/owner/repo', 'https://api.github.com/repos/*')).toBe(true);
      expect(matchScopePattern('https://api.github.com/users', 'https://api.github.com/repos/*')).toBe(false);
    });

    it('should not match path prefixes that share a common stem', () => {
      // /repos-private should NOT match /repos/* scope
      expect(matchScopePattern('https://api.github.com/repos-private/foo', 'https://api.github.com/repos/*')).toBe(false);
      expect(matchScopePattern('https://api.github.com/reposx', 'https://api.github.com/repos/*')).toBe(false);
      // But /repos/x should still match
      expect(matchScopePattern('https://api.github.com/repos/x', 'https://api.github.com/repos/*')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle URLs with query strings', () => {
      expect(matchScopePattern('https://api.github.com/users?page=1', 'https://api.github.com/*')).toBe(true);
    });

    it('should handle URLs with fragments', () => {
      expect(matchScopePattern('https://api.github.com/users#section', 'https://api.github.com/*')).toBe(true);
    });

    it('should be case-sensitive for host', () => {
      // URLs are normalized to lowercase
      expect(matchScopePattern('https://API.GITHUB.COM/users', 'https://api.github.com/*')).toBe(true);
    });
  });
});

describe('validateUrlAgainstScopes', () => {
  it('should return true when URL matches any scope', () => {
    const scopes = [
      'https://api.github.com/*',
      'https://raw.githubusercontent.com/*',
    ];

    expect(validateUrlAgainstScopes('https://api.github.com/users', scopes)).toBe(true);
    expect(validateUrlAgainstScopes('https://raw.githubusercontent.com/owner/repo/main/README.md', scopes)).toBe(true);
  });

  it('should return false when URL matches no scopes', () => {
    const scopes = ['https://api.github.com/*'];

    expect(validateUrlAgainstScopes('https://evil.com/data', scopes)).toBe(false);
    expect(validateUrlAgainstScopes('https://api.gitlab.com/repos', scopes)).toBe(false);
  });

  it('should return false when scopes is empty (no match possible)', () => {
    // When no scopes are defined, no URL can match
    // This is the secure default - callers should handle empty scopes specially
    expect(validateUrlAgainstScopes('https://any.com/url', [])).toBe(false);
  });

  it('should handle multiple scopes', () => {
    const scopes = [
      'https://api.github.com/*',
      'https://api.gitlab.com/*',
      'https://bitbucket.org/api/*',
    ];

    expect(validateUrlAgainstScopes('https://api.github.com/repos', scopes)).toBe(true);
    expect(validateUrlAgainstScopes('https://api.gitlab.com/projects', scopes)).toBe(true);
    expect(validateUrlAgainstScopes('https://bitbucket.org/api/repositories', scopes)).toBe(true);
    expect(validateUrlAgainstScopes('https://other.com/api', scopes)).toBe(false);
  });
});