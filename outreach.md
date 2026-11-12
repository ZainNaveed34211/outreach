# Kluzar Outreach — Final Build Document (for Copilot)

Read this file and build the whole product from it. This file is the complete handoff — it supersedes the earlier spec and plan files. One build, everything in one go, no phases. Do not add features not listed here.

## 1. Product

- Name: Kluzar Outreach (final). Subdomains: outreach.kluzar.com (frontend), outreach-api.kluzar.com (API).
- What it is: a cold email outreach SYSTEM, not a mail server — campaigns, sequences with conditional branching, lead lists, replies inbox, tracking, test mode, workspaces, account + domain management. More advanced than Mailchimp, premium look, all-in-one dashboard.
- The client brings their OWN mailbox (Google Workspace / Gmail / Outlook via OAuth or SMTP) — mail goes from their domain, lands in Primary, replies come to them. Kluzar's default sender hello@kluzar.com via Brevo is the fallback and the test sender. We do NOT give clients a mailbox.
- Audience: Kluzar's clients first (managed outreach as a service), standalone SaaS for the general market after.
- Pricing: FREE — no end date; free until the product grows properly. The landing page shows the offer as "FREE for a limited time". No checkout, no paid plans in this build.

## 2. Technology stack (best — do not change)

- Frontend: Vite + React + TypeScript, Tailwind CSS (compiled into the build — no runtime CDN). Static build output is pushed to the `outreach` repo main branch; Cloudflare Pages deploys it (no build command in Pages — pre-built output, payments-repo pattern).
- Backend: Cloudflare Workers — all backend code in a single `worker.js` (JavaScript). API at outreach-api.kluzar.com, REST + JSON, base `/v1`.
- Repo separation (three repos): frontend `outreach` → Cloudflare Pages (outreach.kluzar.com); backend `outreach-api` → Worker (outreach-api.kluzar.com), code in `worker.js`; Accounts `ZainNaveed34211/login` → Worker kluzar-account-api — existing, do NOT modify (except the `ALLOWED_ORIGINS` env var, Zain's step).
- Data: D1 database `kluzar-outreach`. Files: R2 bucket `kluzar-outreach-files` (CSV uploads, attachments).
- Auth: Kluzar Accounts API — SESSION ONLY. Verify the user is logged in (user_id from session), nothing more. No entitlement/plan logic. Do NOT build a new auth/session system.
- Email: Brevo API (transactional). Analytics: GA4 `G-T30S2TK79K` on every page. Ads: AdSense `ca-pub-3050978093233454` tag on every page (account disapproved 2026-11-05 — tag loads, ads do not show or earn until re-approved).

## 3. Setup status (already done — do not redo)

- Cloudflare Pages project created + `outreach` repo connected on main branch; live with placeholder "ZAIN" page (HTTP 200, verified via curl).
- Worker outreach-api.kluzar.com created (custom domain set, NO code yet — code is shaped by the frontend).
- R2 activated + bucket `kluzar-outreach-files` created.
- Brevo: account created, domain kluzar.com verified (DKIM + DMARC green), sender hello@kluzar.com verified. API key "Kluzar Outreach" generated (Full access, Active, no expiry) — held by Zain; it goes ONLY into the Worker secret `BREVO_API_KEY` at deploy time. NEVER in chat, repo, or code. Do NOT enable Brevo's "Activate for API keys" IP blocking — Cloudflare Workers have dynamic egress IPs; enabling it blocks the Worker's calls to Brevo.
- Default headers Transform Rule excludes outreach: `not (http.host eq "outreach.kluzar.com")` — verified live (no content-security-policy header on outreach.kluzar.com).
- Still to do: create the `outreach-api` repo; create the D1 database; Worker secret at deploy; live test.

## 4. Pages and routing (landing FIRST — NO login check on arrival)

- `/` — public landing page (blog-type marketing page; take layout ideas from Mailchimp, do NOT copy it): hero, features, how it works, free offer, FAQ, footer. Header and pages carry Try Now + Login + Signup buttons. NO login check on arrival — the landing page loads for everyone.
- `/blog/` — blog with articles, for SEO (Copilot: write 4–6 launch articles on outreach / email deliverability topics).
- `/features/`, `/pricing/` (free offer), `/faq/` — main pages.
- `/privacy/`, `/terms/` — new legal pages.
- `/dashboard/` — the app. Login REQUIRED; redirect to Accounts login when not logged in. Dashboard pages: overview (stats), campaigns, leads, sequences, inbox, senders & domains, settings, test mode.
- Login / Signup buttons go to accounts.kluzar.com login / signup (central Accounts). Try Now: login check FIRST (not on the landing page), then the dashboard.
- Contact and support link to contact.kluzar.com and support.kluzar.com (already exist).

## 4.1 Account and session flow (the Accounts system already exists — Copilot did NOT build it)

The Kluzar Accounts system (accounts.kluzar.com, Worker kluzar-account-api) already exists. Do NOT build a new login/signup system. The flow:

- Login button → accounts.kluzar.com/login/?return=&lt;outreach URL&gt; — the user logs in and is returned to outreach. The return URL is validated against an allowlist (https only, Kluzar hosts only). If already logged in, the user is sent straight back to outreach.
- Signup button → accounts.kluzar.com/signup/?return=&lt;outreach URL&gt; — if the account already exists, the page shows "You are already signed up" and returns the user to outreach (with a link to login). If it does not exist, the user creates the account and is returned to outreach.
- Try Now → session check FIRST (there is no login check on the landing page itself): if the user is logged in, go straight to /dashboard/. If not, go through the login/signup flow above, then to /dashboard/.
- How the session is checked (exact contract, read from the existing Accounts Worker source — do not guess or invent): API base `https://account-api.kluzar.com` (Worker `kluzar-account-api`, repo `ZainNaveed34211/login`). Session endpoint: `GET https://account-api.kluzar.com/auth/session` — GET with `credentials: 'include'`, no body. 200 response: `{ ok: true, authenticated: true, user: { id, email, emailVerified, status, firstName, lastName, phone, mfaEnabled }, csrfToken: "<token>", entitlement: {...} }`. 401 response (no session): `{ ok: false, authenticated: false }`. The session cookie is `kluzar_session` — HttpOnly, Secure, SameSite=None, Path=/, Max-Age=172800 (48h), host-only to account-api.kluzar.com (no Domain attribute), set by the API on login via Set-Cookie. CSRF: the token comes from GET /auth/session (`csrfToken`); send it as the `X-CSRF-Token` header on state-changing requests — header only, never query string, cookie, or body. The server check is: token must equal the session's csrf_token AND the Origin header must be present and allowed. CORS on the Accounts API: methods GET/POST/PATCH/OPTIONS, headers Content-Type / X-CSRF-Token / X-Requested-With, credentials allowed, Vary: Origin. Allowed origins come from the Worker's `ALLOWED_ORIGINS` env var (default: only `https://accounts.kluzar.com`).
- LAUNCH-CRITICAL (Zain's step, not code): `https://outreach.kluzar.com` is NOT in the Accounts Worker's allowed origins by default — the `ALLOWED_ORIGINS` env var on the kluzar-account-api Worker must include `https://outreach.kluzar.com` (comma-separated, keeping the existing value), or the outreach frontend's credentialed calls to GET /auth/session will be blocked by CORS. Do NOT change Accounts code for this — env var only. Entitlement is returned by the session endpoint but outreach does NOT use it (session-only).
- Outreach side (Copilot builds this): the ?return= URLs, the Try Now logic, the session check on /dashboard/ and on every API call, the redirect to login on 401. Accounts side (already exists — do not rebuild): the login/signup pages and the return. If an Accounts page does not behave as described here, flag it to Zain — do not work around it in outreach code.

## 5. Features (build ALL of these)

1. Campaigns: name, sender identity, subject lines, email templates with variables ({{first_name}}, {{company}}).
2. Lead lists: CSV import (file to R2, parsed server-side, emails validated, deduped by workspace + email), manual add, list management, lead statuses (new, contacted, replied, interested, not interested, bounced, unsubscribed).
3. Sequences: multi-step follow-ups with delays (e.g. day 0, day 3, day 7); conditional branching — if no reply after N time → action (send a follow-up, change lead status, notify); if reply → action (stop sequence, mark interested, send a different message). Stop-on-reply is mandatory.
4. Sending: per-workspace sender — (a) client's OWN mailbox (Gmail / Microsoft OAuth or SMTP) — PRIMARY, strongly recommended; (b) Kluzar default hello@kluzar.com via Brevo — fallback only. Daily sending limits + throttling. Every email carries an unsubscribe link. Suppression lists: unsubscribed and bounced leads are never mailed again.
5. Replies inbox: one unified inbox per workspace; reply detection marks the lead replied and stops its sequence.
6. Tracking: per campaign and per lead — sent, delivered, opened, clicked, replied, bounced.
7. Workspaces: one per company; a user sees only their own workspaces.
8. Account + domain management: account settings; connected mailboxes; sender identities; domain verification status.
9. Test mode: send a test email and run a test campaign via hello@kluzar.com — the user enters only their own email, or builds their own campaign and runs it as a test (to their own email) to see exactly how it works. No mailbox connection needed to try.
10. PWA: manifest.json + service worker + install prompt — the Chrome "Install" option (Add to Home Screen).
11. SEO files: sitemap.xml, robots.txt, ads.txt, llms.txt.

## 6. What NOT to build

No LinkedIn outreach. No AI email writing. No email warmup. No A/B testing. No SMS / WhatsApp. No CRM or deals pipeline beyond lead status. No lead finding, scraping, or built-in lead database. No bulk sending to purchased lists. No pricing or checkout. No client mailboxes. No client-domain verification via Brevo. Do not add future features — decide later if needed.

## 7. API (worker.js)

- One Cloudflare Worker at outreach-api.kluzar.com. REST + JSON. Base: `https://outreach-api.kluzar.com/v1`.
- Auth on every request: the frontend sends the Accounts session; the Worker verifies the session against the Accounts API BEFORE any handler runs — fail closed (401, no data) on any failure. Every query is scoped to the caller's workspaces; a user can never touch another workspace.
- Origin check on every browser-facing endpoint: allow ONLY `https://outreach.kluzar.com` (exact match on the Origin header); reject all other origins. CORS: exact origin only, credentials allowed, NO wildcard `*`. The webhook endpoint does NOT use origin check — it uses Brevo signature verification. The unsubscribe endpoint does NOT use origin check — it uses a one-time token.
- CSRF (outreach-api mirrors the Accounts pattern): the API issues a per-session CSRF token (returned by `GET /v1/me`); state-changing requests send it as the `X-CSRF-Token` header only (never query string, cookie, or body), plus the Origin must be exactly `https://outreach.kluzar.com`.
- Endpoints:
  - `GET /v1/me` — session + the caller's workspaces.
  - `GET/POST /v1/workspaces` — list / create workspace.
  - `GET/POST/PATCH /v1/campaigns`, `GET/PATCH /v1/campaigns/:id`, `POST /v1/campaigns/:id/launch`, `POST /v1/campaigns/:id/pause`.
  - `GET/POST /v1/leads`, `POST /v1/leads/import` (CSV file to R2, parsed server-side, validated + deduped), `PATCH /v1/leads/:id`.
  - `GET/POST/PATCH /v1/sequences`, `GET/POST /v1/branches` — sequence steps + branching rules.
  - `GET/POST /v1/senders` — sender choice (client mailbox OAuth/SMTP, or Brevo default hello@kluzar.com).
  - `GET /v1/inbox` — replies per workspace.
  - `GET /v1/stats/:campaignId` — sent, delivered, opened, clicked, replied, bounced.
  - `POST /v1/test/send`, `POST /v1/test/campaign` — test mode via hello@kluzar.com (user's own email only).
  - `POST /v1/webhooks/brevo` — Brevo delivery/open/click/bounce/unsubscribe events (verify Brevo signature); updates events + sends.
  - `GET /v1/unsubscribe/:token` — public one-time-token unsubscribe; writes to suppressions.
- TWO APIs — do not confuse them: (1) outreach-api = OUR API (this Worker — build it). (2) Brevo's API = Brevo's email service (do NOT build it — our Worker CALLS it with `BREVO_API_KEY`).
- Sending: `POST https://api.brevo.com/v3/smtp/email` with the `api-key` header — the TRANSACTIONAL endpoint. Do NOT use Brevo's campaign endpoint `/v3/emailCampaigns` (that is Brevo's own campaign system; our campaigns live in our dashboard). Brevo's published code examples show the same `api-key` header auth pattern — use the pattern, not the campaign endpoint.
- Sending flow: request → Worker validates (session, workspace, sender, suppression, daily limit) → D1 write (`sends` = queued) → scheduled trigger picks due steps (delay elapsed, lead not replied, not suppressed, under limit) → Worker calls Brevo API from hello@kluzar.com, or Gmail API / Microsoft Graph with the workspace's stored OAuth token for client mailboxes → record status in D1. No raw SMTP from the Worker, ever.
- Scheduled sender: Worker scheduled trigger (cron) — picks due sequence steps, enforces per-workspace daily limits + throttling + branching actions.
- Files: CSV uploads go to R2 (presigned upload via the Worker, validated server-side); attachments served from R2 via the Worker after auth — never public R2 URLs.
- Errors: generic friendly messages only, no internals, no stack traces; fail closed on session failure.

## 8. Data model (D1 `kluzar-outreach` + R2 `kluzar-outreach-files`)

- workspaces: id, owner_user_id (Accounts user), name, created_at. One workspace per company; a user sees only their own workspaces.
- senders: id, workspace_id, type ('brevo_default' | 'gmail_oauth' | 'outlook_oauth' | 'smtp'), address, display_name, credentials_ref (encrypted server-side; OAuth tokens only — never plaintext passwords in D1), is_default, created_at.
- campaigns: id, workspace_id, name, sender_id, status ('draft' | 'active' | 'paused' | 'done'), created_at.
- leads: id, workspace_id, email, first_name, company, status ('new' | 'contacted' | 'replied' | 'interested' | 'not_interested' | 'bounced' | 'unsubscribed'), created_at. Unique (workspace_id, email).
- sequences: id, campaign_id, step_no, delay_days, subject, body_template, created_at.
- branches: id, sequence_id, condition ('no_reply_after_days' | 'replied'), condition_value, action ('send_followup' | 'change_status' | 'notify' | 'stop'), action_value, created_at.
- sends: id, campaign_id, lead_id, sequence_step, status ('queued' | 'sent' | 'delivered' | 'opened' | 'clicked' | 'replied' | 'bounced' | 'failed'), sent_at, opened_at, clicked_at, replied_at.
- suppressions: id, workspace_id, email, reason ('unsubscribed' | 'bounced' | 'complaint'), created_at. Suppressed emails are never mailed again.
- events: id, send_id, type ('delivered' | 'opened' | 'clicked' | 'replied' | 'bounced' | 'unsubscribed'), at, meta_json. Fed by Brevo webhooks + reply detection.
- files: id, workspace_id, kind ('csv_import' | 'attachment'), r2_key, filename, size_bytes, created_at. File bytes live in R2 only; D1 holds metadata + the R2 key.

## 9. Frontend requirements

- Favicon: the EXACT main-site favicon (same file as kluzar.com). Logo: the exact Kluzar logo — never recreated or changed.
- Design: premium, modern, clear, easy to understand. Logo palette: navy #141272 + violet #7c5cff + cyan accent. Self-hosted fonts (Inter / Manrope). No fake data, features, or charts.
- SEO first (no compromise): semantic HTML, meta description, Open Graph + Twitter cards on every page, canonical URLs, sitemap.xml, robots.txt, mobile-first responsive, fast loading. ads.txt contains exactly: `google.com, pub-3050978093233454, DIRECT, f08c47fec0942fa0`. llms.txt describes the product for LLM crawlers.
- Headers: a `_headers` file in the frontend repo root sets the full security headers (Content-Security-Policy including GA, AdSense and Cloudflare Insights domains; X-Content-Type-Options; Referrer-Policy; Permissions-Policy; etc.) — all properly configured. Google Ads + Analytics on EVERY page. Brevo is called server-side from the Worker only, so it needs no browser allowlist. The default Transform Rule already excludes outreach, so the `_headers` file is the only header source here.
- PWA: manifest.json + service worker + install prompt (Chrome install option).
- Performance: everything fast — frontend and Worker. No render-blocking third-party scripts.

## 10. Security — OWASP Top 10, advanced level (no compromise)

- SECURITY FIRST, above all other priorities. Security on BOTH sides — client-side AND server-side. Client-side validation is for UX only (fast feedback, escaping, CSP); it is NEVER trusted. Server-side is the enforcement: session, origin check, input validation, parameterized queries, rate limits — every request re-checked on the server, no exceptions. Sanitization at framework level AND a separate validation layer (defense in depth).
- Injection (SQL): parameterized queries only — never string-built queries, never trust client input.
- XSS: never innerHTML with user data (textContent / React escaping), output encoding everywhere, strict CSP.
- Broken authentication: session verified server-side on every request; fail closed; no data on 401; already-logged-in users go to /dashboard/ from login pages.
- Sensitive data exposure: secrets only in Worker secrets; OAuth tokens encrypted server-side; no secrets, tokens, or keys in frontend code, repo, or chat.
- Broken access control: workspace scoping on every query (IDOR prevention) — a user can never touch another workspace.
- CSRF: tokens on state-changing requests; SameSite cookies; Origin header check on every browser-facing endpoint (exact `https://outreach.kluzar.com` only).
- Security misconfiguration: least-privilege CORS (exact origins), no debug endpoints, no stack traces in errors.
- Vulnerable components: no unvetted dependencies; self-hosted assets only.
- SSRF: no user-controlled fetch targets; the Worker calls only allowlisted APIs (Brevo, Gmail API, Microsoft Graph, Accounts API).
- File uploads: validate type + size server-side, store in R2 only, serve via Worker after auth.
- Logging: no secrets, tokens, or PII in logs. Errors: generic friendly messages only.

## 11. Binding rules

- No comments in new code. No third-party URLs — self-host assets (approved exceptions: GA, AdSense, Cloudflare Insights). Use "Muse" only, never "Claude". No invented clients, prices, testimonials, results, or metrics. No fake data anywhere.

## 12. R2 manual config (Copilot: also write r2.md)

- Copilot must ALSO create `r2.md` in the repo: step-by-step manual R2 configuration (bucket `kluzar-outreach-files`, Worker binding, CORS if needed, public access OFF, presigned upload flow) so Zain can configure it manually.

## 13. Build order (one build, in this order — no phases)

1. Repos + D1 + Worker scaffold (`worker.js`) + session verification.
2. Brevo client + webhooks + scheduled sender (limits, throttling, suppression, branching).
3. Core features: campaigns, leads, sequences + branching, sending, inbox, tracking, test mode, account + domain management.
4. Dashboard UI + landing page + blog + legal pages + PWA + SEO files + `_headers` + `r2.md`.
5. Hardening (OWASP Top 10 pass) + deploy: frontend pre-built output to `outreach` repo main (Pages auto-deploys); Worker via GitHub Actions (browser-created workflow, never terminal/wrangler). `BREVO_API_KEY` as Worker secret.
6. Live test with real data only — no invented campaigns or leads. Zain verifies in his browser: landing → Try Now → login → build test campaign → send test to his own email → check inbox + tracking.

## 14. Who does what

- Zain (his hands only): Brevo (done), R2 (done), headers rule (done), Pages (done), Worker (done, no code), Worker secret `BREVO_API_KEY` at deploy time, live browser verification.
- Copilot (all code): repos, Worker `worker.js`, frontend, Brevo integration, cron sender, webhooks, test mode, `r2.md`, hardening, deploy workflows.
