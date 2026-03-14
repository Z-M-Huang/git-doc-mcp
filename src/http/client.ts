/**
 * HTTP client for fetching action scripts.
 * @module http/client
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { validateUrl, validateRedirect } from '../sandbox/url-validator.js';
import type { AuditLogger } from '../audit/logger.js';
import { stripCrossOriginHeaders } from './redirect-utils.js';

/**
 * HTTP client options.
 */
export interface HttpClientOptions {
  /** Headers for requests */
  headers?: Record<string, string>;
  /** Timeout in ms */
  timeout?: number;
  /** Maximum response size in bytes */
  maxSize?: number;
  /** Optional audit logger for structured error event logging */
  auditLogger?: AuditLogger;
  /** Allow HTTP URLs (default: false, HTTPS-only) */
  allowHttp?: boolean;
}

/**
 * Default HTTP client options.
 */
const DEFAULT_OPTIONS: Required<Omit<HttpClientOptions, 'auditLogger' | 'allowHttp'>> = {
  headers: {},
  timeout: 30000,
  maxSize: 500 * 1024, // 500KB for action scripts
};

/**
 * Fetch result.
 */
export interface FetchResult {
  content: string;
  hash: string;
  etag?: string;
  lastModified?: string;
}

/**
 * Maximum number of redirects to follow when fetching action scripts.
 */
const MAX_REDIRECTS = 5;

/**
 * Fetch content from URL with SSRF protection.
 */
export async function fetchContent(
  url: string,
  options: HttpClientOptions = {}
): Promise<FetchResult> {
  const { auditLogger, allowHttp = false, ...rest } = options;
  const opts = { ...DEFAULT_OPTIONS, ...rest };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), opts.timeout);
  const allowedSchemes = allowHttp ? ['https', 'http'] : ['https'];
  const validationOptions = { allowedSchemes };

  try {
    // Validate the initial URL against SSRF before fetching
    await validateUrl(url, validationOptions);

    let currentUrl = url;
    let redirectCount = 0;
    let currentHeaders = { ...opts.headers };

    let response = await fetch(currentUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/javascript, text/javascript, */*',
        ...currentHeaders,
      },
      signal: controller.signal,
      redirect: 'manual',
    });

    while (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        auditLogger?.logError('Redirect without location header', { url: currentUrl, status: response.status });
        throw new Error(`Redirect response ${response.status} missing Location header`);
      }

      redirectCount++;
      if (redirectCount > MAX_REDIRECTS) {
        auditLogger?.logError('Too many redirects fetching action', { url, maxRedirects: MAX_REDIRECTS });
        throw new Error(`Too many redirects (max ${MAX_REDIRECTS}) fetching action from ${url}`);
      }

      // Resolve relative redirect URLs
      const redirectTarget = new URL(location, currentUrl).href;

      // Validate the redirect target for SSRF
      await validateRedirect(redirectTarget, url, validationOptions);

      // Strip sensitive headers on cross-origin redirect
      currentHeaders = stripCrossOriginHeaders(currentHeaders, currentUrl, redirectTarget);
      currentUrl = redirectTarget;

      response = await fetch(currentUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/javascript, text/javascript, */*',
          ...currentHeaders,
        },
        signal: controller.signal,
        redirect: 'manual',
      });
    }

    if (!response.ok) {
      auditLogger?.logError('Action fetch failed', { url: currentUrl, status: response.status });
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    // Check size
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > opts.maxSize) {
      auditLogger?.logError('Action content too large', { url: currentUrl, contentLength: parseInt(contentLength, 10), maxSize: opts.maxSize });
      throw new Error(
        `Content too large: ${contentLength} bytes (max: ${opts.maxSize})`
      );
    }

    const content = await response.text();

    // Check actual size
    if (content.length > opts.maxSize) {
      auditLogger?.logError('Action body too large', { url: currentUrl, actualSize: content.length, maxSize: opts.maxSize });
      throw new Error(
        `Content too large: ${content.length} bytes (max: ${opts.maxSize})`
      );
    }

    // Compute hash
    const hash = 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');

    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');

    return {
      content,
      hash,
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Load content from a local file path.
 * Returns the same FetchResult shape as fetchContent for uniform handling.
 */
export async function loadLocalContent(
  filePath: string,
  options?: { maxSize?: number; auditLogger?: AuditLogger }
): Promise<FetchResult> {
  const maxSize = options?.maxSize ?? DEFAULT_OPTIONS.maxSize;
  const content = await fs.readFile(filePath, 'utf-8');

  if (content.length > maxSize) {
    options?.auditLogger?.logError('Local file too large', {
      path: filePath, size: content.length, maxSize,
    });
    throw new Error(`Content too large: ${content.length} bytes (max: ${maxSize})`);
  }

  const hash = 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
  return { content, hash };
}

/**
 * Verify content hash.
 * @throws Error if hash doesn't match
 */
export function verifyHash(content: string, expectedHash: string): void {
  const actualHash = 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');

  if (actualHash !== expectedHash) {
    throw new Error(
      `Hash mismatch: expected ${expectedHash}, got ${actualHash}`
    );
  }
}