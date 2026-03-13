/**
 * Manifest loader - fetches manifest from URL or local file.
 * @module manifest/loader
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as yaml from 'js-yaml';
import { Manifest, parseManifest } from './schema.js';
import { validateUrl, validateRedirect } from '../sandbox/url-validator.js';
import type { AuditLogger } from '../audit/logger.js';
import { stripCrossOriginHeaders } from '../http/redirect-utils.js';

/**
 * Manifest loader options.
 */
export interface ManifestLoaderOptions {
  /** URL or file path to manifest.yml */
  manifestPath: string;
  /** Headers for HTTP requests (for private manifests) */
  headers?: Record<string, string>;
  /** Timeout for HTTP requests in ms */
  timeout?: number;
  /** Optional audit logger for structured error event logging */
  auditLogger?: AuditLogger;
  /** Allow HTTP URLs (default: false, HTTPS-only) */
  allowHttp?: boolean;
}

/**
 * Manifest load result.
 */
export interface ManifestLoadResult {
  manifest: Manifest;
  /** SHA-256 hash of manifest content */
  hash: string;
  /** ETag from HTTP response (if applicable) */
  etag?: string;
  /** Last-Modified from HTTP response (if applicable) */
  lastModified?: string;
  /** Source URL or file path */
  source: string;
}

/**
 * Check if path is a URL.
 */
export function isUrl(path: string): boolean {
  return path.startsWith('http://') || path.startsWith('https://') || path.startsWith('file://');
}

/**
 * Compute SHA-256 hash of content.
 */
export function computeHash(content: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Load manifest from URL or local file.
 */
export async function loadManifest(options: ManifestLoaderOptions): Promise<ManifestLoadResult> {
  const { manifestPath, headers = {}, timeout = 30000, auditLogger, allowHttp = false } = options;

  if (manifestPath.startsWith('file://')) {
    return loadFromFile(new URL(manifestPath).pathname, auditLogger);
  }

  if (manifestPath.startsWith('http://') || manifestPath.startsWith('https://')) {
    return loadFromUrl(manifestPath, headers, timeout, auditLogger, allowHttp);
  }

  // Local file path
  return loadFromFile(manifestPath, auditLogger);
}

/**
 * Load manifest from local file.
 */
async function loadFromFile(filePath: string, auditLogger?: AuditLogger): Promise<ManifestLoadResult> {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  let content: string;
  try {
    content = await fs.readFile(absolutePath, 'utf-8');
  } catch (err) {
    auditLogger?.logError('Manifest file read failed', {
      path: absolutePath,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const hash = computeHash(content);
  const manifest = parseManifest(content, yaml.load);

  return {
    manifest,
    hash,
    source: absolutePath,
  };
}

/**
 * Maximum number of redirects to follow when loading a manifest.
 */
const MAX_REDIRECTS = 5;

/**
 * Load manifest from HTTP URL with SSRF protection.
 */
async function loadFromUrl(
  url: string,
  headers: Record<string, string>,
  timeout: number,
  auditLogger?: AuditLogger,
  allowHttp = false
): Promise<ManifestLoadResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  const allowedSchemes = allowHttp ? ['https', 'http'] : ['https'];
  const validationOptions = { allowedSchemes };

  try {
    // Validate the initial URL against SSRF before fetching
    await validateUrl(url, validationOptions);

    let currentUrl = url;
    let redirectCount = 0;

    // Fetch with manual redirect following and SSRF validation at each hop
    let response = await fetch(currentUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/x-yaml, text/yaml, text/plain, */*',
        ...headers,
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
        auditLogger?.logError('Too many redirects loading manifest', { url, maxRedirects: MAX_REDIRECTS });
        throw new Error(`Too many redirects (max ${MAX_REDIRECTS}) loading manifest from ${url}`);
      }

      // Resolve relative redirect URLs
      const redirectTarget = new URL(location, currentUrl).href;

      // Validate the redirect target for SSRF
      await validateRedirect(redirectTarget, url, validationOptions);

      // Strip sensitive headers on cross-origin redirect
      headers = stripCrossOriginHeaders(headers, currentUrl, redirectTarget);
      currentUrl = redirectTarget;

      response = await fetch(currentUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/x-yaml, text/yaml, text/plain, */*',
          ...headers,
        },
        signal: controller.signal,
        redirect: 'manual',
      });
    }

    if (!response.ok) {
      auditLogger?.logError('Manifest fetch failed', { url: currentUrl, status: response.status });
      throw new Error(`Failed to fetch manifest: ${response.status} ${response.statusText}`);
    }

    const content = await response.text();

    try {
      const hash = computeHash(content);
      const manifest = parseManifest(content, yaml.load);

      const responseEtag = response.headers.get('etag');
      const responseLastModified = response.headers.get('last-modified');

      return {
        manifest,
        hash,
        source: url,
        ...(responseEtag ? { etag: responseEtag } : {}),
        ...(responseLastModified ? { lastModified: responseLastModified } : {}),
      };
    } catch (err) {
      auditLogger?.logError('Manifest parse failed', {
        url: currentUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Check if manifest has changed using ETag.
 */
export async function checkManifestUpdate(
  url: string,
  etag: string,
  headers: Record<string, string> = {},
  timeout = 30000,
  allowHttp = false
): Promise<{ changed: boolean; result?: ManifestLoadResult }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  const allowedSchemes = allowHttp ? ['https', 'http'] : ['https'];
  const validationOptions = { allowedSchemes };

  try {
    // Validate the URL against SSRF before fetching
    await validateUrl(url, validationOptions);

    let currentUrl = url;
    let redirectCount = 0;

    let response = await fetch(currentUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/x-yaml, text/yaml, text/plain, */*',
        'If-None-Match': etag,
        ...headers,
      },
      signal: controller.signal,
      redirect: 'manual',
    });

    while (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Redirect response ${response.status} missing Location header`);
      }

      redirectCount++;
      if (redirectCount > MAX_REDIRECTS) {
        throw new Error(`Too many redirects (max ${MAX_REDIRECTS}) checking manifest update from ${url}`);
      }

      const redirectTarget = new URL(location, currentUrl).href;
      await validateRedirect(redirectTarget, url, validationOptions);
      headers = stripCrossOriginHeaders(headers, currentUrl, redirectTarget);
      currentUrl = redirectTarget;

      response = await fetch(currentUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/x-yaml, text/yaml, text/plain, */*',
          'If-None-Match': etag,
          ...headers,
        },
        signal: controller.signal,
        redirect: 'manual',
      });
    }

    if (response.status === 304) {
      return { changed: false };
    }

    if (!response.ok) {
      throw new Error(`Failed to check manifest: ${response.status} ${response.statusText}`);
    }

    const content = await response.text();
    const hash = computeHash(content);
    const manifest = parseManifest(content, yaml.load);

    const responseEtag = response.headers.get('etag');
    const responseLastModified = response.headers.get('last-modified');

    return {
      changed: true,
      result: {
        manifest,
        hash,
        source: url,
        ...(responseEtag ? { etag: responseEtag } : {}),
        ...(responseLastModified ? { lastModified: responseLastModified } : {}),
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }
}