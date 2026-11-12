const OUTREACH_ORIGIN = 'https://outreach.kluzar.com'
const AUD = 'kluzar-outreach-api'
const KID = 'outreach-assertion-v1'
const KID_V2 = 'outreach-assertion-v2'

const enc = new TextEncoder()
const dec = new TextDecoder()

export function b64urlDecode(value) {
  const normalized = String(value).replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function b64urlEncode(bytes) {
  let value = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    value += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

export function parseAssertion(token) {
  try {
    if (typeof token !== 'string') return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const header = JSON.parse(dec.decode(b64urlDecode(parts[0])))
    const payload = JSON.parse(dec.decode(b64urlDecode(parts[1])))
    if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') return null
    return { header, payload, signature: b64urlDecode(parts[2]), signingInput: `${parts[0]}.${parts[1]}` }
  } catch {
    return null
  }
}

export async function verifyAssertion(token, publicKeysByKid, nowMs = Date.now()) {
  const parsed = parseAssertion(token)
  if (!parsed) return { ok: false, error: 'Malformed assertion.' }
  const { header, payload, signature, signingInput } = parsed
  if (header.alg !== 'EdDSA') return { ok: false, error: 'Unsupported signing algorithm.' }
  if (typeof header.kid !== 'string' || !header.kid) return { ok: false, error: 'Missing key id.' }
  const jwk = publicKeysByKid[header.kid]
  if (!jwk) return { ok: false, error: 'Unknown key id.' }
  if (typeof payload.sub !== 'string' || !payload.sub) return { ok: false, error: 'Missing subject.' }
  if (typeof payload.sid !== 'string' || !payload.sid) return { ok: false, error: 'Missing session id.' }
  if (typeof payload.jti !== 'string' || !payload.jti) return { ok: false, error: 'Missing token id.' }
  if (payload.aud !== AUD) return { ok: false, error: 'Wrong audience.' }
  const nowSec = Math.floor(nowMs / 1000)
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') return { ok: false, error: 'Missing timestamps.' }
  if (payload.iat > nowSec + 30) return { ok: false, error: 'Assertion issued in the future.' }
  if (payload.exp <= nowSec) return { ok: false, error: 'Assertion expired.' }
  if (payload.exp - payload.iat > 600) return { ok: false, error: 'Assertion lifetime too long.' }
  let key
  try {
    key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify'])
  } catch {
    return { ok: false, error: 'Invalid verification key.' }
  }
  let valid = false
  try {
    valid = await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, enc.encode(signingInput))
  } catch {
    valid = false
  }
  if (!valid) return { ok: false, error: 'Bad signature.' }
  return { ok: true, payload }
}

function publicKeysByKid(env) {
  const map = {}
  try {
    if (env.OUTREACH_ASSERTION_PUBLIC_KEY) {
      map[KID] = JSON.parse(env.OUTREACH_ASSERTION_PUBLIC_KEY)
    }
  } catch {
  }
  try {
    if (env.OUTREACH_ASSERTION_PUBLIC_KEY_V2) {
      map[KID_V2] = JSON.parse(env.OUTREACH_ASSERTION_PUBLIC_KEY_V2)
    }
  } catch {
  }
  return map
}

export async function authenticate(request, env) {
  if (request.headers.get('origin') !== OUTREACH_ORIGIN) {
    return { ok: false, status: 403, error: 'Request not allowed.' }
  }
  const header = request.headers.get('authorization') ?? ''
  const match = header.match(/^Bearer\s+(.+)$/)
  if (!match) return { ok: false, status: 401, error: 'Please sign in to continue.' }
  const verified = await verifyAssertion(match[1], publicKeysByKid(env))
  if (!verified.ok) return { ok: false, status: 401, error: 'Please sign in to continue.' }
  const { sub, sid } = verified.payload
  let row
  try {
    row = await env.ACCOUNTS_DB.prepare(
      'SELECT s.*, u.status AS user_status, u.email AS user_email, u.email_verified AS email_verified FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.user_id = ?',
    ).bind(sid, sub).first()
  } catch {
    return { ok: false, status: 401, error: 'Please sign in to continue.' }
  }
  const expiresMs = new Date(row?.expires_at).getTime()
  if (
    !row ||
    row.user_id !== sub ||
    !Number.isFinite(expiresMs) ||
    expiresMs <= Date.now() ||
    row.user_status !== 'active'
  ) return { ok: false, status: 401, error: 'Please sign in to continue.' }
  return {
    ok: true,
    userId: sub,
    email: typeof row.user_email === 'string' ? row.user_email.trim().toLowerCase() : '',
    emailVerified: row.email_verified === 1,
  }
}
