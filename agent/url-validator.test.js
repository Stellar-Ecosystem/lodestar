import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateEndpointUrl, validateRedirect, createSafeFetch } from './url-validator.js';

describe('URL Validator - SSRF Protection', () => {
  beforeEach(() => {
    // Clear environment variables before each test
    delete process.env.ALLOWED_ENDPOINTS;
  });

  describe('validateEndpointUrl', () => {
    it('should reject non-HTTPS URLs', async () => {
      const result = await validateEndpointUrl('http://example.com');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('HTTPS');
    });

    it('should accept valid HTTPS URLs', async () => {
      const result = await validateEndpointUrl('https://example.com');
      expect(result.valid).toBe(true);
    });

    it('should reject private IPv4 addresses', async () => {
      const privateIPs = [
        'https://10.0.0.1',
        'https://172.16.0.1',
        'https://192.168.1.1',
        'https://169.254.169.254', // AWS metadata service
      ];

      for (const url of privateIPs) {
        const result = await validateEndpointUrl(url);
        expect(result.valid).toBe(false);
        expect(result.reason).toContain('Private IP');
      }
    });

    it('should reject loopback addresses', async () => {
      const loopbackIPs = [
        'https://127.0.0.1',
        'https://127.0.0.1:3000',
        'https://localhost',
      ];

      for (const url of loopbackIPs) {
        const result = await validateEndpointUrl(url);
        expect(result.valid).toBe(false);
        expect(result.reason).toContain('Private IP');
      }
    });

    it('should reject link-local addresses', async () => {
      const result = await validateEndpointUrl('https://169.254.1.1');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Private IP');
    });

    it('should reject IPv6 loopback', async () => {
      const result = await validateEndpointUrl('https://[::1]');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Private IP');
    });

    it('should reject IPv6 link-local', async () => {
      const result = await validateEndpointUrl('https://[fe80::1]');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Private IP');
    });

    it('should reject IPv6 unique local', async () => {
      const result = await validateEndpointUrl('https://[fc00::1]');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Private IP');
    });

    it('should accept public IPv4 addresses', async () => {
      const result = await validateEndpointUrl('https://8.8.8.8');
      expect(result.valid).toBe(true);
    });

    it('should accept public IPv6 addresses', async () => {
      const result = await validateEndpointUrl('https://[2001:4860:4860::8888]');
      expect(result.valid).toBe(true);
    });

    it('should reject invalid URLs', async () => {
      const result = await validateEndpointUrl('not-a-url');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Invalid URL');
    });

    it('should allow URLs from allowlist', async () => {
      process.env.ALLOWED_ENDPOINTS = 'localhost,127.0.0.1';
      
      const result1 = await validateEndpointUrl('https://localhost:3000');
      expect(result1.valid).toBe(true);

      const result2 = await validateEndpointUrl('https://127.0.0.1:3001');
      expect(result2.valid).toBe(true);
    });

    it('should allow subdomains matching allowlist', async () => {
      process.env.ALLOWED_ENDPOINTS = 'example.com';
      
      const result = await validateEndpointUrl('https://api.example.com');
      expect(result.valid).toBe(true);
    });

    it('should reject DNS resolution to private IPs', async () => {
      // Mock DNS resolution to return a private IP
      vi.mock('dns/promises', () => ({
        resolve: vi.fn().mockResolvedValue(['192.168.1.1']),
      }));

      const { resolve } = await import('dns/promises');
      resolve.mockResolvedValue(['192.168.1.1']);

      const result = await validateEndpointUrl('https://malicious.com');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('DNS resolved to private IP');
    });

    it('should reject DNS resolution to metadata service IP', async () => {
      const { resolve } = await import('dns/promises');
      resolve.mockResolvedValue(['169.254.169.254']);

      const result = await validateEndpointUrl('https://attacker.com');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('DNS resolved to private IP');
    });

    it('should accept DNS resolution to public IPs', async () => {
      const { resolve } = await import('dns/promises');
      resolve.mockResolvedValue(['1.1.1.1']);

      const result = await validateEndpointUrl('https://example.com');
      expect(result.valid).toBe(true);
    });

    it('should reject DNS resolution failures', async () => {
      const { resolve } = await import('dns/promises');
      resolve.mockRejectedValue(new Error('DNS lookup failed'));

      const result = await validateEndpointUrl('https://example.com');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('DNS resolution failed');
    });
  });

  describe('validateRedirect', () => {
    it('should validate redirect URL using same rules', async () => {
      const result = await validateRedirect(
        'https://example.com',
        'https://malicious.com'
      );
      expect(result.valid).toBe(true);
    });

    it('should block redirect to private IP', async () => {
      const result = await validateRedirect(
        'https://example.com',
        'https://192.168.1.1'
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Redirect blocked');
    });

    it('should block redirect to metadata service', async () => {
      const result = await validateRedirect(
        'https://example.com',
        'https://169.254.169.254/latest/meta-data/'
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Redirect blocked');
    });

    it('should block cross-host redirects unless allowed', async () => {
      const result = await validateRedirect(
        'https://example.com',
        'https://other.com'
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Cross-host redirect blocked');
    });

    it('should allow same-host redirects', async () => {
      const result = await validateRedirect(
        'https://example.com/path1',
        'https://example.com/path2'
      );
      expect(result.valid).toBe(true);
    });

    it('should allow cross-host redirects in allowlist', async () => {
      process.env.ALLOWED_ENDPOINTS = 'trusted.com';
      
      const result = await validateRedirect(
        'https://example.com',
        'https://api.trusted.com'
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('createSafeFetch', () => {
    it('should block requests to invalid URLs', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Map(),
      });

      const safeFetch = createSafeFetch(mockFetch);

      await expect(safeFetch('http://example.com')).rejects.toThrow('SSRF_BLOCKED');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should allow requests to valid URLs', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Map(),
      });

      const safeFetch = createSafeFetch(mockFetch);

      const result = await safeFetch('https://example.com');
      expect(mockFetch).toHaveBeenCalledWith('https://example.com', {});
      expect(result.status).toBe(200);
    });

    it('should block redirects to private IPs', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          status: 302,
          headers: new Map([['location', 'https://192.168.1.1']]),
        });

      const safeFetch = createSafeFetch(mockFetch);

      await expect(safeFetch('https://example.com')).rejects.toThrow('SSRF_REDIRECT_BLOCKED');
    });

    it('should block redirects to metadata service', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          status: 302,
          headers: new Map([['location', 'https://169.254.169.254/latest/meta-data/']]),
        });

      const safeFetch = createSafeFetch(mockFetch);

      await expect(safeFetch('https://example.com')).rejects.toThrow('SSRF_REDIRECT_BLOCKED');
    });

    it('should follow valid same-host redirects', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          status: 302,
          headers: new Map([['location', '/new-path']]),
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: new Map(),
        });

      const safeFetch = createSafeFetch(mockFetch);

      const result = await safeFetch('https://example.com/old-path');
      expect(result.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should handle relative redirect URLs', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          status: 302,
          headers: new Map([['location', '/api/v2']]),
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: new Map(),
        });

      const safeFetch = createSafeFetch(mockFetch);

      const result = await safeFetch('https://example.com/api/v1');
      expect(result.status).toBe(200);
    });
  });

  describe('SSRF Attack Scenarios', () => {
    it('should block AWS metadata service attack', async () => {
      const attackUrls = [
        'https://169.254.169.254/latest/meta-data/',
        'https://169.254.169.254/latest/meta-data/iam/security-credentials/',
        'https://169.254.169.254/latest/user-data',
      ];

      for (const url of attackUrls) {
        const result = await validateEndpointUrl(url);
        expect(result.valid).toBe(false);
        expect(result.reason).toContain('Private IP');
      }
    });

    it('should block GCP metadata service attack', async () => {
      const result = await validateEndpointUrl('https://metadata.google.internal/computeMetadata/v1/');
      // This would resolve to a private IP via DNS
      const { resolve } = await import('dns/promises');
      resolve.mockResolvedValue(['169.254.169.254']);

      const validation = await validateEndpointUrl('https://metadata.google.internal/computeMetadata/v1/');
      expect(validation.valid).toBe(false);
    });

    it('should block localhost admin panel attack', async () => {
      const attackUrls = [
        'https://localhost:3001/admin',
        'https://127.0.0.1:8080/api',
        'https://127.0.0.1:6379', // Redis
        'https://localhost:27017', // MongoDB
      ];

      for (const url of attackUrls) {
        const result = await validateEndpointUrl(url);
        expect(result.valid).toBe(false);
        expect(result.reason).toContain('Private IP');
      }
    });

    it('should block internal network scan', async () => {
      const internalIPs = [
        'https://192.168.0.1',
        'https://192.168.1.1',
        'https://10.0.0.1',
        'https://172.16.0.1',
      ];

      for (const url of internalIPs) {
        const result = await validateEndpointUrl(url);
        expect(result.valid).toBe(false);
        expect(result.reason).toContain('Private IP');
      }
    });

    it('should block DNS rebinding attack', async () => {
      const { resolve } = await import('dns/promises');
      // First call returns public IP, second returns private IP
      resolve.mockResolvedValue(['192.168.1.1']);

      const result = await validateEndpointUrl('https://attacker.com');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('DNS resolved to private IP');
    });
  });
});
