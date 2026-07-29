import dns from 'dns/promises';
import net from 'net';
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
});

// Private IP ranges
const PRIVATE_IP_RANGES = [
  { start: '10.0.0.0', prefix: 8 },
  { start: '172.16.0.0', prefix: 12 },
  { start: '192.168.0.0', prefix: 16 },
  { start: '169.254.0.0', prefix: 16 }, // Link-local
  { start: '127.0.0.0', prefix: 8 }, // Loopback
];

// IPv6 private ranges
const PRIVATE_IPV6_RANGES = [
  { start: '::1', prefix: 128 }, // Loopback
  { start: 'fe80::', prefix: 10 }, // Link-local
  { start: 'fc00::', prefix: 7 }, // Unique local
];

// Configurable allowlist for local development
const ALLOWLIST = process.env.ALLOWED_ENDPOINTS
  ? process.env.ALLOWED_ENDPOINTS.split(',').map(s => s.trim().toLowerCase())
  : [];

/**
 * Check if an IP address is in a private range
 */
function isPrivateIP(ip) {
  // Check IPv4
  if (net.isIPv4(ip)) {
    const ipNum = ipToNumber(ip);
    for (const range of PRIVATE_IP_RANGES) {
      const startNum = ipToNumber(range.start);
      const mask = (0xFFFFFFFF << (32 - range.prefix)) >>> 0;
      if ((ipNum & mask) === (startNum & mask)) {
        return true;
      }
    }
    return false;
  }

  // Check IPv6
  if (net.isIPv6(ip)) {
    for (const range of PRIVATE_IPV6_RANGES) {
      if (isIPv6InRange(ip, range.start, range.prefix)) {
        return true;
      }
    }
    return false;
  }

  return false;
}

/**
 * Convert IPv4 address to number
 */
function ipToNumber(ip) {
  const parts = ip.split('.').map(Number);
  return (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/**
 * Check if IPv6 address is in range
 */
function isIPv6InRange(ip, start, prefix) {
  const ipBytes = ipv6ToBytes(ip);
  const startBytes = ipv6ToBytes(start);
  const maskBytes = prefixToMask(prefix);
  
  for (let i = 0; i < 16; i++) {
    if ((ipBytes[i] & maskBytes[i]) !== (startBytes[i] & maskBytes[i])) {
      return false;
    }
  }
  return true;
}

/**
 * Convert IPv6 address to byte array
 */
function ipv6ToBytes(ip) {
  const bytes = new Uint8Array(16);
  const parts = ip.split(':');
  let byteIndex = 0;
  
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '') {
      // Handle :: expansion
      const skip = 8 - parts.length + 1;
      byteIndex += skip * 2;
    } else {
      const num = parseInt(part, 16);
      bytes[byteIndex++] = (num >> 8) & 0xFF;
      bytes[byteIndex++] = num & 0xFF;
    }
  }
  
  return bytes;
}

/**
 * Convert prefix length to mask bytes
 */
function prefixToMask(prefix) {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    const bitsRemaining = Math.max(0, prefix - i * 8);
    bytes[i] = bitsRemaining >= 8 ? 0xFF : (0xFF << (8 - bitsRemaining)) & 0xFF;
  }
  return bytes;
}

/**
 * Validate a URL before making a request
 * @param {string} url - The URL to validate
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function validateEndpointUrl(url) {
  try {
    const parsed = new URL(url);
    
    // Check protocol - must be HTTPS
    if (parsed.protocol !== 'https:') {
      return { valid: false, reason: `Protocol must be HTTPS, got ${parsed.protocol}` };
    }

    const hostname = parsed.hostname;
    
    // Check allowlist
    if (ALLOWLIST.some(allowed => hostname.toLowerCase().includes(allowed))) {
      logger.debug({ hostname }, 'URL allowed by allowlist');
      return { valid: true };
    }

    // Check if hostname is an IP address
    if (net.isIP(hostname)) {
      if (isPrivateIP(hostname)) {
        return { valid: false, reason: `Private IP address not allowed: ${hostname}` };
      }
      return { valid: true };
    }

    // Resolve DNS to check actual IP addresses
    try {
      const addresses = await dns.resolve(hostname);
      for (const address of addresses) {
        if (isPrivateIP(address)) {
          return { valid: false, reason: `DNS resolved to private IP: ${hostname} -> ${address}` };
        }
      }
    } catch (dnsErr) {
      // DNS resolution failed - this might be a legitimate issue, but we should block it
      // to prevent DNS rebinding attacks
      return { valid: false, reason: `DNS resolution failed for ${hostname}: ${dnsErr.message}` };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, reason: `Invalid URL: ${err.message}` };
  }
}

/**
 * Validate a redirect URL
 * @param {string} originalUrl - The original URL
 * @param {string} redirectUrl - The redirect URL
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function validateRedirect(originalUrl, redirectUrl) {
  const validation = await validateEndpointUrl(redirectUrl);
  if (!validation.valid) {
    return { valid: false, reason: `Redirect blocked: ${validation.reason}` };
  }

  // Additional check: redirect should not go to a different host unless explicitly allowed
  const originalHost = new URL(originalUrl).hostname;
  const redirectHost = new URL(redirectUrl).hostname;
  
  if (originalHost !== redirectHost && !ALLOWLIST.some(allowed => redirectHost.toLowerCase().includes(allowed))) {
    return { valid: false, reason: `Cross-host redirect blocked: ${originalHost} -> ${redirectHost}` };
  }

  return { valid: true };
}

/**
 * Create a fetch wrapper that validates URLs and redirects
 */
export function createSafeFetch(baseFetch) {
  return async (url, options = {}) => {
    // Validate initial URL
    const validation = await validateEndpointUrl(url);
    if (!validation.valid) {
      const err = new Error(validation.reason);
      err.code = 'SSRF_BLOCKED';
      throw err;
    }

    // Create fetch with redirect handling
    const response = await baseFetch(url, {
      ...options,
      redirect: 'manual', // We'll handle redirects manually
    });

    // Handle redirects
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return response;
      }

      // Resolve relative URLs
      const redirectUrl = new URL(location, url).toString();
      
      const redirectValidation = await validateRedirect(url, redirectUrl);
      if (!redirectValidation.valid) {
        const err = new Error(redirectValidation.reason);
        err.code = 'SSRF_REDIRECT_BLOCKED';
        throw err;
      }

      // Follow the redirect
      return createSafeFetch(baseFetch)(redirectUrl, options);
    }

    return response;
  };
}
