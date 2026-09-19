import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP } from "node:net";

/** Addresses a server-side fetch must never reach on behalf of a user: loopback, private, link-local, metadata. */
const privateRanges = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  privateRanges.addSubnet(network, prefix, "ipv6");
}

export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const ip = mapped ?? address;
  const family = isIP(ip);
  if (family === 0) return true; // not an address at all: refuse rather than guess
  return privateRanges.check(ip, family === 4 ? "ipv4" : "ipv6");
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: "invalid_url" | "blocked_address"; detail: string };

/** Shape checks that need no network: scheme, credentials, and literal IP addresses. */
export function checkUrl(input: string, allowPrivate: boolean): UrlCheck {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: "invalid_url", detail: `"${input}" is not a valid URL.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "invalid_url", detail: `Only http and https are fetched, not ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "invalid_url", detail: "URLs with embedded credentials are not fetched." };
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literalOrLocal = isIP(host) !== 0 ? isPrivateAddress(host) : /(^|\.)localhost$/i.test(host);
  if (!allowPrivate && literalOrLocal) {
    return { ok: false, reason: "blocked_address", detail: `${host} is a private or loopback address.` };
  }
  return { ok: true, url };
}

export class BlockedAddressError extends Error {
  constructor(hostname: string, address: string) {
    super(`${hostname} resolves to ${address}, a private or loopback address.`);
    this.name = "BlockedAddressError";
  }
}

type LookupCallback = (error: Error | null, address?: unknown, family?: number) => void;

/**
 * A DNS lookup for the socket layer that refuses private addresses. Checking
 * at connect time, not before it, means a hostname cannot pass validation and
 * then resolve somewhere else for the real request (DNS rebinding), and every
 * redirect hop is covered without extra code.
 */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: object, callback: LookupCallback): void => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const blocked = allowPrivate ? undefined : addresses.find((entry) => isPrivateAddress(entry.address));
      if (blocked) return callback(new BlockedAddressError(hostname, blocked.address));

      if ((options as { all?: boolean }).all) return callback(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}
