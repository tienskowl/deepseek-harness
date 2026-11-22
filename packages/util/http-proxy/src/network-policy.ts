/** Local, launch-time policy for outbound HTTP requests issued by the DSH process. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface NetworkPolicy {
  readonly blockedDomains: readonly string[]
  readonly auditDenied: boolean
}

const DEFAULT_BLOCKED = ['deepseek.cn', 'deepseek.com'] as const

/** Accept only DNS suffixes, never a URL, port, wildcard, or empty string. */
export function normalizeBlockedDomains(domains: readonly string[]): string[] {
  const normalized = domains.map(domain => {
    const value = domain.trim().toLowerCase().replace(/\.$/, '')
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
      || !value.includes('.')) throw new Error(`Invalid network-policy blocked domain: ${JSON.stringify(domain)}`)
    return value
  })
  return [...new Set(normalized)]
}

export function isBlockedHostname(hostname: string, domains: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`))
}

/**
 * Loaded once before plugins start. Invalid files fail startup rather than silently allow traffic.
 * If absent, DSH ships with two DeepSeek DNS suffixes blocked.
 */
export function loadNetworkPolicy(home: string): NetworkPolicy {
  let raw: string
  try {
    raw = readFileSync(join(home, 'network-policy.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { blockedDomains: [...DEFAULT_BLOCKED], auditDenied: true }
    }
    throw error
  }
  const value: unknown = JSON.parse(raw)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('network-policy.json must contain an object')
  }
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['blockedDomains', 'auditDenied'].includes(key))) {
    throw new Error('network-policy.json contains unsupported keys')
  }
  if (input.blockedDomains !== undefined
    && (!Array.isArray(input.blockedDomains) || !input.blockedDomains.every(item => typeof item === 'string'))) {
    throw new Error('network-policy.json blockedDomains must be an array of domain strings')
  }
  if (input.auditDenied !== undefined && typeof input.auditDenied !== 'boolean') {
    throw new Error('network-policy.json auditDenied must be a boolean')
  }
  return {
    blockedDomains: normalizeBlockedDomains((input.blockedDomains as string[] | undefined) ?? DEFAULT_BLOCKED),
    auditDenied: input.auditDenied !== false,
  }
}
