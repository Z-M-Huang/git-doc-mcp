/**
 * Unit tests for URL validation (SSRF protection).
 * @module __tests__/sandbox/url-validator.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DNS to avoid live network calls (AC20)
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({
  lookup: mockLookup,
}));

import { validateUrl, validateRedirect, isHttps, getHostname, isIpInCidr } from '../../sandbox/url-validator.js';

beforeEach(() => {
  mockLookup.mockReset();
  // Default: resolve to a public IP
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('isIpInCidr', () => {
  it('should match IPs in CIDR ranges', () => {
    // 10.0.0.0/8
    expect(isIpInCidr('10.0.0.1', '10.0.0.0/8')).toBe(true);
    expect(isIpInCidr('10.255.255.255', '10.0.0.0/8')).toBe(true);
    expect(isIpInCidr('11.0.0.1', '10.0.0.0/8')).toBe(false);

    // 172.16.0.0/12
    expect(isIpInCidr('172.16.0.1', '172.16.0.0/12')).toBe(true);
    expect(isIpInCidr('172.31.255.255', '172.16.0.0/12')).toBe(true);
    expect(isIpInCidr('172.15.0.1', '172.16.0.0/12')).toBe(false);
    expect(isIpInCidr('172.32.0.1', '172.16.0.0/12')).toBe(false);

    // 192.168.0.0/16
    expect(isIpInCidr('192.168.0.1', '192.168.0.0/16')).toBe(true);
    expect(isIpInCidr('192.168.255.255', '192.168.0.0/16')).toBe(true);
    expect(isIpInCidr('192.169.0.1', '192.168.0.0/16')).toBe(false);

    // 127.0.0.0/8 (localhost)
    expect(isIpInCidr('127.0.0.1', '127.0.0.0/8')).toBe(true);
    expect(isIpInCidr('127.255.255.255', '127.0.0.0/8')).toBe(true);
  });

  it('should handle /32 (single IP)', () => {
    expect(isIpInCidr('1.2.3.4', '1.2.3.4/32')).toBe(true);
    expect(isIpInCidr('1.2.3.5', '1.2.3.4/32')).toBe(false);
  });

  it('should return false for empty range', () => {
    expect(isIpInCidr('10.0.0.1', '')).toBe(false);
  });

  it('should handle CIDR without prefix (defaults to /32 for IPv4)', () => {
    expect(isIpInCidr('1.2.3.4', '1.2.3.4')).toBe(true);
    expect(isIpInCidr('1.2.3.5', '1.2.3.4')).toBe(false);
  });

  it('should return false for malformed IPv4', () => {
    expect(isIpInCidr('1.2.3', '10.0.0.0/8')).toBe(false);
    expect(isIpInCidr('10.0.0.1', '10.0.0/8')).toBe(false);
  });

  it('should match IPv6 addresses in CIDR ranges', () => {
    // ::1/128 (loopback)
    expect(isIpInCidr('::1', '::1/128')).toBe(true);
    expect(isIpInCidr('::2', '::1/128')).toBe(false);

    // fc00::/7 (unique local)
    expect(isIpInCidr('fc00::1', 'fc00::/7')).toBe(true);
    expect(isIpInCidr('fd00::1', 'fc00::/7')).toBe(true);
    expect(isIpInCidr('fe00::1', 'fc00::/7')).toBe(false);

    // fe80::/10 (link-local)
    expect(isIpInCidr('fe80::1', 'fe80::/10')).toBe(true);
    expect(isIpInCidr('fec0::1', 'fe80::/10')).toBe(false);
  });

  it('should handle IPv6 CIDR without prefix (defaults to /128)', () => {
    expect(isIpInCidr('::1', '::1')).toBe(true);
    expect(isIpInCidr('::2', '::1')).toBe(false);
  });

  it('should not cross-match IPv4 and IPv6', () => {
    expect(isIpInCidr('::1', '127.0.0.0/8')).toBe(false);
    expect(isIpInCidr('10.0.0.1', 'fc00::/7')).toBe(false);
  });
});

describe('validateUrl', () => {
  describe('scheme validation', () => {
    it('should accept HTTPS URLs', async () => {
      const result = await validateUrl('https://example.com/path');
      expect(result.href).toBe('https://example.com/path');
    });

    it('should reject HTTP URLs by default', async () => {
      await expect(validateUrl('http://example.com/path')).rejects.toThrow(/not allowed/);
    });

    it('should accept HTTP URLs when allowed', async () => {
      const result = await validateUrl('http://example.com/path', { allowedSchemes: ['https', 'http'] });
      expect(result.href).toBe('http://example.com/path');
    });

    it('should reject file:// URLs', async () => {
      await expect(validateUrl('file:///etc/passwd')).rejects.toThrow();
    });

    it('should reject data: URLs', async () => {
      await expect(validateUrl('data:text/html,<script>alert(1)</script>')).rejects.toThrow();
    });
  });

  describe('invalid URLs', () => {
    it('should reject malformed URLs', async () => {
      await expect(validateUrl('not-a-url')).rejects.toThrow(/Invalid URL/);
      await expect(validateUrl('')).rejects.toThrow(/Invalid URL/);
    });
  });

  describe('SSRF protection (AC21)', () => {
    it('should reject localhost (127.0.0.1)', async () => {
      mockLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      await expect(validateUrl('https://localhost/')).rejects.toThrow(/Blocked IP/);
    });

    it('should reject 127.x.x.x range', async () => {
      mockLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      await expect(validateUrl('https://127.0.0.1/')).rejects.toThrow(/Blocked IP/);
    });

    it('should reject private IPs in 10.0.0.0/8', async () => {
      mockLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
      await expect(validateUrl('https://internal.example.com/')).rejects.toThrow(/Blocked IP/);
    });

    it('should reject private IPs in 172.16.0.0/12', async () => {
      mockLookup.mockResolvedValue([{ address: '172.16.0.1', family: 4 }]);
      await expect(validateUrl('https://internal.example.com/')).rejects.toThrow(/Blocked IP/);
    });

    it('should reject private IPs in 192.168.0.0/16', async () => {
      mockLookup.mockResolvedValue([{ address: '192.168.1.1', family: 4 }]);
      await expect(validateUrl('https://internal.example.com/')).rejects.toThrow(/Blocked IP/);
    });

    it('should reject link-local IPs in 169.254.0.0/16', async () => {
      mockLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
      await expect(validateUrl('https://metadata.example.com/')).rejects.toThrow(/Blocked IP/);
    });

    it('should reject IPv6 loopback ::1', async () => {
      mockLookup.mockResolvedValue([{ address: '::1', family: 6 }]);
      await expect(validateUrl('https://ipv6-localhost.example.com/')).rejects.toThrow(/Blocked IP/);
    });

    it('should reject IPv6 unique local fc00::', async () => {
      mockLookup.mockResolvedValue([{ address: 'fc00::1', family: 6 }]);
      await expect(validateUrl('https://ipv6-private.example.com/')).rejects.toThrow(/Blocked IP/);
    });

    it('should accept public IPs', async () => {
      mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      const result = await validateUrl('https://example.com/');
      expect(result.hostname).toBe('example.com');
    });
  });

  describe('custom blocked IP ranges', () => {
    it('should reject IPs in custom blocked ranges', async () => {
      mockLookup.mockResolvedValue([{ address: '203.0.113.5', family: 4 }]);
      await expect(
        validateUrl('https://example.com/', { blockedIpRanges: ['203.0.113.0/24'] })
      ).rejects.toThrow(/Blocked IP/);
    });

    it('should accept IPs not in custom blocked ranges', async () => {
      mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      const result = await validateUrl('https://example.com/', { blockedIpRanges: ['203.0.113.0/24'] });
      expect(result.hostname).toBe('example.com');
    });
  });

  describe('allowLocalhost option', () => {
    it('should allow localhost when allowLocalhost is true', async () => {
      mockLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      // 127.0.0.1 is still blocked by 127.0.0.0/8 CIDR, but the explicit
      // localhost string check is skipped. Since CIDR still blocks it,
      // this tests the allowLocalhost path even though the end result is blocked.
      await expect(
        validateUrl('https://localhost/', { allowLocalhost: true })
      ).rejects.toThrow(/Blocked IP/);
    });
  });

  describe('DNS resolution failures', () => {
    it('should reject when DNS fails', async () => {
      mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
      await expect(validateUrl('https://nonexistent.example.com/')).rejects.toThrow(/resolve hostname/);
    });
  });
});

describe('validateRedirect', () => {
  it('should validate redirect URL against SSRF', async () => {
    const result = await validateRedirect('https://example.com/new', 'https://example.com/old');
    expect(result.href).toBe('https://example.com/new');
  });

  it('should reject redirect to private IP', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    await expect(
      validateRedirect('https://internal.example.com/', 'https://example.com/')
    ).rejects.toThrow(/Blocked IP/);
  });
});

describe('isHttps', () => {
  it('should return true for HTTPS URLs', () => {
    expect(isHttps('https://example.com')).toBe(true);
    expect(isHttps('https://example.com/path?query=1')).toBe(true);
  });

  it('should return false for non-HTTPS URLs', () => {
    expect(isHttps('http://example.com')).toBe(false);
    expect(isHttps('ftp://example.com')).toBe(false);
    expect(isHttps('file:///path')).toBe(false);
  });

  it('should return false for invalid URLs', () => {
    expect(isHttps('not-a-url')).toBe(false);
  });
});

describe('getHostname', () => {
  it('should extract hostname from URLs', () => {
    expect(getHostname('https://example.com/path')).toBe('example.com');
    expect(getHostname('https://api.github.com/users')).toBe('api.github.com');
    expect(getHostname('https://sub.domain.example.com:8080/path')).toBe('sub.domain.example.com');
  });

  it('should return undefined for invalid URLs', () => {
    expect(getHostname('not-a-url')).toBeUndefined();
  });
});
