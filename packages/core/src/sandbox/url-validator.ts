/**
 * URL validation for SSRF protection and redirect handling.
 * @module sandbox/url-validator
 */

import * as dns from 'node:dns/promises';

/**
 * URL validation options.
 */
export interface UrlValidationOptions {
  /** Allowed URL schemes (default: ['https']) */
  allowedSchemes?: string[];
  /** Maximum number of redirects to follow */
  maxRedirects?: number;
  /** Whether to allow localhost (default: false) */
  allowLocalhost?: boolean;
  /** Custom blocked IP ranges */
  blockedIpRanges?: string[];
}

/**
 * Default validation options.
 */
const DEFAULT_OPTIONS: Required<UrlValidationOptions> = {
  allowedSchemes: ['https'],
  maxRedirects: 5,
  allowLocalhost: false,
  blockedIpRanges: [],
};

/**
 * Blocked IP ranges for SSRF protection.
 */
const BLOCKED_PRIVATE_RANGES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

/**
 * Parse an IPv6 address into a BigInt (128-bit).
 */
function parseIpv6ToBigInt(ip: string): bigint {
  const halves = ip.split('::');
  const left = halves[0] ? halves[0].split(':').filter(s => s !== '') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':').filter(s => s !== '') : [];

  const groups: number[] = [];
  for (const g of left) groups.push(parseInt(g, 16));

  const fill = 8 - left.length - right.length;
  for (let i = 0; i < fill; i++) groups.push(0);

  for (const g of right) groups.push(parseInt(g, 16));

  let result = BigInt(0);
  for (const group of groups) {
    result = (result << BigInt(16)) | BigInt(group);
  }
  return result;
}

/**
 * Check if IP is in CIDR range (supports IPv4 and IPv6).
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  if (!range) {
    return false;
  }

  const isIpv6 = ip.includes(':');
  const isRangeIpv6 = range.includes(':');

  // Must be same address family
  if (isIpv6 !== isRangeIpv6) return false;

  if (isIpv6) {
    const bits = bitsStr !== undefined ? parseInt(bitsStr, 10) : 128;
    const ipNum = parseIpv6ToBigInt(ip);
    const rangeNum = parseIpv6ToBigInt(range);
    const mask = bits === 0 ? BigInt(0) : ((BigInt(1) << BigInt(128)) - BigInt(1)) << BigInt(128 - bits);
    return (ipNum & mask) === (rangeNum & mask);
  }

  // IPv4
  const rangeParts = range.split('.').map(Number);
  const ipParts = ip.split('.').map(Number);

  if (rangeParts.length !== 4 || ipParts.length !== 4) {
    return false;
  }

  const bits = bitsStr !== undefined ? parseInt(bitsStr, 10) : 32;
  let maskNum = 0;
  for (let i = 0; i < bits; i++) {
    maskNum |= (1 << (31 - i));
  }

  const rangeNum = ((rangeParts[0] ?? 0) << 24) | ((rangeParts[1] ?? 0) << 16) | ((rangeParts[2] ?? 0) << 8) | (rangeParts[3] ?? 0);
  const ipNum = ((ipParts[0] ?? 0) << 24) | ((ipParts[1] ?? 0) << 16) | ((ipParts[2] ?? 0) << 8) | (ipParts[3] ?? 0);

  return (rangeNum & maskNum) === (ipNum & maskNum);
}

/**
 * Check if IP is in any blocked range.
 */
function isBlockedIp(ip: string, options: Required<UrlValidationOptions>): boolean {
  // Check custom blocked ranges
  for (const range of options.blockedIpRanges) {
    if (isIpInCidr(ip, range)) {
      return true;
    }
  }

  // Check default private ranges
  for (const range of BLOCKED_PRIVATE_RANGES) {
    if (isIpInCidr(ip, range)) {
      return true;
    }
  }

  // Check localhost
  if (!options.allowLocalhost) {
    if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') {
      return true;
    }
  }

  return false;
}

/**
 * Validate URL for SSRF protection.
 * @throws Error if URL is invalid or blocked
 */
export async function validateUrl(
  urlString: string,
  options: UrlValidationOptions = {}
): Promise<URL> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Parse URL
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  // Check scheme
  if (!opts.allowedSchemes.includes(url.protocol.replace(':', ''))) {
    throw new Error(
      `URL scheme "${url.protocol}" not allowed. Allowed: ${opts.allowedSchemes.join(', ')}. Use --allow-http to allow insecure HTTP connections.`
    );
  }

  // Resolve hostname to IP for SSRF protection
  const hostname = url.hostname;
  let ips: string[];

  try {
    // Try to resolve as IPv4 first, then IPv6
    const result = await dns.lookup(hostname, { all: true });
    ips = result.map((r) => r.address);
  } catch {
    throw new Error(`Failed to resolve hostname: ${hostname}`);
  }

  // Check all resolved IPs
  for (const ip of ips) {
    if (isBlockedIp(ip, opts)) {
      throw new Error(
        `Blocked IP address: ${ip} (resolved from ${hostname}). ` +
        `This appears to be a private/internal network address.`
      );
    }
  }

  return url;
}

/**
 * Validate a redirect URL.
 * Re-validates all SSRF protections for the redirect target.
 */
export async function validateRedirect(
  redirectUrl: string,
  _originalUrl: string,
  options: UrlValidationOptions = {}
): Promise<URL> {
  // Validate the redirect URL with all SSRF checks
  const url = await validateUrl(redirectUrl, options);

  // Log redirect for audit (caller provides audit logger at a higher level)

  return url;
}

/**
 * Check if a URL is HTTPS.
 */
export function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Extract hostname from URL.
 */
export function getHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}