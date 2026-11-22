import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
