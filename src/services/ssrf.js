import dns from 'node:dns';
import { URL } from 'node:url';
import net from 'node:net';
import { config } from '../utils/config.js';

const dnsCache = new Map();
const DNS_CACHE_TTL_MS = 60 * 1000;

export function isPrivateIP(ip) {
  if (!net.isIP(ip)) {
    return false;
  }

  // Convert IPv4-mapped IPv6 to IPv4
  let checkIp = ip;
  if (net.isIPv6(ip) && ip.toLowerCase().startsWith('::ffff:')) {
    checkIp = ip.substring(7);
  }

  if (net.isIPv4(checkIp)) {
    const parts = checkIp.split('.').map(part => parseInt(part, 10));
    const [a, b, c, d] = parts;

    // 127.0.0.0/8 (loopback)
    if (a === 127) return true;
    // 10.0.0.0/8 (private)
    if (a === 10) return true;
    // 172.16.0.0/12 (private)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16 (private)
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;
    // 0.0.0.0/8 (unspecified)
    if (a === 0) return true;
    
    return false;
  }

  if (net.isIPv6(checkIp)) {
    const normalized = checkIp.toLowerCase();
    
    // ::1 (IPv6 loopback)
    if (normalized === '::1') return true;
    
    // Parse IPv6 address parts
    // Expand completely
    let hexParts = normalized.split(':');
    if (hexParts.includes('')) {
      const emptyIndex = hexParts.indexOf('');
      const toFill = 8 - (hexParts.length - 1);
      hexParts.splice(emptyIndex, 1, ...Array(toFill).fill('0'));
    }
    hexParts = hexParts.map(p => p || '0');
    
    const firstPart = parseInt(hexParts[0], 16);
    
    // fc00::/7 (IPv6 unique local)
    if ((firstPart & 0xfe00) === 0xfc00) return true;
    
    // fe80::/10 (IPv6 link-local)
    if ((firstPart & 0xffc0) === 0xfe80) return true;
    
    // Unspecified
    if (hexParts.every(p => parseInt(p, 16) === 0)) return true;
    
    return false;
  }

  return false;
}

export function normalizeUrl(urlString) {
  let urlObj;
  try {
    urlObj = new URL(urlString);
  } catch (e) {
    throw new Error('Invalid URL');
  }

  // Remove fragment
  urlObj.hash = '';

  let normalized = urlObj.toString();
  
  // Remove trailing slash if path is just '/'
  if (normalized.endsWith('/') && urlObj.pathname === '/' && !urlObj.search) {
      normalized = normalized.slice(0, -1);
  }
  
  return normalized;
}

export async function validateUrl(urlString) {
  let urlObj;
  try {
    urlObj = new URL(urlString);
  } catch (e) {
    throw new Error('Invalid URL format');
  }

  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    throw new Error('Protocol not allowed');
  }

  const hostname = urlObj.hostname.toLowerCase();
  const localDemoHostnames = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

  // String checks
  if (!config.allowPrivateTargets && localDemoHostnames.has(hostname)) {
    throw new Error('Private hostname not allowed');
  }

  // Avoid external-DNS dependency when the explicitly opt-in development
  // setting is being used for the bundled localhost demo.
  if (config.allowPrivateTargets && localDemoHostnames.has(hostname)) {
    return { url: normalizeUrl(urlString), hostname, resolvedIPs: [hostname] };
  }

  let resolvedIPs = [];
  
  const cachedDns = dnsCache.get(hostname);
  if (cachedDns && (Date.now() - cachedDns.timestamp < DNS_CACHE_TTL_MS)) {
    resolvedIPs = cachedDns.resolvedIPs;
  } else if (net.isIP(hostname)) {
    resolvedIPs = [hostname];
  } else {
    try {
      const [ipv4s, ipv6s] = await Promise.allSettled([
        dns.promises.resolve4(hostname),
        dns.promises.resolve6(hostname)
      ]);
      
      if (ipv4s.status === 'fulfilled') resolvedIPs.push(...ipv4s.value);
      if (ipv6s.status === 'fulfilled') resolvedIPs.push(...ipv6s.value);
      
      if (resolvedIPs.length === 0) {
        throw new Error('DNS resolution failed to find any IP addresses');
      }
      dnsCache.set(hostname, { resolvedIPs, timestamp: Date.now() });
    } catch (err) {
      throw new Error(`DNS resolution failed: ${err.message}`);
    }
  }

  for (const ip of resolvedIPs) {
    if (!config.allowPrivateTargets && isPrivateIP(ip)) {
      throw new Error(`URL resolves to private IP: ${ip}`);
    }
  }

  const normalizedUrl = normalizeUrl(urlString);

  return { url: normalizedUrl, hostname, resolvedIPs };
}

export async function validateUrlSafe(urlString) {
  try {
    const result = await validateUrl(urlString);
    return { safe: true, ...result };
  } catch (err) {
    return { safe: false, error: err.message };
  }
}
