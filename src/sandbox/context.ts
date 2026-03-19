/**
 * Action execution context.
 * @module sandbox/context
 */

import { Manifest } from '../manifest/schema.js';
import { validateUrl, validateRedirect } from './url-validator.js';
import { validateUrlScope } from '../secrets/patterns.js';
import type { AuditLogger } from '../audit/logger.js';
import { stripCrossOriginHeaders } from '../http/redirect-utils.js';

/**
 * Simplified manifest for context (only needed fields).
 */
export interface SimplifiedManifest {
  name: string;
  version: string;
}

/**
 * Action context passed to action scripts.
 */
export interface ActionContext {
  /** Manifest metadata */
  manifest: SimplifiedManifest;

  /**
   * Scoped fetch function.
   * - Validates URL for SSRF
   * - Re-validates redirect URLs
   * - Resolves relative redirects
   * - Logs all requests for audit
   */
  fetch: (url: string, options?: FetchOptions) => Promise<Response>;

  /**
   * Get a secret value with URL scope validation.
   * Returns the secret value if the URL matches the secret's scope,
   * or undefined if the secret doesn't exist or the URL is out of scope.
   */
  getSecret: (name: string, url: string) => string | undefined;

  /**
   * Logging function.
   */
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * Fetch options for ctx.fetch.
 */
export interface FetchOptions extends RequestInit {
  /** Maximum response size in bytes */
  maxSize?: number;
}

/**
 * Options for creating action context.
 */
export interface CreateContextOptions {
  manifest: SimplifiedManifest | Manifest;
  secrets: Record<string, string>;
  /** Secret scopes: secret name -> patterns */
  secretScopes: Record<string, string[]>;
  /** Maximum response size (default: 10MB) */
  maxResponseSize?: number;
  /** Maximum redirects (default: 5) */
  maxRedirects?: number;
  /** Logger function */
  logger?: (level: string, message: string) => void;
  /** Request timeout in ms */
  timeout?: number;
  /** Optional audit logger for structured event logging */
  auditLogger?: AuditLogger;
}

/**
 * Create action context for isolated execution.
 */
export function createActionContext(options: CreateContextOptions): ActionContext {
  const {
    manifest,
    secrets,
    secretScopes,
    maxResponseSize = 10 * 1024 * 1024, // 10MB
    maxRedirects = 5,
    logger = console.error,
    auditLogger,
  } = options;

  const log: ActionContext['log'] = (level, message) => {
    logger(level, `[${manifest.name}] ${message}`);
    auditLogger?.logActionLog(level, message, manifest.name);
  };

  /**
   * Get a secret with URL scope validation (AC2-AC4).
   * The inverted scope logic is removed (AC5) — scope validation only
   * applies when a secret is explicitly accessed via getSecret.
   */
  const getSecret = (name: string, url: string): string | undefined => {
    const value = secrets[name];
    if (!value) return undefined;
    const patterns = secretScopes[name];
    if (!patterns) return undefined;
    try {
      validateUrlScope(url, patterns);
      auditLogger?.logSecretAccess(name, url, true, manifest.name);
      return value;
    } catch {
      auditLogger?.logSecretAccess(name, url, false, manifest.name);
      return undefined;
    }
  };

  const scopedFetch: ActionContext['fetch'] = async (url, init = {}) => {
    const maxSize = init.maxSize ?? maxResponseSize;
    // Remove maxSize from init before passing to native fetch
    const { maxSize: _maxSize, ...initWithoutMaxSize } = init; // eslint-disable-line @typescript-eslint/no-unused-vars
    let fetchInit = initWithoutMaxSize;

    // Pre-fetch audit log: always fires as an attempt signal
    auditLogger?.logFetch(url, undefined, undefined, manifest.name);

    const startTime = Date.now();
    let responseStatus: number | undefined;

    try {
      // Validate URL for SSRF inside try/finally so DNS failures are also audit-logged (AC25)
      await validateUrl(url, { maxRedirects });

      // Execute fetch with redirect validation
      let currentUrl = url;
      let redirectCount = 0;

      while (redirectCount < maxRedirects) {
        const response = await fetch(currentUrl, {
          ...fetchInit,
          redirect: 'manual',
        });

        // Handle redirect
        if (response.status >= 300 && response.status < 400) {
          const rawRedirectUrl = response.headers.get('location');
          if (!rawRedirectUrl) {
            throw new Error(`Redirect without location header from ${currentUrl}`);
          }

          redirectCount++;

          // Resolve relative redirect URLs against current URL (AC11, AC12)
          const resolvedRedirectUrl = new URL(rawRedirectUrl, currentUrl).href;

          // Validate redirect URL for SSRF (AC13)
          await validateRedirect(resolvedRedirectUrl, currentUrl, { maxRedirects });

          // Strip sensitive headers on cross-origin redirect
          // Pass headers directly — stripCrossOriginHeaders normalizes HeadersInit (Headers, tuples, objects)
          const safeHeaders = stripCrossOriginHeaders(fetchInit.headers ?? {}, currentUrl, resolvedRedirectUrl);
          fetchInit = { ...fetchInit, headers: safeHeaders };

          auditLogger?.logRedirect(currentUrl, resolvedRedirectUrl, manifest.name);
          currentUrl = resolvedRedirectUrl;
          continue;
        }

        // Record the final HTTP status for the post-fetch audit log
        responseStatus = response.status;

        // Check response size
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > maxSize) {
          throw new Error(
            `Response too large: ${contentLength} bytes (max: ${maxSize})`
          );
        }

        // Actually enforce size by reading with limit
        const reader = response.body?.getReader();
        if (reader) {
          const chunks: Uint8Array[] = [];
          let totalSize = 0;

          while (true) {
            const result = await reader.read();
            if (result.done) break;

            const chunk = result.value as Uint8Array;
            totalSize += chunk.length;
            if (totalSize > maxSize) {
              void reader.cancel();
              throw new Error(
                `Response body too large: ${totalSize} bytes (max: ${maxSize})`
              );
            }
            chunks.push(chunk);
          }

          // Reconstruct response with the body
          const body = new Uint8Array(totalSize);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.length;
          }

          // Return a new response with the read body
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }

        return response;
      }

      throw new Error(`Too many redirects (max: ${maxRedirects})`);
    } finally {
      // Post-fetch audit log: fires on success and error paths (AC25)
      auditLogger?.logFetch(url, responseStatus, Date.now() - startTime, manifest.name);
    }
  };

  return {
    manifest: {
      name: manifest.name,
      version: manifest.version,
    },
    fetch: scopedFetch,
    getSecret,
    log,
  };
}
