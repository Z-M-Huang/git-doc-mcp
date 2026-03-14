/**
 * Secret approval and scoping manager.
 * @module secrets/manager
 */

import { Secret } from '../manifest/schema.js';
import { normalizeScopes, validateUrlScope } from './patterns.js';

/**
 * Approved secret with its scope patterns.
 */
export interface ApprovedSecret {
  name: string;
  value: string;
  scopes: string[];
}

/**
 * Secrets manager handles secret approval and scoped access.
 */
export class SecretsManager {
  private approvedSecrets: Map<string, ApprovedSecret> = new Map();

  /**
   * Approve a secret with its value and scope patterns.
   */
  approve(secret: Secret, value: string): void {
    this.approvedSecrets.set(secret.name, {
      name: secret.name,
      value,
      scopes: normalizeScopes(secret.scope),
    });
  }

  /**
   * Check if a secret is approved.
   */
  isApproved(name: string): boolean {
    return this.approvedSecrets.has(name);
  }

  /**
   * Get a secret value if approved and URL is in scope.
   * @returns The secret value, or undefined if not approved or out of scope
   */
  getSecret(name: string, url?: string): string | undefined {
    const secret = this.approvedSecrets.get(name);
    if (!secret) {
      return undefined;
    }

    // If URL provided, validate scope
    if (url) {
      try {
        validateUrlScope(url, secret.scopes);
      } catch {
        return undefined;
      }
    }

    return secret.value;
  }

  /**
   * Get all approved secrets for a specific URL.
   * Only returns secrets whose scopes include the URL.
   */
  getSecretsForUrl(url: string): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [name, secret] of this.approvedSecrets) {
      try {
        validateUrlScope(url, secret.scopes);
        result[name] = secret.value;
      } catch {
        // Secret not in scope for this URL
      }
    }

    return result;
  }

  /**
   * Get all approved secrets (without scope validation).
   * Use with caution - for passing to worker process only.
   */
  getAllSecrets(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, secret] of this.approvedSecrets) {
      result[name] = secret.value;
    }
    return result;
  }

  /**
   * Get scope patterns for a secret.
   */
  getScopes(name: string): string[] | undefined {
    return this.approvedSecrets.get(name)?.scopes;
  }

  /**
   * Clear all approved secrets.
   */
  clear(): void {
    this.approvedSecrets.clear();
  }

  /**
   * List all approved secret names.
   */
  listApproved(): string[] {
    return Array.from(this.approvedSecrets.keys());
  }
}