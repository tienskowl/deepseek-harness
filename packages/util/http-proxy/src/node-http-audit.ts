/**
 * Guard Node's classic HTTP clients in addition to the Undici dispatcher.
 * Installed at profile startup, before user plugins mount. This cannot reach
 * copies of the original functions captured before installation, or subprocesses.
 */
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { isBlockedHostname, type NetworkPolicy } from './network-policy.ts'

type RequestFunction = typeof http.request
type HttpModule = { request: RequestFunction; get: typeof http.get }

export interface NetworkAuditOptions {
  readonly networkPolicy?: NetworkPolicy
  readonly reportDenied?: (hostname: string) => void
}

function requestHostname(args: readonly unknown[]): string | undefined {
  const first = args[0]
  const second = args[1]
  const fromUrl = typeof first === 'string' || first instanceof URL
    ? (() => {
        try { return new URL(String(first)).hostname } catch { return undefined }
      })()
    : undefined
  const options = (typeof first === 'object' && first !== null && !(first instanceof URL)
    ? first
    : typeof second === 'object' && second !== null && !(second instanceof URL)
      ? second
      : undefined) as { hostname?: unknown; host?: unknown } | undefined
  // Node's request(url, options) options override the parsed URL.
  const candidate = options?.hostname ?? options?.host
  if (typeof candidate === 'string') {
    // host can contain a port or [IPv6]:port; URL handles both forms.
    try { return new URL(`http://${candidate}`).hostname } catch { return undefined }
  }
  return fromUrl ?? (options === undefined ? undefined : 'localhost')
}

/**
 * Install a per-process, reversible policy on http(s).request/get.
 * Denials throw before a ClientRequest/socket is created; allowed calls keep
 * Node's original overloads, callback, options and return value.
 */
export function installNodeHttpAudit(options: NetworkAuditOptions): () => void {
  const domains = options.networkPolicy?.blockedDomains ?? []
  if (domains.length === 0) return () => {}
  const originals = [
    { api: http as HttpModule, request: http.request, get: http.get },
    { api: https as HttpModule, request: https.request, get: https.get },
  ]
  for (const { api, request } of originals) {
    const guardedRequest = function (...args: unknown[]) {
      const hostname = requestHostname(args)
      if (hostname !== undefined && isBlockedHostname(hostname, domains)) {
        if (options.networkPolicy?.auditDenied !== false) options.reportDenied?.(hostname)
        throw new Error(`DSH_NETWORK_DENIED: outbound connection blocked for ${hostname}`)
      }
      return Reflect.apply(request, api, args) as ReturnType<RequestFunction>
    } as RequestFunction
    api.request = guardedRequest
    // Do not call the original get: it references the module's original request
    // internally in some Node versions, bypassing our guarded wrapper.
    api.get = ((...args: unknown[]) => {
      const req = Reflect.apply(guardedRequest, api, args) as ReturnType<RequestFunction>
      req.end()
      return req
    }) as typeof http.get
  }
  syncBuiltinESMExports()
  return () => {
    for (const { api, request, get } of originals) {
      api.request = request
      api.get = get
    }
    syncBuiltinESMExports()
  }
}
