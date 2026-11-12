import assert from 'node:assert/strict'
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import worker, { completeUpload, constantTimeEqual, createR2PresignedPutUrl, isValidEmail, normalizedBrevoEvent, parseCsv, renderTemplate } from './worker.js'
import { authenticate } from './verify.js'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const { privateKey: otherPrivateKey } = generateKeyPairSync('ed25519')
const publicJwk = publicKey.export({ format: 'jwk' })

function b64urlEncodeBuffer(value) {
  return Buffer.from(value).toString('base64url')
}

function assertionClaims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000)
  return { sub: 'user-1', sid: 'session-1', aud: 'kluzar-outreach-api', iat: now, exp: now + 300, jti: 'test-jti-value-0123456789', ...overrides }
}

function makeAssertion(claims, options = {}) {
  const header = { alg: options.alg ?? 'EdDSA', typ: 'JWT', kid: options.kid ?? 'outreach-assertion-v1' }
  const encodedHeader = b64urlEncodeBuffer(JSON.stringify(header))
  const encodedPayload = b64urlEncodeBuffer(JSON.stringify(claims))
  const signature = sign(null, Buffer.from(`${encodedHeader}.${encodedPayload}`), options.signingKey ?? privateKey)
  return `${encodedHeader}.${encodedPayload}.${b64urlEncodeBuffer(signature)}`
}

function accountsRow(overrides = {}) {
  return {
    id: 'session-1',
    user_id: 'user-1',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    user_status: 'active',
    user_email: 'user@example.com',
    email_verified: 1,
    ...overrides,
  }
}

function apiEnv(row) {
  return {
    OUTREACH_ASSERTION_PUBLIC_KEY: JSON.stringify(publicJwk),
    ACCOUNTS_DB: {
      prepare() {
        return {
          bind() {
            return {
              async first() { return row },
            }
          },
        }
      },
    },
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async first() { return { request_count: 1 } },
              async all() { return { results: [] } },
              async run() { return { meta: { changes: 1 } } },
            }
          },
        }
      },
    },
  }
}

function meRequest(authorization, origin = 'https://outreach.kluzar.com') {
  const headers = { Origin: origin }
  if (authorization !== null) headers.Authorization = authorization
  return new Request('https://outreach-api.kluzar.com/v1/me', { headers })
}

test('CSV parser validates headers, deduplicates addresses, and handles quoted cells', async () => {
  const rows = await parseCsv('email,first_name,company\nPerson@example.com,Ada,"Acme, Inc."\nperson@example.com,Other,Other\ninvalid,No,Company\n')
  assert.deepEqual(rows, [{ email: 'person@example.com', firstName: 'Other', company: 'Other' }])
})

test('CSV parser rejects malformed and oversized row sets', async () => {
  await assert.rejects(parseCsv('first_name,company\nAda,Acme'))
  await assert.rejects(parseCsv('email,first_name\n"unfinished,Ada'))
})

test('email validation and template rendering reject/control only expected content', () => {
  assert.equal(isValidEmail('name+tag@example.com'), true)
  assert.equal(isValidEmail('not-an-email'), false)
  assert.equal(renderTemplate('Hello {{first_name}} at {{company}}.', { first_name: 'Ada', company: 'Acme' }), 'Hello Ada at Acme.')
  assert.equal(renderTemplate('Hello {{first_name}}.', { first_name: '', company: '' }), 'Hello .')
})

test('Brevo events are mapped only from recognized event names', () => {
  assert.deepEqual(normalizedBrevoEvent('hardBounce'), { type: 'bounced', apiEvent: 'hardBounce' })
  assert.deepEqual(normalizedBrevoEvent('Unsubscribed'), { type: 'unsubscribed', apiEvent: 'unsubscribed' })
  assert.equal(normalizedBrevoEvent('unknown'), null)
})

test('constant-time token comparison returns true only for exact values', async () => {
  assert.equal(await constantTimeEqual('same-token', 'same-token'), true)
  assert.equal(await constantTimeEqual('same-token', 'same-t0ken'), false)
  assert.equal(await constantTimeEqual('short', 'longer'), false)
})

test('R2 upload URLs are short-lived and SigV4 signatures bind the object and content type', async () => {
  const credentials = {
    R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_ACCESS_KEY_ID: 'test-access',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    R2_BUCKET_NAME: 'kluzar-outreach-files',
  }
  const signedUrl = new URL(await createR2PresignedPutUrl(
    credentials,
    'workspace/uploads/upload-id',
    'text/csv',
  ))
  assert.equal(signedUrl.hostname, `${credentials.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`)
  assert.equal(signedUrl.pathname, '/kluzar-outreach-files/workspace/uploads/upload-id')
  assert.equal(signedUrl.searchParams.get('X-Amz-Expires'), '300')
  assert.equal(signedUrl.searchParams.get('X-Amz-SignedHeaders'), 'content-type;host')

  const query = [...signedUrl.searchParams.entries()]
    .filter(([name]) => name !== 'X-Amz-Signature')
    .map(([name, value]) => [encodeURIComponent(name), encodeURIComponent(value)])
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`)
    .join('&')
  const date = signedUrl.searchParams.get('X-Amz-Date')
  assert.ok(date)
  const dateStamp = date.slice(0, 8)
  const scope = `${dateStamp}/auto/s3/aws4_request`
  const canonicalRequest = [
    'PUT',
    signedUrl.pathname,
    query,
    `content-type:text/csv\nhost:${signedUrl.hostname}\n`,
    'content-type;host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    date,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n')
  const hmac = (key, value) => createHmac('sha256', key).update(value).digest()
  const dateKey = hmac(`AWS4${credentials.R2_SECRET_ACCESS_KEY}`, dateStamp)
  const regionKey = hmac(dateKey, 'auto')
  const serviceKey = hmac(regionKey, 's3')
  const signingKey = hmac(serviceKey, 'aws4_request')
  assert.equal(signedUrl.searchParams.get('X-Amz-Signature'), hmac(signingKey, stringToSign).toString('hex'))
})

test('attachment completion validates staging bytes and promotes them to a separate final key', async () => {
  const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d])
  const intent = {
    id: 'upload-id',
    workspace_id: 'workspace-id',
    list_id: null,
    kind: 'attachment',
    r2_key: 'uploads/upload-id',
    filename: 'report.pdf',
    size_bytes: bytes.byteLength,
    content_type: 'application/pdf',
    expires_at: Date.now() + 60000,
    completed_at: null,
    result_json: null,
  }
  const batchStatements = []
  const storedObjects = []
  const deletedObjects = []
  const env = {
    DB: {
      async batch(statements) {
        batchStatements.push(...statements)
      },
    },
    FILES: {
      async get(key) {
        assert.equal(key, intent.r2_key)
        return {
          size: bytes.byteLength,
          httpMetadata: { contentType: intent.content_type },
          async arrayBuffer() {
            return bytes.buffer
          },
        }
      },
      async put(key, value, options) {
        storedObjects.push({ key, bytes: [...value], options })
      },
      async delete(key) {
        deletedObjects.push(key)
      },
    },
  }
  env.DB.prepare = (sql) => ({
    bind(...values) {
      return {
        sql,
        values,
        async first() {
          return sql.includes('FROM upload_intents') ? intent : null
        },
      }
    },
  })

  const response = await completeUpload(env, intent.id, { userId: 'owner-id' }, 'https://outreach.kluzar.com', 'attachment')
  assert.equal(response.status, 201)
  assert.deepEqual((await response.json()).data, {
    id: intent.id,
    filename: 'report.pdf',
    sizeBytes: bytes.byteLength,
  })
  assert.equal(storedObjects[0].key, 'workspace-id/attachments/upload-id.pdf')
  assert.deepEqual(storedObjects[0].bytes, [...bytes])
  assert.equal(batchStatements[0].values[3], storedObjects[0].key)
  assert.deepEqual(deletedObjects, [intent.r2_key])
})

test('API rejects an untrusted browser origin before session verification', async () => {
  const result = await worker.fetch(new Request('https://outreach-api.kluzar.com/v1/me', {
    headers: { Origin: 'https://attacker.example' },
  }), {}, { waitUntil() {} })
  assert.equal(result.status, 403)
  assert.deepEqual(await result.json(), { ok: false, error: 'Request could not be verified.' })
})

test('API fails closed when the assertion is absent', async () => {
  const result = await worker.fetch(new Request('https://outreach-api.kluzar.com/v1/me', {
    headers: { Origin: 'https://outreach.kluzar.com' },
  }), {}, { waitUntil() {} })
  assert.equal(result.status, 401)
  assert.equal((await result.json()).ok, false)
})

test('preflight accepts only the configured origin and headers', async () => {
  const allowed = await worker.fetch(new Request('https://outreach-api.kluzar.com/v1/me', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://outreach.kluzar.com',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'content-type,authorization',
    },
  }), {}, { waitUntil() {} })
  assert.equal(allowed.status, 204)
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://outreach.kluzar.com')
  assert.equal(allowed.headers.get('Access-Control-Allow-Headers'), 'Content-Type, Authorization')
  const csrfDenied = await worker.fetch(new Request('https://outreach-api.kluzar.com/v1/me', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://outreach.kluzar.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-csrf-token',
    },
  }), {}, { waitUntil() {} })
  assert.equal(csrfDenied.status, 403)
  const denied = await worker.fetch(new Request('https://outreach-api.kluzar.com/v1/me', {
    method: 'OPTIONS',
    headers: { Origin: 'https://attacker.example' },
  }), {}, { waitUntil() {} })
  assert.equal(denied.status, 403)
})

test('valid assertion passes with a matching active session row', async () => {
  const token = makeAssertion(assertionClaims())
  const result = await worker.fetch(meRequest(`Bearer ${token}`), apiEnv(accountsRow()), { waitUntil() {} })
  assert.equal(result.status, 200)
  const body = await result.json()
  assert.deepEqual(body.data.user, { id: 'user-1', email: 'user@example.com' })
  assert.deepEqual(body.data.workspaces, [])
  assert.equal(body.csrfToken, undefined)
})

test('assertion with the wrong audience fails with a generic 401', async () => {
  const token = makeAssertion(assertionClaims({ aud: 'kluzar-manage-api' }))
  const result = await worker.fetch(meRequest(`Bearer ${token}`), apiEnv(accountsRow()), { waitUntil() {} })
  assert.equal(result.status, 401)
  assert.deepEqual(await result.json(), { ok: false, error: 'Please sign in to continue.' })
})

test('assertion with an unknown kid fails', async () => {
  const token = makeAssertion(assertionClaims(), { kid: 'unknown-kid' })
  const result = await worker.fetch(meRequest(`Bearer ${token}`), apiEnv(accountsRow()), { waitUntil() {} })
  assert.equal(result.status, 401)
  assert.equal((await result.json()).ok, false)
})

test('assertion with a non-EdDSA algorithm fails before verification', async () => {
  const token = makeAssertion(assertionClaims(), { alg: 'HS256' })
  const result = await worker.fetch(meRequest(`Bearer ${token}`), apiEnv(accountsRow()), { waitUntil() {} })
  assert.equal(result.status, 401)
  assert.equal((await result.json()).ok, false)
})

test('expired assertion fails', async () => {
  const now = Math.floor(Date.now() / 1000)
  const token = makeAssertion(assertionClaims({ iat: now - 400, exp: now - 100 }))
  const result = await worker.fetch(meRequest(`Bearer ${token}`), apiEnv(accountsRow()), { waitUntil() {} })
  assert.equal(result.status, 401)
  assert.equal((await result.json()).ok, false)
})

test('assertion issued too far in the future fails', async () => {
  const now = Math.floor(Date.now() / 1000)
  const token = makeAssertion(assertionClaims({ iat: now + 120, exp: now + 420 }))
  const result = await worker.fetch(meRequest(`Bearer ${token}`), apiEnv(accountsRow()), { waitUntil() {} })
  assert.equal(result.status, 401)
  assert.equal((await result.json()).ok, false)
})

test('assertion with a lifetime over 600 seconds fails', async () => {
  const now = Math.floor(Date.now() / 1000)
  const token = makeAssertion(assertionClaims({ iat: now, exp: now + 601 }))
  const result = await worker.fetch(meRequest(`Bearer ${token}`), apiEnv(accountsRow()), { waitUntil() {} })
  assert.equal(result.status, 401)
  assert.equal((await result.json()).ok, false)
})

test('assertion without a jti fails', async () => {
  const token = makeAssertion(assertionClaims({ jti: undefined }))
  const result = await worker.fetch(meRequest(`Bearer ${token}`), apiEnv(accountsRow()), { waitUntil() {} })
  assert.equal(result.status, 401)
  assert.equal((await result.json()).ok, false)
})

test('assertion with a bad signature fails', async () => {
  const token = makeAssertion(assertionClaims(), { signingKey: otherPrivateKey })
  const result = await worker.fetch(meRequest(`Bearer ${token}`), apiEnv(accountsRow()), { waitUntil() {} })
  assert.equal(result.status, 401)
  assert.equal((await result.json()).ok, false)
})

test('valid assertion fails when the session row is unknown', async () => {
  const token = makeAssertion(assertionClaims())
  const result = await worker.fetch(meRequest(`Bearer ${token}`), apiEnv(null), { waitUntil() {} })
  assert.equal(result.status, 401)
  assert.equal((await result.json()).ok, false)
})

test('valid assertion fails when the session belongs to another user', async () => {
  const token = makeAssertion(assertionClaims())
  const result = await worker.fetch(meRequest(`Bearer ${token}`), apiEnv(accountsRow({ user_id: 'user-2' })), { waitUntil() {} })
  assert.equal(result.status, 401)
  assert.equal((await result.json()).ok, false)
})

test('valid assertion fails when the session row is expired', async () => {
  const token = makeAssertion(assertionClaims())
  const result = await worker.fetch(meRequest(`Bearer ${token}`), apiEnv(accountsRow({ expires_at: new Date(Date.now() - 1000).toISOString() })), { waitUntil() {} })
  assert.equal(result.status, 401)
  assert.equal((await result.json()).ok, false)
})

test('valid assertion fails when the user is not active', async () => {
  const token = makeAssertion(assertionClaims())
  const result = await worker.fetch(meRequest(`Bearer ${token}`), apiEnv(accountsRow({ user_status: 'suspended' })), { waitUntil() {} })
  assert.equal(result.status, 401)
  assert.equal((await result.json()).ok, false)
})

test('missing or malformed Authorization fails', async () => {
  const token = makeAssertion(assertionClaims())
  const variants = [null, 'Bearer', 'Token abc.def.ghi', 'Bearer aaa.bbb', `Bearer ${token}extra`]
  for (const authorization of variants) {
    const result = await worker.fetch(meRequest(authorization), apiEnv(accountsRow()), { waitUntil() {} })
    assert.equal(result.status, 401, `expected 401 for ${authorization}`)
    assert.equal((await result.json()).ok, false)
  }
})

test('valid assertion fails closed when the public key is not configured', async () => {
  const token = makeAssertion(assertionClaims())
  const env = apiEnv(accountsRow())
  delete env.OUTREACH_ASSERTION_PUBLIC_KEY
  const result = await worker.fetch(meRequest(`Bearer ${token}`), env, { waitUntil() {} })
  assert.equal(result.status, 401)
  assert.equal((await result.json()).ok, false)
})

test('authenticate rejects a wrong Origin with 403 before reading the token', async () => {
  const request = new Request('https://outreach-api.kluzar.com/v1/me', {
    headers: { Origin: 'https://attacker.example' },
  })
  const result = await authenticate(request, apiEnv(accountsRow()))
  assert.deepEqual(result, { ok: false, status: 403, error: 'Request not allowed.' })
})

const BREVO_PATH_TOKEN = 'b'.repeat(32)
const BREVO_TOKEN = 'brevo-webhook-token-value'

function brevoEnv() {
  return {
    BREVO_WEBHOOK_PATH_TOKEN: BREVO_PATH_TOKEN,
    BREVO_WEBHOOK_TOKEN: BREVO_TOKEN,
    BREVO_API_KEY: 'brevo-api-key',
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('FROM sends s JOIN leads')) {
                  return { id: 'send-1', lead_id: 'lead-1', status: 'sent', workspace_id: 'ws-1', email: 'lead@example.com' }
                }
                return null
              },
              async run() { return { meta: { changes: 1 } } },
              async all() { return { results: [] } },
            }
          },
        }
      },
    },
  }
}

function brevoRequest(authorization) {
  return new Request(`https://outreach-api.kluzar.com/v1/webhooks/brevo/${BREVO_PATH_TOKEN}`, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify([{
      event: 'delivered',
      email: 'lead@example.com',
      messageId: 'msg-123',
      ts_event: Math.floor(Date.now() / 1000),
    }]),
  })
}

async function withBrevoReport(run) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { events: [{ email: 'lead@example.com', messageId: 'msg-123', event: 'delivered' }] }
    },
  })
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('Brevo webhook accepts a Bearer token', async () => {
  await withBrevoReport(async () => {
    const result = await worker.fetch(brevoRequest(`Bearer ${BREVO_TOKEN}`), brevoEnv(), { waitUntil() {} })
    assert.equal(result.status, 204)
  })
})

test('Brevo webhook accepts a bare token', async () => {
  await withBrevoReport(async () => {
    const result = await worker.fetch(brevoRequest(BREVO_TOKEN), brevoEnv(), { waitUntil() {} })
    assert.equal(result.status, 204)
  })
})

test('Brevo webhook rejects a wrong token', async () => {
  const result = await worker.fetch(brevoRequest('Bearer wrong-token'), brevoEnv(), { waitUntil() {} })
  assert.equal(result.status, 401)
  assert.equal((await result.json()).ok, false)
})

import { countImportOverlap, decryptToken, encryptToken } from './worker.js'

function makeDb(seed = {}) {
  const tables = {
    workspaces: seed.workspaces ?? [{ id: 'ws-1', owner_user_id: 'user-1', owner_email: 'user@example.com', name: 'Main', notify_reply_email: 1, created_at: 1 }],
    campaigns: seed.campaigns ?? [],
    sequences: seed.sequences ?? [],
    branches: seed.branches ?? [],
    leads: seed.leads ?? [],
    lead_lists: seed.lead_lists ?? [{ id: 'list-1', workspace_id: 'ws-1', name: 'Main list', created_at: 1 }],
    lead_list_members: seed.lead_list_members ?? [],
    senders: seed.senders ?? [],
    sends: seed.sends ?? [],
    replies: seed.replies ?? [],
    suppressions: seed.suppressions ?? [],
    snippets: seed.snippets ?? [],
    activity_log: seed.activity_log ?? [],
    notifications: seed.notifications ?? [],
    brevo_ignored_messages: seed.brevo_ignored_messages ?? [],
    events: seed.events ?? [],
    inbox_replies: seed.inbox_replies ?? [],
    unsubscribe_tokens: seed.unsubscribe_tokens ?? [],
  }
  const statements = []
  const findWorkspace = (id, userId) => tables.workspaces.find((row) => row.id === id && row.owner_user_id === userId)
  const findCampaign = (id, userId, workspaceId) => {
    const campaign = tables.campaigns.find((row) => row.id === id)
    if (!campaign) return null
    const workspace = tables.workspaces.find((row) => row.id === campaign.workspace_id && row.owner_user_id === userId)
    if (!workspace) return null
    if (workspaceId !== null && workspaceId !== undefined && campaign.workspace_id !== workspaceId) return null
    const sender = tables.senders.find((row) => row.id === campaign.sender_id)
    return { ...campaign, sender_type: sender?.type ?? null }
  }
  const eligibleLeads = (campaign) => tables.leads.filter((lead) =>
    lead.workspace_id === campaign.workspace_id &&
    ['new', 'contacted'].includes(lead.status) &&
    tables.lead_list_members.some((member) => member.list_id === campaign.lead_list_id && member.lead_id === lead.id) &&
    !tables.suppressions.some((row) => row.workspace_id === lead.workspace_id && row.email === lead.email) &&
    !tables.sends.some((send) =>
      send.lead_id === lead.id && ['queued', 'sending'].includes(send.status) &&
      tables.campaigns.some((row) => row.id === send.campaign_id && row.workspace_id === lead.workspace_id && row.status === 'active'),
    ),
  )
  const like = (value, pattern) => {
    const needle = String(pattern).replaceAll('%', '').toLowerCase()
    return String(value ?? '').toLowerCase().includes(needle)
  }
  function execute(sql, values, mode) {
    if (sql.includes('INSERT INTO rate_limits')) return { request_count: 1 }
    if (sql.includes('FROM workspaces WHERE id = ? AND owner_user_id = ?')) {
      return findWorkspace(values[0], values[1]) ?? null
    }
    if (sql.includes('SELECT w.id, w.owner_email, w.notify_reply_email, c.name FROM campaigns c JOIN workspaces w')) {
      const campaign = tables.campaigns.find((row) => row.id === values[0])
      if (!campaign) return null
      const workspace = tables.workspaces.find((row) => row.id === campaign.workspace_id)
      return workspace ? { id: workspace.id, owner_email: workspace.owner_email, notify_reply_email: workspace.notify_reply_email, name: campaign.name } : null
    }
    if (sql.includes('FROM campaigns c JOIN workspaces w')) {
      return findCampaign(values[0], values[1], values[2]) ?? null
    }
    if (sql.includes('SELECT id, type, address FROM senders WHERE id = ? AND workspace_id = ?')) {
      return tables.senders.find((row) => row.id === values[0] && row.workspace_id === values[1]) ?? null
    }
    if (sql.includes('SELECT id FROM senders WHERE workspace_id = ? AND type IN')) {
      return tables.senders.find((row) => row.workspace_id === values[0] && ['gmail_oauth', 'outlook_oauth'].includes(row.type)) ?? null
    }
    if (sql.includes('SELECT provider_message_id FROM brevo_ignored_messages')) {
      return tables.brevo_ignored_messages.find((row) => row.workspace_id === values[0] && row.kind === 'test') ?? null
    }
    if (sql.includes("FROM campaigns WHERE workspace_id = ? AND status <> 'draft'")) {
      return tables.campaigns.find((row) => row.workspace_id === values[0] && row.status !== 'draft') ?? null
    }
    if (sql.includes('SELECT id FROM campaigns WHERE workspace_id = ? LIMIT 1')) {
      return tables.campaigns.find((row) => row.workspace_id === values[0]) ?? null
    }
    if (sql.includes('SELECT id FROM leads WHERE workspace_id = ? LIMIT 1')) {
      return tables.leads.find((row) => row.workspace_id === values[0]) ?? null
    }
    if (sql.includes('SELECT MAX(step_no) AS max_step')) {
      const steps = tables.sequences.filter((row) => row.campaign_id === values[0])
      return { max_step: steps.length ? Math.max(...steps.map((row) => row.step_no)) : 0 }
    }
    if (sql.includes('SELECT id FROM sends WHERE campaign_id = ? LIMIT 1')) {
      return tables.sends.find((row) => row.campaign_id === values[0]) ?? null
    }
    if (sql.includes('SELECT id, name FROM lead_lists WHERE id = ? AND workspace_id = ?')) {
      return tables.lead_lists.find((row) => row.id === values[0] && row.workspace_id === values[1]) ?? null
    }
    if (sql.includes('SELECT id FROM lead_lists WHERE id = ? AND workspace_id = ?')) {
      return tables.lead_lists.find((row) => row.id === values[0] && row.workspace_id === values[1]) ?? null
    }
    if (sql.includes('SELECT id, email, first_name, company FROM leads WHERE id = ? AND workspace_id = ?')) {
      return tables.leads.find((row) => row.id === values[0] && row.workspace_id === values[1]) ?? null
    }
    if (sql.includes('SELECT id, status FROM leads WHERE workspace_id = ? AND email = ?')) {
      return tables.leads.find((row) => row.workspace_id === values[0] && row.email === values[1]) ?? null
    }
    if (sql.includes('SELECT id FROM suppressions WHERE workspace_id = ? AND email = ?')) {
      return tables.suppressions.find((row) => row.workspace_id === values[0] && row.email === values[1]) ?? null
    }
    if (sql.includes('FROM suppressions s') && sql.includes('JOIN workspaces w')) {
      const row = tables.suppressions.find((item) => item.id === values[0])
      if (!row) return null
      const workspace = tables.workspaces.find((item) => item.id === row.workspace_id && item.owner_user_id === values[1])
      return workspace ? row : null
    }
    if (sql.includes('FROM leads l JOIN workspaces w ON w.id = l.workspace_id')) {
      const lead = tables.leads.find((row) => row.id === values[0])
      if (!lead) return null
      const workspace = tables.workspaces.find((row) => row.id === lead.workspace_id && row.owner_user_id === values[1])
      if (!workspace) return null
      if (values[2] !== null && values[2] !== undefined && lead.workspace_id !== values[2]) return null
      return lead
    }
    if (sql.includes('FROM replies r JOIN sends s ON s.id = r.send_id JOIN leads l ON l.id = s.lead_id')) {
      const reply = tables.replies.find((row) => row.id === values[0])
      if (!reply) return null
      const send = tables.sends.find((row) => row.id === reply.send_id)
      const lead = tables.leads.find((row) => row.id === send?.lead_id)
      const campaign = tables.campaigns.find((row) => row.id === send?.campaign_id)
      const sender = tables.senders.find((row) => row.id === campaign?.sender_id)
      if (!send || !lead || !campaign || !sender || campaign.workspace_id !== values[1]) return null
      return {
        id: reply.id, subject: reply.subject, campaign_id: send.campaign_id, lead_id: send.lead_id,
        provider_message_id: send.provider_message_id, provider_thread_id: send.provider_thread_id,
        lead_email: lead.email, lead_status: lead.status, workspace_id: campaign.workspace_id,
        sender_id: sender.id, sender_type: sender.type, sender_address: sender.address,
        sender_name: sender.display_name, credentials_ref: sender.credentials_ref,
        credentials_expires_at: sender.credentials_expires_at,
      }
    }
    if (sql.includes('SELECT COUNT(*) AS count FROM sends s JOIN campaigns c')) {
      const dayStart = values[1]
      const count = tables.sends.filter((send) =>
        send.sent_at >= dayStart && ['sent', 'delivered', 'opened', 'clicked', 'replied', 'bounced'].includes(send.status) &&
        tables.campaigns.some((row) => row.id === send.campaign_id && row.workspace_id === values[0]),
      ).length
      return { count }
    }
    if (sql.includes('SELECT COUNT(*) AS count FROM inbox_replies')) {
      return { count: tables.inbox_replies.filter((row) => row.workspace_id === values[0] && row.sent_at >= values[1]).length }
    }
    if (sql.includes('SELECT MAX(s.sent_at)')) {
      const times = tables.sends.filter((send) =>
        send.sent_at !== null && send.sent_at !== undefined &&
        tables.campaigns.some((row) => row.id === send.campaign_id && row.workspace_id === values[0]),
      ).map((send) => send.sent_at)
      return { sent_at: times.length ? Math.max(...times) : null }
    }
    if (sql.includes('SELECT MAX(sent_at) AS sent_at FROM inbox_replies')) {
      const times = tables.inbox_replies.filter((row) => row.workspace_id === values[0]).map((row) => row.sent_at)
      return { sent_at: times.length ? Math.max(...times) : null }
    }
    if (sql.includes('(SELECT COUNT(*) FROM lead_list_members WHERE list_id = ?)')) {
      const listId = values[0]
      const workspaceId = values[2]
      const members = tables.lead_list_members.filter((row) => row.list_id === listId)
      const inList = members.map((row) => tables.leads.find((lead) => lead.id === row.lead_id)).filter(Boolean)
      return {
        total_in_list: members.length,
        suppressed_in_list: inList.filter((lead) => tables.suppressions.some((row) => row.workspace_id === workspaceId && row.email === lead.email)).length,
        excluded_in_list: inList.filter((lead) => ['bounced', 'unsubscribed'].includes(lead.status)).length,
        with_first_name: inList.filter((lead) => lead.first_name && lead.first_name.trim() !== '').length,
        with_company: inList.filter((lead) => lead.company && lead.company.trim() !== '').length,
      }
    }
    if (sql.includes('SELECT email FROM leads WHERE workspace_id = ? AND email IN')) {
      return { results: tables.leads.filter((row) => row.workspace_id === values[0] && values.slice(1).includes(row.email)).map((row) => ({ email: row.email })) }
    }
    if (sql.includes('SELECT email FROM suppressions WHERE workspace_id = ? AND email IN')) {
      return { results: tables.suppressions.filter((row) => row.workspace_id === values[0] && values.slice(1).includes(row.email)).map((row) => ({ email: row.email })) }
    }
    if (sql.includes('SELECT id, email FROM leads WHERE workspace_id = ? AND id IN')) {
      return { results: tables.leads.filter((row) => row.workspace_id === values[0] && values.slice(1).includes(row.id)).map((row) => ({ id: row.id, email: row.email })) }
    }
    if (sql.includes('SELECT l.id FROM leads l JOIN lead_list_members m')) {
      const campaign = { workspace_id: values[0], lead_list_id: values[1] }
      return { results: eligibleLeads(campaign).map((row) => ({ id: row.id })) }
    }
    if (sql.includes('INSERT OR IGNORE INTO sends')) {
      const campaign = tables.campaigns.find((row) => row.id === values[0])
      const now = values[1]
      for (const lead of eligibleLeads(campaign)) {
        if (!tables.sends.some((row) => row.campaign_id === campaign.id && row.lead_id === lead.id && row.sequence_step === 1)) {
          tables.sends.push({ id: `send-${tables.sends.length + 1}`, campaign_id: campaign.id, lead_id: lead.id, sequence_step: 1, status: 'queued', scheduled_at: now, created_at: now, sent_at: null })
        }
      }
      return { meta: { changes: 1 } }
    }
    if (sql.includes('INSERT INTO campaigns')) {
      tables.campaigns.push({ id: values[0], workspace_id: values[1], name: values[2], sender_id: values[3], lead_list_id: values[4], status: values[5], scheduled_at: null, created_at: values[6] })
      return { meta: { changes: 1 } }
    }
    if (sql.includes('INSERT INTO sequences')) {
      tables.sequences.push({ id: values[0], campaign_id: values[1], step_no: values[2], delay_days: values[3], subject: values[4], body_template: values[5], created_at: values[6] })
      return { meta: { changes: 1 } }
    }
    if (sql.includes('INSERT INTO branches')) {
      tables.branches.push({ id: values[0], sequence_id: values[1], condition: values[2], condition_value: values[3], action: values[4], action_value: values[5], created_at: values[6] })
      return { meta: { changes: 1 } }
    }
    if (sql.includes('INSERT INTO activity_log')) {
      tables.activity_log.push({ id: values[0], workspace_id: values[1], type: values[2], message: values[3], created_at: values[4] })
      return { meta: { changes: 1 } }
    }
    if (sql.includes('INSERT INTO notifications')) {
      tables.notifications.push({ id: values[0], workspace_id: values[1], message: values[2], created_at: values[3], read_at: null })
      return { meta: { changes: 1 } }
    }
    if (sql.includes('INSERT INTO inbox_replies')) {
      tables.inbox_replies.push({ id: values[0], reply_id: values[1], workspace_id: values[2], sender_id: values[3], subject: values[4], body_text: values[5], provider_message_id: values[6], sent_at: values[7], created_at: values[8] })
      return { meta: { changes: 1 } }
    }
    if (sql.includes('INSERT INTO snippets')) {
      if (tables.snippets.some((row) => row.workspace_id === values[1] && row.title === values[2])) throw new Error('duplicate snippet')
      tables.snippets.push({ id: values[0], workspace_id: values[1], title: values[2], body: values[3], created_at: values[4] })
      return { meta: { changes: 1 } }
    }
    if (sql.includes('INSERT INTO suppressions')) {
      const existing = tables.suppressions.find((row) => row.workspace_id === values[1] && row.email === values[2])
      if (existing) existing.reason = values[3]
      else tables.suppressions.push({ id: values[0], workspace_id: values[1], email: values[2], reason: values[3], created_at: values[4] })
      return { meta: { changes: 1 } }
    }
    if (sql.includes("UPDATE campaigns SET status = 'scheduled'")) {
      const campaign = tables.campaigns.find((row) => row.id === values[1])
      if (campaign) { campaign.status = 'scheduled'; campaign.scheduled_at = values[0] }
      return { meta: { changes: campaign ? 1 : 0 } }
    }
    if (sql.includes("UPDATE campaigns SET status = 'active', scheduled_at = NULL")) {
      const campaign = tables.campaigns.find((row) => row.id === values[0])
      if (campaign) { campaign.status = 'active'; campaign.scheduled_at = null }
      return { meta: { changes: campaign ? 1 : 0 } }
    }
    if (sql.includes("UPDATE campaigns SET status = 'paused', scheduled_at = NULL")) {
      const campaign = tables.campaigns.find((row) => row.id === values[0])
      if (campaign) { campaign.status = 'paused'; campaign.scheduled_at = null }
      return { meta: { changes: campaign ? 1 : 0 } }
    }
    if (sql.includes("UPDATE campaigns SET status = 'archived'")) {
      const campaign = tables.campaigns.find((row) => row.id === values[0])
      if (campaign) campaign.status = 'archived'
      return { meta: { changes: campaign ? 1 : 0 } }
    }
    if (sql.includes('UPDATE campaigns SET name = ?')) {
      const campaign = tables.campaigns.find((row) => row.id === values[3])
      if (!campaign) return null
      campaign.name = values[0]
      campaign.status = values[1]
      if (values[2] === 'draft') campaign.scheduled_at = null
      return { id: campaign.id, name: campaign.name, sender_id: campaign.sender_id, status: campaign.status, created_at: campaign.created_at }
    }
    if (sql.includes('UPDATE campaigns SET status = ? WHERE id = ? AND status = ?')) {
      const campaign = tables.campaigns.find((row) => row.id === values[1] && row.status === values[2])
      if (campaign) campaign.status = values[0]
      return { meta: { changes: campaign ? 1 : 0 } }
    }
    if (sql.includes('UPDATE campaigns SET status = ? WHERE id = ?')) {
      const campaign = tables.campaigns.find((row) => row.id === values[1])
      if (campaign) campaign.status = values[0]
      return { meta: { changes: campaign ? 1 : 0 } }
    }
    if (sql.includes('UPDATE workspaces SET notify_reply_email')) {
      const workspace = tables.workspaces.find((row) => row.id === values[1] && row.owner_user_id === values[2])
      if (!workspace) return null
      workspace.notify_reply_email = values[0]
      return { id: workspace.id, notify_reply_email: workspace.notify_reply_email }
    }
    if (sql.includes('UPDATE replies SET read_at = ?') && sql.includes('RETURNING id, read_at')) {
      const reply = tables.replies.find((row) => row.id === values[1])
      if (!reply) return null
      const send = tables.sends.find((row) => row.id === reply.send_id)
      const campaign = tables.campaigns.find((row) => row.id === send?.campaign_id)
      const workspace = tables.workspaces.find((row) => row.id === campaign?.workspace_id && row.owner_user_id === values[2])
      if (!workspace) return null
      reply.read_at = values[0]
      return { id: reply.id, read_at: reply.read_at }
    }
    if (sql.includes('UPDATE replies SET read_at = ? WHERE id = ?')) {
      const reply = tables.replies.find((row) => row.id === values[1])
      if (reply) reply.read_at = values[0]
      return { meta: { changes: reply ? 1 : 0 } }
    }
    if (sql.includes('UPDATE snippets SET title = ?, body = ?')) {
      const snippet = tables.snippets.find((row) => row.id === values[2] && tables.workspaces.some((ws) => ws.id === row.workspace_id && ws.owner_user_id === values[3]))
      if (!snippet) return null
      snippet.title = values[0]
      snippet.body = values[1]
      return snippet
    }
    if (sql.includes('DELETE FROM snippets WHERE id = ?')) {
      const index = tables.snippets.findIndex((row) => row.id === values[0] && tables.workspaces.some((ws) => ws.id === row.workspace_id && ws.owner_user_id === values[1]))
      if (index < 0) return null
      tables.snippets.splice(index, 1)
      return { id: values[0] }
    }
    if (sql.includes('DELETE FROM suppressions WHERE id = ?')) {
      const index = tables.suppressions.findIndex((row) => row.id === values[0])
      if (index >= 0) tables.suppressions.splice(index, 1)
      return { meta: { changes: 1 } }
    }
    if (sql.includes("UPDATE leads SET status = 'new' WHERE workspace_id = ? AND email = ?")) {
      const lead = tables.leads.find((row) => row.workspace_id === values[0] && row.email === values[1] && ['unsubscribed', 'bounced'].includes(row.status))
      if (lead) lead.status = 'new'
      return { meta: { changes: lead ? 1 : 0 } }
    }
    if (sql.includes('UPDATE leads SET status = ? WHERE id = ?')) {
      const lead = tables.leads.find((row) => row.id === values[1])
      if (lead) lead.status = values[0]
      return { meta: { changes: lead ? 1 : 0 } }
    }
    if (sql.includes('UPDATE leads SET status = ? WHERE workspace_id = ? AND id IN')) {
      const ids = values.slice(2)
      let changes = 0
      for (const lead of tables.leads) {
        if (lead.workspace_id === values[1] && ids.includes(lead.id)) { lead.status = values[0]; changes += 1 }
      }
      return { meta: { changes } }
    }
    if (sql.includes("UPDATE sends SET status = 'stopped' WHERE lead_id = ?")) {
      for (const send of tables.sends) {
        if (send.lead_id === values[0] && send.status === 'queued') send.status = 'stopped'
      }
      return { meta: { changes: 1 } }
    }
    if (sql.includes('SELECT id, name, sender_id, lead_list_id, status, scheduled_at, created_at FROM campaigns c')) {
      const query = String(values[1] ?? '')
      const status = String(values[3] ?? '')
      return {
        results: tables.campaigns.filter((row) =>
          row.workspace_id === values[0] &&
          (query === '' || row.name.toLowerCase().includes(query.toLowerCase())) &&
          (status === '' || row.status === status),
        ),
      }
    }
    if (sql.includes('FROM lead_lists l LEFT JOIN lead_list_members')) {
      const query = String(values[1] ?? '')
      return {
        results: tables.lead_lists.filter((row) =>
          row.workspace_id === values[0] && (query === '' || row.name.toLowerCase().includes(query.toLowerCase())),
        ).map((row) => ({ ...row, lead_count: tables.lead_list_members.filter((member) => member.list_id === row.id).length })),
      }
    }
    if (sql.includes('SELECT l.id, l.email, l.first_name, l.company, l.status, l.created_at')) {
      const listId = values[1]
      const status = String(values[3] ?? '')
      const query = String(values[5] ?? '')
      const pattern = String(values[6] ?? '').replaceAll('%', '').toLowerCase()
      return {
        results: tables.leads.filter((row) =>
          row.workspace_id === values[0] &&
          (listId === null || listId === undefined || tables.lead_list_members.some((member) => member.lead_id === row.id && member.list_id === listId)) &&
          (status === '' || row.status === status) &&
          (query === '' || like(row.email, pattern) || like(row.first_name, pattern) || like(row.company, pattern)),
        ),
      }
    }
    if (sql.includes('SELECT l.email, l.first_name, l.company, l.status, l.created_at')) {
      return {
        results: tables.leads.filter((row) =>
          tables.lead_list_members.some((member) => member.list_id === values[0] && member.lead_id === row.id) && row.workspace_id === values[1],
        ),
      }
    }
    if (sql.includes('FROM sends s JOIN leads l ON l.id = s.lead_id')) {
      return {
        results: tables.sends.filter((row) => row.campaign_id === values[0]).map((send) => {
          const lead = tables.leads.find((row) => row.id === send.lead_id) ?? {}
          return { email: lead.email, first_name: lead.first_name, company: lead.company, lead_status: lead.status, sequence_step: send.sequence_step, send_status: send.status, sent_at: send.sent_at ?? null, opened_at: send.opened_at ?? null, clicked_at: send.clicked_at ?? null, replied_at: send.replied_at ?? null }
        }),
      }
    }
    if (sql.includes('SELECT step_no, delay_days, subject, body_template FROM sequences WHERE campaign_id = ?')) {
      return { results: tables.sequences.filter((row) => row.campaign_id === values[0]).sort((a, b) => a.step_no - b.step_no) }
    }
    if (sql.includes('SELECT id, step_no, delay_days, subject, body_template FROM sequences WHERE campaign_id = ?')) {
      return { results: tables.sequences.filter((row) => row.campaign_id === values[0]).sort((a, b) => a.step_no - b.step_no) }
    }
    if (sql.includes('SELECT step_no FROM sequences WHERE campaign_id = ?')) {
      return { results: tables.sequences.filter((row) => row.campaign_id === values[0]).map((row) => ({ step_no: row.step_no })) }
    }
    if (sql.includes('FROM branches b JOIN sequences s ON s.id = b.sequence_id WHERE s.campaign_id = ?')) {
      const stepIds = tables.sequences.filter((row) => row.campaign_id === values[0]).map((row) => row.id)
      return { results: tables.branches.filter((row) => stepIds.includes(row.sequence_id)) }
    }
    if (sql.includes('FROM sequences s JOIN campaigns c ON c.id = s.campaign_id')) {
      const step = tables.sequences.find((row) => row.id === values[0])
      if (!step) return null
      const campaign = tables.campaigns.find((row) => row.id === step.campaign_id)
      const workspace = tables.workspaces.find((row) => row.id === campaign?.workspace_id && row.owner_user_id === values[1])
      if (!campaign || !workspace || campaign.status !== 'draft') return null
      return { ...step, workspace_id: campaign.workspace_id, status: campaign.status, campaign_name: campaign.name }
    }
    if (sql.includes('SELECT condition, condition_value, action, action_value FROM branches WHERE sequence_id = ?')) {
      return { results: tables.branches.filter((row) => row.sequence_id === values[0]) }
    }
    if (sql.includes('FROM replies r JOIN sends s ON s.id = r.send_id JOIN leads l ON l.id = s.lead_id')) {
      const campaignId = values[1]
      const read = String(values[3] ?? '')
      return {
        results: tables.replies.filter((reply) => {
          const send = tables.sends.find((row) => row.id === reply.send_id)
          const campaign = tables.campaigns.find((row) => row.id === send?.campaign_id)
          if (!campaign || campaign.workspace_id !== values[0]) return false
          if (campaignId !== null && campaignId !== undefined && send.campaign_id !== campaignId) return false
          if (read === 'read' && !reply.read_at) return false
          if (read === 'unread' && reply.read_at) return false
          return true
        }).map((reply) => {
          const send = tables.sends.find((row) => row.id === reply.send_id)
          const lead = tables.leads.find((row) => row.id === send?.lead_id) ?? {}
          return { ...reply, campaign_id: send?.campaign_id, lead_id: send?.lead_id, lead_email: lead.email, first_name: lead.first_name }
        }),
      }
    }
    if (sql.includes('FROM snippets WHERE workspace_id = ?')) {
      return { results: tables.snippets.filter((row) => row.workspace_id === values[0]) }
    }
    if (sql.includes('FROM suppressions WHERE workspace_id = ?')) {
      return { results: tables.suppressions.filter((row) => row.workspace_id === values[0]) }
    }
    if (sql.includes('FROM activity_log WHERE workspace_id = ?')) {
      return { results: [...tables.activity_log].filter((row) => row.workspace_id === values[0]).sort((a, b) => b.created_at - a.created_at) }
    }
    if (sql.includes('FROM sends s JOIN campaigns c ON c.id = s.campaign_id WHERE s.lead_id = ?')) {
      return {
        results: tables.sends.filter((row) => row.lead_id === values[0]).map((send) => ({
          ...send,
          campaign_name: tables.campaigns.find((row) => row.id === send.campaign_id)?.name ?? null,
        })),
      }
    }
    if (sql.includes('FROM events e JOIN sends s ON s.id = e.send_id')) {
      return { results: tables.events.filter((event) => tables.sends.some((row) => row.id === event.send_id && row.lead_id === values[0])) }
    }
    if (sql.includes('FROM leads l') && sql.includes('JOIN lead_list_members m ON m.lead_id = l.id') && sql.includes('ORDER BY l.created_at LIMIT 1')) {
      const lead = tables.leads.find((row) =>
        row.workspace_id === values[1] && tables.lead_list_members.some((member) => member.list_id === values[0] && member.lead_id === row.id),
      )
      return lead ?? null
    }
    if (sql.includes('FROM campaigns c LEFT JOIN senders s ON s.id = c.sender_id')) {
      return {
        results: tables.campaigns.filter((row) => row.status === 'scheduled' && row.scheduled_at !== null && row.scheduled_at !== undefined && row.scheduled_at <= values[0]).map((row) => ({
          ...row,
          sender_type: tables.senders.find((sender) => sender.id === row.sender_id)?.type ?? null,
        })),
      }
    }
    throw new Error(`unhandled SQL in fake DB: ${sql.slice(0, 120)}`)
  }
  const DB = {
    prepare(sql) {
      return {
        bind(...values) {
          const statement = {
            sql,
            values,
            async first() {
              const result = execute(sql, values, 'first')
              if (result && typeof result === 'object' && 'results' in result) return result.results[0] ?? null
              return result
            },
            async all() {
              const result = execute(sql, values, 'all')
              if (result && typeof result === 'object' && 'results' in result) return result
              return { results: result ? [result] : [] }
            },
            async run() {
              const result = execute(sql, values, 'run')
              if (result && typeof result === 'object' && 'meta' in result) return result
              return { meta: { changes: 1 } }
            },
          }
          statements.push(statement)
          return statement
        },
      }
    },
    async batch(list) {
      const results = []
      for (const statement of list) results.push(await statement.run())
      return results
    },
  }
  return { DB, tables, statements }
}

function authedEnv(seed = {}) {
  const db = makeDb(seed)
  const env = {
    OUTREACH_ASSERTION_PUBLIC_KEY: JSON.stringify(publicJwk),
    TOKEN_ENCRYPTION_KEY: seed.tokenKey ?? undefined,
    ACCOUNTS_DB: {
      prepare() {
        return {
          bind() {
            return {
              async first() { return accountsRow() },
            }
          },
        }
      },
    },
    DB: db.DB,
    FILES: {
      async get() { return null },
      async put() {},
      async delete() {},
    },
  }
  return { env, db }
}

function authedRequest(method, path, body) {
  const headers = { Origin: 'https://outreach.kluzar.com', Authorization: `Bearer ${makeAssertion(assertionClaims())}` }
  const init = { method, headers }
  if (body !== undefined) init.body = JSON.stringify(body)
  return new Request(`https://outreach-api.kluzar.com${path}`, init)
}

function seedCampaign(overrides = {}) {
  return {
    id: 'camp-1',
    workspace_id: 'ws-1',
    name: 'Launch campaign',
    sender_id: 'sender-1',
    lead_list_id: 'list-1',
    status: 'draft',
    scheduled_at: null,
    created_at: 1000,
    ...overrides,
  }
}

function seedSender(overrides = {}) {
  return {
    id: 'sender-1',
    workspace_id: 'ws-1',
    type: 'gmail_oauth',
    address: 'owner@example.com',
    display_name: 'Owner',
    credentials_ref: null,
    credentials_expires_at: null,
    is_default: 1,
    created_at: 1,
    ...overrides,
  }
}

function seedLead(overrides = {}) {
  return {
    id: 'lead-1',
    workspace_id: 'ws-1',
    email: 'ada@example.com',
    first_name: 'Ada',
    company: 'Acme',
    status: 'new',
    created_at: 1000,
    ...overrides,
  }
}

test('campaign scheduling validates the launch time and stores a scheduled launch', async () => {
  const seed = {
    campaigns: [seedCampaign()],
    senders: [seedSender()],
    sequences: [{ id: 'step-1', campaign_id: 'camp-1', step_no: 1, delay_days: 0, subject: 'Hello', body_template: 'Hi', created_at: 1 }],
    leads: [seedLead()],
    lead_list_members: [{ list_id: 'list-1', lead_id: 'lead-1', created_at: 1 }],
  }
  const { env, db } = authedEnv(seed)
  const past = await worker.fetch(authedRequest('POST', '/v1/campaigns/camp-1/schedule', { scheduledAt: Date.now() - 1000, confirmAuthorizedRecipients: true }), env, { waitUntil() {} })
  assert.equal(past.status, 400)
  const missing = await worker.fetch(authedRequest('POST', '/v1/campaigns/nope/schedule', { scheduledAt: Date.now() + 3600000, confirmAuthorizedRecipients: true }), env, { waitUntil() {} })
  assert.equal(missing.status, 404)
  const scheduled = await worker.fetch(authedRequest('POST', '/v1/campaigns/camp-1/schedule', { scheduledAt: Date.now() + 3600000, confirmAuthorizedRecipients: true }), env, { waitUntil() {} })
  assert.equal(scheduled.status, 200)
  assert.equal((await scheduled.json()).data.status, 'scheduled')
  assert.equal(db.tables.campaigns[0].status, 'scheduled')
  assert.equal(db.tables.activity_log.length, 1)
  assert.equal(db.tables.activity_log[0].type, 'campaign_scheduled')
})

test('campaign preview resolves variables with a real lead', async () => {
  const seed = {
    campaigns: [seedCampaign()],
    sequences: [{ id: 'step-1', campaign_id: 'camp-1', step_no: 1, delay_days: 0, subject: 'Hello {{first_name}}', body_template: 'Hi {{first_name}} from {{company}}.', created_at: 1 }],
    leads: [seedLead(), seedLead({ id: 'lead-2', email: 'bo@example.com', first_name: '', company: '' })],
    lead_list_members: [
      { list_id: 'list-1', lead_id: 'lead-1', created_at: 1 },
      { list_id: 'list-1', lead_id: 'lead-2', created_at: 2 },
    ],
  }
  const { env } = authedEnv(seed)
  const result = await worker.fetch(authedRequest('GET', '/v1/campaigns/camp-1/preview?workspaceId=ws-1'), env, { waitUntil() {} })
  assert.equal(result.status, 200)
  const body = await result.json()
  assert.equal(body.data.lead.email, 'ada@example.com')
  assert.equal(body.data.steps[0].subject, 'Hello Ada')
  assert.equal(body.data.steps[0].body, 'Hi Ada from Acme.')
  const other = await worker.fetch(authedRequest('GET', '/v1/campaigns/camp-1/preview?workspaceId=ws-1&leadId=lead-2'), env, { waitUntil() {} })
  const otherBody = await other.json()
  assert.equal(otherBody.data.steps[0].subject, 'Hello ')
  assert.equal(otherBody.data.steps[0].body, 'Hi  from .')
})

test('pre-launch check counts ready, suppressed and excluded leads', async () => {
  const seed = {
    campaigns: [seedCampaign()],
    senders: [seedSender()],
    sequences: [{ id: 'step-1', campaign_id: 'camp-1', step_no: 1, delay_days: 0, subject: 'Hello {{first_name}}', body_template: 'Hi {{first_name}}.', created_at: 1 }],
    leads: [
      seedLead(),
      seedLead({ id: 'lead-2', email: 'bo@example.com', first_name: 'Bo', company: 'Beta', status: 'bounced' }),
      seedLead({ id: 'lead-3', email: 'cy@example.com', first_name: 'Cy', company: 'Gamma' }),
    ],
    lead_list_members: [
      { list_id: 'list-1', lead_id: 'lead-1', created_at: 1 },
      { list_id: 'list-1', lead_id: 'lead-2', created_at: 2 },
      { list_id: 'list-1', lead_id: 'lead-3', created_at: 3 },
    ],
    suppressions: [{ id: 'supp-1', workspace_id: 'ws-1', email: 'cy@example.com', reason: 'unsubscribed', created_at: 1 }],
  }
  const { env } = authedEnv(seed)
  const result = await worker.fetch(authedRequest('GET', '/v1/campaigns/camp-1/prelaunch?workspaceId=ws-1'), env, { waitUntil() {} })
  assert.equal(result.status, 200)
  const data = (await result.json()).data
  assert.equal(data.totalInList, 3)
  assert.equal(data.readyToSend, 1)
  assert.equal(data.suppressedInList, 1)
  assert.equal(data.excludedInList, 1)
  assert.equal(data.senderReady, true)
  assert.equal(data.hasFirstStep, true)
  assert.deepEqual(data.variablesUsed, { first_name: true, company: false })
  assert.deepEqual(data.fieldsPresent, { first_name: true, company: true })
})

test('cloning a campaign copies its sequence and branches as a draft', async () => {
  const seed = {
    campaigns: [seedCampaign()],
    sequences: [
      { id: 'step-1', campaign_id: 'camp-1', step_no: 1, delay_days: 0, subject: 'First', body_template: 'One', created_at: 1 },
      { id: 'step-2', campaign_id: 'camp-1', step_no: 2, delay_days: 3, subject: 'Second', body_template: 'Two', created_at: 2 },
    ],
    branches: [{ id: 'branch-1', sequence_id: 'step-1', condition: 'replied', condition_value: null, action: 'stop', action_value: null, created_at: 1 }],
  }
  const { env, db } = authedEnv(seed)
  const result = await worker.fetch(authedRequest('POST', '/v1/campaigns/camp-1/clone'), env, { waitUntil() {} })
  assert.equal(result.status, 201)
  const data = (await result.json()).data
  assert.equal(data.status, 'draft')
  assert.equal(data.name, 'Launch campaign (copy)')
  assert.notEqual(data.id, 'camp-1')
  assert.equal(db.tables.campaigns.length, 2)
  assert.equal(db.tables.sequences.filter((row) => row.campaign_id === data.id).length, 2)
  assert.equal(db.tables.branches.length, 2)
  assert.equal(db.tables.activity_log[0].type, 'campaign_cloned')
})

test('cloning a sequence step appends it after the last step', async () => {
  const seed = {
    campaigns: [seedCampaign()],
    sequences: [
      { id: 'step-1', campaign_id: 'camp-1', step_no: 1, delay_days: 0, subject: 'First', body_template: 'One', created_at: 1 },
      { id: 'step-2', campaign_id: 'camp-1', step_no: 2, delay_days: 3, subject: 'Second', body_template: 'Two', created_at: 2 },
    ],
    branches: [{ id: 'branch-1', sequence_id: 'step-1', condition: 'replied', condition_value: null, action: 'stop', action_value: null, created_at: 1 }],
  }
  const { env, db } = authedEnv(seed)
  const result = await worker.fetch(authedRequest('POST', '/v1/sequences/step-1/clone'), env, { waitUntil() {} })
  assert.equal(result.status, 201)
  const data = (await result.json()).data
  assert.equal(data.step_no, 3)
  assert.equal(data.subject, 'First')
  assert.equal(db.tables.sequences.length, 3)
  assert.equal(db.tables.branches.filter((row) => row.sequence_id === data.id).length, 1)
})

test('campaign archive restores to draft without sends and to paused with sends', async () => {
  const { env, db } = authedEnv({ campaigns: [seedCampaign()] })
  const archived = await worker.fetch(authedRequest('POST', '/v1/campaigns/camp-1/archive'), env, { waitUntil() {} })
  assert.equal(archived.status, 200)
  assert.equal((await archived.json()).data.status, 'archived')
  const restored = await worker.fetch(authedRequest('POST', '/v1/campaigns/camp-1/unarchive'), env, { waitUntil() {} })
  assert.equal((await restored.json()).data.status, 'draft')
  db.tables.sends.push({ id: 'send-1', campaign_id: 'camp-1', lead_id: 'lead-1', sequence_step: 1, status: 'sent', sent_at: 1000, created_at: 1000 })
  await worker.fetch(authedRequest('POST', '/v1/campaigns/camp-1/archive'), env, { waitUntil() {} })
  const restoredAgain = await worker.fetch(authedRequest('POST', '/v1/campaigns/camp-1/unarchive'), env, { waitUntil() {} })
  assert.equal((await restoredAgain.json()).data.status, 'paused')
  assert.equal(db.tables.activity_log.filter((row) => row.type === 'campaign_archived').length, 2)
})

test('bulk lead status change updates only the selected leads', async () => {
  const seed = {
    leads: [
      seedLead(),
      seedLead({ id: 'lead-2', email: 'bo@example.com', first_name: 'Bo', company: 'Beta' }),
      seedLead({ id: 'lead-3', email: 'cy@example.com', first_name: 'Cy', company: 'Gamma' }),
    ],
  }
  const { env, db } = authedEnv(seed)
  const invalid = await worker.fetch(authedRequest('PATCH', '/v1/leads/bulk', { workspaceId: 'ws-1', leadIds: ['lead-1'], status: 'archived' }), env, { waitUntil() {} })
  assert.equal(invalid.status, 400)
  const result = await worker.fetch(authedRequest('PATCH', '/v1/leads/bulk', { workspaceId: 'ws-1', leadIds: ['lead-1', 'lead-2'], status: 'interested' }), env, { waitUntil() {} })
  assert.equal(result.status, 200)
  assert.equal((await result.json()).data.updated, 2)
  assert.equal(db.tables.leads.find((row) => row.id === 'lead-1').status, 'interested')
  assert.equal(db.tables.leads.find((row) => row.id === 'lead-3').status, 'new')
  const suppressed = await worker.fetch(authedRequest('PATCH', '/v1/leads/bulk', { workspaceId: 'ws-1', leadIds: ['lead-3'], status: 'unsubscribed' }), env, { waitUntil() {} })
  assert.equal(suppressed.status, 200)
  assert.equal(db.tables.suppressions.length, 1)
  assert.equal(db.tables.suppressions[0].email, 'cy@example.com')
})

test('snippets are created, listed, updated and deleted per workspace', async () => {
  const { env } = authedEnv({})
  const created = await worker.fetch(authedRequest('POST', '/v1/snippets', { workspaceId: 'ws-1', title: 'Thanks', body: 'Thank you for replying.' }), env, { waitUntil() {} })
  assert.equal(created.status, 201)
  const id = (await created.json()).data.id
  const duplicate = await worker.fetch(authedRequest('POST', '/v1/snippets', { workspaceId: 'ws-1', title: 'Thanks', body: 'Other text.' }), env, { waitUntil() {} })
  assert.equal(duplicate.status, 409)
  const listed = await worker.fetch(authedRequest('GET', '/v1/snippets?workspaceId=ws-1'), env, { waitUntil() {} })
  assert.equal((await listed.json()).data.length, 1)
  const updated = await worker.fetch(authedRequest('PATCH', `/v1/snippets/${id}`, { title: 'Thanks!', body: 'Thank you!' }), env, { waitUntil() {} })
  assert.equal((await updated.json()).data.title, 'Thanks!')
  const deleted = await worker.fetch(authedRequest('DELETE', `/v1/snippets/${id}`), env, { waitUntil() {} })
  assert.equal(deleted.status, 200)
  const empty = await worker.fetch(authedRequest('GET', '/v1/snippets?workspaceId=ws-1'), env, { waitUntil() {} })
  assert.equal((await empty.json()).data.length, 0)
})

test('suppression manager adds, lists and removes suppressed emails', async () => {
  const seed = { leads: [seedLead()] }
  const { env, db } = authedEnv(seed)
  const added = await worker.fetch(authedRequest('POST', '/v1/suppressions', { workspaceId: 'ws-1', email: 'ada@example.com', reason: 'bounced' }), env, { waitUntil() {} })
  assert.equal(added.status, 201)
  assert.equal(db.tables.leads[0].status, 'bounced')
  const listed = await worker.fetch(authedRequest('GET', '/v1/suppressions?workspaceId=ws-1'), env, { waitUntil() {} })
  const rows = (await listed.json()).data
  assert.equal(rows.length, 1)
  assert.equal(rows[0].reason, 'bounced')
  const removed = await worker.fetch(authedRequest('DELETE', `/v1/suppressions/${rows[0].id}`), env, { waitUntil() {} })
  assert.equal(removed.status, 200)
  assert.equal(db.tables.suppressions.length, 0)
  assert.equal(db.tables.leads[0].status, 'new')
  assert.deepEqual(db.tables.activity_log.map((row) => row.type), ['suppression_added', 'suppression_removed'])
})

test('onboarding state reflects real workspace progress', async () => {
  const seed = {
    senders: [seedSender()],
    leads: [seedLead()],
    campaigns: [seedCampaign()],
    brevo_ignored_messages: [{ provider_message_id: 'msg-1', workspace_id: 'ws-1', kind: 'test', created_at: 1 }],
  }
  const { env, db } = authedEnv(seed)
  const first = await worker.fetch(authedRequest('GET', '/v1/onboarding?workspaceId=ws-1'), env, { waitUntil() {} })
  assert.deepEqual((await first.json()).data, { senderConnected: true, leadsAdded: true, campaignCreated: true, testSent: true, launched: false })
  db.tables.campaigns[0].status = 'active'
  const second = await worker.fetch(authedRequest('GET', '/v1/onboarding?workspaceId=ws-1'), env, { waitUntil() {} })
  assert.equal((await second.json()).data.launched, true)
})

test('activity log lists logged workspace events newest first', async () => {
  const seed = {
    activity_log: [
      { id: 'a-1', workspace_id: 'ws-1', type: 'campaign_created', message: 'First', created_at: 1000 },
      { id: 'a-2', workspace_id: 'ws-1', type: 'campaign_launched', message: 'Second', created_at: 2000 },
    ],
  }
  const { env } = authedEnv(seed)
  const result = await worker.fetch(authedRequest('GET', '/v1/activity?workspaceId=ws-1'), env, { waitUntil() {} })
  const rows = (await result.json()).data
  assert.equal(rows.length, 2)
  assert.equal(rows[0].type, 'campaign_launched')
})

test('notification preferences are read and updated per workspace', async () => {
  const { env } = authedEnv({})
  const first = await worker.fetch(authedRequest('GET', '/v1/workspaces/ws-1/preferences'), env, { waitUntil() {} })
  assert.deepEqual((await first.json()).data, { notifyReplyEmail: true })
  const updated = await worker.fetch(authedRequest('PATCH', '/v1/workspaces/ws-1/preferences', { notifyReplyEmail: false }), env, { waitUntil() {} })
  assert.deepEqual((await updated.json()).data, { notifyReplyEmail: false })
  const again = await worker.fetch(authedRequest('GET', '/v1/workspaces/ws-1/preferences'), env, { waitUntil() {} })
  assert.deepEqual((await again.json()).data, { notifyReplyEmail: false })
})

test('inbox replies can be marked read and unread', async () => {
  const seed = {
    campaigns: [seedCampaign()],
    leads: [seedLead({ status: 'replied' })],
    sends: [{ id: 'send-1', campaign_id: 'camp-1', lead_id: 'lead-1', sequence_step: 1, status: 'replied', provider_message_id: 'm-1', provider_thread_id: 't-1', sent_at: 1000, created_at: 1000 }],
    replies: [{ id: 'reply-1', send_id: 'send-1', sender_email: 'ada@example.com', subject: 'Re: Hello', body_text: 'Hi', received_at: 2000, read_at: null }],
  }
  const { env } = authedEnv(seed)
  const read = await worker.fetch(authedRequest('POST', '/v1/inbox/reply-1/read', { read: true }), env, { waitUntil() {} })
  assert.equal(read.status, 200)
  assert.ok((await read.json()).data.read_at)
  const unread = await worker.fetch(authedRequest('POST', '/v1/inbox/reply-1/read', { read: false }), env, { waitUntil() {} })
  assert.equal((await unread.json()).data.read_at, null)
})

test('lead list export returns an ownership-checked CSV download', async () => {
  const seed = {
    leads: [seedLead(), seedLead({ id: 'lead-2', email: 'bo@example.com', first_name: 'Bo', company: 'Beta' })],
    lead_list_members: [
      { list_id: 'list-1', lead_id: 'lead-1', created_at: 1 },
      { list_id: 'list-1', lead_id: 'lead-2', created_at: 2 },
    ],
  }
  const { env } = authedEnv(seed)
  const result = await worker.fetch(authedRequest('GET', '/v1/lists/list-1/export?workspaceId=ws-1'), env, { waitUntil() {} })
  assert.equal(result.status, 200)
  assert.match(result.headers.get('Content-Type'), /text\/csv/)
  assert.match(result.headers.get('Content-Disposition'), /attachment/)
  const text = await result.text()
  assert.ok(text.startsWith('email,first_name,company,status,created_at'))
  assert.ok(text.includes('ada@example.com'))
  assert.ok(text.includes('bo@example.com'))
  const missing = await worker.fetch(authedRequest('GET', '/v1/lists/nope/export?workspaceId=ws-1'), env, { waitUntil() {} })
  assert.equal(missing.status, 404)
})

test('campaign stats export returns one row per send', async () => {
  const seed = {
    campaigns: [seedCampaign()],
    leads: [seedLead()],
    sends: [
      { id: 'send-1', campaign_id: 'camp-1', lead_id: 'lead-1', sequence_step: 1, status: 'sent', sent_at: 1000, opened_at: null, clicked_at: null, replied_at: null, created_at: 1000 },
      { id: 'send-2', campaign_id: 'camp-1', lead_id: 'lead-1', sequence_step: 2, status: 'queued', sent_at: null, opened_at: null, clicked_at: null, replied_at: null, created_at: 2000 },
    ],
  }
  const { env } = authedEnv(seed)
  const result = await worker.fetch(authedRequest('GET', '/v1/campaigns/camp-1/stats.csv?workspaceId=ws-1'), env, { waitUntil() {} })
  assert.equal(result.status, 200)
  const lines = (await result.text()).trim().split('\r\n')
  assert.equal(lines.length, 3)
  assert.ok(lines[1].includes('ada@example.com'))
  assert.ok(lines[1].includes(',1,sent,'))
})

test('import overlap counts existing and suppressed addresses separately', async () => {
  const seed = {
    leads: [seedLead()],
    suppressions: [{ id: 'supp-1', workspace_id: 'ws-1', email: 'cy@example.com', reason: 'unsubscribed', created_at: 1 }],
  }
  const { env } = authedEnv(seed)
  const overlap = await countImportOverlap(env, 'ws-1', ['ada@example.com', 'cy@example.com', 'new@example.com'])
  assert.deepEqual(overlap, { duplicates: 1, suppressed: 1 })
})

test('lead search filters by name, email and company and by status', async () => {
  const seed = {
    leads: [
      seedLead(),
      seedLead({ id: 'lead-2', email: 'bo@example.com', first_name: 'Bo', company: 'Beta', status: 'bounced' }),
      seedLead({ id: 'lead-3', email: 'cy@example.com', first_name: 'Cy', company: 'Gamma' }),
    ],
  }
  const { env } = authedEnv(seed)
  const byCompany = await worker.fetch(authedRequest('GET', '/v1/leads?workspaceId=ws-1&q=beta'), env, { waitUntil() {} })
  assert.deepEqual((await byCompany.json()).data.map((row) => row.email), ['bo@example.com'])
  const byStatus = await worker.fetch(authedRequest('GET', '/v1/leads?workspaceId=ws-1&status=bounced'), env, { waitUntil() {} })
  assert.deepEqual((await byStatus.json()).data.map((row) => row.email), ['bo@example.com'])
  const byName = await worker.fetch(authedRequest('GET', '/v1/leads?workspaceId=ws-1&q=CY'), env, { waitUntil() {} })
  assert.deepEqual((await byName.json()).data.map((row) => row.email), ['cy@example.com'])
})

test('campaign list filters by status', async () => {
  const seed = {
    campaigns: [seedCampaign(), seedCampaign({ id: 'camp-2', name: 'Second', status: 'active' })],
  }
  const { env } = authedEnv(seed)
  const result = await worker.fetch(authedRequest('GET', '/v1/campaigns?workspaceId=ws-1&status=active'), env, { waitUntil() {} })
  assert.deepEqual((await result.json()).data.map((row) => row.id), ['camp-2'])
  const byName = await worker.fetch(authedRequest('GET', '/v1/campaigns?workspaceId=ws-1&q=second'), env, { waitUntil() {} })
  assert.deepEqual((await byName.json()).data.map((row) => row.id), ['camp-2'])
})

async function replyTestEnv(seed, tokenKey) {
  const { env, db } = authedEnv({ ...seed, tokenKey })
  const ciphertext = await encryptToken(env, { accessToken: 'mailbox-token', refreshToken: 'mailbox-refresh', expiresAt: Date.now() + 3600000 })
  const sender = db.tables.senders[0]
  sender.credentials_ref = ciphertext
  sender.credentials_expires_at = Date.now() + 3600000
  return { env, db }
}

function replySeed(overrides = {}) {
  return {
    campaigns: [seedCampaign()],
    senders: [seedSender()],
    leads: [seedLead({ status: 'replied' })],
    lead_list_members: [{ list_id: 'list-1', lead_id: 'lead-1', created_at: 1 }],
    sends: [{ id: 'send-1', campaign_id: 'camp-1', lead_id: 'lead-1', sequence_step: 1, status: 'replied', provider_message_id: 'orig-msg-1', provider_thread_id: 'thread-1', sent_at: 1000, created_at: 1000 }],
    replies: [{ id: 'reply-1', send_id: 'send-1', sender_email: 'ada@example.com', subject: 'Re: Hello', body_text: 'Sounds good', received_at: 2000, read_at: null }],
    ...overrides,
  }
}

test('inbox reply sends a threaded Gmail reply and marks the reply read', async () => {
  const tokenKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const { env, db } = await replyTestEnv(replySeed(), tokenKey)
  const originalFetch = globalThis.fetch
  let sentBody = null
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('gmail.googleapis.com/gmail/v1/users/me/messages/send')) {
      sentBody = JSON.parse(String(init.body))
      return { ok: true, async json() { return { id: 'gmail-msg-9', threadId: 'thread-1' } } }
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  try {
    const result = await worker.fetch(authedRequest('POST', '/v1/inbox/reply-1/reply', { workspaceId: 'ws-1', body: 'Thanks for replying, Ada.' }), env, { waitUntil() {} })
    assert.equal(result.status, 202)
    assert.equal((await result.json()).data.sent, true)
    assert.equal(sentBody.threadId, 'thread-1')
    assert.equal(db.tables.inbox_replies.length, 1)
    assert.equal(db.tables.inbox_replies[0].body_text, 'Thanks for replying, Ada.')
    assert.ok(db.tables.replies[0].read_at)
    assert.equal(db.tables.activity_log[0].type, 'reply_sent')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('inbox reply uses the Outlook createReply flow for Microsoft mailboxes', async () => {
  const tokenKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const seed = replySeed({ senders: [seedSender({ type: 'outlook_oauth', address: 'owner@outlook.com' })] })
  const { env, db } = await replyTestEnv(seed, tokenKey)
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push(String(url))
    if (String(url).includes('/createReply')) return { ok: true, async json() { return { id: 'draft-1', conversationId: 'conv-1' } } }
    if (String(url).includes('/me/messages/draft-1')) return { ok: true, async json() { return {} } }
    throw new Error(`unexpected fetch ${url}`)
  }
  try {
    const result = await worker.fetch(authedRequest('POST', '/v1/inbox/reply-1/reply', { workspaceId: 'ws-1', body: 'Thanks for replying.' }), env, { waitUntil() {} })
    assert.equal(result.status, 202)
    assert.ok(calls.some((url) => url.includes('/createReply')))
    assert.ok(calls.some((url) => url.endsWith('/draft-1/send')))
    assert.equal(db.tables.inbox_replies.length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('inbox reply respects the workspace daily limit', async () => {
  const tokenKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const todaySends = Array.from({ length: 50 }, (_item, index) => ({
    id: `send-today-${index}`,
    campaign_id: 'camp-1',
    lead_id: 'lead-1',
    sequence_step: 1,
    status: 'sent',
    sent_at: Date.now(),
    created_at: Date.now(),
  }))
  const seed = replySeed({ sends: [replySeed().sends[0], ...todaySends] })
  const { env } = await replyTestEnv(seed, tokenKey)
  const result = await worker.fetch(authedRequest('POST', '/v1/inbox/reply-1/reply', { workspaceId: 'ws-1', body: 'Thanks.' }), env, { waitUntil() {} })
  assert.equal(result.status, 429)
})

test('inbox reply refuses a suppressed lead', async () => {
  const tokenKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const seed = replySeed({
    suppressions: [{ id: 'supp-1', workspace_id: 'ws-1', email: 'ada@example.com', reason: 'unsubscribed', created_at: 1 }],
  })
  const { env } = await replyTestEnv(seed, tokenKey)
  const result = await worker.fetch(authedRequest('POST', '/v1/inbox/reply-1/reply', { workspaceId: 'ws-1', body: 'Thanks.' }), env, { waitUntil() {} })
  assert.equal(result.status, 409)
})

test('inbox reply fails closed when the mailbox cannot be refreshed', async () => {
  const { env } = authedEnv(replySeed())
  const result = await worker.fetch(authedRequest('POST', '/v1/inbox/reply-1/reply', { workspaceId: 'ws-1', body: 'Thanks.' }), env, { waitUntil() {} })
  assert.equal(result.status, 502)
})

test('decryptToken round-trips the credentials it encrypts', async () => {
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const env = { TOKEN_ENCRYPTION_KEY: key }
  const value = { accessToken: 'a-token', refreshToken: 'r-token', expiresAt: 123456789 }
  const ciphertext = await encryptToken(env, value)
  assert.deepEqual(await decryptToken(env, ciphertext), value)
})
