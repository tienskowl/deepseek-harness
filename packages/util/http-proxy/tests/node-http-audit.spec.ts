import http, { get as esmHttpGet, request as esmHttpRequest } from 'node:http'
import https, { request as esmHttpsRequest } from 'node:https'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { installNodeHttpAudit } from '../src/node-http-audit.ts'

const restore: Array<() => void> = []
afterEach(() => { for (const dispose of restore.splice(0).reverse()) dispose() })

function guard(domains = ['deepseek.com', 'deepseek.cn']) {
  const reported: string[] = []
  const dispose = installNodeHttpAudit({
    networkPolicy: { blockedDomains: domains, auditDenied: true },
    reportDenied: hostname => { reported.push(hostname) },
  })
  restore.push(dispose)
  return reported
}

describe('classic Node HTTP network audit', () => {
  it('denies request URL strings, URLs and options objects before DNS/socket creation', () => {
    const reported = guard()
    expect(() => http.request('http://api.deepseek.com/path?token=secret')).toThrow('DSH_NETWORK_DENIED')
    expect(() => https.request(new URL('https://deepseek.cn/'))).toThrow('DSH_NETWORK_DENIED')
    expect(() => http.request({ hostname: 'foo.deepseek.com', path: '/' })).toThrow('DSH_NETWORK_DENIED')
    expect(() => http.get('http://deepseek.com/')).toThrow('DSH_NETWORK_DENIED')
    expect(() => https.get({ host: 'api.deepseek.cn:443' })).toThrow('DSH_NETWORK_DENIED')
    expect(reported).toEqual(['api.deepseek.com', 'deepseek.cn', 'foo.deepseek.com', 'deepseek.com', 'api.deepseek.cn'])
    expect(reported.join(' ')).not.toContain('secret')
  })

  it('honors the URL options override and case-insensitive exact suffix match', () => {
    guard()
    expect(() => http.request('http://allowed.test', { hostname: 'API.DEEPSEEK.COM' })).toThrow('DSH_NETWORK_DENIED')
    expect(() => http.request('http://api.deepseek.com', { hostname: 'deepseek.com.evil.test' })).not.toThrow()
    // The permitted request was only allocated, never sent.
  })

  it('updates named built-in ESM exports and restores them on dispose', () => {
    const originalRequest = http.request
    const originalGet = http.get
    const reported = guard()
    expect(() => esmHttpRequest('http://deepseek.com')).toThrow('DSH_NETWORK_DENIED')
    expect(() => esmHttpGet('http://deepseek.cn')).toThrow('DSH_NETWORK_DENIED')
    expect(() => esmHttpsRequest('https://api.deepseek.com')).toThrow('DSH_NETWORK_DENIED')
    expect(reported).toHaveLength(3)
    restore.pop()?.()
    expect(http.request).toBe(originalRequest)
    expect(http.get).toBe(originalGet)
  })

  it('preserves allowed request behavior including get, callback and response', async () => {
    const server = createServer((_req, res) => { res.end('OK') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as AddressInfo).port
      guard()
      const body = await new Promise<string>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/`, response => {
          let output = ''
          response.on('data', chunk => { output += String(chunk) })
          response.on('end', () => resolve(output))
          response.on('error', reject)
        }).on('error', reject)
      })
      expect(body).toBe('OK')
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('supports reentrant guards and audit suppression', () => {
    guard(['deepseek.com'])
    const messages: string[] = []
    const dispose = installNodeHttpAudit({
      networkPolicy: { blockedDomains: ['example.org'], auditDenied: false },
      reportDenied: host => messages.push(host),
    })
    restore.push(dispose)
    expect(() => http.request('http://x.example.org')).toThrow('DSH_NETWORK_DENIED')
    expect(messages).toEqual([])
    restore.pop()?.()
    expect(() => http.request('http://deepseek.com')).toThrow('DSH_NETWORK_DENIED')
  })
})
