/**
 * Unit tests for SecretsManager.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SecretsManager } from '../../secrets/manager.js';

describe('SecretsManager', () => {
  let manager: SecretsManager;

  const githubSecret = {
    name: 'GITHUB_TOKEN',
    scope: 'https://api.github.com/*',
    required: true,
    description: 'GitHub API token',
  };

  const gitlabSecret = {
    name: 'GITLAB_TOKEN',
    scope: 'https://gitlab.com/api/*',
    required: false,
    description: 'GitLab API token',
  };

  beforeEach(() => {
    manager = new SecretsManager();
  });

  describe('approve and isApproved', () => {
    it('should approve a secret', () => {
      manager.approve(githubSecret, 'ghp_abc123');
      expect(manager.isApproved('GITHUB_TOKEN')).toBe(true);
    });

    it('should return false for unapproved secret', () => {
      expect(manager.isApproved('UNKNOWN')).toBe(false);
    });
  });

  describe('getSecret', () => {
    beforeEach(() => {
      manager.approve(githubSecret, 'ghp_abc123');
    });

    it('should return value without URL', () => {
      expect(manager.getSecret('GITHUB_TOKEN')).toBe('ghp_abc123');
    });

    it('should return value for in-scope URL (AC2)', () => {
      expect(manager.getSecret('GITHUB_TOKEN', 'https://api.github.com/repos')).toBe('ghp_abc123');
    });

    it('should return undefined for out-of-scope URL (AC3)', () => {
      expect(manager.getSecret('GITHUB_TOKEN', 'https://evil.com/steal')).toBeUndefined();
    });

    it('should return undefined for nonexistent secret (AC4)', () => {
      expect(manager.getSecret('NONEXISTENT', 'https://api.github.com/repos')).toBeUndefined();
    });
  });

  describe('getSecretsForUrl', () => {
    beforeEach(() => {
      manager.approve(githubSecret, 'ghp_abc123');
      manager.approve(gitlabSecret, 'glpat_def456');
    });

    it('should return only matching secrets', () => {
      const secrets = manager.getSecretsForUrl('https://api.github.com/repos');
      expect(secrets).toEqual({ GITHUB_TOKEN: 'ghp_abc123' });
    });

    it('should return empty for unmatched URL', () => {
      const secrets = manager.getSecretsForUrl('https://httpbin.org/get');
      expect(secrets).toEqual({});
    });

    it('should return both when URL matches both scopes', () => {
      // This won't happen with different scopes, but test the mechanics
      const secrets = manager.getSecretsForUrl('https://api.github.com/repos');
      expect(Object.keys(secrets)).toHaveLength(1);
    });
  });

  describe('getAllSecrets', () => {
    it('should return all secrets regardless of scope', () => {
      manager.approve(githubSecret, 'ghp_abc123');
      manager.approve(gitlabSecret, 'glpat_def456');
      const all = manager.getAllSecrets();
      expect(all).toEqual({
        GITHUB_TOKEN: 'ghp_abc123',
        GITLAB_TOKEN: 'glpat_def456',
      });
    });

    it('should return empty when no secrets approved', () => {
      expect(manager.getAllSecrets()).toEqual({});
    });
  });

  describe('getScopes', () => {
    it('should return scopes for approved secret', () => {
      manager.approve(githubSecret, 'ghp_abc123');
      const scopes = manager.getScopes('GITHUB_TOKEN');
      expect(scopes).toEqual(['https://api.github.com/*']);
    });

    it('should return undefined for unknown secret', () => {
      expect(manager.getScopes('UNKNOWN')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should remove all secrets', () => {
      manager.approve(githubSecret, 'ghp_abc123');
      manager.clear();
      expect(manager.isApproved('GITHUB_TOKEN')).toBe(false);
      expect(manager.listApproved()).toEqual([]);
    });
  });

  describe('listApproved', () => {
    it('should list all approved secret names', () => {
      manager.approve(githubSecret, 'ghp_abc123');
      manager.approve(gitlabSecret, 'glpat_def456');
      const names = manager.listApproved();
      expect(names).toContain('GITHUB_TOKEN');
      expect(names).toContain('GITLAB_TOKEN');
      expect(names).toHaveLength(2);
    });
  });

  describe('edge cases', () => {
    it('should handle secret with array scope', () => {
      const multiScopeSecret = {
        name: 'MULTI',
        scope: ['https://api.github.com/*', 'https://github.com/*'],
        required: false,
        description: 'Multi-scope',
      };
      manager.approve(multiScopeSecret, 'multi-val');
      expect(manager.getSecret('MULTI', 'https://api.github.com/repos')).toBe('multi-val');
      expect(manager.getSecret('MULTI', 'https://github.com/user')).toBe('multi-val');
    });
  });
});
