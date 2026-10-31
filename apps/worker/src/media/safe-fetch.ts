// An HTTP client for links an AI sends us (upload_media sourceUrl): https only, and it connects only
// to public IP addresses. The check runs in the socket's DNS lookup, i.e. on the address actually
// dialled, so a host name that resolves to a private, loopback, link-local (cloud metadata) or other
// reserved address is refused, including after a redirect and on DNS rebinding. Redirects are not
// followed here: the downloader (drive.ts downloadToFile) re-checks every hop and fetches it again
// through this client. Bodies are not decompressed (identity encoding) so the byte cap is exact.

import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions, type LookupOneOptions } from 'node:dns'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { isPublicIp } from '@app/core/links'
import type { FetchLike } from './drive'

/** A refused address (the downloader reports it as a refusal, not a temporary error). */
export class PrivateAddressError extends Error {
  override readonly name = 'PrivateAddressError'
  readonly code = 'EPRIVATEADDRESS'
}

export type Resolver = (hostname: string) => Promise<LookupAddress[]>

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(addresses)))
  })

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

/**
 * A `lookup` for net/tls sockets that resolves with `resolver` and fails unless EVERY address is
 * public (a mixed answer could be raced to the private one).
 */
export function publicOnlyLookup(resolver: Resolver = systemResolver) {
  return (hostname: string, options: LookupOneOptions | LookupAllOptions | number, callback: LookupCallback): void => {
    const all = typeof options === 'object' && options !== null && (options as LookupAllOptions).all === true
    resolver(hostname).then(
      (addresses) => {
        if (addresses.length === 0) return callback(Object.assign(new Error(`${hostname} did not resolve`), { code: 'ENOTFOUND' }), '', 4)
        const blocked = addresses.find((a) => !isPublicIp(a.address))
        if (blocked) return callback(new PrivateAddressError(`${hostname} resolves to a non-public address`), '', 4)
        if (all) return callback(null, addresses)
        const first = addresses[0] as LookupAddress
        callback(null, first.address, first.family)
      },
      (error: NodeJS.ErrnoException) => callback(error, '', 4),
    )
  }
}

const NULL_BODY = new Set([101, 103, 204, 205, 304])

/** fetch-shaped GET over https that only dials public IP addresses and never follows redirects. */
export function createPublicFetch(options: { resolver?: Resolver; request?: typeof httpsRequest } = {}): FetchLike {
  const lookup = publicOnlyLookup(options.resolver)
  const request = options.request ?? httpsRequest
  return (input, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      let url: URL
      try {
        url = new URL(input)
      } catch {
        reject(new TypeError('Invalid URL'))
        return
      }
      if (url.protocol !== 'https:') {
        reject(new TypeError('Only https:// links are fetched'))
        return
      }
      const headers: Record<string, string> = {}
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value
      })
      headers['accept-encoding'] = 'identity'
      const req = request(
        {
          protocol: 'https:',
          hostname: url.hostname.replace(/^\[|\]$/g, ''),
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers,
          lookup: lookup as never,
          agent: false,
          servername: url.hostname,
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0
          const out = new Headers()
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue
            for (const v of Array.isArray(value) ? value : [value]) out.append(key, v)
          }
          if (status < 200 || status > 599) {
            res.destroy()
            reject(new TypeError(`Unexpected HTTP status ${status}`))
            return
          }
          const body = NULL_BODY.has(status) ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>)
          if (!body) res.resume()
          resolve(new Response(body, { status, headers: out }))
        },
      )
      req.on('error', reject)
      req.end()
    })
}
