import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { getGlobalDispatcher } from 'undici'
import { installProxyFromEnvironment } from '../src/install.ts'
import { isBlockedHostname, loadNetworkPolicy, normalizeBlockedDomains } from '../src/network-policy.ts'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
function home(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-network-policy-'))
  homes.push(directory)
  return directory
}
const noProxy = { get: (_name: string): undefined => undefined }

describe('built-in network policy', () => {
  it('defaults to blocking deepseek.cn and deepseek.com including subdomains', () => {
    const policy = loadNetworkPolicy(home())
    expect(policy.blockedDomains).toEqual(['deepseek.cn', 'deepseek.com'])
    expect(isBlockedHostname('API.DEEPSEEK.COM.', policy.blockedDomains)).toBe(true)
    expect(isBlockedHostname('deepseek.cn', policy.blockedDomains)).toBe(true)
    expect(isBlockedHostname('fake-deepseek.com', policy.blockedDomains)).toBe(false)
    expect(isBlockedHostname('deepseek.com.attacker.test', policy.blockedDomains)).toBe(false)
  })

  it('allows configurable domain lists and an empty list', () => {
    const directory = home()
    writeFileSync(join(directory, 'network-policy.json'),
      JSON.stringify({ blockedDomains: ['Example.ORG.', 'internal.test'], auditDenied: false }))
    expect(loadNetworkPolicy(directory)).toEqual({ blockedDomains: ['example.org', 'internal.test'], auditDenied: false })
    writeFileSync(join(directory, 'network-policy.json'), JSON.stringify({ blockedDomains: [] }))
    expect(loadNetworkPolicy(directory).blockedDomains).toEqual([])
  })

  it('rejects malformed configuration instead of silently disabling the guard', () => {
    expect(() => normalizeBlockedDomains(['https://deepseek.com', '*.deepseek.com', 'deepseek.com:443'])).toThrow()
    const directory = home()
    writeFileSync(join(directory, 'network-policy.json'), '{"blockedDomains":"deepseek.com"}')
    expect(() => loadNetworkPolicy(directory)).toThrow('blockedDomains')
  })

  it('rejects outbound fetch before DNS lookup even without an HTTP proxy', async () => {
    const before = getGlobalDispatcher()
    const audit: string[] = []
    const dispose = await installProxyFromEnvironment(noProxy, () => {}, {
      networkPolicy: loadNetworkPolicy(home()), reportDenied: hostname => audit.push(hostname),
    })
    try {
      expect(getGlobalDispatcher()).not.toBe(before)
      await expect(fetch('https://api.deepseek.com/chat/completions')).rejects.toThrow()
      await expect(fetch('http://deepseek.cn/')).rejects.toThrow()
      expect(audit).toEqual(['api.deepseek.com', 'deepseek.cn'])
    } finally {
      await dispose()
    }
    expect(getGlobalDispatcher()).toBe(before)
  })

  it('never forwards blocked HTTP requests to an explicitly configured proxy', async () => {
    let arrivals = 0
    const proxy = createServer((_request, response) => {
      arrivals += 1
      response.writeHead(200).end('proxy')
    })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const port = (proxy.address() as AddressInfo).port
    const lookup = {
      get: (name: string) => name === 'HTTP_PROXY'
        ? { value: `http://127.0.0.1:${port}` }
        : undefined,
    }
    const audited: string[] = []
    const dispose = await installProxyFromEnvironment(lookup, () => {}, {
      networkPolicy: loadNetworkPolicy(home()),
      reportDenied: hostname => { audited.push(hostname) },
    })
    try {
      await expect(fetch('http://api.deepseek.com/v1')).rejects.toThrow()
      expect(audited).toEqual(['api.deepseek.com'])
      expect(arrivals).toBe(0)
      expect(await (await fetch('http://other-provider.example/v1')).text()).toBe('proxy')
      expect(arrivals).toBe(1)
    } finally {
      await dispose()
      await new Promise<void>((resolve, reject) => proxy.close(err => err ? reject(err) : resolve()))
    }
  })

  it('matches the configured domains rather than hard-coded DeepSeek rules', async () => {
    const audit: string[] = []
    const dispose = await installProxyFromEnvironment(noProxy, () => {}, {
      networkPolicy: { blockedDomains: ['example.org'], auditDenied: true },
      reportDenied: hostname => audit.push(hostname),
    })
    try {
      await expect(fetch('https://foo.example.org/probe')).rejects.toThrow()
      expect(audit).toEqual(['foo.example.org'])
    } finally {
      await dispose()
    }
  })
})
