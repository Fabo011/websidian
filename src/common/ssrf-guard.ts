import { BadRequestException } from '@nestjs/common';
import { Agent as HttpAgent, ClientRequestArgs } from 'http';
import {
  Agent as HttpsAgent,
  RequestOptions as HttpsRequestOptions,
} from 'https';
import { lookup as dnsLookup, LookupAddress } from 'dns';
import { Duplex } from 'stream';
import ipaddr from 'ipaddr.js';

/**
 * SSRF egress guard for bring-your-own storage (user-supplied WebDAV URL /
 * S3 endpoint). See security/audits/2026-07-23 SSRF-1.
 *
 * Two layers:
 *  1. {@link assertPublicHttpUrl} — a cheap, synchronous check at the validation
 *     boundary: scheme must be http/https and, when the host is an IP literal,
 *     it must be a public unicast address. Gives the user a clear 400 for the
 *     obvious payloads (`http://169.254.169.254`, `http://127.0.0.1`, `file://`).
 *  2. {@link guardedHttpAgent} / {@link guardedHttpsAgent} — HTTP(S) agents whose
 *     socket DNS resolution is replaced by {@link guardedLookup}. Every
 *     connection (including redirects) re-resolves the hostname and refuses to
 *     connect if ANY resolved address is non-public. This is the real backstop:
 *     it blocks hostnames that resolve to private space and defeats DNS
 *     rebinding (resolve-public-at-save, resolve-private-at-connect).
 *
 * The guard is only applied to providers built from *user* credentials; the
 * operator's own global/managed backend is trusted (it may legitimately point
 * at an internal address) and is left unguarded.
 */

/**
 * Is this IP address outside the public unicast range?
 *
 * ipaddr.js classifies every address into a range; only `unicast` is public.
 * Everything else — loopback, link-local (169.254/16 metadata, fe80::/10),
 * private (RFC1918), carrier-grade NAT, unique-local, reserved, multicast … —
 * is refused. IPv4-mapped IPv6 addresses are unwrapped first so `::ffff:10.0.0.1`
 * cannot slip through. Unparseable input is treated as blocked (fail closed).
 */
export function isBlockedAddress(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return true;
  }
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      addr = v6.toIPv4Address();
    }
  }
  return addr.range() !== 'unicast';
}

/**
 * Validate a user-supplied storage URL. Throws {@link BadRequestException} when
 * the scheme is not http/https or the host is a non-public IP literal. Hostnames
 * are not resolved here (that is the agent's job at connect time), so this stays
 * synchronous and safe to use from a validator.
 */
export function assertPublicHttpUrl(rawUrl: string, label = 'URL'): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException(`${label} is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestException(`${label} must use http or https.`);
  }
  // Strip the brackets IPv6 literals carry in a URL host.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) && isBlockedAddress(host)) {
    throw new BadRequestException(
      `${label} may not point at a private or internal address.`,
    );
  }
}

/** DNS timeout for a guarded connection, in milliseconds. */
const DNS_LOOKUP_TIMEOUT_MS = 15_000;

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `dns.lookup`-compatible function that resolves the hostname and then refuses
 * the connection if ANY resolved address is non-public. Wired into the guarded
 * agents so the check happens at connect time (covering redirects and DNS
 * rebinding), not just at save time.
 */
export function guardedLookup(
  hostname: string,
  options: unknown,
  callback?: LookupCallback,
): void {
  const cb = (typeof options === 'function' ? options : callback) as
    LookupCallback | undefined;
  const opts =
    options && typeof options === 'object'
      ? (options as Record<string, unknown>)
      : {};
  if (!cb) {
    return;
  }
  dnsLookup(
    hostname,
    { ...opts, all: true, verbatim: true },
    (err, addresses) => {
      if (err) {
        return cb(err);
      }
      for (const a of addresses) {
        if (isBlockedAddress(a.address)) {
          return cb(
            Object.assign(
              new Error(
                `Blocked request to non-public address ${a.address} (${hostname}).`,
              ),
              { code: 'ESSRFBLOCKED' },
            ),
          );
        }
      }
      if (opts.all) {
        return cb(null, addresses);
      }
      const first = addresses[0];
      return cb(null, first.address, first.family);
    },
  );
}

class GuardedHttpAgent extends HttpAgent {
  createConnection(
    options: ClientRequestArgs,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex {
    const guarded = { ...options, lookup: guardedLookup } as ClientRequestArgs;
    return super.createConnection(guarded, callback);
  }
}

class GuardedHttpsAgent extends HttpsAgent {
  createConnection(
    options: HttpsRequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex {
    const guarded = {
      ...options,
      lookup: guardedLookup,
    } as HttpsRequestOptions;
    // https.Agent.createConnection is present at runtime but not in its public
    // type; it is inherited from http.Agent.
    return (
      super.createConnection as unknown as (
        o: HttpsRequestOptions,
        cb?: (err: Error | null, stream: Duplex) => void,
      ) => Duplex
    )(guarded, callback);
  }
}

/** Shared guarded agents for all user-provider outbound requests. */
export const guardedHttpAgent = new GuardedHttpAgent({
  keepAlive: true,
  timeout: DNS_LOOKUP_TIMEOUT_MS,
});
export const guardedHttpsAgent = new GuardedHttpsAgent({
  keepAlive: true,
  timeout: DNS_LOOKUP_TIMEOUT_MS,
});
