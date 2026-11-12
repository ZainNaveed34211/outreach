import { authenticate } from './verify.js'

const APP_ORIGIN = 'https://outreach.kluzar.com'
const BREVO_API_URL = 'https://api.brevo.com/v3'
const GOOGLE_REDIRECT_URI = 'https://outreach.kluzar.com/oauth/google/callback'
const MICROSOFT_REDIRECT_URI = 'https://outreach.kluzar.com/oauth/microsoft/callback'
const DAILY_SEND_LIMIT = 50
const SEND_INTERVAL_SECONDS = 60
const MAX_JSON_BYTES = 131072
const MAX_CSV_BYTES = 5242880
const VALID_LEAD_STATUSES = new Set(['new', 'contacted', 'replied', 'interested', 'not_interested', 'bounced', 'unsubscribed'])

async function logActivity(env, workspaceId, type, message) {
  try {
    await env.DB.prepare(
      'INSERT INTO activity_log (id, workspace_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), workspaceId, type, String(message).slice(0, 500), Date.now()).run()
  } catch {
  }
}

async function dailySendCount(env, workspaceId, now) {
  const dayStart = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`)
  const [campaignSends, manualReplies] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM sends s JOIN campaigns c ON c.id = s.campaign_id
       WHERE c.workspace_id = ? AND s.sent_at >= ? AND s.status IN ('sent', 'delivered', 'opened', 'clicked', 'replied', 'bounced')`,
    ).bind(workspaceId, dayStart).first(),
    env.DB.prepare(
      'SELECT COUNT(*) AS count FROM inbox_replies WHERE workspace_id = ? AND sent_at >= ?',
    ).bind(workspaceId, dayStart).first(),
  ])
  return Number(campaignSends?.count ?? 0) + Number(manualReplies?.count ?? 0)
}

async function lastSendAt(env, workspaceId) {
  const [campaignSend, manualReply] = await Promise.all([
    env.DB.prepare(
      `SELECT MAX(s.sent_at) AS sent_at FROM sends s JOIN campaigns c ON c.id = s.campaign_id
       WHERE c.workspace_id = ? AND s.sent_at IS NOT NULL`,
    ).bind(workspaceId).first(),
    env.DB.prepare(
      'SELECT MAX(sent_at) AS sent_at FROM inbox_replies WHERE workspace_id = ?',
    ).bind(workspaceId).first(),
  ])
  return Math.max(Number(campaignSend?.sent_at ?? 0), Number(manualReply?.sent_at ?? 0))
}

function escapeLike(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

async function queueCampaignSends(env, campaign, now) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO sends (id, campaign_id, lead_id, sequence_step, status, scheduled_at, created_at)
     SELECT lower(hex(randomblob(16))), ?, l.id, 1, 'queued', ?, ?
     FROM leads l JOIN lead_list_members m ON m.lead_id = l.id
     WHERE l.workspace_id = ? AND m.list_id = ? AND l.status IN ('new', 'contacted')
       AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = l.workspace_id AND s.email = l.email)
       AND NOT EXISTS (
         SELECT 1 FROM sends active_send JOIN campaigns active_campaign ON active_campaign.id = active_send.campaign_id
         WHERE active_send.lead_id = l.id AND active_campaign.workspace_id = l.workspace_id
           AND active_campaign.status = 'active' AND active_send.status IN ('queued', 'sending')
       )`,
  ).bind(campaign.id, now, now, campaign.workspace_id, campaign.lead_list_id).run()
}

async function campaignEligibleLeads(env, campaign) {
  const rows = await env.DB.prepare(
    `SELECT l.id FROM leads l JOIN lead_list_members m ON m.lead_id = l.id
     WHERE l.workspace_id = ? AND m.list_id = ? AND l.status IN ('new', 'contacted')
       AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = l.workspace_id AND s.email = l.email)
       AND NOT EXISTS (
         SELECT 1 FROM sends active_send JOIN campaigns active_campaign ON active_campaign.id = active_send.campaign_id
         WHERE active_send.lead_id = l.id AND active_campaign.workspace_id = l.workspace_id
           AND active_campaign.status = 'active' AND active_send.status IN ('queued', 'sending')
       )`,
  ).bind(campaign.workspace_id, campaign.lead_list_id).all()
  return rows.results ?? []
}

function response(body, status, origin) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Vary': 'Origin',
  })
  if (origin === APP_ORIGIN) {
    headers.set('Access-Control-Allow-Origin', APP_ORIGIN)
    headers.set('Access-Control-Allow-Credentials', 'true')
    headers.set('Access-Control-Expose-Headers', 'Content-Disposition')
  }
  if (body instanceof Response) return body
  headers.set('Content-Type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(body), { status, headers })
}

function errorResponse(message, status, origin) {
  return response({ ok: false, error: message }, status, origin)
}

function jsonResponse(data, origin, status = 200) {
  const body = { ok: true, data }
  return response(body, status, origin)
}

function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function normalizeEmail(value) {
  return value.trim().toLowerCase()
}

function safeText(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function base64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

function randomToken(size = 32) {
  return base64Url(crypto.getRandomValues(new Uint8Array(size)))
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return new Uint8Array(digest)
}

async function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  if (a.length !== b.length) {
    let difference = a.length ^ b.length
    const length = Math.max(a.length, b.length)
    for (let index = 0; index < length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0)
    return difference === 0
  }
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index]
  return difference === 0
}

async function readJson(request, maxBytes = MAX_JSON_BYTES) {
  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > maxBytes) return null
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > maxBytes) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function rateLimit(env, userId) {
  const key = base64Url(await sha256(userId))
  const now = Math.floor(Date.now() / 1000)
  const start = Math.floor(now / 60) * 60
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (rate_key, window_start, request_count)
     VALUES (?, ?, 1)
     ON CONFLICT(rate_key) DO UPDATE SET
       request_count = CASE WHEN window_start = excluded.window_start THEN request_count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING request_count`,
  ).bind(key, start).first()
  return Number(row?.request_count ?? 121) <= 120
}

async function ownsWorkspace(env, workspaceId, userId) {
  if (!safeText(workspaceId, 100)) return false
  const row = await env.DB.prepare(
    'SELECT id FROM workspaces WHERE id = ? AND owner_user_id = ?',
  ).bind(workspaceId, userId).first()
  return Boolean(row)
}

async function workspaceRecord(env, workspaceId, userId) {
  if (!safeText(workspaceId, 100)) return null
  return env.DB.prepare(
    'SELECT id, owner_user_id, owner_email, name, created_at FROM workspaces WHERE id = ? AND owner_user_id = ?',
  ).bind(workspaceId, userId).first()
}

async function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
    } else if (char === '"' && cell.length === 0) {
      quoted = true
    } else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(cell)
      if (row.some((value) => value.length > 0)) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
    if (cell.length > 10000) throw new Error('invalid_csv')
  }
  if (quoted) throw new Error('invalid_csv')
  row.push(cell)
  if (row.some((value) => value.length > 0)) rows.push(row)
  if (rows.length < 2 || rows.length > 10001) throw new Error('invalid_csv')
  const headers = rows[0].map((value) => value.trim().toLowerCase())
  const emailIndex = headers.indexOf('email')
  if (emailIndex < 0) throw new Error('invalid_csv')
  const firstNameIndex = headers.indexOf('first_name')
  const companyIndex = headers.indexOf('company')
  const leads = new Map()
  for (const values of rows.slice(1)) {
    const email = normalizeEmail(values[emailIndex] ?? '')
    if (!isValidEmail(email)) continue
    leads.set(email, {
      email,
      firstName: firstNameIndex < 0 ? '' : String(values[firstNameIndex] ?? '').trim().slice(0, 100),
      company: companyIndex < 0 ? '' : String(values[companyIndex] ?? '').trim().slice(0, 150),
    })
  }
  return [...leads.values()]
}

async function encryptToken(env, value) {
  const rawKey = env.TOKEN_ENCRYPTION_KEY
  if (!rawKey) throw new Error('configuration')
  let keyBytes
  try {
    const normalized = rawKey.replaceAll('-', '+').replaceAll('_', '/')
    keyBytes = Uint8Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')), (char) => char.charCodeAt(0))
  } catch {
    throw new Error('configuration')
  }
  if (keyBytes.length !== 32) throw new Error('configuration')
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)))
  return `${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`
}

async function decryptToken(env, value) {
  if (!env.TOKEN_ENCRYPTION_KEY || typeof value !== 'string') throw new Error('configuration')
  const [encodedIv, encodedData] = value.split('.')
  if (!encodedIv || !encodedData) throw new Error('credentials')
  const decode = (encoded) => Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=')), (char) => char.charCodeAt(0))
  const rawKey = env.TOKEN_ENCRYPTION_KEY.replaceAll('-', '+').replaceAll('_', '/')
  const keyBytes = Uint8Array.from(atob(rawKey.padEnd(Math.ceil(rawKey.length / 4) * 4, '=')), (char) => char.charCodeAt(0))
  if (keyBytes.length !== 32) throw new Error('configuration')
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt'])
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(encodedIv) }, key, decode(encodedData))
  return JSON.parse(new TextDecoder().decode(plaintext))
}

async function setCorsPreflight(request) {
  if (request.headers.get('origin') !== APP_ORIGIN) return new Response(null, { status: 403 })
  const requestedHeaders = (request.headers.get('access-control-request-headers') ?? '')
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean)
  const allowedHeaders = new Set(['content-type', 'authorization'])
  if (requestedHeaders.some((header) => !allowedHeaders.has(header))) return new Response(null, { status: 403 })
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': APP_ORIGIN,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin',
    },
  })
}

function safeUnsubscribeHtml(token) {
  const escapedToken = token.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Unsubscribe</title><style>body{font:16px system-ui,sans-serif;max-width:36rem;margin:10vh auto;padding:0 1.25rem;color:#17172a}button{background:#141272;color:white;border:0;border-radius:8px;padding:.8rem 1.2rem;font:inherit;cursor:pointer}</style><main><h1>Unsubscribe from these emails?</h1><p>Confirm to stop further outreach emails to this address.</p><form method="post" action="/v1/unsubscribe/${escapedToken}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form></main></html>`
  return new Response(html, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
  })
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname
    const origin = request.headers.get('origin')

    if (request.method === 'OPTIONS') return setCorsPreflight(request)

    const unsubscribeMatch = path.match(/^\/v1\/unsubscribe\/([A-Za-z0-9_-]{32,100})$/)
    if (unsubscribeMatch) {
      if (request.method === 'GET') return safeUnsubscribeHtml(unsubscribeMatch[1])
      if (request.method === 'POST') return unsubscribe(request, env, unsubscribeMatch[1])
      return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } })
    }

    const webhookMatch = path.match(/^\/v1\/webhooks\/brevo\/([A-Za-z0-9_-]{32,100})$/)
    if (webhookMatch && request.method === 'POST') return brevoWebhook(request, env, webhookMatch[1])
    if (path.startsWith('/v1/webhooks/')) return errorResponse('Request could not be verified.', 401)

    if (origin !== APP_ORIGIN) return errorResponse('Request could not be verified.', 403)
    if (!path.startsWith('/v1/')) return errorResponse('Not found.', 404, origin)
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) return errorResponse('Method not allowed.', 405, origin)

    const auth = await authenticate(request, env)
    if (!auth.ok) return errorResponse(auth.error, auth.status, origin)
    const session = { userId: auth.userId, email: auth.email, emailVerified: auth.emailVerified }
    if (!await rateLimit(env, session.userId)) return errorResponse('Too many requests. Please try again shortly.', 429, origin)

    try {
      return await routeApi(request, env, ctx, url, session, origin)
    } catch (error) {
      if (error instanceof Error && error.message === 'configuration') return errorResponse('This action is temporarily unavailable.', 503, origin)
      return errorResponse('Something went wrong. Please try again.', 500, origin)
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduler(env))
    ctx.waitUntil(cleanupExpiredUploads(env))
  },
}

async function routeApi(request, env, ctx, url, session, origin) {
  const path = url.pathname.replace(/\/+$/, '')
  const method = request.method
  if (path === '/v1/me' && method === 'GET') {
    const workspaces = await env.DB.prepare(
      'SELECT id, name, created_at FROM workspaces WHERE owner_user_id = ? ORDER BY created_at',
    ).bind(session.userId).all()
    return jsonResponse({
      user: { id: session.userId, email: session.email || null },
      workspaces: workspaces.results ?? [],
    }, origin)
  }
  if (path === '/v1/workspaces' && method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT id, name, created_at FROM workspaces WHERE owner_user_id = ? ORDER BY created_at',
    ).bind(session.userId).all()
    return jsonResponse(rows.results ?? [], origin)
  }
  if (path === '/v1/workspaces' && method === 'POST') return createWorkspace(request, env, session, origin)
  if (path === '/v1/lists' && method === 'GET') return listLeadLists(env, url, session, origin)
  if (path === '/v1/lists' && method === 'POST') return createLeadList(request, env, session, origin)
  if (path === '/v1/campaigns' && method === 'GET') return listCampaigns(env, url, session, origin)
  if (path === '/v1/campaigns' && method === 'POST') return createCampaign(request, env, session, origin)
  const campaignMatch = path.match(/^\/v1\/campaigns\/([A-Za-z0-9_-]+)$/)
  if (campaignMatch && method === 'GET') return getCampaign(env, campaignMatch[1], url, session, origin)
  if (campaignMatch && method === 'PATCH') return updateCampaign(request, env, campaignMatch[1], session, origin)
  const campaignAction = path.match(/^\/v1\/campaigns\/([A-Za-z0-9_-]+)\/(launch|pause)$/)
  if (campaignAction && method === 'POST') return campaignActionResponse(request, env, campaignAction[1], campaignAction[2], session, origin)
  if (path === '/v1/leads' && method === 'GET') return listLeads(env, url, session, origin)
  if (path === '/v1/leads' && method === 'POST') return createLead(request, env, session, origin)
  if (path === '/v1/leads/import' && method === 'POST') return importLeads(request, env, session, origin)
  const importComplete = path.match(/^\/v1\/leads\/import\/([A-Za-z0-9_-]+)\/complete$/)
  if (importComplete && method === 'POST') return completeUpload(env, importComplete[1], session, origin, 'csv_import')
  if (path === '/v1/leads/bulk' && method === 'PATCH') return bulkUpdateLeads(request, env, session, origin)
  const leadTimelineMatch = path.match(/^\/v1\/leads\/([A-Za-z0-9_-]+)\/timeline$/)
  if (leadTimelineMatch && method === 'GET') return leadTimeline(env, leadTimelineMatch[1], url, session, origin)
  const leadMatch = path.match(/^\/v1\/leads\/([A-Za-z0-9_-]+)$/)
  if (leadMatch && method === 'PATCH') return updateLead(request, env, leadMatch[1], session, origin)
  if (path === '/v1/sequences' && method === 'GET') return listSequences(env, url, session, origin)
  if (path === '/v1/sequences' && method === 'POST') return createSequence(request, env, session, origin)
  const sequenceMatch = path.match(/^\/v1\/sequences\/([A-Za-z0-9_-]+)$/)
  if (sequenceMatch && method === 'PATCH') return updateSequence(request, env, sequenceMatch[1], session, origin)
  if (path === '/v1/branches' && method === 'GET') return listBranches(env, url, session, origin)
  if (path === '/v1/branches' && method === 'POST') return createBranch(request, env, session, origin)
  if (path === '/v1/senders' && method === 'GET') return listSenders(env, url, session, origin)
  if (path === '/v1/senders' && method === 'POST') return createBrevoSender(request, env, session, origin)
  if (path === '/v1/senders/oauth' && method === 'POST') return startOAuth(request, env, session, origin)
  const oauthExchange = path.match(/^\/v1\/oauth\/(google|microsoft)\/exchange$/)
  if (oauthExchange && method === 'POST') return exchangeOAuth(request, env, oauthExchange[1], session, origin)
  if (path === '/v1/inbox' && method === 'GET') return listInbox(env, url, session, origin)
  const inboxReplyMatch = path.match(/^\/v1\/inbox\/([A-Za-z0-9_-]+)\/reply$/)
  if (inboxReplyMatch && method === 'POST') return replyToInbox(request, env, inboxReplyMatch[1], session, origin)
  const inboxReadMatch = path.match(/^\/v1\/inbox\/([A-Za-z0-9_-]+)\/read$/)
  if (inboxReadMatch && method === 'POST') return markInboxRead(request, env, inboxReadMatch[1], session, origin)
  if (path === '/v1/suppressions' && method === 'GET') return listSuppressions(env, url, session, origin)
  if (path === '/v1/suppressions' && method === 'POST') return addSuppression(request, env, session, origin)
  const suppressionMatch = path.match(/^\/v1\/suppressions\/([A-Za-z0-9_-]+)$/)
  if (suppressionMatch && method === 'DELETE') return removeSuppression(env, suppressionMatch[1], session, origin)
  if (path === '/v1/snippets' && method === 'GET') return listSnippets(env, url, session, origin)
  if (path === '/v1/snippets' && method === 'POST') return createSnippet(request, env, session, origin)
  const snippetMatch = path.match(/^\/v1\/snippets\/([A-Za-z0-9_-]+)$/)
  if (snippetMatch && method === 'PATCH') return updateSnippet(request, env, snippetMatch[1], session, origin)
  if (snippetMatch && method === 'DELETE') return deleteSnippet(env, snippetMatch[1], session, origin)
  if (path === '/v1/onboarding' && method === 'GET') return onboardingState(env, url, session, origin)
  if (path === '/v1/activity' && method === 'GET') return listActivity(env, url, session, origin)
  const preferencesMatch = path.match(/^\/v1\/workspaces\/([A-Za-z0-9_-]+)\/preferences$/)
  if (preferencesMatch && method === 'GET') return getPreferences(env, preferencesMatch[1], session, origin)
  if (preferencesMatch && method === 'PATCH') return updatePreferences(request, env, preferencesMatch[1], session, origin)
  const listExportMatch = path.match(/^\/v1\/lists\/([A-Za-z0-9_-]+)\/export$/)
  if (listExportMatch && method === 'GET') return exportLeadList(env, listExportMatch[1], url, session)
  const campaignPreviewMatch = path.match(/^\/v1\/campaigns\/([A-Za-z0-9_-]+)\/preview$/)
  if (campaignPreviewMatch && method === 'GET') return previewCampaign(env, campaignPreviewMatch[1], url, session, origin)
  const campaignPrelaunchMatch = path.match(/^\/v1\/campaigns\/([A-Za-z0-9_-]+)\/prelaunch$/)
  if (campaignPrelaunchMatch && method === 'GET') return prelaunchCheck(env, campaignPrelaunchMatch[1], url, session, origin)
  const campaignCloneMatch = path.match(/^\/v1\/campaigns\/([A-Za-z0-9_-]+)\/clone$/)
  if (campaignCloneMatch && method === 'POST') return cloneCampaign(env, campaignCloneMatch[1], session, origin)
  const campaignScheduleMatch = path.match(/^\/v1\/campaigns\/([A-Za-z0-9_-]+)\/schedule$/)
  if (campaignScheduleMatch && method === 'POST') return scheduleCampaign(request, env, campaignScheduleMatch[1], session, origin)
  const campaignArchiveMatch = path.match(/^\/v1\/campaigns\/([A-Za-z0-9_-]+)\/archive$/)
  if (campaignArchiveMatch && method === 'POST') return archiveCampaign(env, campaignArchiveMatch[1], session, origin)
  const campaignUnarchiveMatch = path.match(/^\/v1\/campaigns\/([A-Za-z0-9_-]+)\/unarchive$/)
  if (campaignUnarchiveMatch && method === 'POST') return unarchiveCampaign(env, campaignUnarchiveMatch[1], session, origin)
  const campaignStatsCsvMatch = path.match(/^\/v1\/campaigns\/([A-Za-z0-9_-]+)\/stats.csv$/)
  if (campaignStatsCsvMatch && method === 'GET') return exportCampaignStats(env, campaignStatsCsvMatch[1], url, session)
  const sequenceCloneMatch = path.match(/^\/v1\/sequences\/([A-Za-z0-9_-]+)\/clone$/)
  if (sequenceCloneMatch && method === 'POST') return cloneSequence(env, sequenceCloneMatch[1], session, origin)
  if (path === '/v1/notifications' && method === 'GET') return listNotifications(env, url, session, origin)
  if (path === '/v1/notifications/read' && method === 'POST') return markNotificationsRead(request, env, session, origin)
  const statsMatch = path.match(/^\/v1\/stats\/([A-Za-z0-9_-]+)$/)
  if (statsMatch && method === 'GET') return campaignStats(env, statsMatch[1], url, session, origin)
  if (path === '/v1/test/send' && method === 'POST') return sendTest(request, env, session, origin)
  if (path === '/v1/test/campaign' && method === 'POST') return testCampaign(request, env, session, origin)
  if (path === '/v1/files' && method === 'POST') return uploadAttachment(request, env, session, origin)
  const fileMatch = path.match(/^\/v1\/files\/([A-Za-z0-9_-]+)$/)
  if (fileMatch && method === 'POST') return completeUpload(env, fileMatch[1], session, origin, 'attachment')
  if (fileMatch && method === 'GET') return downloadFile(env, fileMatch[1], url, session)
  return errorResponse('Not found.', 404, origin)
}

async function createWorkspace(request, env, session, origin) {
  const body = await readJson(request)
  if (!isObject(body) || !safeText(body.name, 100)) return errorResponse('Enter a valid workspace name.', 400, origin)
  const id = crypto.randomUUID()
  const now = Date.now()
  const ownerEmail = session.emailVerified && session.email ? session.email : ''
  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO workspaces (id, owner_user_id, owner_email, name, created_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(id, session.userId, ownerEmail, body.name.trim(), now),
      env.DB.prepare(
        'INSERT INTO lead_lists (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)',
      ).bind(crypto.randomUUID(), id, 'Main list', now),
    ])
  } catch {
    return errorResponse('A workspace with this name already exists.', 409, origin)
  }
  return jsonResponse({ id, name: body.name.trim(), created_at: now }, origin, 201)
}

async function listLeadLists(env, url, session, origin) {
  const workspaceId = url.searchParams.get('workspaceId')
  if (!await ownsWorkspace(env, workspaceId, session.userId)) return errorResponse('Workspace not found.', 404, origin)
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, 100)
  const sort = url.searchParams.get('sort') ?? 'created_desc'
  const orderBy = sort === 'created_asc'
    ? 'l.created_at ASC'
    : sort === 'name_asc'
      ? 'l.name ASC'
      : sort === 'name_desc'
        ? 'l.name DESC'
        : 'l.created_at DESC'
  const rows = await env.DB.prepare(
    `SELECT l.id, l.name, l.created_at, COUNT(m.lead_id) AS lead_count
     FROM lead_lists l LEFT JOIN lead_list_members m ON m.list_id = l.id
     WHERE l.workspace_id = ? AND (? = '' OR l.name LIKE ? ESCAPE '\\')
     GROUP BY l.id ORDER BY ${orderBy}`,
  ).bind(workspaceId, query, `%${escapeLike(query)}%`).all()
  return jsonResponse(rows.results ?? [], origin)
}

async function createLeadList(request, env, session, origin) {
  const body = await readJson(request)
  if (!isObject(body) || !safeText(body.name, 100) || !await ownsWorkspace(env, body.workspaceId, session.userId)) {
    return errorResponse('Enter a valid list name and workspace.', 400, origin)
  }
  const id = crypto.randomUUID()
  const createdAt = Date.now()
  try {
    await env.DB.prepare('INSERT INTO lead_lists (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, body.workspaceId, body.name.trim(), createdAt).run()
  } catch {
    return errorResponse('A list with this name already exists.', 409, origin)
  }
  return jsonResponse({ id, name: body.name.trim(), created_at: createdAt, lead_count: 0 }, origin, 201)
}

async function listCampaigns(env, url, session, origin) {
  const workspaceId = url.searchParams.get('workspaceId')
  if (!await ownsWorkspace(env, workspaceId, session.userId)) return errorResponse('Workspace not found.', 404, origin)
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, 100)
  const status = url.searchParams.get('status') ?? ''
  const validStatuses = new Set(['draft', 'active', 'paused', 'done', 'scheduled', 'archived'])
  if (status && !validStatuses.has(status)) return errorResponse('Choose a valid campaign status.', 400, origin)
  const sort = url.searchParams.get('sort') ?? 'created_desc'
  const orderBy = sort === 'created_asc'
    ? 'c.created_at ASC'
    : sort === 'name_asc'
      ? 'c.name ASC'
      : sort === 'name_desc'
        ? 'c.name DESC'
        : 'c.created_at DESC'
  const rows = await env.DB.prepare(
    `SELECT id, name, sender_id, lead_list_id, status, scheduled_at, created_at FROM campaigns c
     WHERE workspace_id = ?
       AND (? = '' OR c.name LIKE ? ESCAPE '\\')
       AND (? = '' OR c.status = ?)
     ORDER BY ${orderBy}`,
  ).bind(workspaceId, query, `%${escapeLike(query)}%`, status, status).all()
  return jsonResponse(rows.results ?? [], origin)
}

async function createCampaign(request, env, session, origin) {
  const body = await readJson(request)
  if (!isObject(body) || !safeText(body.name, 120) || !await ownsWorkspace(env, body.workspaceId, session.userId)) {
    return errorResponse('Enter a valid campaign and workspace.', 400, origin)
  }
  const list = await env.DB.prepare(
    'SELECT id FROM lead_lists WHERE id = ? AND workspace_id = ?',
  ).bind(body.leadListId, body.workspaceId).first()
  if (!list) return errorResponse('Choose a lead list in this workspace.', 400, origin)
  if (body.senderId) {
    const sender = await env.DB.prepare(
      'SELECT id FROM senders WHERE id = ? AND workspace_id = ?',
    ).bind(body.senderId, body.workspaceId).first()
    if (!sender) return errorResponse('Sender not found.', 404, origin)
  }
  const id = crypto.randomUUID()
  const createdAt = Date.now()
  await env.DB.prepare(
    'INSERT INTO campaigns (id, workspace_id, name, sender_id, lead_list_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, body.workspaceId, body.name.trim(), body.senderId ?? null, body.leadListId, 'draft', createdAt).run()
  await logActivity(env, body.workspaceId, 'campaign_created', `Campaign "${body.name.trim()}" was created as a draft.`)
  return jsonResponse({ id, name: body.name.trim(), sender_id: body.senderId ?? null, lead_list_id: body.leadListId, status: 'draft', created_at: createdAt }, origin, 201)
}

async function getCampaign(env, campaignId, url, session, origin) {
  const workspaceId = url.searchParams.get('workspaceId')
  const campaign = await env.DB.prepare(
    `SELECT c.id, c.workspace_id, c.name, c.sender_id, c.lead_list_id, c.status, c.scheduled_at, c.created_at
     FROM campaigns c JOIN workspaces w ON w.id = c.workspace_id
     WHERE c.id = ? AND w.owner_user_id = ? AND (? IS NULL OR c.workspace_id = ?)`,
  ).bind(campaignId, session.userId, workspaceId, workspaceId).first()
  if (!campaign) return errorResponse('Campaign not found.', 404, origin)
  const steps = await env.DB.prepare(
    'SELECT id, step_no, delay_days, subject, body_template, created_at FROM sequences WHERE campaign_id = ? ORDER BY step_no',
  ).bind(campaignId).all()
  return jsonResponse({ ...campaign, sequence: steps.results ?? [] }, origin)
}

async function updateCampaign(request, env, campaignId, session, origin) {
  const body = await readJson(request)
  if (!isObject(body) || !safeText(body.name, 120) || !['draft', 'paused'].includes(body.status ?? 'draft')) {
    return errorResponse('Enter valid campaign details.', 400, origin)
  }
  const result = await env.DB.prepare(
    `UPDATE campaigns SET name = ?, status = ?, scheduled_at = CASE WHEN ? = 'draft' THEN NULL ELSE scheduled_at END
     WHERE id = ? AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
     RETURNING id, name, sender_id, status, created_at`,
  ).bind(body.name.trim(), body.status ?? 'draft', body.status ?? 'draft', campaignId, session.userId).first()
  if (!result) return errorResponse('Campaign not found.', 404, origin)
  return jsonResponse(result, origin)
}

async function campaignActionResponse(request, env, campaignId, action, session, origin) {
  const campaign = await env.DB.prepare(
    `SELECT c.id, c.workspace_id, c.name, c.sender_id, c.lead_list_id, c.status, s.type AS sender_type
     FROM campaigns c JOIN workspaces w ON w.id = c.workspace_id
     LEFT JOIN senders s ON s.id = c.sender_id AND s.workspace_id = c.workspace_id
     WHERE c.id = ? AND w.owner_user_id = ?`,
  ).bind(campaignId, session.userId).first()
  if (!campaign) return errorResponse('Campaign not found.', 404, origin)
  if (action === 'pause') {
    await env.DB.prepare('UPDATE campaigns SET status = ? WHERE id = ?').bind('paused', campaignId).run()
    await logActivity(env, campaign.workspace_id, 'campaign_paused', `Campaign "${campaign.name ?? 'Untitled'}" was paused.`)
    return jsonResponse({ id: campaignId, status: 'paused' }, origin)
  }
  if (campaign.status !== 'draft') return errorResponse('Only a draft campaign can be launched.', 409, origin)
  if (!campaign.sender_id) return errorResponse('Choose a sender before launching.', 409, origin)
  if (!['gmail_oauth', 'outlook_oauth'].includes(campaign.sender_type)) {
    return errorResponse('Connect a reply-monitored Gmail or Microsoft mailbox before launching.', 409, origin)
  }
  const confirmation = await readJson(request)
  if (!isObject(confirmation) || confirmation.confirmAuthorizedRecipients !== true) {
    return errorResponse('Confirm that every selected recipient is authorised to receive this campaign.', 400, origin)
  }
  const steps = await env.DB.prepare(
    'SELECT step_no FROM sequences WHERE campaign_id = ? ORDER BY step_no',
  ).bind(campaignId).all()
  if (!steps.results?.length || Number(steps.results[0].step_no) !== 1) return errorResponse('Add a first sequence step before launching.', 409, origin)
  const leads = await campaignEligibleLeads(env, campaign)
  if (!leads.length) return errorResponse('No eligible leads are available in this list.', 409, origin)
  const now = Date.now()
  await queueCampaignSends(env, campaign, now)
  await env.DB.prepare('UPDATE campaigns SET status = ? WHERE id = ? AND status = ?').bind('active', campaignId, 'draft').run()
  await logActivity(env, campaign.workspace_id, 'campaign_launched', `Campaign "${campaign.name ?? 'Untitled'}" launched to ${leads.length} recipients.`)
  return jsonResponse({ id: campaignId, status: 'active', queued: leads.length }, origin)
}

async function listLeads(env, url, session, origin) {
  const workspaceId = url.searchParams.get('workspaceId')
  if (!await ownsWorkspace(env, workspaceId, session.userId)) return errorResponse('Workspace not found.', 404, origin)
  const listId = url.searchParams.get('listId')
  if (listId) {
    const list = await env.DB.prepare('SELECT id FROM lead_lists WHERE id = ? AND workspace_id = ?')
      .bind(listId, workspaceId).first()
    if (!list) return errorResponse('Lead list not found.', 404, origin)
  }
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, 100)
  const status = url.searchParams.get('status') ?? ''
  if (status && !VALID_LEAD_STATUSES.has(status)) return errorResponse('Choose a valid lead status.', 400, origin)
  const sort = url.searchParams.get('sort') ?? 'created_desc'
  const orderBy = sort === 'created_asc'
    ? 'l.created_at ASC'
    : sort === 'email_asc'
      ? 'l.email ASC'
      : sort === 'email_desc'
        ? 'l.email DESC'
        : 'l.created_at DESC'
  const rows = await env.DB.prepare(
    `SELECT l.id, l.email, l.first_name, l.company, l.status, l.created_at
     FROM leads l WHERE l.workspace_id = ?
       AND (? IS NULL OR EXISTS (SELECT 1 FROM lead_list_members m WHERE m.lead_id = l.id AND m.list_id = ?))
       AND (? = '' OR l.status = ?)
       AND (? = '' OR l.email LIKE ? ESCAPE '\\' OR l.first_name LIKE ? ESCAPE '\\' OR l.company LIKE ? ESCAPE '\\')
     ORDER BY ${orderBy} LIMIT 1000`,
  ).bind(
    workspaceId, listId, listId, status, status,
    query, `%${escapeLike(query)}%`, `%${escapeLike(query)}%`, `%${escapeLike(query)}%`,
  ).all()
  return jsonResponse(rows.results ?? [], origin)
}

async function createLead(request, env, session, origin) {
  const body = await readJson(request)
  if (!isObject(body) || !await ownsWorkspace(env, body.workspaceId, session.userId) || !isValidEmail(body.email)) {
    return errorResponse('Enter a valid email address and workspace.', 400, origin)
  }
  const list = await env.DB.prepare('SELECT id FROM lead_lists WHERE id = ? AND workspace_id = ?')
    .bind(body.listId, body.workspaceId).first()
  if (!list) return errorResponse('Choose a lead list in this workspace.', 400, origin)
  const email = normalizeEmail(body.email)
  const suppressed = await env.DB.prepare(
    'SELECT id FROM suppressions WHERE workspace_id = ? AND email = ?',
  ).bind(body.workspaceId, email).first()
  if (suppressed) return errorResponse('This address is suppressed and cannot be added.', 409, origin)
  const lead = {
    id: crypto.randomUUID(),
    workspace_id: body.workspaceId,
    email,
    first_name: typeof body.firstName === 'string' ? body.firstName.trim().slice(0, 100) : null,
    company: typeof body.company === 'string' ? body.company.trim().slice(0, 150) : null,
    status: 'new',
    created_at: Date.now(),
  }
  try {
    const existing = await env.DB.prepare(
      'SELECT id FROM leads WHERE workspace_id = ? AND email = ?',
    ).bind(lead.workspace_id, lead.email).first()
    if (existing) {
      await env.DB.prepare('INSERT OR IGNORE INTO lead_list_members (list_id, lead_id, created_at) VALUES (?, ?, ?)')
        .bind(body.listId, existing.id, Date.now()).run()
      return jsonResponse({ ...lead, id: existing.id }, origin, 200)
    }
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO leads (id, workspace_id, email, first_name, company, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(lead.id, lead.workspace_id, lead.email, lead.first_name, lead.company, lead.status, lead.created_at),
      env.DB.prepare('INSERT INTO lead_list_members (list_id, lead_id, created_at) VALUES (?, ?, ?)')
        .bind(body.listId, lead.id, lead.created_at),
    ])
  } catch {
    return errorResponse('This address already exists in the workspace.', 409, origin)
  }
  return jsonResponse(lead, origin, 201)
}

async function updateLead(request, env, leadId, session, origin) {
  const body = await readJson(request)
  if (!isObject(body) || !VALID_LEAD_STATUSES.has(body.status)) return errorResponse('Choose a valid lead status.', 400, origin)
  const lead = await env.DB.prepare(
    `UPDATE leads SET status = ?
     WHERE id = ? AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
     RETURNING id, workspace_id, email, first_name, company, status, created_at`,
  ).bind(body.status, leadId, session.userId).first()
  if (!lead) return errorResponse('Lead not found.', 404, origin)
  if (body.status === 'unsubscribed' || body.status === 'bounced') {
    await env.DB.prepare(
      `INSERT INTO suppressions (id, workspace_id, email, reason, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, email) DO UPDATE SET reason = excluded.reason`,
    ).bind(crypto.randomUUID(), lead.workspace_id, lead.email, body.status, Date.now()).run()
  }
  return jsonResponse(lead, origin)
}

async function importLeads(request, env, session, origin) {
  const body = await readJson(request)
  if (
    !isObject(body) ||
    !safeText(body.workspaceId, 100) ||
    !safeText(body.listId, 100) ||
    !safeText(body.filename, 255) ||
    !Number.isInteger(body.sizeBytes) ||
    body.sizeBytes < 1 ||
    body.sizeBytes > MAX_CSV_BYTES ||
    !String(body.filename).toLowerCase().endsWith('.csv') ||
    !await ownsWorkspace(env, body.workspaceId, session.userId)
  ) return errorResponse('Choose a valid workspace and CSV file.', 400, origin)
  const list = await env.DB.prepare('SELECT id FROM lead_lists WHERE id = ? AND workspace_id = ?')
    .bind(body.listId, body.workspaceId).first()
  if (!list) return errorResponse('Choose a lead list in this workspace.', 400, origin)
  const allowedTypes = new Set(['text/csv', 'application/csv', 'application/vnd.ms-excel', 'application/octet-stream'])
  const contentType = typeof body.contentType === 'string' ? body.contentType.toLowerCase() : ''
  if (!allowedTypes.has(contentType)) return errorResponse('Choose a valid CSV file.', 415, origin)
  return createUploadIntent(env, {
    workspaceId: body.workspaceId,
    listId: body.listId,
    kind: 'csv_import',
    filename: body.filename,
    sizeBytes: body.sizeBytes,
    contentType,
  }, session.userId, origin)
}

async function createUploadIntent(env, input, userId, origin) {
  const maxBytes = input.kind === 'csv_import' ? MAX_CSV_BYTES : 10485760
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > maxBytes) {
    return errorResponse(input.kind === 'csv_import' ? 'CSV file must be smaller than 5 MB.' : 'File must be smaller than 10 MB.', 413, origin)
  }
  const id = crypto.randomUUID()
  const key = `uploads/${id}`
  const now = Date.now()
  const expiresAt = now + 10 * 60 * 1000
  await env.DB.prepare(
    `INSERT INTO upload_intents
      (id, workspace_id, list_id, kind, r2_key, filename, size_bytes, content_type, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, input.workspaceId, input.listId ?? null, input.kind, key, input.filename, input.sizeBytes, input.contentType, expiresAt, now).run()
  try {
    const uploadUrl = await createR2PresignedPutUrl(env, key, input.contentType)
    return jsonResponse({
      uploadId: id,
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      expiresAt,
    }, origin, 201)
  } catch (error) {
    await env.DB.prepare('DELETE FROM upload_intents WHERE id = ? AND completed_at IS NULL').bind(id).run()
    throw error
  }
}

async function createR2PresignedPutUrl(env, key, contentType) {
  const accountId = env.R2_ACCOUNT_ID
  const accessKeyId = env.R2_ACCESS_KEY_ID
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY
  const bucketName = env.R2_BUCKET_NAME
  if (
    typeof accountId !== 'string' || !/^[a-f0-9]{32}$/i.test(accountId) ||
    !safeText(accessKeyId, 128) || !safeText(secretAccessKey, 256) ||
    !safeText(bucketName, 63) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketName)
  ) throw new Error('configuration')

  const region = 'auto'
  const service = 's3'
  const host = `${accountId}.r2.cloudflarestorage.com`
  const date = new Date()
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const uriEncode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  const canonicalUri = `/${uriEncode(bucketName)}/${key.split('/').map(uriEncode).join('/')}`
  const parameters = new Map([
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', '300'],
    ['X-Amz-SignedHeaders', 'content-type;host'],
  ])
  const canonicalQuery = [...parameters.entries()]
    .map(([name, value]) => [uriEncode(name), uriEncode(value)])
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`)
    .join('&')
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQuery,
    `content-type:${contentType}\nhost:${host}\n`,
    'content-type;host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    [...await sha256(canonicalRequest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  ].join('\n')
  const hmac = async (keyBytes, value) => new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    new TextEncoder().encode(value),
  ))
  const dateKey = await hmac(new TextEncoder().encode(`AWS4${secretAccessKey}`), dateStamp)
  const regionKey = await hmac(dateKey, region)
  const serviceKey = await hmac(regionKey, service)
  const signingKey = await hmac(serviceKey, 'aws4_request')
  const signature = [...await hmac(signingKey, stringToSign)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

async function countImportOverlap(env, workspaceId, emails) {
  if (!emails.length) return { duplicates: 0, suppressed: 0 }
  const placeholders = emails.map(() => '?').join(',')
  const [existingRows, suppressedRows] = await Promise.all([
    env.DB.prepare(`SELECT email FROM leads WHERE workspace_id = ? AND email IN (${placeholders})`)
      .bind(workspaceId, ...emails).all(),
    env.DB.prepare(`SELECT email FROM suppressions WHERE workspace_id = ? AND email IN (${placeholders})`)
      .bind(workspaceId, ...emails).all(),
  ])
  const existingEmails = new Set((existingRows.results ?? []).map((row) => row.email))
  const suppressedEmails = new Set((suppressedRows.results ?? []).map((row) => row.email))
  let suppressed = 0
  for (const email of suppressedEmails) {
    if (!existingEmails.has(email)) suppressed += 1
  }
  return { duplicates: existingEmails.size, suppressed }
}

async function completeUpload(env, uploadId, session, origin, expectedKind) {
  const intent = await env.DB.prepare(
    `SELECT i.id, i.workspace_id, i.list_id, i.kind, i.r2_key, i.filename, i.size_bytes,
            i.content_type, i.expires_at, i.completed_at, i.result_json
     FROM upload_intents i JOIN workspaces w ON w.id = i.workspace_id
     WHERE i.id = ? AND w.owner_user_id = ?`,
  ).bind(uploadId, session.userId).first()
  if (!intent || intent.kind !== expectedKind) return errorResponse('Upload not found.', 404, origin)
  if (intent.completed_at && intent.result_json) return jsonResponse(JSON.parse(intent.result_json), origin)
  if (intent.expires_at < Date.now()) return errorResponse('Upload has expired. Please start again.', 410, origin)

  const object = await env.FILES.get(intent.r2_key)
  if (!object) return errorResponse('Uploaded file was not found. Please upload it again.', 400, origin)
  if (object.size !== intent.size_bytes || object.size < 1) {
    await env.FILES.delete(intent.r2_key)
    return errorResponse('Uploaded file size does not match the requested size.', 400, origin)
  }
  const metadataType = object.httpMetadata?.contentType
  if (metadataType && metadataType.toLowerCase() !== intent.content_type.toLowerCase()) {
    await env.FILES.delete(intent.r2_key)
    return errorResponse('Uploaded file type does not match the requested type.', 415, origin)
  }
  const objectBytes = new Uint8Array(await object.arrayBuffer())

  let result
  let finalKey
  let csvLeads
  if (intent.kind === 'csv_import') {
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(objectBytes)
    } catch {
      await env.FILES.delete(intent.r2_key)
      return errorResponse('CSV file must use valid UTF-8.', 400, origin)
    }
    try {
      csvLeads = await parseCsv(text)
    } catch {
      await env.FILES.delete(intent.r2_key)
      return errorResponse('CSV format is invalid or too large.', 400, origin)
    }
    finalKey = `${intent.workspace_id}/csv/${intent.id}.csv`
    result = { fileId: intent.id, accepted: 0, parsed: csvLeads.length, duplicates: 0, suppressed: 0 }
  } else {
    const permitted = new Map([
      ['application/pdf', { extension: '.pdf', prefix: [0x25, 0x50, 0x44, 0x46, 0x2d] }],
      ['image/png', { extension: '.png', prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
      ['image/jpeg', { extension: '.jpg', prefix: [0xff, 0xd8, 0xff] }],
    ])
    const type = permitted.get(intent.content_type.toLowerCase())
    const filename = intent.filename.replace(/[\u0000-\u001f\u007f]/g, '_').slice(0, 255)
    if (!type || !filename.toLowerCase().endsWith(type.extension)) {
      await env.FILES.delete(intent.r2_key)
      return errorResponse('Only PDF, PNG, and JPEG attachments are accepted.', 415, origin)
    }
    const prefix = objectBytes.subarray(0, type.prefix.length)
    if (!type.prefix.every((byte, index) => prefix[index] === byte)) {
      await env.FILES.delete(intent.r2_key)
      return errorResponse('Attachment content does not match its file type.', 415, origin)
    }
    finalKey = `${intent.workspace_id}/attachments/${intent.id}${type.extension}`
    result = { id: intent.id, filename, sizeBytes: object.size }
  }

  await env.FILES.put(finalKey, objectBytes, {
    httpMetadata: { contentType: intent.content_type },
  })
  try {
    if (csvLeads) {
      for (let offset = 0; offset < csvLeads.length; offset += 100) {
        const chunk = csvLeads.slice(offset, offset + 100)
        const createdAt = Date.now()
        const overlap = await countImportOverlap(env, intent.workspace_id, chunk.map((lead) => lead.email))
        result.duplicates += overlap.duplicates
        result.suppressed += overlap.suppressed
        const leadValues = []
        const memberValues = []
        for (const lead of chunk) {
          leadValues.push(
            crypto.randomUUID(),
            intent.workspace_id,
            lead.email,
            lead.firstName || null,
            lead.company || null,
            'new',
            createdAt,
          )
          memberValues.push(intent.list_id, intent.workspace_id, lead.email, createdAt)
        }
        const leadRows = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')
        const memberRows = chunk.map(() => '(?, ?, ?, ?)').join(', ')
        const outcomes = await env.DB.batch([
          env.DB.prepare(
            `WITH incoming(id, workspace_id, email, first_name, company, status, created_at) AS (VALUES ${leadRows})
             INSERT OR IGNORE INTO leads (id, workspace_id, email, first_name, company, status, created_at)
             SELECT id, workspace_id, email, first_name, company, status, created_at FROM incoming
             WHERE NOT EXISTS (
               SELECT 1 FROM suppressions s
               WHERE s.workspace_id = incoming.workspace_id AND s.email = incoming.email
             )`,
          ).bind(...leadValues),
          env.DB.prepare(
            `WITH incoming(list_id, workspace_id, email, created_at) AS (VALUES ${memberRows})
             INSERT OR IGNORE INTO lead_list_members (list_id, lead_id, created_at)
             SELECT incoming.list_id, leads.id, incoming.created_at
             FROM incoming JOIN leads
               ON leads.workspace_id = incoming.workspace_id AND leads.email = incoming.email
             WHERE NOT EXISTS (
               SELECT 1 FROM suppressions s
               WHERE s.workspace_id = incoming.workspace_id AND s.email = incoming.email
             )`,
          ).bind(...memberValues),
        ])
        result.accepted += outcomes[0]?.meta?.changes ?? 0
      }
    }
    await env.DB.batch([
      env.DB.prepare(
        'INSERT OR IGNORE INTO files (id, workspace_id, kind, r2_key, filename, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(intent.id, intent.workspace_id, intent.kind, finalKey, intent.filename.slice(0, 255), object.size, Date.now()),
      env.DB.prepare(
        'UPDATE upload_intents SET completed_at = ?, result_json = ? WHERE id = ? AND completed_at IS NULL',
      ).bind(Date.now(), JSON.stringify(result), intent.id),
    ])
    if (intent.kind === 'csv_import') {
      await logActivity(env, intent.workspace_id, 'leads_imported', `${result.accepted} contacts imported from ${intent.filename} (${result.duplicates} duplicates skipped, ${result.suppressed} suppressed skipped).`)
    }
  } catch (error) {
    await env.FILES.delete(finalKey)
    throw error
  }
  await env.FILES.delete(intent.r2_key)
  return jsonResponse(result, origin, expectedKind === 'csv_import' ? 200 : 201)
}

async function cleanupExpiredUploads(env) {
  const expired = await env.DB.prepare(
    'SELECT id, r2_key FROM upload_intents WHERE expires_at < ? ORDER BY expires_at LIMIT 25',
  ).bind(Date.now()).all()
  for (const upload of expired.results ?? []) {
    await env.FILES.delete(upload.r2_key)
    await env.DB.prepare('DELETE FROM upload_intents WHERE id = ? AND expires_at < ?')
      .bind(upload.id, Date.now()).run()
  }
}

async function listSequences(env, url, session, origin) {
  const workspaceId = url.searchParams.get('workspaceId')
  if (!await ownsWorkspace(env, workspaceId, session.userId)) return errorResponse('Workspace not found.', 404, origin)
  const rows = await env.DB.prepare(
    `SELECT s.id, s.campaign_id, s.step_no, s.delay_days, s.subject, s.body_template, s.created_at
     FROM sequences s JOIN campaigns c ON c.id = s.campaign_id
     WHERE c.workspace_id = ? ORDER BY c.created_at DESC, s.step_no`,
  ).bind(workspaceId).all()
  return jsonResponse(rows.results ?? [], origin)
}

async function createSequence(request, env, session, origin) {
  const body = await readJson(request)
  if (
    !isObject(body) ||
    !safeText(body.campaignId, 100) ||
    !Number.isInteger(body.stepNo) || body.stepNo < 1 || body.stepNo > 50 ||
    !Number.isInteger(body.delayDays) || body.delayDays < 0 || body.delayDays > 365 ||
    !safeText(body.subject, 200) || /[\r\n]/.test(body.subject) ||
    !safeText(body.bodyTemplate, 10000)
  ) return errorResponse('Enter valid sequence step details.', 400, origin)
  const campaign = await env.DB.prepare(
    `SELECT c.id FROM campaigns c JOIN workspaces w ON w.id = c.workspace_id
     WHERE c.id = ? AND w.owner_user_id = ? AND c.status = 'draft'`,
  ).bind(body.campaignId, session.userId).first()
  if (!campaign) return errorResponse('Campaign not found or cannot be edited.', 404, origin)
  const id = crypto.randomUUID()
  await env.DB.prepare(
    'INSERT INTO sequences (id, campaign_id, step_no, delay_days, subject, body_template, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, body.campaignId, body.stepNo, body.delayDays, body.subject.trim(), body.bodyTemplate, Date.now()).run()
  return jsonResponse({ id, campaign_id: body.campaignId, step_no: body.stepNo, delay_days: body.delayDays }, origin, 201)
}

async function updateSequence(request, env, sequenceId, session, origin) {
  const body = await readJson(request)
  if (!isObject(body) || !safeText(body.subject, 200) || /[\r\n]/.test(body.subject) || !safeText(body.bodyTemplate, 10000) || !Number.isInteger(body.delayDays) || body.delayDays < 0 || body.delayDays > 365) {
    return errorResponse('Enter valid sequence step details.', 400, origin)
  }
  const row = await env.DB.prepare(
    `UPDATE sequences SET subject = ?, body_template = ?, delay_days = ?
     WHERE id = ? AND campaign_id IN (
       SELECT c.id FROM campaigns c JOIN workspaces w ON w.id = c.workspace_id
       WHERE w.owner_user_id = ? AND c.status = 'draft'
     ) RETURNING id, campaign_id, step_no, delay_days, subject, body_template`,
  ).bind(body.subject.trim(), body.bodyTemplate, body.delayDays, sequenceId, session.userId).first()
  if (!row) return errorResponse('Sequence step not found or cannot be edited.', 404, origin)
  return jsonResponse(row, origin)
}

async function listBranches(env, url, session, origin) {
  const workspaceId = url.searchParams.get('workspaceId')
  if (!await ownsWorkspace(env, workspaceId, session.userId)) return errorResponse('Workspace not found.', 404, origin)
  const rows = await env.DB.prepare(
    `SELECT b.id, b.sequence_id, b.condition, b.condition_value, b.action, b.action_value, b.created_at
     FROM branches b JOIN sequences s ON s.id = b.sequence_id
     JOIN campaigns c ON c.id = s.campaign_id WHERE c.workspace_id = ?`,
  ).bind(workspaceId).all()
  return jsonResponse(rows.results ?? [], origin)
}

async function createBranch(request, env, session, origin) {
  const body = await readJson(request)
  if (
    !isObject(body) ||
    !safeText(body.sequenceId, 100) ||
    !['no_reply_after_days', 'replied'].includes(body.condition) ||
    !['send_followup', 'change_status', 'notify', 'stop'].includes(body.action)
  ) return errorResponse('Enter valid branching rule details.', 400, origin)
  if (body.condition === 'no_reply_after_days' && (!Number.isInteger(body.conditionValue) || body.conditionValue < 1 || body.conditionValue > 365)) {
    return errorResponse('Enter a valid no-reply delay.', 400, origin)
  }
  if (body.action === 'change_status' && !VALID_LEAD_STATUSES.has(body.actionValue)) return errorResponse('Choose a valid lead status.', 400, origin)
  if (body.action === 'send_followup' && body.actionValue !== undefined && body.actionValue !== null && (!/^\d{1,2}$/.test(String(body.actionValue)) || Number(body.actionValue) < 1 || Number(body.actionValue) > 50)) {
    return errorResponse('Choose a valid follow-up step.', 400, origin)
  }
  const step = await env.DB.prepare(
    `SELECT s.id FROM sequences s JOIN campaigns c ON c.id = s.campaign_id
     JOIN workspaces w ON w.id = c.workspace_id WHERE s.id = ? AND w.owner_user_id = ?`,
  ).bind(body.sequenceId, session.userId).first()
  if (!step) return errorResponse('Sequence step not found.', 404, origin)
  const id = crypto.randomUUID()
  await env.DB.prepare(
    'INSERT INTO branches (id, sequence_id, condition, condition_value, action, action_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, body.sequenceId, body.condition, body.conditionValue ?? null, body.action, body.actionValue ?? null, Date.now()).run()
  return jsonResponse({ id, sequence_id: body.sequenceId }, origin, 201)
}

async function listSenders(env, url, session, origin) {
  const workspaceId = url.searchParams.get('workspaceId')
  if (!await ownsWorkspace(env, workspaceId, session.userId)) return errorResponse('Workspace not found.', 404, origin)
  const rows = await env.DB.prepare(
    'SELECT id, workspace_id, type, address, display_name, is_default, created_at FROM senders WHERE workspace_id = ? ORDER BY created_at',
  ).bind(workspaceId).all()
  return jsonResponse(rows.results ?? [], origin)
}

async function createBrevoSender(request, env, session, origin) {
  const body = await readJson(request)
  if (!isObject(body) || !await ownsWorkspace(env, body.workspaceId, session.userId)) return errorResponse('Workspace not found.', 404, origin)
  const existing = await env.DB.prepare(
    `SELECT id, workspace_id, type, address, display_name, is_default, created_at
     FROM senders WHERE workspace_id = ? AND type = 'brevo_default'`,
  ).bind(body.workspaceId).first()
  if (existing) {
    await env.DB.batch([
      env.DB.prepare('UPDATE senders SET is_default = 0 WHERE workspace_id = ?').bind(body.workspaceId),
      env.DB.prepare('UPDATE senders SET is_default = 1 WHERE id = ? AND workspace_id = ?').bind(existing.id, body.workspaceId),
    ])
    return jsonResponse({ ...existing, is_default: 1 }, origin)
  }
  const id = crypto.randomUUID()
  const createdAt = Date.now()
  await env.DB.batch([
    env.DB.prepare('UPDATE senders SET is_default = 0 WHERE workspace_id = ?').bind(body.workspaceId),
    env.DB.prepare(
      'INSERT INTO senders (id, workspace_id, type, address, display_name, is_default, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    ).bind(id, body.workspaceId, 'brevo_default', 'hello@kluzar.com', 'Kluzar', createdAt),
  ])
  return jsonResponse({ id, workspace_id: body.workspaceId, type: 'brevo_default', address: 'hello@kluzar.com', display_name: 'Kluzar', is_default: 1, created_at: createdAt }, origin, 201)
}

async function listInbox(env, url, session, origin) {
  const workspaceId = url.searchParams.get('workspaceId')
  if (!await ownsWorkspace(env, workspaceId, session.userId)) return errorResponse('Workspace not found.', 404, origin)
  const campaignId = url.searchParams.get('campaignId')
  if (campaignId) {
    const campaign = await env.DB.prepare('SELECT id FROM campaigns WHERE id = ? AND workspace_id = ?')
      .bind(campaignId, workspaceId).first()
    if (!campaign) return errorResponse('Campaign not found.', 404, origin)
  }
  const read = url.searchParams.get('read') ?? ''
  if (read && !['read', 'unread'].includes(read)) return errorResponse('Choose a valid read filter.', 400, origin)
  const rows = await env.DB.prepare(
    `SELECT r.id, r.sender_email, r.subject, r.body_text, r.received_at, r.read_at, s.campaign_id, s.lead_id, l.email AS lead_email, l.first_name
     FROM replies r JOIN sends s ON s.id = r.send_id JOIN leads l ON l.id = s.lead_id
     JOIN campaigns c ON c.id = s.campaign_id WHERE c.workspace_id = ?
       AND (? IS NULL OR s.campaign_id = ?)
       AND (? = '' OR (? = 'read' AND r.read_at IS NOT NULL) OR (? = 'unread' AND r.read_at IS NULL))
     ORDER BY r.received_at DESC LIMIT 200`,
  ).bind(workspaceId, campaignId, campaignId, read, read, read).all()
  return jsonResponse(rows.results ?? [], origin)
}

async function replyToInbox(request, env, replyId, session, origin) {
  const body = await readJson(request)
  if (!isObject(body) || !safeText(body.body, 10000) || !safeText(body.workspaceId, 100)) {
    return errorResponse('Enter a reply message.', 400, origin)
  }
  if (!await ownsWorkspace(env, body.workspaceId, session.userId)) return errorResponse('Workspace not found.', 404, origin)
  const reply = await env.DB.prepare(
    `SELECT r.id, r.subject, s.campaign_id, s.lead_id, s.provider_message_id, s.provider_thread_id,
            l.email AS lead_email, l.status AS lead_status, c.workspace_id, c.sender_id,
            d.type AS sender_type, d.address AS sender_address, d.display_name AS sender_name,
            d.credentials_ref, d.credentials_expires_at
     FROM replies r JOIN sends s ON s.id = r.send_id JOIN leads l ON l.id = s.lead_id
     JOIN campaigns c ON c.id = s.campaign_id JOIN senders d ON d.id = c.sender_id
     WHERE r.id = ? AND c.workspace_id = ?`,
  ).bind(replyId, body.workspaceId).first()
  if (!reply) return errorResponse('Reply not found.', 404, origin)
  if (!['gmail_oauth', 'outlook_oauth'].includes(reply.sender_type)) {
    return errorResponse('Connect a reply-monitored mailbox before replying.', 409, origin)
  }
  if (['unsubscribed', 'bounced'].includes(reply.lead_status)) {
    return errorResponse('This lead can no longer be contacted.', 409, origin)
  }
  const suppressed = await env.DB.prepare('SELECT id FROM suppressions WHERE workspace_id = ? AND email = ?')
    .bind(body.workspaceId, reply.lead_email).first()
  if (suppressed) return errorResponse('This address is suppressed and cannot be contacted.', 409, origin)
  const now = Date.now()
  if (await dailySendCount(env, body.workspaceId, now) >= DAILY_SEND_LIMIT) {
    return errorResponse('The daily sending limit for this workspace has been reached.', 429, origin)
  }
  const sender = {
    id: reply.sender_id,
    type: reply.sender_type,
    address: reply.sender_address,
    display_name: reply.sender_name,
    credentials_ref: reply.credentials_ref,
    credentials_expires_at: reply.credentials_expires_at,
  }
  const credentials = await refreshSender(env, sender)
  if (!credentials) return errorResponse('Mailbox connection could not be refreshed. Please reconnect it.', 502, origin)
  const subject = typeof reply.subject === 'string' && reply.subject.toLowerCase().startsWith('re: ')
    ? reply.subject.slice(0, 500)
    : `Re: ${(reply.subject || 'your message').slice(0, 495)}`
  const message = {
    email: reply.lead_email,
    subject,
    text: body.body.trim(),
    unsubscribeToken: null,
    threadId: reply.provider_thread_id ?? null,
    originalMessageId: reply.provider_message_id ?? null,
  }
  let providerResult = null
  if (sender.type === 'gmail_oauth') {
    providerResult = await sendGmail(env, sender, credentials, message)
  } else if (message.originalMessageId) {
    providerResult = await sendMicrosoftReply(sender, credentials, message)
  } else {
    providerResult = await sendMicrosoft(sender, credentials, message)
  }
  if (!providerResult) return errorResponse('Reply could not be sent. Please try again later.', 502, origin)
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO inbox_replies (id, reply_id, workspace_id, sender_id, subject, body_text, provider_message_id, sent_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), reply.id, body.workspaceId, sender.id, subject, body.body.trim(), providerResult.messageId, now, now),
    env.DB.prepare('UPDATE replies SET read_at = ? WHERE id = ?').bind(now, reply.id),
  ])
  await logActivity(env, body.workspaceId, 'reply_sent', `You replied to ${reply.lead_email}.`)
  return jsonResponse({ sent: true, messageId: providerResult.messageId }, origin, 202)
}

async function markInboxRead(request, env, replyId, session, origin) {
  const body = await readJson(request)
  if (!isObject(body) || typeof body.read !== 'boolean') return errorResponse('Choose whether the reply is read or unread.', 400, origin)
  const now = Date.now()
  const row = await env.DB.prepare(
    `UPDATE replies SET read_at = ?
     WHERE id = ? AND send_id IN (
       SELECT s.id FROM sends s JOIN campaigns c ON c.id = s.campaign_id
       JOIN workspaces w ON w.id = c.workspace_id WHERE w.owner_user_id = ?
     ) RETURNING id, read_at`,
  ).bind(body.read ? now : null, replyId, session.userId).first()
  if (!row) return errorResponse('Reply not found.', 404, origin)
  return jsonResponse(row, origin)
}

async function ownedCampaign(env, campaignId, session, workspaceId) {
  return env.DB.prepare(
    `SELECT c.id, c.workspace_id, c.name, c.sender_id, c.lead_list_id, c.status, c.scheduled_at, c.created_at
     FROM campaigns c JOIN workspaces w ON w.id = c.workspace_id
     WHERE c.id = ? AND w.owner_user_id = ? AND (? IS NULL OR c.workspace_id = ?)`,
  ).bind(campaignId, session.userId, workspaceId, workspaceId).first()
}

async function previewCampaign(env, campaignId, url, session, origin) {
  const workspaceId = url.searchParams.get('workspaceId')
  const campaign = await ownedCampaign(env, campaignId, session, workspaceId)
  if (!campaign) return errorResponse('Campaign not found.', 404, origin)
  const steps = await env.DB.prepare(
    'SELECT step_no, delay_days, subject, body_template FROM sequences WHERE campaign_id = ? ORDER BY step_no',
  ).bind(campaignId).all()
  let lead = null
  const leadId = url.searchParams.get('leadId')
  if (leadId) {
    lead = await env.DB.prepare('SELECT id, email, first_name, company FROM leads WHERE id = ? AND workspace_id = ?')
      .bind(leadId, campaign.workspace_id).first()
  }
  if (!lead) {
    lead = await env.DB.prepare(
      `SELECT l.id, l.email, l.first_name, l.company FROM leads l
       JOIN lead_list_members m ON m.lead_id = l.id
       WHERE m.list_id = ? AND l.workspace_id = ? ORDER BY l.created_at LIMIT 1`,
    ).bind(campaign.lead_list_id, campaign.workspace_id).first()
  }
  const data = { first_name: lead?.first_name ?? '', company: lead?.company ?? '' }
  return jsonResponse({
    campaign: { id: campaign.id, name: campaign.name },
    lead: lead ? { id: lead.id, email: lead.email, first_name: lead.first_name, company: lead.company } : null,
    steps: (steps.results ?? []).map((step) => ({
      step_no: step.step_no,
      delay_days: step.delay_days,
      subject: renderTemplate(step.subject, data),
      body: renderTemplate(step.body_template, data),
    })),
  }, origin)
}

async function prelaunchCheck(env, campaignId, url, session, origin) {
  const workspaceId = url.searchParams.get('workspaceId')
  const campaign = await ownedCampaign(env, campaignId, session, workspaceId)
  if (!campaign) return errorResponse('Campaign not found.', 404, origin)
  const sender = campaign.sender_id
    ? await env.DB.prepare('SELECT id, type, address FROM senders WHERE id = ? AND workspace_id = ?')
      .bind(campaign.sender_id, campaign.workspace_id).first()
    : null
  const steps = await env.DB.prepare(
    'SELECT step_no, delay_days, subject, body_template FROM sequences WHERE campaign_id = ? ORDER BY step_no',
  ).bind(campaignId).all()
  const stepRows = steps.results ?? []
  const eligible = await campaignEligibleLeads(env, campaign)
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM lead_list_members WHERE list_id = ?) AS total_in_list,
       (SELECT COUNT(*) FROM leads l JOIN lead_list_members m ON m.lead_id = l.id
        WHERE m.list_id = ? AND l.workspace_id = ? AND l.email IN (SELECT email FROM suppressions WHERE workspace_id = ?)) AS suppressed_in_list,
       (SELECT COUNT(*) FROM leads l JOIN lead_list_members m ON m.lead_id = l.id
        WHERE m.list_id = ? AND l.workspace_id = ? AND l.status IN ('bounced', 'unsubscribed')) AS excluded_in_list,
       (SELECT COUNT(*) FROM leads l JOIN lead_list_members m ON m.lead_id = l.id
        WHERE m.list_id = ? AND l.workspace_id = ? AND l.first_name IS NOT NULL AND TRIM(l.first_name) <> '') AS with_first_name,
       (SELECT COUNT(*) FROM leads l JOIN lead_list_members m ON m.lead_id = l.id
        WHERE m.list_id = ? AND l.workspace_id = ? AND l.company IS NOT NULL AND TRIM(l.company) <> '') AS with_company`,
  ).bind(
    campaign.lead_list_id,
    campaign.lead_list_id, campaign.workspace_id, campaign.workspace_id,
    campaign.lead_list_id, campaign.workspace_id,
    campaign.lead_list_id, campaign.workspace_id,
    campaign.lead_list_id, campaign.workspace_id,
  ).first()
  const templates = stepRows.map((step) => `${step.subject}\n${step.body_template}`).join('\n')
  return jsonResponse({
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status, scheduled_at: campaign.scheduled_at },
    sender: sender ? { id: sender.id, type: sender.type, address: sender.address } : null,
    senderReady: Boolean(sender && ['gmail_oauth', 'outlook_oauth'].includes(sender.type)),
    steps: stepRows.length,
    hasFirstStep: stepRows.length > 0 && Number(stepRows[0].step_no) === 1,
    totalInList: Number(counts?.total_in_list ?? 0),
    readyToSend: eligible.length,
    suppressedInList: Number(counts?.suppressed_in_list ?? 0),
    excludedInList: Number(counts?.excluded_in_list ?? 0),
    variablesUsed: {
      first_name: templates.includes('{{first_name}}'),
      company: templates.includes('{{company}}'),
    },
    fieldsPresent: {
      first_name: Number(counts?.with_first_name ?? 0) > 0,
      company: Number(counts?.with_company ?? 0) > 0,
    },
  }, origin)
}

async function cloneCampaign(env, campaignId, session, origin) {
  const campaign = await ownedCampaign(env, campaignId, session, null)
  if (!campaign) return errorResponse('Campaign not found.', 404, origin)
  const steps = await env.DB.prepare(
    'SELECT id, step_no, delay_days, subject, body_template FROM sequences WHERE campaign_id = ? ORDER BY step_no',
  ).bind(campaignId).all()
  const branches = await env.DB.prepare(
    `SELECT b.id, b.sequence_id, b.condition, b.condition_value, b.action, b.action_value
     FROM branches b JOIN sequences s ON s.id = b.sequence_id WHERE s.campaign_id = ?`,
  ).bind(campaignId).all()
  const newId = crypto.randomUUID()
  const now = Date.now()
  const name = `${campaign.name} (copy)`.slice(0, 120)
  const stepIdMap = new Map()
  const statements = [
    env.DB.prepare(
      'INSERT INTO campaigns (id, workspace_id, name, sender_id, lead_list_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(newId, campaign.workspace_id, name, campaign.sender_id, campaign.lead_list_id, 'draft', now),
  ]
  for (const step of steps.results ?? []) {
    const newStepId = crypto.randomUUID()
    stepIdMap.set(step.id, newStepId)
    statements.push(env.DB.prepare(
      'INSERT INTO sequences (id, campaign_id, step_no, delay_days, subject, body_template, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(newStepId, newId, step.step_no, step.delay_days, step.subject, step.body_template, now))
  }
  for (const branch of branches.results ?? []) {
    const newStepId = stepIdMap.get(branch.sequence_id)
    if (!newStepId) continue
    statements.push(env.DB.prepare(
      'INSERT INTO branches (id, sequence_id, condition, condition_value, action, action_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), newStepId, branch.condition, branch.condition_value, branch.action, branch.action_value, now))
  }
  await env.DB.batch(statements)
  await logActivity(env, campaign.workspace_id, 'campaign_cloned', `Campaign "${campaign.name}" was duplicated as "${name}".`)
  return jsonResponse({ id: newId, name, sender_id: campaign.sender_id, lead_list_id: campaign.lead_list_id, status: 'draft', created_at: now }, origin, 201)
}

async function cloneSequence(env, sequenceId, session, origin) {
  const step = await env.DB.prepare(
    `SELECT s.id, s.campaign_id, s.step_no, s.delay_days, s.subject, s.body_template, c.workspace_id, c.status, c.name AS campaign_name
     FROM sequences s JOIN campaigns c ON c.id = s.campaign_id
     JOIN workspaces w ON w.id = c.workspace_id
     WHERE s.id = ? AND w.owner_user_id = ? AND c.status = 'draft'`,
  ).bind(sequenceId, session.userId).first()
  if (!step) return errorResponse('Sequence step not found or cannot be edited.', 404, origin)
  const maxRow = await env.DB.prepare('SELECT MAX(step_no) AS max_step FROM sequences WHERE campaign_id = ?')
    .bind(step.campaign_id).first()
  const newStepNo = Number(maxRow?.max_step ?? 0) + 1
  if (newStepNo > 50) return errorResponse('This campaign already has the maximum number of steps.', 409, origin)
  const newId = crypto.randomUUID()
  const now = Date.now()
  const branches = await env.DB.prepare(
    'SELECT condition, condition_value, action, action_value FROM branches WHERE sequence_id = ?',
  ).bind(sequenceId).all()
  const statements = [
    env.DB.prepare(
      'INSERT INTO sequences (id, campaign_id, step_no, delay_days, subject, body_template, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(newId, step.campaign_id, newStepNo, step.delay_days, step.subject, step.body_template, now),
  ]
  for (const branch of branches.results ?? []) {
    statements.push(env.DB.prepare(
      'INSERT INTO branches (id, sequence_id, condition, condition_value, action, action_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), newId, branch.condition, branch.condition_value, branch.action, branch.action_value, now))
  }
  await env.DB.batch(statements)
  return jsonResponse({ id: newId, campaign_id: step.campaign_id, step_no: newStepNo, delay_days: step.delay_days, subject: step.subject, body_template: step.body_template }, origin, 201)
}

async function scheduleCampaign(request, env, campaignId, session, origin) {
  const body = await readJson(request)
  const now = Date.now()
  if (
    !isObject(body) ||
    !Number.isInteger(body.scheduledAt) ||
    body.scheduledAt <= now ||
    body.scheduledAt > now + 90 * 86400000
  ) return errorResponse('Choose a launch time within the next 90 days.', 400, origin)
  const campaign = await env.DB.prepare(
    `SELECT c.id, c.workspace_id, c.name, c.sender_id, c.lead_list_id, c.status, s.type AS sender_type
     FROM campaigns c JOIN workspaces w ON w.id = c.workspace_id
     LEFT JOIN senders s ON s.id = c.sender_id AND s.workspace_id = c.workspace_id
     WHERE c.id = ? AND w.owner_user_id = ?`,
  ).bind(campaignId, session.userId).first()
  if (!campaign) return errorResponse('Campaign not found.', 404, origin)
  if (!['draft', 'scheduled'].includes(campaign.status)) return errorResponse('Only a draft campaign can be scheduled.', 409, origin)
  if (!campaign.sender_id || !['gmail_oauth', 'outlook_oauth'].includes(campaign.sender_type)) {
    return errorResponse('Connect a reply-monitored Gmail or Microsoft mailbox before scheduling.', 409, origin)
  }
  if (!isObject(body) || body.confirmAuthorizedRecipients !== true) {
    return errorResponse('Confirm that every selected recipient is authorised to receive this campaign.', 400, origin)
  }
  const steps = await env.DB.prepare(
    'SELECT step_no FROM sequences WHERE campaign_id = ? ORDER BY step_no',
  ).bind(campaignId).all()
  if (!steps.results?.length || Number(steps.results[0].step_no) !== 1) return errorResponse('Add a first sequence step before scheduling.', 409, origin)
  const leads = await campaignEligibleLeads(env, campaign)
  if (!leads.length) return errorResponse('No eligible leads are available in this list.', 409, origin)
  await env.DB.prepare(
    "UPDATE campaigns SET status = 'scheduled', scheduled_at = ? WHERE id = ? AND status IN ('draft', 'scheduled')",
  ).bind(body.scheduledAt, campaignId).run()
  await logActivity(env, campaign.workspace_id, 'campaign_scheduled', `Campaign "${campaign.name}" scheduled for ${new Date(body.scheduledAt).toISOString()}.`)
  return jsonResponse({ id: campaignId, status: 'scheduled', scheduled_at: body.scheduledAt, queued: leads.length }, origin)
}

async function launchScheduledCampaigns(env, now) {
  const due = await env.DB.prepare(
    `SELECT c.id, c.workspace_id, c.name, c.sender_id, c.lead_list_id, s.type AS sender_type
     FROM campaigns c LEFT JOIN senders s ON s.id = c.sender_id AND s.workspace_id = c.workspace_id
     WHERE c.status = 'scheduled' AND c.scheduled_at IS NOT NULL AND c.scheduled_at <= ? LIMIT 25`,
  ).bind(now).all()
  for (const campaign of due.results ?? []) {
    const steps = await env.DB.prepare(
      'SELECT step_no FROM sequences WHERE campaign_id = ? ORDER BY step_no',
    ).bind(campaign.id).all()
    if (
      !campaign.sender_id ||
      !['gmail_oauth', 'outlook_oauth'].includes(campaign.sender_type) ||
      !steps.results?.length ||
      Number(steps.results[0].step_no) !== 1
    ) {
      await env.DB.prepare("UPDATE campaigns SET status = 'paused', scheduled_at = NULL WHERE id = ?")
        .bind(campaign.id).run()
      continue
    }
    const leads = await campaignEligibleLeads(env, campaign)
    if (!leads.length) {
      await env.DB.prepare("UPDATE campaigns SET status = 'paused', scheduled_at = NULL WHERE id = ?")
        .bind(campaign.id).run()
      continue
    }
    await queueCampaignSends(env, campaign, now)
    await env.DB.prepare("UPDATE campaigns SET status = 'active', scheduled_at = NULL WHERE id = ? AND status = 'scheduled'")
      .bind(campaign.id).run()
    await logActivity(env, campaign.workspace_id, 'campaign_launched', `Campaign "${campaign.name}" launched on schedule to ${leads.length} recipients.`)
  }
}

async function archiveCampaign(env, campaignId, session, origin) {
  const campaign = await ownedCampaign(env, campaignId, session, null)
  if (!campaign) return errorResponse('Campaign not found.', 404, origin)
  if (campaign.status === 'archived') return errorResponse('Campaign is already archived.', 409, origin)
  await env.DB.prepare("UPDATE campaigns SET status = 'archived' WHERE id = ?").bind(campaignId).run()
  await logActivity(env, campaign.workspace_id, 'campaign_archived', `Campaign "${campaign.name}" was archived.`)
  return jsonResponse({ id: campaignId, status: 'archived' }, origin)
}

async function unarchiveCampaign(env, campaignId, session, origin) {
  const campaign = await ownedCampaign(env, campaignId, session, null)
  if (!campaign) return errorResponse('Campaign not found.', 404, origin)
  if (campaign.status !== 'archived') return errorResponse('Campaign is not archived.', 409, origin)
  const sent = await env.DB.prepare('SELECT id FROM sends WHERE campaign_id = ? LIMIT 1').bind(campaignId).first()
  const status = sent ? 'paused' : 'draft'
  await env.DB.prepare('UPDATE campaigns SET status = ? WHERE id = ?').bind(status, campaignId).run()
  await logActivity(env, campaign.workspace_id, 'campaign_unarchived', `Campaign "${campaign.name}" was restored.`)
  return jsonResponse({ id: campaignId, status }, origin)
}

function csvEscape(value) {
  const text = String(value ?? '')
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

function csvResponse(filename, body) {
  const safeName = filename.replace(/[^\w.-]+/g, '_').slice(0, 120) || 'export.csv'
  return new Response(body, {
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Type': 'text/csv; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Vary': 'Origin',
      'Access-Control-Allow-Origin': APP_ORIGIN,
      'Access-Control-Allow-Credentials': 'true',
    },
  })
}

async function exportLeadList(env, listId, url, session) {
  const workspaceId = url.searchParams.get('workspaceId')
  if (!await ownsWorkspace(env, workspaceId, session.userId)) return errorResponse('Workspace not found.', 404, APP_ORIGIN)
  const list = await env.DB.prepare('SELECT id, name FROM lead_lists WHERE id = ? AND workspace_id = ?')
    .bind(listId, workspaceId).first()
  if (!list) return errorResponse('Lead list not found.', 404, APP_ORIGIN)
  const rows = await env.DB.prepare(
    `SELECT l.email, l.first_name, l.company, l.status, l.created_at
     FROM leads l JOIN lead_list_members m ON m.lead_id = l.id
     WHERE m.list_id = ? AND l.workspace_id = ? ORDER BY l.email`,
  ).bind(listId, workspaceId).all()
  const lines = ['email,first_name,company,status,created_at']
  for (const lead of rows.results ?? []) {
    lines.push([
      csvEscape(lead.email),
      csvEscape(lead.first_name ?? ''),
      csvEscape(lead.company ?? ''),
      csvEscape(lead.status),
      csvEscape(new Date(Number(lead.created_at)).toISOString()),
    ].join(','))
  }
  return csvResponse(`${list.name}-leads.csv`, `${lines.join('\r\n')}\r\n`)
}

async function exportCampaignStats(env, campaignId, url, session) {
  const workspaceId = url.searchParams.get('workspaceId')
  const campaign = await ownedCampaign(env, campaignId, session, workspaceId)
  if (!campaign) return errorResponse('Campaign not found.', 404, APP_ORIGIN)
  const rows = await env.DB.prepare(
    `SELECT l.email, l.first_name, l.company, l.status AS lead_status, s.sequence_step, s.status AS send_status,
            s.sent_at, s.opened_at, s.clicked_at, s.replied_at
     FROM sends s JOIN leads l ON l.id = s.lead_id
     WHERE s.campaign_id = ? ORDER BY l.email, s.sequence_step`,
  ).bind(campaignId).all()
  const lines = ['email,first_name,company,lead_status,sequence_step,send_status,sent_at,opened_at,clicked_at,replied_at']
  for (const row of rows.results ?? []) {
    const formatTime = (value) => value ? new Date(Number(value)).toISOString() : ''
    lines.push([
      csvEscape(row.email),
      csvEscape(row.first_name ?? ''),
      csvEscape(row.company ?? ''),
      csvEscape(row.lead_status),
      csvEscape(row.sequence_step),
      csvEscape(row.send_status),
      csvEscape(formatTime(row.sent_at)),
      csvEscape(formatTime(row.opened_at)),
      csvEscape(formatTime(row.clicked_at)),
      csvEscape(formatTime(row.replied_at)),
    ].join(','))
  }
  return csvResponse(`${campaign.name}-stats.csv`, `${lines.join('\r\n')}\r\n`)
}

async function bulkUpdateLeads(request, env, session, origin) {
  const body = await readJson(request)
  if (
    !isObject(body) ||
    !await ownsWorkspace(env, body.workspaceId, session.userId) ||
    !VALID_LEAD_STATUSES.has(body.status) ||
    !Array.isArray(body.leadIds) ||
    body.leadIds.length < 1 ||
    body.leadIds.length > 500 ||
    body.leadIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))
  ) return errorResponse('Choose valid leads and a status.', 400, origin)
  const placeholders = body.leadIds.map(() => '?').join(',')
  const updated = await env.DB.prepare(
    `UPDATE leads SET status = ? WHERE workspace_id = ? AND id IN (${placeholders})`,
  ).bind(body.status, body.workspaceId, ...body.leadIds).run()
  const changed = updated.meta?.changes ?? 0
  if (body.status === 'unsubscribed' || body.status === 'bounced') {
    const leads = await env.DB.prepare(
      `SELECT id, email FROM leads WHERE workspace_id = ? AND id IN (${placeholders})`,
    ).bind(body.workspaceId, ...body.leadIds).all()
    const statements = []
    for (const lead of leads.results ?? []) {
      statements.push(env.DB.prepare(
        `INSERT INTO suppressions (id, workspace_id, email, reason, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, email) DO UPDATE SET reason = excluded.reason`,
      ).bind(crypto.randomUUID(), body.workspaceId, lead.email, body.status, Date.now()))
      statements.push(env.DB.prepare(
        `UPDATE sends SET status = 'stopped' WHERE lead_id = ? AND campaign_id IN
         (SELECT id FROM campaigns WHERE workspace_id = ?) AND status = 'queued'`,
      ).bind(lead.id, body.workspaceId))
    }
    if (statements.length) await env.DB.batch(statements)
  }
  return jsonResponse({ updated: changed }, origin)
}

async function leadTimeline(env, leadId, url, session, origin) {
  const workspaceId = url.searchParams.get('workspaceId')
  const lead = await env.DB.prepare(
    `SELECT l.id, l.email, l.first_name, l.company, l.status, l.created_at
     FROM leads l JOIN workspaces w ON w.id = l.workspace_id
     WHERE l.id = ? AND w.owner_user_id = ? AND (? IS NULL OR l.workspace_id = ?)`,
  ).bind(leadId, session.userId, workspaceId, workspaceId).first()
  if (!lead) return errorResponse('Lead not found.', 404, origin)
  const sends = await env.DB.prepare(
    `SELECT s.id, s.campaign_id, s.sequence_step, s.status, s.scheduled_at, s.sent_at,
            c.name AS campaign_name
     FROM sends s JOIN campaigns c ON c.id = s.campaign_id WHERE s.lead_id = ? ORDER BY s.created_at`,
  ).bind(leadId).all()
  const events = await env.DB.prepare(
    `SELECT e.send_id, e.type, e.at FROM events e JOIN sends s ON s.id = e.send_id
     WHERE s.lead_id = ? ORDER BY e.at`,
  ).bind(leadId).all()
  const sendById = new Map((sends.results ?? []).map((send) => [send.id, send]))
  const timeline = [{ type: 'imported', at: Number(lead.created_at), campaign_name: null, sequence_step: null }]
  for (const send of sends.results ?? []) {
    if (send.sent_at) {
      timeline.push({ type: 'sent', at: Number(send.sent_at), campaign_name: send.campaign_name, sequence_step: send.sequence_step })
    }
  }
  for (const event of events.results ?? []) {
    const send = sendById.get(event.send_id)
    timeline.push({
      type: event.type,
      at: Number(event.at),
      campaign_name: send?.campaign_name ?? null,
      sequence_step: send?.sequence_step ?? null,
    })
  }
  timeline.sort((left, right) => left.at - right.at)
  return jsonResponse({ lead, timeline }, origin)
}

async function listSuppressions(env, url, session, origin) {
  const workspaceId = url.searchParams.get('workspaceId')
  if (!await ownsWorkspace(env, workspaceId, session.userId)) return errorResponse('Workspace not found.', 404, origin)
  const rows = await env.DB.prepare(
    'SELECT id, email, reason, created_at FROM suppressions WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 500',
  ).bind(workspaceId).all()
  return jsonResponse(rows.results ?? [], origin)
}

async function addSuppression(request, env, session, origin) {
  const body = await readJson(request)
  if (
    !isObject(body) ||
    !await ownsWorkspace(env, body.workspaceId, session.userId) ||
    !isValidEmail(body.email) ||
    !['unsubscribed', 'bounced', 'complaint'].includes(body.reason)
  ) return errorResponse('Enter a valid email address and reason.', 400, origin)
  const email = normalizeEmail(body.email)
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO suppressions (id, workspace_id, email, reason, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, email) DO UPDATE SET reason = excluded.reason`,
  ).bind(crypto.randomUUID(), body.workspaceId, email, body.reason, now).run()
  const lead = await env.DB.prepare('SELECT id, status FROM leads WHERE workspace_id = ? AND email = ?')
    .bind(body.workspaceId, email).first()
  if (lead) {
    const status = body.reason === 'bounced' ? 'bounced' : 'unsubscribed'
    await env.DB.batch([
      env.DB.prepare('UPDATE leads SET status = ? WHERE id = ?').bind(status, lead.id),
      env.DB.prepare(
        `UPDATE sends SET status = 'stopped' WHERE lead_id = ? AND campaign_id IN
         (SELECT id FROM campaigns WHERE workspace_id = ?) AND status = 'queued'`,
      ).bind(lead.id, body.workspaceId),
    ])
  }
  await logActivity(env, body.workspaceId, 'suppression_added', `${email} was suppressed (${body.reason}).`)
  return jsonResponse({ email, reason: body.reason, created_at: now }, origin, 201)
}

async function removeSuppression(env, suppressionId, session, origin) {
  const row = await env.DB.prepare(
    `SELECT s.id, s.workspace_id, s.email FROM suppressions s
     JOIN workspaces w ON w.id = s.workspace_id
     WHERE s.id = ? AND w.owner_user_id = ?`,
  ).bind(suppressionId, session.userId).first()
  if (!row) return errorResponse('Suppression not found.', 404, origin)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM suppressions WHERE id = ?').bind(suppressionId),
    env.DB.prepare("UPDATE leads SET status = 'new' WHERE workspace_id = ? AND email = ? AND status IN ('unsubscribed', 'bounced')")
      .bind(row.workspace_id, row.email),
  ])
  await logActivity(env, row.workspace_id, 'suppression_removed', `${row.email} was removed from suppression.`)
  return jsonResponse({ removed: true }, origin)
}

async function listSnippets(env, url, session, origin) {
  const workspaceId = url.searchParams.get('workspaceId')
  if (!await ownsWorkspace(env, workspaceId, session.userId)) return errorResponse('Workspace not found.', 404, origin)
  const rows = await env.DB.prepare(
    'SELECT id, title, body, created_at FROM snippets WHERE workspace_id = ? ORDER BY created_at',
  ).bind(workspaceId).all()
  return jsonResponse(rows.results ?? [], origin)
}

async function createSnippet(request, env, session, origin) {
  const body = await readJson(request)
  if (
    !isObject(body) ||
    !await ownsWorkspace(env, body.workspaceId, session.userId) ||
    !safeText(body.title, 100) ||
    !safeText(body.body, 2000)
  ) return errorResponse('Enter a snippet title and text.', 400, origin)
  const id = crypto.randomUUID()
  const now = Date.now()
  try {
    await env.DB.prepare(
      'INSERT INTO snippets (id, workspace_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(id, body.workspaceId, body.title.trim(), body.body.trim(), now).run()
  } catch {
    return errorResponse('A snippet with this title already exists.', 409, origin)
  }
  return jsonResponse({ id, title: body.title.trim(), body: body.body.trim(), created_at: now }, origin, 201)
}

async function updateSnippet(request, env, snippetId, session, origin) {
  const body = await readJson(request)
  if (!isObject(body) || !safeText(body.title, 100) || !safeText(body.body, 2000)) {
    return errorResponse('Enter a snippet title and text.', 400, origin)
  }
  const row = await env.DB.prepare(
    `UPDATE snippets SET title = ?, body = ?
     WHERE id = ? AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
     RETURNING id, title, body, created_at`,
  ).bind(body.title.trim(), body.body.trim(), snippetId, session.userId).first()
  if (!row) return errorResponse('Snippet not found.', 404, origin)
  return jsonResponse(row, origin)
}

async function deleteSnippet(env, snippetId, session, origin) {
  const row = await env.DB.prepare(
    `DELETE FROM snippets WHERE id = ? AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
     RETURNING id`,
  ).bind(snippetId, session.userId).first()
  if (!row) return errorResponse('Snippet not found.', 404, origin)
  return jsonResponse({ removed: true }, origin)
}

async function onboardingState(env, url, session, origin) {
  const workspaceId = url.searchParams.get('workspaceId')
  if (!await ownsWorkspace(env, workspaceId, session.userId)) return errorResponse('Workspace not found.', 404, origin)
  const [sender, lead, campaign, test, launched] = await Promise.all([
    env.DB.prepare(
      "SELECT id FROM senders WHERE workspace_id = ? AND type IN ('gmail_oauth', 'outlook_oauth') LIMIT 1",
    ).bind(workspaceId).first(),
    env.DB.prepare('SELECT id FROM leads WHERE workspace_id = ? LIMIT 1').bind(workspaceId).first(),
    env.DB.prepare('SELECT id FROM campaigns WHERE workspace_id = ? LIMIT 1').bind(workspaceId).first(),
    env.DB.prepare(
      "SELECT provider_message_id FROM brevo_ignored_messages WHERE workspace_id = ? AND kind = 'test' LIMIT 1",
    ).bind(workspaceId).first(),
    env.DB.prepare(
      "SELECT id FROM campaigns WHERE workspace_id = ? AND status <> 'draft' LIMIT 1",
    ).bind(workspaceId).first(),
  ])
  return jsonResponse({
    senderConnected: Boolean(sender),
    leadsAdded: Boolean(lead),
    campaignCreated: Boolean(campaign),
    testSent: Boolean(test),
    launched: Boolean(launched),
  }, origin)
}

async function listActivity(env, url, session, origin) {
  const workspaceId = url.searchParams.get('workspaceId')
  if (!await ownsWorkspace(env, workspaceId, session.userId)) return errorResponse('Workspace not found.', 404, origin)
  const rows = await env.DB.prepare(
    'SELECT id, type, message, created_at FROM activity_log WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100',
  ).bind(workspaceId).all()
  return jsonResponse(rows.results ?? [], origin)
}

async function getPreferences(env, workspaceId, session, origin) {
  const workspace = await workspaceRecord(env, workspaceId, session.userId)
  if (!workspace) return errorResponse('Workspace not found.', 404, origin)
  return jsonResponse({ notifyReplyEmail: workspace.notify_reply_email !== 0 }, origin)
}

async function updatePreferences(request, env, workspaceId, session, origin) {
  const body = await readJson(request)
  if (!isObject(body) || typeof body.notifyReplyEmail !== 'boolean') {
    return errorResponse('Choose whether reply emails are on or off.', 400, origin)
  }
  const row = await env.DB.prepare(
    `UPDATE workspaces SET notify_reply_email = ?
     WHERE id = ? AND owner_user_id = ? RETURNING id, notify_reply_email`,
  ).bind(body.notifyReplyEmail ? 1 : 0, workspaceId, session.userId).first()
  if (!row) return errorResponse('Workspace not found.', 404, origin)
  return jsonResponse({ notifyReplyEmail: row.notify_reply_email !== 0 }, origin)
}

async function listNotifications(env, url, session, origin) {
  const workspaceId = url.searchParams.get('workspaceId')
  if (!await ownsWorkspace(env, workspaceId, session.userId)) return errorResponse('Workspace not found.', 404, origin)
  const rows = await env.DB.prepare(
    'SELECT id, message, created_at, read_at FROM notifications WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100',
  ).bind(workspaceId).all()
  return jsonResponse(rows.results ?? [], origin)
}

async function markNotificationsRead(request, env, session, origin) {
  const body = await readJson(request)
  if (!isObject(body) || !await ownsWorkspace(env, body.workspaceId, session.userId)) return errorResponse('Workspace not found.', 404, origin)
  await env.DB.prepare(
    'UPDATE notifications SET read_at = ? WHERE workspace_id = ? AND read_at IS NULL',
  ).bind(Date.now(), body.workspaceId).run()
  return jsonResponse({ marked: true }, origin)
}

async function campaignStats(env, campaignId, url, session, origin) {
  const workspaceId = url.searchParams.get('workspaceId')
  const campaign = await env.DB.prepare(
    `SELECT c.id FROM campaigns c JOIN workspaces w ON w.id = c.workspace_id
     WHERE c.id = ? AND w.owner_user_id = ? AND (? IS NULL OR c.workspace_id = ?)`,
  ).bind(campaignId, session.userId, workspaceId, workspaceId).first()
  if (!campaign) return errorResponse('Campaign not found.', 404, origin)
  const result = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM sends WHERE campaign_id = ? AND sent_at IS NOT NULL) AS sent,
       (SELECT COUNT(*) FROM sends WHERE campaign_id = ? AND status = 'queued') AS queued,
       (SELECT COUNT(*) FROM sends WHERE campaign_id = ? AND status = 'failed') AS failed,
       (SELECT COUNT(DISTINCT e.send_id) FROM events e JOIN sends s ON s.id = e.send_id WHERE s.campaign_id = ? AND e.type = 'delivered') AS delivered,
       (SELECT COUNT(DISTINCT e.send_id) FROM events e JOIN sends s ON s.id = e.send_id WHERE s.campaign_id = ? AND e.type = 'opened') AS opened,
       (SELECT COUNT(DISTINCT e.send_id) FROM events e JOIN sends s ON s.id = e.send_id WHERE s.campaign_id = ? AND e.type = 'clicked') AS clicked,
       (SELECT COUNT(DISTINCT e.send_id) FROM events e JOIN sends s ON s.id = e.send_id WHERE s.campaign_id = ? AND e.type = 'replied') AS replied,
       (SELECT COUNT(DISTINCT e.send_id) FROM events e JOIN sends s ON s.id = e.send_id WHERE s.campaign_id = ? AND e.type = 'bounced') AS bounced`,
  ).bind(campaignId, campaignId, campaignId, campaignId, campaignId, campaignId, campaignId, campaignId).first()
  return jsonResponse(result ?? {}, origin)
}

async function downloadFile(env, fileId, url, session) {
  const workspaceId = url.searchParams.get('workspaceId')
  const file = await env.DB.prepare(
    `SELECT f.id, f.workspace_id, f.kind, f.r2_key, f.filename
     FROM files f JOIN workspaces w ON w.id = f.workspace_id
     WHERE f.id = ? AND w.owner_user_id = ? AND (? IS NULL OR f.workspace_id = ?)`,
  ).bind(fileId, session.userId, workspaceId, workspaceId).first()
  if (!file || file.kind !== 'attachment') return errorResponse('File not found.', 404, APP_ORIGIN)
  const object = await env.FILES.get(file.r2_key)
  if (!object) return errorResponse('File not found.', 404, APP_ORIGIN)
  const safeName = String(file.filename).replace(/[\r\n"\\]/g, '_').slice(0, 180)
  return new Response(object.body, {
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Vary': 'Origin',
      'Access-Control-Allow-Origin': APP_ORIGIN,
      'Access-Control-Allow-Credentials': 'true',
    },
  })
}

async function uploadAttachment(request, env, session, origin) {
  const maxBytes = 10485760
  const body = await readJson(request)
  if (
    !isObject(body) ||
    !safeText(body.workspaceId, 100) ||
    !safeText(body.filename, 255) ||
    !Number.isInteger(body.sizeBytes) ||
    body.sizeBytes < 1 ||
    body.sizeBytes > maxBytes ||
    !await ownsWorkspace(env, body.workspaceId, session.userId)
  ) {
    return errorResponse('Choose a valid workspace and attachment.', 400, origin)
  }
  const permitted = new Map([
    ['application/pdf', { extension: '.pdf', prefix: [0x25, 0x50, 0x44, 0x46, 0x2d] }],
    ['image/png', { extension: '.png', prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
    ['image/jpeg', { extension: '.jpg', prefix: [0xff, 0xd8, 0xff] }],
  ])
  const contentType = typeof body.contentType === 'string' ? body.contentType.toLowerCase() : ''
  const type = permitted.get(contentType)
  const filename = body.filename.replace(/[\u0000-\u001f\u007f]/g, '_').slice(0, 255)
  if (!type || !filename.toLowerCase().endsWith(type.extension)) {
    return errorResponse('Only PDF, PNG, and JPEG attachments are accepted.', 415, origin)
  }
  return createUploadIntent(env, {
    workspaceId: body.workspaceId,
    kind: 'attachment',
    filename,
    sizeBytes: body.sizeBytes,
    contentType,
    extension: type.extension,
  }, session.userId, origin)
}

async function sendTest(request, env, session, origin) {
  const body = await readJson(request)
  if (!isObject(body) || !isValidEmail(body.email) || !session.emailVerified || !session.email || normalizeEmail(body.email) !== session.email) {
    return errorResponse('Test messages can only be sent to your verified account email.', 400, origin)
  }
  const workspace = await env.DB.prepare('SELECT id FROM workspaces WHERE owner_user_id = ?')
    .bind(session.userId).first()
  if (!workspace) return errorResponse('Create a workspace before sending a test.', 409, origin)
  if (!env.BREVO_API_KEY) return errorResponse('Test sending is not configured yet.', 503, origin)
  const token = randomToken()
  await env.DB.prepare(
    'INSERT INTO unsubscribe_tokens (token_hash, workspace_id, lead_id, email, expires_at) VALUES (?, ?, NULL, ?, ?)',
  ).bind(base64Url(await sha256(token)), workspace.id, session.email, Date.now() + 31536000000).run()
  const sent = await sendBrevo(env, {
    email: session.email,
    subject: 'Your Kluzar Outreach test email',
    text: 'This is a test message sent to your own verified account address. It was not sent to any workspace leads.',
    unsubscribeToken: token,
    messageId: null,
    tag: 'kluzar-outreach-test',
  })
  if (!sent?.messageId) return errorResponse('Test email could not be sent. Please try again later.', 502, origin)
  await env.DB.prepare(
    'INSERT OR IGNORE INTO brevo_ignored_messages (provider_message_id, workspace_id, kind, created_at) VALUES (?, ?, ?, ?)',
  ).bind(sent.messageId, workspace.id, 'test', Date.now()).run()
  await logActivity(env, workspace.id, 'test_sent', 'A test message was sent to your verified account email.')
  return jsonResponse({ queued: true }, origin, 202)
}

async function testCampaign(request, env, session, origin) {
  const body = await readJson(request)
  if (!isObject(body) || !isValidEmail(body.email) || !session.emailVerified || !session.email || normalizeEmail(body.email) !== session.email) {
    return errorResponse('Test campaigns can only be sent to your verified account email.', 400, origin)
  }
  if (!safeText(body.campaignId, 100)) return errorResponse('Choose a campaign to test.', 400, origin)
  const campaign = await env.DB.prepare(
    `SELECT c.id, c.workspace_id FROM campaigns c JOIN workspaces w ON w.id = c.workspace_id
     WHERE c.id = ? AND w.owner_user_id = ? AND c.status = 'draft'`,
  ).bind(body.campaignId, session.userId).first()
  if (!campaign) return errorResponse('Campaign not found or cannot be tested.', 404, origin)
  const step = await env.DB.prepare(
    'SELECT subject, body_template FROM sequences WHERE campaign_id = ? AND step_no = 1',
  ).bind(campaign.id).first()
  if (!step) return errorResponse('Add a first sequence step before testing.', 409, origin)
  if (!env.BREVO_API_KEY) return errorResponse('Test sending is not configured yet.', 503, origin)
  const token = randomToken()
  await env.DB.prepare(
    'INSERT INTO unsubscribe_tokens (token_hash, workspace_id, lead_id, email, expires_at) VALUES (?, ?, NULL, ?, ?)',
  ).bind(base64Url(await sha256(token)), campaign.workspace_id, session.email, Date.now() + 31536000000).run()
  const sent = await sendBrevo(env, {
    email: session.email,
    subject: step.subject,
    text: renderTemplate(step.body_template, { first_name: '', company: '' }),
    unsubscribeToken: token,
    messageId: null,
    tag: 'kluzar-outreach-test',
  })
  if (!sent?.messageId) return errorResponse('Test campaign could not be sent. Please try again later.', 502, origin)
  await env.DB.prepare(
    'INSERT OR IGNORE INTO brevo_ignored_messages (provider_message_id, workspace_id, kind, created_at) VALUES (?, ?, ?, ?)',
  ).bind(sent.messageId, campaign.workspace_id, 'test', Date.now()).run()
  await logActivity(env, campaign.workspace_id, 'test_sent', 'A test of a campaign draft was sent to your verified account email.')
  return jsonResponse({ queued: true }, origin, 202)
}

function renderTemplate(template, lead) {
  return template.replace(/\{\{(first_name|company)\}\}/g, (_match, key) => {
    const value = lead[key] ?? ''
    return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  })
}

async function startOAuth(request, env, session, origin) {
  const body = await readJson(request)
  if (!isObject(body) || !['google', 'microsoft'].includes(body.provider) || !await ownsWorkspace(env, body.workspaceId, session.userId)) {
    return errorResponse('Choose a valid mailbox provider and workspace.', 400, origin)
  }
  const provider = body.provider
  const clientId = provider === 'google' ? env.GOOGLE_OAUTH_CLIENT_ID : env.MICROSOFT_OAUTH_CLIENT_ID
  if (!clientId) return errorResponse('Mailbox connection is not configured yet.', 503, origin)
  const state = randomToken()
  const nonce = randomToken()
  const verifier = randomToken(48)
  const challenge = base64Url(await sha256(verifier))
  const createdAt = Date.now()
  await env.DB.prepare(
    `INSERT INTO oauth_states (state, user_id, workspace_id, provider, verifier, nonce, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(state, session.userId, body.workspaceId, provider, verifier, nonce, createdAt, createdAt + 600000).run()
  const redirectUri = provider === 'google' ? GOOGLE_REDIRECT_URI : MICROSOFT_REDIRECT_URI
  const authorizeUrl = provider === 'google'
    ? new URL('https://accounts.google.com/o/oauth2/v2/auth')
    : new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
  authorizeUrl.searchParams.set('client_id', clientId)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('redirect_uri', redirectUri)
  authorizeUrl.searchParams.set('response_mode', 'query')
  authorizeUrl.searchParams.set('state', state)
  authorizeUrl.searchParams.set('nonce', nonce)
  authorizeUrl.searchParams.set('code_challenge', challenge)
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')
  if (provider === 'google') {
    authorizeUrl.searchParams.set('scope', 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly')
    authorizeUrl.searchParams.set('access_type', 'offline')
    authorizeUrl.searchParams.set('prompt', 'consent')
  } else {
    authorizeUrl.searchParams.set('scope', 'openid email profile offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read')
  }
  return jsonResponse({ authorizationUrl: authorizeUrl.toString() }, origin)
}

async function exchangeOAuth(request, env, provider, session, origin) {
  const body = await readJson(request)
  if (!isObject(body) || !safeText(body.code, 4096) || !safeText(body.state, 200)) {
    return errorResponse('Mailbox connection could not be verified.', 400, origin)
  }
  const state = await env.DB.prepare(
    'SELECT state, user_id, workspace_id, provider, verifier, nonce, expires_at FROM oauth_states WHERE state = ?',
  ).bind(body.state).first()
  if (!state || state.provider !== provider || state.user_id !== session.userId || state.expires_at < Date.now()) {
    return errorResponse('Mailbox connection could not be verified.', 400, origin)
  }
  const consumed = await env.DB.prepare('DELETE FROM oauth_states WHERE state = ? AND user_id = ? RETURNING state')
    .bind(body.state, session.userId).first()
  if (!consumed) return errorResponse('Mailbox connection could not be verified.', 400, origin)
  const clientId = provider === 'google' ? env.GOOGLE_OAUTH_CLIENT_ID : env.MICROSOFT_OAUTH_CLIENT_ID
  const clientSecret = provider === 'google' ? env.GOOGLE_OAUTH_CLIENT_SECRET : env.MICROSOFT_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) return errorResponse('Mailbox connection is not configured yet.', 503, origin)
  const redirectUri = provider === 'google' ? GOOGLE_REDIRECT_URI : MICROSOFT_REDIRECT_URI
  const tokenUrl = provider === 'google'
    ? 'https://oauth2.googleapis.com/token'
    : 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
  const parameters = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: body.code,
    code_verifier: state.verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  })
  let tokenResponse
  try {
    tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: parameters,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    return errorResponse('Mailbox connection could not be completed.', 502, origin)
  }
  if (!tokenResponse.ok) return errorResponse('Mailbox connection could not be completed.', 400, origin)
  const tokens = await tokenResponse.json().catch(() => null)
  if (!isObject(tokens) || typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string') {
    return errorResponse('Mailbox did not grant the required access.', 400, origin)
  }
  let address
  if (provider === 'google') {
    if (!String(tokens.scope ?? '').includes('gmail.send') || !String(tokens.scope ?? '').includes('gmail.readonly') || !tokens.id_token) {
      return errorResponse('Mailbox did not grant the required access.', 400, origin)
    }
    address = await googleIdentity(env, tokens.id_token, state.nonce)
  } else {
    const granted = String(tokens.scope ?? '')
    if (!granted.includes('Mail.Send') || !granted.includes('Mail.Read') || !tokens.id_token) {
      return errorResponse('Mailbox did not grant the required access.', 400, origin)
    }
    address = await microsoftIdentity(env, tokens.id_token, state.nonce)
  }
  if (!address) return errorResponse('Mailbox identity could not be verified.', 400, origin)
  const credentials = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + Math.max(60, Number(tokens.expires_in) || 3600) * 1000,
  }
  const ciphertext = await encryptToken(env, credentials)
  const type = provider === 'google' ? 'gmail_oauth' : 'outlook_oauth'
  const senderId = crypto.randomUUID()
  const now = Date.now()
  const existing = await env.DB.prepare(
    'SELECT id FROM senders WHERE workspace_id = ? AND address = ? AND type = ?',
  ).bind(state.workspace_id, address, type).first()
  if (existing) {
    await env.DB.prepare(
      'UPDATE senders SET credentials_ref = ?, credentials_expires_at = ?, display_name = ? WHERE id = ? AND workspace_id = ?',
    ).bind(ciphertext, credentials.expiresAt, address, existing.id, state.workspace_id).run()
    return jsonResponse({ id: existing.id, type, address, connected: true }, origin)
  }
  await env.DB.prepare(
    `INSERT INTO senders
     (id, workspace_id, type, address, display_name, credentials_ref, credentials_expires_at, is_default, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).bind(senderId, state.workspace_id, type, address, address, ciphertext, credentials.expiresAt, now).run()
  return jsonResponse({ id: senderId, type, address, connected: true }, origin, 201)
}

async function googleIdentity(env, idToken, nonce) {
  const url = new URL('https://oauth2.googleapis.com/tokeninfo')
  url.searchParams.set('id_token', idToken)
  try {
    const result = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) })
    if (!result.ok) return null
    const identity = await result.json()
    if (
      identity.aud !== env.GOOGLE_OAUTH_CLIENT_ID ||
      identity.nonce !== nonce ||
      identity.email_verified !== 'true' ||
      !isValidEmail(identity.email)
    ) return null
    return normalizeEmail(identity.email)
  } catch {
    return null
  }
}

async function microsoftIdentity(env, idToken, nonce) {
  const parts = idToken.split('.')
  if (parts.length !== 3 || !env.MICROSOFT_OAUTH_CLIENT_ID) return null
  try {
    const decodePart = (value) => JSON.parse(new TextDecoder().decode(Uint8Array.from(
      atob(value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')),
      (char) => char.charCodeAt(0),
    )))
    const header = decodePart(parts[0])
    const claims = decodePart(parts[1])
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || claims.nonce !== nonce || claims.aud !== env.MICROSOFT_OAUTH_CLIENT_ID) return null
    const now = Math.floor(Date.now() / 1000)
    if (claims.exp < now || claims.nbf > now || !safeText(claims.tid, 100)) return null
    const keysResponse = await fetch('https://login.microsoftonline.com/common/discovery/v2.0/keys', {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    })
    if (!keysResponse.ok) return null
    const keySet = await keysResponse.json()
    const jwk = keySet.keys?.find((key) => key.kid === header.kid && key.kty === 'RSA')
    if (!jwk) return null
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    const signature = Uint8Array.from(atob(parts[2].replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(parts[2].length / 4) * 4, '=')), (char) => char.charCodeAt(0))
    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    const validSignature = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signingInput)
    if (!validSignature || claims.iss !== `https://login.microsoftonline.com/${claims.tid}/v2.0`) return null
    const address = claims.email ?? claims.preferred_username
    return isValidEmail(address) ? normalizeEmail(address) : null
  } catch {
    return null
  }
}

async function refreshSender(env, sender) {
  if (!sender.credentials_ref) return null
  let credentials
  try {
    credentials = await decryptToken(env, sender.credentials_ref)
  } catch {
    return null
  }
  if (credentials.expiresAt > Date.now() + 120000) return credentials
  const google = sender.type === 'gmail_oauth'
  const url = google
    ? 'https://oauth2.googleapis.com/token'
    : 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
  const clientId = google ? env.GOOGLE_OAUTH_CLIENT_ID : env.MICROSOFT_OAUTH_CLIENT_ID
  const clientSecret = google ? env.GOOGLE_OAUTH_CLIENT_SECRET : env.MICROSOFT_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret || !credentials.refreshToken) return null
  const fields = {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: 'refresh_token',
  }
  if (!google) fields.scope = 'offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read'
  let refreshed
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(fields),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return null
    refreshed = await response.json()
  } catch {
    return null
  }
  if (!refreshed?.access_token) return null
  const updated = {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? credentials.refreshToken,
    expiresAt: Date.now() + Math.max(60, Number(refreshed.expires_in) || 3600) * 1000,
  }
  const encrypted = await encryptToken(env, updated)
  await env.DB.prepare('UPDATE senders SET credentials_ref = ?, credentials_expires_at = ? WHERE id = ?')
    .bind(encrypted, updated.expiresAt, sender.id).run()
  return updated
}

function encodeMimeSubject(value) {
  return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(value)))}?=`
}

function encodeMimeBody(value) {
  const bytes = new TextEncoder().encode(value)
  return base64Url(bytes)
}

async function sendBrevo(env, message) {
  if (!env.BREVO_API_KEY) return null
  const unsubscribeUrl = `https://outreach-api.kluzar.com/v1/unsubscribe/${message.unsubscribeToken}`
  let result
  try {
    const response = await fetch(`${BREVO_API_URL}/smtp/email`, {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: 'Kluzar', email: 'hello@kluzar.com' },
        to: [{ email: message.email }],
        subject: message.subject,
        textContent: message.text,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        tags: [message.tag ?? 'kluzar-outreach'],
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return null
    result = await response.json()
  } catch {
    return null
  }
  if (typeof result.messageId !== 'string' || result.messageId.length < 3) return null
  return { messageId: result.messageId, threadId: null }
}

async function sendGmail(env, sender, credentials, message) {
  const headers = [
    `From: ${sender.display_name} <${sender.address}>`,
    `To: ${message.email}`,
    `Subject: ${encodeMimeSubject(message.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
  ]
  if (message.unsubscribeToken) {
    const unsubscribeUrl = `https://outreach-api.kluzar.com/v1/unsubscribe/${message.unsubscribeToken}`
    headers.push(`List-Unsubscribe: <${unsubscribeUrl}>`)
    headers.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click')
  }
  const raw = [
    ...headers,
    '',
    message.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
  ].join('\r\n')
  try {
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encodeMimeBody(raw), ...(message.threadId ? { threadId: message.threadId } : {}) }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return null
    const result = await response.json()
    return { messageId: result.id ?? null, threadId: result.threadId ?? null }
  } catch {
    return null
  }
}

async function sendMicrosoft(sender, credentials, message) {
  const headers = []
  if (message.unsubscribeToken) {
    const unsubscribeUrl = `https://outreach-api.kluzar.com/v1/unsubscribe/${message.unsubscribeToken}`
    headers.push(
      { name: 'List-Unsubscribe', value: `<${unsubscribeUrl}>` },
      { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
    )
  }
  try {
    const created = await fetch('https://graph.microsoft.com/v1.0/me/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
        Prefer: 'IdType="ImmutableId"',
      },
      body: JSON.stringify({
        subject: message.subject,
        body: { contentType: 'Text', content: message.text },
        toRecipients: [{ emailAddress: { address: message.email } }],
        internetMessageHeaders: headers,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
    if (!created.ok) return null
    const draft = await created.json()
    const sent = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(draft.id)}/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
    if (!sent.ok) return null
    return { messageId: draft.id, threadId: draft.conversationId ?? null }
  } catch {
    return null
  }
}

async function sendMicrosoftReply(sender, credentials, message) {
  let draft
  try {
    const created = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(message.originalMessageId)}/createReply`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
    if (!created.ok) return null
    draft = await created.json()
  } catch {
    return null
  }
  try {
    const updated = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(draft.id)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: { contentType: 'Text', content: message.text } }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
    if (!updated.ok) return null
    const sent = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(draft.id)}/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
    if (!sent.ok) return null
    return { messageId: draft.id, threadId: draft.conversationId ?? null }
  } catch {
    return null
  }
}

async function brevoWebhook(request, env, pathToken) {
  const authorization = request.headers.get('authorization') ?? ''
  const webhookToken = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : authorization
  if (
    !env.BREVO_WEBHOOK_PATH_TOKEN ||
    !env.BREVO_WEBHOOK_TOKEN ||
    !await constantTimeEqual(pathToken, env.BREVO_WEBHOOK_PATH_TOKEN) ||
    !await constantTimeEqual(webhookToken, env.BREVO_WEBHOOK_TOKEN)
  ) return errorResponse('Request could not be verified.', 401)
  const body = await readJson(request, 65536)
  if (!body) return errorResponse('Request could not be verified.', 400)
  const events = Array.isArray(body) ? body : [body]
  if (events.length < 1 || events.length > 20 || events.some((item) => !isObject(item))) {
    return errorResponse('Request could not be verified.', 400)
  }
  for (const event of events) {
    const accepted = await acceptBrevoEvent(env, event)
    if (!accepted) return errorResponse('Request could not be verified.', 401)
  }
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}

function normalizedBrevoEvent(value) {
  const event = String(value ?? '').toLowerCase().replace(/[\s_-]/g, '')
  if (event === 'delivered') return { type: 'delivered', apiEvent: 'delivered' }
  if (event === 'opened' || event === 'firstopening' || event === 'uniqueopened') return { type: 'opened', apiEvent: 'opened' }
  if (event === 'click' || event === 'clicked') return { type: 'clicked', apiEvent: 'click' }
  if (event === 'hardbounce') return { type: 'bounced', apiEvent: 'hardBounce' }
  if (event === 'softbounce') return { type: 'bounced', apiEvent: 'softBounce' }
  if (event === 'invalidemail') return { type: 'bounced', apiEvent: 'invalid' }
  if (event === 'blocked') return { type: 'bounced', apiEvent: 'blocked' }
  if (event === 'error') return { type: 'bounced', apiEvent: 'error' }
  if (event === 'spam' || event === 'complaint') return { type: 'complaint', apiEvent: 'spam' }
  if (event === 'unsubscribe' || event === 'unsubscribed') return { type: 'unsubscribed', apiEvent: 'unsubscribed' }
  return null
}

async function verifyBrevoEvent(env, payload, eventInfo) {
  if (!env.BREVO_API_KEY || !isValidEmail(payload.email)) return false
  const messageId = payload.messageId ?? payload['message-id'] ?? payload.message_id
  if (typeof messageId !== 'string' || messageId.length < 3 || messageId.length > 500) return false
  const eventTime = Number(payload.ts_event) > 0 ? Number(payload.ts_event) * 1000 : Date.now()
  const start = new Date(Math.max(0, eventTime - 86400000)).toISOString().slice(0, 10)
  const end = new Date(Math.min(Date.now() + 86400000, eventTime + 86400000)).toISOString().slice(0, 10)
  const url = new URL(`${BREVO_API_URL}/smtp/statistics/events`)
  url.searchParams.set('email', normalizeEmail(payload.email))
  url.searchParams.set('event', eventInfo.apiEvent)
  url.searchParams.set('startDate', start)
  url.searchParams.set('endDate', end)
  url.searchParams.set('limit', '100')
  let upstream
  try {
    upstream = await fetch(url, {
      headers: { 'api-key': env.BREVO_API_KEY, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    return false
  }
  if (!upstream.ok) return false
  const report = await upstream.json().catch(() => null)
  const rows = report?.events
  if (!Array.isArray(rows)) return false
  return rows.some((row) =>
    normalizeEmail(String(row.email ?? '')) === normalizeEmail(payload.email) &&
    String(row.messageId ?? row.message_id ?? '') === messageId &&
    String(row.event ?? '').toLowerCase().replace(/[\s_-]/g, '') === eventInfo.apiEvent.toLowerCase().replace(/[\s_-]/g, ''),
  )
}

async function acceptBrevoEvent(env, payload) {
  const eventInfo = normalizedBrevoEvent(payload.event)
  if (!eventInfo || !await verifyBrevoEvent(env, payload, eventInfo)) return false
  const messageId = payload.messageId ?? payload['message-id'] ?? payload.message_id
  const email = normalizeEmail(payload.email)
  const send = await env.DB.prepare(
    `SELECT s.id, s.lead_id, s.status, l.workspace_id, l.email
     FROM sends s JOIN leads l ON l.id = s.lead_id
     WHERE s.provider_message_id = ? AND l.email = ?`,
  ).bind(messageId, email).first()
  if (!send) {
    const ignored = await env.DB.prepare('SELECT provider_message_id FROM brevo_ignored_messages WHERE provider_message_id = ?')
      .bind(messageId).first()
    return Boolean(ignored)
  }
  const providerEventId = payload.id === undefined || payload.id === null
    ? `brevo:${base64Url(await sha256(`${messageId}:${eventInfo.type}:${payload.ts_event ?? ''}:${email}`))}`
    : `brevo:${String(payload.id).slice(0, 180)}`
  const now = Number(payload.ts_event) > 0 ? Number(payload.ts_event) * 1000 : Date.now()
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO events (id, send_id, type, at, meta_json, provider_event_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), send.id, eventInfo.type === 'complaint' ? 'bounced' : eventInfo.type, now, JSON.stringify({ provider: 'brevo', event: eventInfo.apiEvent }), providerEventId).run()
  if ((inserted.meta?.changes ?? 0) === 0) return true
  if (eventInfo.type === 'unsubscribed' || eventInfo.type === 'bounced' || eventInfo.type === 'complaint') {
    const reason = eventInfo.type === 'unsubscribed' ? 'unsubscribed' : eventInfo.type === 'complaint' ? 'complaint' : 'bounced'
    await env.DB.batch([
      env.DB.prepare('UPDATE sends SET status = ? WHERE id = ?')
        .bind(reason === 'unsubscribed' ? 'stopped' : 'bounced', send.id),
      env.DB.prepare(
        `INSERT INTO suppressions (id, workspace_id, email, reason, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, email) DO UPDATE SET reason = excluded.reason`,
      ).bind(crypto.randomUUID(), send.workspace_id, email, reason, now),
      env.DB.prepare('UPDATE leads SET status = ? WHERE id = ? AND status NOT IN (?, ?)')
        .bind(reason === 'unsubscribed' ? 'unsubscribed' : 'bounced', send.lead_id, 'unsubscribed', 'bounced'),
      env.DB.prepare(
        `UPDATE sends SET status = ? WHERE lead_id = ? AND campaign_id IN
         (SELECT id FROM campaigns WHERE workspace_id = ?) AND status = 'queued'`,
      ).bind('stopped', send.lead_id, send.workspace_id),
    ])
  } else if (eventInfo.type === 'delivered') {
    await env.DB.prepare('UPDATE sends SET status = ? WHERE id = ? AND status = ?')
      .bind('delivered', send.id, 'sent').run()
  } else if (eventInfo.type === 'opened') {
    await env.DB.prepare('UPDATE sends SET status = ?, opened_at = COALESCE(opened_at, ?) WHERE id = ? AND status IN (?, ?, ?)')
      .bind('opened', now, send.id, 'sent', 'delivered', 'opened').run()
  } else if (eventInfo.type === 'clicked') {
    await env.DB.prepare('UPDATE sends SET status = ?, clicked_at = COALESCE(clicked_at, ?) WHERE id = ? AND status IN (?, ?, ?, ?)')
      .bind('clicked', now, send.id, 'sent', 'delivered', 'opened', 'clicked').run()
  }
  return true
}

async function unsubscribe(request, env, token) {
  const contentType = request.headers.get('content-type') ?? ''
  const length = Number(request.headers.get('content-length') ?? 0)
  if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded') || length > 512) {
    return new Response('Invalid unsubscribe request.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  }
  let form
  try {
    form = new URLSearchParams(await request.text())
  } catch {
    return new Response('Invalid unsubscribe request.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  }
  if (form.get('List-Unsubscribe') !== 'One-Click') {
    return new Response('Invalid unsubscribe request.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  }
  const tokenHash = base64Url(await sha256(token))
  const record = await env.DB.prepare(
    'SELECT token_hash, workspace_id, lead_id, email, expires_at, used_at FROM unsubscribe_tokens WHERE token_hash = ?',
  ).bind(tokenHash).first()
  if (!record || record.expires_at < Date.now()) return new Response('This unsubscribe link is no longer available.', { status: 410, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  if (record.used_at) return new Response('This address is already unsubscribed.', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  const now = Date.now()
  const claim = await env.DB.prepare(
    'UPDATE unsubscribe_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING workspace_id',
  ).bind(now, tokenHash, now).first()
  if (!claim) return new Response('This address is already unsubscribed.', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO suppressions (id, workspace_id, email, reason, created_at)
       VALUES (?, ?, ?, 'unsubscribed', ?)
       ON CONFLICT(workspace_id, email) DO UPDATE SET reason = 'unsubscribed'`,
    ).bind(crypto.randomUUID(), record.workspace_id, record.email, now),
    ...(record.lead_id ? [env.DB.prepare('UPDATE leads SET status = ? WHERE id = ?').bind('unsubscribed', record.lead_id)] : []),
    env.DB.prepare(
      `UPDATE sends SET status = 'stopped' WHERE lead_id = ? AND campaign_id IN
       (SELECT id FROM campaigns WHERE workspace_id = ?) AND status = 'queued'`,
    ).bind(record.lead_id ?? '', record.workspace_id),
  ])
  return new Response('You have been unsubscribed.', {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      'Content-Type': 'text/plain; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

async function runScheduler(env) {
  const now = Date.now()
  await env.DB.prepare(
    `UPDATE sends SET status = 'failed'
     WHERE status = 'sending' AND sending_at < ?`,
  ).bind(now - 1800000).run()
  await pollReplies(env, now)
  await processNoReplyBranches(env, now)
  await launchScheduledCampaigns(env, now)
  await sendDueMessages(env, now)
}

async function pollReplies(env, now) {
  const rows = await env.DB.prepare(
    `SELECT s.id, s.campaign_id, s.lead_id, s.sequence_step, s.sent_at, s.provider_thread_id, s.is_reply_followup,
            l.email AS lead_email, l.first_name, l.company, c.workspace_id,
            d.id AS sender_id, d.type AS sender_type, d.address AS sender_address, d.display_name AS sender_name,
            d.credentials_ref, d.credentials_expires_at
     FROM sends s JOIN leads l ON l.id = s.lead_id
     JOIN campaigns c ON c.id = s.campaign_id
     JOIN senders d ON d.id = c.sender_id
     WHERE s.sent_at IS NOT NULL AND s.provider_thread_id IS NOT NULL
       AND s.status IN ('sent', 'delivered', 'opened', 'clicked')
       AND c.status IN ('active', 'paused') AND d.type IN ('gmail_oauth', 'outlook_oauth')
     ORDER BY s.sent_at DESC LIMIT 100`,
  ).all()
  for (const send of rows.results ?? []) {
    const reply = await findReply(env, send, now)
    if (reply) await recordReply(env, send, reply)
  }
}

async function findReply(env, send, now) {
  const sender = {
    id: send.sender_id,
    type: send.sender_type,
    address: send.sender_address,
    display_name: send.sender_name,
    credentials_ref: send.credentials_ref,
    credentials_expires_at: send.credentials_expires_at,
  }
  const credentials = await refreshSender(env, sender)
  if (!credentials) return null
  if (sender.type === 'gmail_oauth') {
    let response
    try {
      response = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(send.provider_thread_id)}?format=full`,
        { headers: { Authorization: `Bearer ${credentials.accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(8000) },
      )
    } catch {
      return null
    }
    if (!response.ok) return null
    const thread = await response.json().catch(() => null)
    for (const message of thread?.messages ?? []) {
      const receivedAt = Number(message.internalDate ?? 0)
      if (receivedAt <= send.sent_at) continue
      const headers = message.payload?.headers ?? []
      const from = headerAddress(headers.find((header) => String(header.name).toLowerCase() === 'from')?.value ?? '')
      if (from !== send.lead_email) continue
      const subject = String(headers.find((header) => String(header.name).toLowerCase() === 'subject')?.value ?? '').slice(0, 500)
      const bodyText = gmailPlainText(message.payload).slice(0, 20000)
      return { senderEmail: from, subject, bodyText, receivedAt }
    }
    return null
  }
  const filter = `conversationId eq '${String(send.provider_thread_id).replaceAll("'", "''")}' and receivedDateTime ge ${new Date(send.sent_at).toISOString()}`
  const query = new URLSearchParams({
    '$filter': filter,
    '$select': 'id,conversationId,receivedDateTime,from,subject,body',
    '$top': '20',
  })
  let response
  try {
    response = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?${query}`, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Prefer: 'outlook.body-content-type="text"',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    return null
  }
  if (!response.ok) return null
  const inbox = await response.json().catch(() => null)
  for (const message of inbox?.value ?? []) {
    const from = normalizeEmail(String(message.from?.emailAddress?.address ?? ''))
    const receivedAt = Date.parse(message.receivedDateTime)
    if (from !== send.lead_email || receivedAt <= send.sent_at) continue
    const bodyText = message.body?.contentType === 'text' ? String(message.body.content ?? '').slice(0, 20000) : ''
    return {
      senderEmail: from,
      subject: String(message.subject ?? '').slice(0, 500),
      bodyText,
      receivedAt,
    }
  }
  return null
}

function headerAddress(value) {
  const bracketed = value.match(/<([^<>]+)>/)
  const address = bracketed?.[1] ?? value
  return isValidEmail(address.trim()) ? normalizeEmail(address) : ''
}

function gmailPlainText(payload) {
  let result = ''
  const visit = (part) => {
    if (part?.mimeType === 'text/plain' && part.body?.data && result.length < 20000) {
      try {
        const encoded = String(part.body.data).replaceAll('-', '+').replaceAll('_', '/')
        const binary = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='))
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
        result += new TextDecoder().decode(bytes)
      } catch {
        result = ''
      }
    }
    for (const child of part?.parts ?? []) visit(child)
  }
  visit(payload)
  return result
}

async function recordReply(env, send, reply) {
  const inserted = await env.DB.prepare(
    'INSERT OR IGNORE INTO replies (id, send_id, sender_email, subject, body_text, received_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(crypto.randomUUID(), send.id, reply.senderEmail, reply.subject, reply.bodyText, reply.receivedAt).run()
  if ((inserted.meta?.changes ?? 0) === 0) return
  await env.DB.batch([
    env.DB.prepare('UPDATE sends SET status = ?, replied_at = ? WHERE id = ?').bind('replied', reply.receivedAt, send.id),
    env.DB.prepare("UPDATE leads SET status = 'replied' WHERE id = ? AND status NOT IN ('unsubscribed', 'bounced')").bind(send.lead_id),
    env.DB.prepare(
      "INSERT INTO events (id, send_id, type, at, meta_json, provider_event_id) VALUES (?, ?, 'replied', ?, ?, ?)",
    ).bind(crypto.randomUUID(), send.id, reply.receivedAt, JSON.stringify({ provider: send.sender_type }), `reply:${send.id}`),
    env.DB.prepare(
      `UPDATE sends SET status = 'stopped' WHERE lead_id = ? AND campaign_id = ? AND status = 'queued'`,
    ).bind(send.lead_id, send.campaign_id),
  ])
  await executeBranches(env, send, 'replied', reply.receivedAt)
  const workspace = await env.DB.prepare(
    'SELECT w.id, w.owner_email, w.notify_reply_email, c.name FROM campaigns c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ?',
  ).bind(send.campaign_id).first()
  if (workspace) {
    await notifyWorkspace(
      env,
      workspace,
      `New reply from ${reply.senderEmail} on campaign "${workspace.name}".`,
      workspace.notify_reply_email !== 0,
    )
    await logActivity(env, workspace.id, 'reply_received', `${reply.senderEmail} replied on campaign "${workspace.name}".`)
  }
}

async function processNoReplyBranches(env, now) {
  const rows = await env.DB.prepare(
    `SELECT s.id, s.campaign_id, s.lead_id, s.sequence_step, s.sent_at, l.workspace_id, l.status AS lead_status
     FROM sends s JOIN leads l ON l.id = s.lead_id
     JOIN campaigns c ON c.id = s.campaign_id
     WHERE s.sent_at IS NOT NULL AND s.status IN ('sent', 'delivered', 'opened', 'clicked')
       AND c.status = 'active' AND l.status NOT IN ('replied', 'bounced', 'unsubscribed')
     ORDER BY s.sent_at DESC LIMIT 200`,
  ).all()
  for (const send of rows.results ?? []) await executeBranches(env, send, 'no_reply_after_days', now)
}

async function executeBranches(env, send, condition, at) {
  const step = await env.DB.prepare(
    'SELECT id FROM sequences WHERE campaign_id = ? AND step_no = ?',
  ).bind(send.campaign_id, send.sequence_step).first()
  if (!step) return
  const rows = await env.DB.prepare(
    `SELECT id, condition, condition_value, action, action_value FROM branches
     WHERE sequence_id = ? AND condition = ?`,
  ).bind(step.id, condition).all()
  for (const branch of rows.results ?? []) {
    if (condition === 'no_reply_after_days' && at - Number(send.sent_at) < Number(branch.condition_value) * 86400000) continue
    const claim = await env.DB.prepare(
      'INSERT OR IGNORE INTO branch_executions (id, branch_id, send_id, created_at) VALUES (?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), branch.id, send.id, at).run()
    if ((claim.meta?.changes ?? 0) === 0) continue
    if (branch.action === 'stop') {
      await env.DB.prepare(
        `UPDATE sends SET status = 'stopped' WHERE campaign_id = ? AND lead_id = ? AND status = 'queued'`,
      ).bind(send.campaign_id, send.lead_id).run()
    } else if (branch.action === 'change_status' && VALID_LEAD_STATUSES.has(branch.action_value)) {
      await env.DB.prepare('UPDATE leads SET status = ? WHERE id = ?').bind(branch.action_value, send.lead_id).run()
      if (branch.action_value === 'unsubscribed' || branch.action_value === 'bounced') {
        const lead = await env.DB.prepare('SELECT workspace_id, email FROM leads WHERE id = ?').bind(send.lead_id).first()
        await env.DB.prepare(
          `INSERT INTO suppressions (id, workspace_id, email, reason, created_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, email) DO UPDATE SET reason = excluded.reason`,
        ).bind(crypto.randomUUID(), lead.workspace_id, lead.email, branch.action_value, at).run()
      }
    } else if (branch.action === 'send_followup') {
      const requestedStep = Number.parseInt(branch.action_value ?? '', 10)
      const next = Number.isInteger(requestedStep) && requestedStep > 0
        ? await env.DB.prepare('SELECT step_no, delay_days FROM sequences WHERE campaign_id = ? AND step_no = ?')
          .bind(send.campaign_id, requestedStep).first()
        : await env.DB.prepare(
          'SELECT step_no, delay_days FROM sequences WHERE campaign_id = ? AND step_no > ? ORDER BY step_no LIMIT 1',
        ).bind(send.campaign_id, send.sequence_step).first()
      if (next) {
        const replied = condition === 'replied'
        const dueAt = replied ? at : at + Number(next.delay_days) * 86400000
        await env.DB.prepare(
          `INSERT INTO sends
           (id, campaign_id, lead_id, sequence_step, status, scheduled_at, is_reply_followup, created_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
           ON CONFLICT(campaign_id, lead_id, sequence_step) DO UPDATE SET
             status = 'queued',
             scheduled_at = MIN(scheduled_at, excluded.scheduled_at),
             is_reply_followup = MAX(is_reply_followup, excluded.is_reply_followup)
           WHERE sends.status = 'queued' OR (excluded.is_reply_followup = 1 AND sends.status = 'stopped')`,
        ).bind(crypto.randomUUID(), send.campaign_id, send.lead_id, next.step_no, dueAt, replied ? 1 : 0, at).run()
      }
    } else if (branch.action === 'notify') {
      const workspace = await env.DB.prepare(
        `SELECT w.id, w.owner_email, c.name FROM campaigns c JOIN workspaces w ON w.id = c.workspace_id
         WHERE c.id = ?`,
      ).bind(send.campaign_id).first()
      if (workspace) await notifyWorkspace(env, workspace, `A sequence rule was triggered for campaign "${workspace.name}".`)
    }
  }
}

async function notifyWorkspace(env, workspace, message, emailAllowed = true) {
  await env.DB.prepare(
    'INSERT INTO notifications (id, workspace_id, message, created_at) VALUES (?, ?, ?, ?)',
  ).bind(crypto.randomUUID(), workspace.id, message.slice(0, 500), Date.now()).run()
  if (!emailAllowed || !workspace.owner_email || !env.BREVO_API_KEY) return
  const token = randomToken()
  await env.DB.prepare(
    'INSERT INTO unsubscribe_tokens (token_hash, workspace_id, lead_id, email, expires_at) VALUES (?, ?, NULL, ?, ?)',
  ).bind(base64Url(await sha256(token)), workspace.id, workspace.owner_email, Date.now() + 31536000000).run()
  const sent = await sendBrevo(env, {
    email: workspace.owner_email,
    subject: 'Kluzar Outreach notification',
    text: `${message}\n\nYou can review your workspace in Kluzar Outreach.`,
    unsubscribeToken: token,
    messageId: null,
    tag: 'kluzar-outreach-notification',
  })
  if (sent?.messageId) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO brevo_ignored_messages (provider_message_id, workspace_id, kind, created_at) VALUES (?, ?, ?, ?)',
    ).bind(sent.messageId, workspace.id, 'notification', Date.now()).run()
  }
}

async function sendDueMessages(env, now) {
  const rows = await env.DB.prepare(
    `SELECT s.id, s.campaign_id, s.lead_id, s.sequence_step, s.is_reply_followup,
            l.workspace_id, l.email AS lead_email, l.first_name, l.company, l.status AS lead_status,
            c.sender_id, c.status AS campaign_status, q.subject, q.body_template,
            d.type AS sender_type, d.address AS sender_address, d.display_name AS sender_name,
            d.credentials_ref, d.credentials_expires_at, w.owner_email
     FROM sends s JOIN campaigns c ON c.id = s.campaign_id
     JOIN leads l ON l.id = s.lead_id JOIN sequences q ON q.campaign_id = s.campaign_id AND q.step_no = s.sequence_step
     JOIN senders d ON d.id = c.sender_id JOIN workspaces w ON w.id = c.workspace_id
     WHERE s.status = 'queued' AND s.scheduled_at <= ? AND c.status = 'active'
     ORDER BY s.scheduled_at LIMIT 100`,
  ).bind(now).all()
  for (const send of rows.results ?? []) {
    if (!['gmail_oauth', 'outlook_oauth'].includes(send.sender_type)) {
      await env.DB.prepare("UPDATE sends SET status = 'stopped' WHERE id = ? AND status = 'queued'").bind(send.id).run()
      continue
    }
    if (['bounced', 'unsubscribed'].includes(send.lead_status) || (send.lead_status === 'replied' && !send.is_reply_followup)) {
      await env.DB.prepare("UPDATE sends SET status = 'stopped' WHERE id = ? AND status = 'queued'").bind(send.id).run()
      continue
    }
    const suppression = await env.DB.prepare('SELECT id FROM suppressions WHERE workspace_id = ? AND email = ?')
      .bind(send.workspace_id, send.lead_email).first()
    if (suppression) {
      await env.DB.prepare("UPDATE sends SET status = 'stopped' WHERE id = ? AND status = 'queued'").bind(send.id).run()
      continue
    }
    const sentToday = await dailySendCount(env, send.workspace_id, now)
    const lastAt = await lastSendAt(env, send.workspace_id)
    if (sentToday >= DAILY_SEND_LIMIT || (lastAt && now - lastAt < SEND_INTERVAL_SECONDS * 1000)) continue
    const claimed = await env.DB.prepare(
      "UPDATE sends SET status = 'sending', sending_at = ? WHERE id = ? AND status = 'queued' RETURNING id",
    ).bind(now, send.id).first()
    if (!claimed) continue
    const unsubscribeToken = randomToken()
    try {
      await env.DB.prepare(
        'INSERT INTO unsubscribe_tokens (token_hash, workspace_id, lead_id, email, expires_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(base64Url(await sha256(unsubscribeToken)), send.workspace_id, send.lead_id, send.lead_email, now + 31536000000).run()
    } catch {
      await env.DB.prepare("UPDATE sends SET status = 'failed' WHERE id = ?").bind(send.id).run()
      continue
    }
    const message = {
      email: send.lead_email,
      subject: send.subject,
      text: renderTemplate(send.body_template, { first_name: send.first_name ?? '', company: send.company ?? '' }),
      unsubscribeToken,
    }
    const sender = {
      id: send.sender_id,
      type: send.sender_type,
      address: send.sender_address,
      display_name: send.sender_name,
      credentials_ref: send.credentials_ref,
      credentials_expires_at: send.credentials_expires_at,
    }
    const credentials = await refreshSender(env, sender)
    const providerResult = !credentials ? null : sender.type === 'gmail_oauth'
      ? await sendGmail(env, sender, credentials, message)
      : await sendMicrosoft(sender, credentials, message)
    if (!providerResult) {
      await env.DB.prepare("UPDATE sends SET status = 'failed', sending_at = NULL WHERE id = ?").bind(send.id).run()
      continue
    }
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE sends SET status = 'sent', sent_at = ?, sending_at = NULL, provider_message_id = ?, provider_thread_id = ?
         WHERE id = ? AND status = 'sending'`,
      ).bind(Date.now(), providerResult.messageId, providerResult.threadId, send.id),
      env.DB.prepare("UPDATE leads SET status = 'contacted' WHERE id = ? AND status = 'new'").bind(send.lead_id),
    ])
    if (!send.is_reply_followup) {
      const next = await env.DB.prepare(
        'SELECT step_no, delay_days FROM sequences WHERE campaign_id = ? AND step_no > ? ORDER BY step_no LIMIT 1',
      ).bind(send.campaign_id, send.sequence_step).first()
      if (next) {
        const sentAt = Date.now()
        await env.DB.prepare(
          `INSERT OR IGNORE INTO sends (id, campaign_id, lead_id, sequence_step, status, scheduled_at, created_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
        ).bind(crypto.randomUUID(), send.campaign_id, send.lead_id, next.step_no, sentAt + Number(next.delay_days) * 86400000, sentAt).run()
      }
    }

  }
}

export {
  completeUpload,
  constantTimeEqual,
  countImportOverlap,
  createR2PresignedPutUrl,
  decryptToken,
  encryptToken,
  isValidEmail,
  normalizedBrevoEvent,
  parseCsv,
  renderTemplate,
}
