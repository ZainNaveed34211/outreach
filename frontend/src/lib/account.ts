const ACCOUNT_API = 'https://account-api.kluzar.com'
const SESSION_BASE = `${ACCOUNT_API}/auth`

export type AccountSession = {
  authenticated: boolean
  csrfToken: string
  user?: Record<string, unknown>
  entitlement?: Record<string, unknown>
}

let assertion: string | null = null
let assertionExpMs = 0

export function clearAssertion(): void {
  assertion = null
  assertionExpMs = 0
}

export async function fetchAccountSession(): Promise<AccountSession> {
  try {
    const res = await fetch(`${SESSION_BASE}/session`, { credentials: 'include' })
    const data = (await res.json().catch(() => null)) as {
      authenticated?: unknown
      csrfToken?: unknown
      user?: Record<string, unknown>
      entitlement?: Record<string, unknown>
    } | null
    if (!res.ok || !data || data.authenticated !== true) return { authenticated: false, csrfToken: '' }
    return {
      authenticated: true,
      csrfToken: typeof data.csrfToken === 'string' ? data.csrfToken : '',
      user: data.user,
      entitlement: data.entitlement,
    }
  } catch {
    return { authenticated: false, csrfToken: '' }
  }
}

export async function getAssertion(csrfToken: string): Promise<string | null> {
  if (assertion && assertionExpMs - Date.now() > 60_000) return assertion
  try {
    const res = await fetch(`${SESSION_BASE}/outreach-assertion`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: '{}',
    })
    const data = (await res.json().catch(() => null)) as {
      ok?: unknown
      assertion?: unknown
      expiresIn?: unknown
    } | null
    if (!res.ok || !data || data.ok !== true || typeof data.assertion !== 'string') {
      clearAssertion()
      return null
    }
    assertion = data.assertion
    const ttl = typeof data.expiresIn === 'number' && data.expiresIn > 0 ? data.expiresIn : 300
    assertionExpMs = Date.now() + ttl * 1000
    return assertion
  } catch {
    clearAssertion()
    return null
  }
}
