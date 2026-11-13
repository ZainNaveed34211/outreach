import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { clearAssertion, fetchAccountSession, getAssertion } from './lib/account'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'https://outreach-api.kluzar.com/v1'
const ACCOUNT_BASE = 'https://accounts.kluzar.com'
const CONTACT_URL = 'https://contact.kluzar.com'
const SUPPORT_URL = 'https://support.kluzar.com'

type Workspace = { id: string; name: string }
type ApiResult<T> = { data?: T; error?: string; csrfToken?: string }
type Campaign = { id: string; name: string; status: string; lead_list_id: string; sender_id?: string | null; scheduled_at?: number | null }
type Lead = { id: string; email: string; first_name?: string; company?: string; status: string }
type LeadList = { id: string; name: string; lead_count: number }
type Sender = { id: string; type: string; address: string; display_name: string; is_default: number }
type Reply = { id: string; sender_email: string; subject: string; body_text: string; received_at: number; read_at?: number | null; lead_email: string; lead_id?: string; campaign_id?: string }
type SequenceStep = { id: string; campaign_id: string; step_no: number; subject: string; delay_days: number }
type Notification = { id: string; message: string; created_at: number; read_at: number | null }
type OnboardingState = { senderConnected: boolean; leadsAdded: boolean; campaignCreated: boolean; testSent: boolean; launched: boolean }
type ActivityItem = { id: string; type: string; message: string; created_at: number }
type Snippet = { id: string; title: string; body: string; created_at: number }
type Suppression = { id: string; email: string; reason: string; created_at: number }
type PreviewStep = { step_no: number; delay_days: number; subject: string; body: string }
type PreviewData = { campaign: { id: string; name: string }; lead: { id: string; email: string; first_name?: string | null; company?: string | null } | null; steps: PreviewStep[] }
type PrelaunchData = { campaign: { id: string; name: string; status: string; scheduled_at?: number | null }; sender: { id: string; type: string; address: string } | null; senderReady: boolean; steps: number; hasFirstStep: boolean; totalInList: number; readyToSend: number; suppressedInList: number; excludedInList: number; variablesUsed: { first_name: boolean; company: boolean }; fieldsPresent: { first_name: boolean; company: boolean } }
type TimelineEvent = { type: string; at: number; campaign_name?: string | null; sequence_step?: number | null }
type TimelineData = { lead: Lead; timeline: TimelineEvent[] }

const articles = [
  {
    slug: 'a-practical-guide-to-email-deliverability',
    title: 'A practical guide to email deliverability',
    description: 'Build a responsible sending setup before you send your first campaign.',
    body: [
      'Email deliverability starts with the mailbox and domain you send from. Use a mailbox you control, verify its domain authentication, and begin with recipients who have a legitimate reason to hear from you. A message sent from your own domain, through a mailbox you own, is judged by mailbox providers on the reputation of that domain — not on the reputation of a shared sending service.',
      'Check the three authentication records for your sending domain with your mailbox or domain provider: SPF, which lists the servers allowed to send for your domain; DKIM, which signs each message so receivers can confirm it was not altered; and DMARC, which tells receivers what to do when a message fails those checks. If any of these is missing or wrong, legitimate mail can be treated as suspicious even when the content is fine.',
      'Warm up a new mailbox gradually. Start with a small number of messages to people you already have a relationship with, and increase volume slowly over days and weeks rather than sending a large batch on day one. A sudden spike from a domain with no sending history is one of the most common reasons new senders land in spam.',
      'Keep messages relevant and clear. Make it easy for recipients to unsubscribe, honour opt-outs promptly, and remove invalid addresses rather than repeatedly retrying them. Every bounce and complaint is a signal to mailbox providers, so a clean list protects your domain for the next campaign as well as this one.',
      'Monitor bounces and replies as well as opens. Open tracking can be incomplete, so it should never be treated as proof that a person read a message. A reply, even a short one, is a far stronger signal than an open — and in Kluzar Outreach a detected reply stops the follow-up sequence for that lead automatically.',
      'Finally, test before you launch. Send the campaign to your own address first, read it in the email client your recipients are likely to use, and check the sender name, the links, and the unsubscribe experience. A test that reaches your own inbox tells you more about deliverability than any checklist on its own.',
    ],
  },
  {
    slug: 'how-to-plan-a-respectful-outreach-sequence',
    title: 'How to plan a respectful outreach sequence',
    description: 'Use a small number of useful follow-ups and stop as soon as someone replies.',
    body: [
      'A good sequence has a clear purpose for each message. Start with a relevant reason for writing, then use a follow-up only when it adds useful context. If the second message says nothing the first one did not, it is noise — and noise is what gets a sender marked as spam.',
      'Write the first message as if it were the only one. State who you are, why you are writing to this person specifically, and what you are asking for, in as few lines as you can. A short message that is clearly about the recipient will always outperform a long message about yourself.',
      'Set delays that leave recipients room to respond. A follow-up two or three days after the first message is reasonable for most outreach; same-day follow-ups feel automated and are read as pressure. Leave at least a few days between steps, and keep the total number of steps small — two or three messages is enough for most purposes.',
      'Stop the sequence on reply, unsubscribe, bounce, or any other suppression signal. Continuing to send after someone has replied, or after they have asked to stop, damages your reputation and your relationship with that person. In Kluzar Outreach this is built in: reply detection stops the lead\u2019s active sequence, and suppressed addresses are checked before every send, including scheduled follow-ups.',
      'Personalisation should use verified information, not guesses about the recipient. A first name and a company name from your own records are enough. Invented details — a guessed job title, a wrong product name, a compliment about work the person never did — are worse than no personalisation at all, because they prove the message was not really written for them.',
      'Review every message for accuracy before launch. Read each step aloud, check every link, and send a test to your own address. A small, deliberate launch is easier to monitor than an unchecked bulk send, and it gives you a chance to fix a mistake while it has only reached one inbox.',
    ],
  },
  {
    slug: 'using-suppression-lists-correctly',
    title: 'Using suppression lists correctly',
    description: 'Why unsubscribed and bounced addresses need to stay out of future sends.',
    body: [
      'A suppression list is a safety control, not just a campaign setting. Check it immediately before every send, including scheduled follow-ups. An address that unsubscribed yesterday must not receive a follow-up that was scheduled last week — the check has to happen at send time, not at list-building time.',
      'Keep suppression records scoped and protected. Restrict access to the workspace that owns them and record the reason an address was suppressed. A suppression created because someone unsubscribed, one created because a message bounced, and one created because of a complaint are different facts, and the reason matters if the address is ever questioned later.',
      'Treat complaints and unsubscribe requests as signals to stop. Do not re-import an address in a way that bypasses an existing suppression. If a list import contains an address that is already suppressed, the import must not revive it — the suppression wins, every time.',
      'Bounces need the same discipline. A hard bounce means the address does not exist or will not accept mail, and retrying it repeatedly harms your sender reputation. A soft bounce, such as a full mailbox, may be worth one careful retry, but a pattern of bounces from the same domain is a sign to pause and check your list rather than push through it.',
      'Suppression is also a matter of consent. Someone who asked to stop hearing from you has not consented to a different campaign from the same workspace, a different sender address, or a message sent a month later. One suppression covers the workspace, not just the campaign that created it.',
      'In Kluzar Outreach, suppressions are checked before sending, unsubscribed and bounced addresses are excluded from future sends, and leads can be marked unsubscribed from the dashboard. If you are unsure whether an address should receive mail, the safe answer is no — leave it suppressed and move on.',
    ],
  },
  {
    slug: 'testing-an-email-campaign-before-launch',
    title: 'Testing an email campaign before launch',
    description: 'Preview the message, validate its links, and test with your own address.',
    body: [
      'Read each message in the email client your recipients are likely to use. Check formatting, links, sender identity, and the unsubscribe experience. A message that looks right in one client can break in another, so check the plain-text rendering as well as the styled one — Kluzar Outreach sends plain-text messages, which keeps this simpler, but the sender name and the subject line still deserve a careful look.',
      'Use a test recipient that you control. Confirm that the content renders as expected and that the campaign does not reach other contacts in test mode. In Kluzar Outreach, test mode sends only to your own verified account email — never to workspace leads — so a test is always safe to run, even on a live campaign draft.',
      'Test the whole sequence, not just the first message. If your campaign has a follow-up step, send a test of that step too and check its delay and its wording in context. A follow-up that reads well on its own can still feel wrong when it arrives three days after the first message.',
      'Check the links by clicking them. Every link in a test message should lead where you expect, and none of them should be broken or point at a placeholder. A single dead link in an outreach email tells the recipient the message was not checked — and it wastes the one chance you had to make a good impression.',
      'Before launch, review the audience and suppression state once more. Confirm the lead list is the right one, confirm the sender is the mailbox you intend to send from, and confirm that suppressed addresses are excluded. Launch also asks you to confirm you have permission to contact the list — treat that confirmation as a real check, not a formality.',
      'A small, deliberate launch is easier to monitor than an unchecked bulk send. After launching, watch the replies inbox and the campaign stats. If something looks wrong — a bounce, a confused reply, a formatting problem you missed — pause, fix it, and only then continue. The first hour after launch is when a mistake is cheapest to correct.',
    ],
  },
]

const pageDescriptions: Record<string, string> = {
  '/': 'Plan thoughtful email outreach with campaigns, sequences, lead lists, and a unified replies inbox.',
  '/features/': 'Explore Kluzar Outreach campaign, lead, sequence, inbox, and sender features.',
  '/pricing/': 'Kluzar Outreach is free for a limited time. No checkout or paid plans are available in this build.',
  '/faq/': 'Answers about Kluzar Outreach, sender accounts, testing, sequences, and privacy.',
  '/privacy/': 'Learn how Kluzar Outreach is designed to handle account, workspace, and campaign data.',
  '/terms/': 'Terms for accessing and using Kluzar Outreach.',
  '/blog/': 'Practical guidance on responsible outreach, email deliverability, and campaign testing.',
}

function pageTitle(path: string) {
  if (path.startsWith('/blog/')) {
    const slug = path.split('/').filter(Boolean)[1]
    return articles.find((article) => article.slug === slug)?.title ?? 'Blog'
  }
  const titles: Record<string, string> = {
    '/': 'Kluzar Outreach — Thoughtful outreach, clearly managed',
    '/features/': 'Features — Kluzar Outreach',
    '/pricing/': 'Pricing — Kluzar Outreach',
    '/faq/': 'FAQ — Kluzar Outreach',
    '/privacy/': 'Privacy — Kluzar Outreach',
    '/terms/': 'Terms — Kluzar Outreach',
    '/blog/': 'Outreach insights — Kluzar Outreach',
    '/login/': 'Sign in — Kluzar Outreach',
  }
  if (path.startsWith('/dashboard/') || path.startsWith('/oauth/')) return 'Dashboard — Kluzar Outreach'
  return titles[path] ?? 'Page not found — Kluzar Outreach'
}

async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  csrfToken?: string,
): Promise<{ response: Response; payload: ApiResult<T> }> {
  const attempt = async (): Promise<{ response: Response; payload: ApiResult<T> }> => {
    const assertion = csrfToken ? await getAssertion(csrfToken) : null
    if (!assertion) return { response: new Response(null, { status: 401 }), payload: {} }
    const headers = new Headers(options.headers)
    headers.set('Accept', 'application/json')
    if (typeof options.body === 'string') headers.set('Content-Type', 'application/json')
    headers.set('Authorization', `Bearer ${assertion}`)
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      credentials: 'include',
      cache: 'no-store',
    })
    const payload = (await response.json().catch(() => ({}))) as ApiResult<T>
    return { response, payload }
  }
  const first = await attempt()
  if (first.response.status !== 401) return first
  clearAssertion()
  return attempt()
}

function accountUrl(mode: 'login' | 'signup', returnTo: string) {
  const target = new URL(`/${mode}/`, ACCOUNT_BASE)
  target.searchParams.set('next', returnTo)
  return target.toString()
}

function usePageMetadata(path: string) {
  useEffect(() => {
    const description = pageDescriptions[path] ?? 'Practical guidance and tools for managing thoughtful outreach.'
    const canonical = `https://outreach.kluzar.com${path}`
    const title = pageTitle(path)
    document.title = title
    const setMeta = (selector: string, key: string, value: string) => {
      let element = document.head.querySelector<HTMLMetaElement>(selector)
      if (!element) {
        element = document.createElement('meta')
        element.setAttribute(selector.includes('[property=') ? 'property' : 'name', key)
        document.head.append(element)
      }
      element.content = value
    }
    setMeta('meta[name="description"]', 'name', description)
    setMeta('meta[property="og:title"]', 'property', title)
    setMeta('meta[property="og:description"]', 'property', description)
    setMeta('meta[property="og:url"]', 'property', canonical)
    setMeta('meta[name="twitter:card"]', 'name', 'summary')
    setMeta('meta[name="twitter:title"]', 'name', title)
    setMeta('meta[name="twitter:description"]', 'name', description)
    let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')
    if (!link) {
      link = document.createElement('link')
      link.rel = 'canonical'
      document.head.append(link)
    }
    link.href = canonical
  }, [path])
}

function useAnalytics(path: string) {
  useEffect(() => {
    if (path.startsWith('/oauth/')) return
    const win = window as Window & { dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void }
    win.dataLayer ??= []
    win.gtag ??= (...args: unknown[]) => win.dataLayer?.push(args)
    if (!document.querySelector('[data-kluzar-gtag]')) {
      const script = document.createElement('script')
      script.async = true
      script.src = 'https://www.googletagmanager.com/gtag/js?id=G-T30S2TK79K'
      script.dataset.kluzarGtag = 'true'
      document.head.append(script)
      win.gtag('js', new Date())
      win.gtag('config', 'G-T30S2TK79K', { send_page_view: false })
    }
    win.gtag('event', 'page_view', {
      page_title: document.title,
      page_location: window.location.href,
      page_path: path,
    })
    if (!document.querySelector('[data-kluzar-ads]')) {
      const script = document.createElement('script')
      script.async = true
      script.crossOrigin = 'anonymous'
      script.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3050978093233454'
      script.dataset.kluzarAds = 'true'
      document.head.append(script)
    }
  }, [path])
}

function Logo({ small = false }: { small?: boolean }) {
  return <img className={small ? 'brand-logo brand-logo-small' : 'brand-logo'} src="/brand/kluzar-logo.png" alt="Kluzar" />
}

function LogoDark({ small = false }: { small?: boolean }) {
  return <img className={small ? 'brand-logo brand-logo-small' : 'brand-logo'} src="/brand/logo-dark.png" alt="Kluzar" />
}

function Header() {
  const returnTo = `${window.location.origin}/dashboard/`
  return (
    <header className="site-header">
      <a className="brand-link" href="/" aria-label="Kluzar Outreach home"><Logo /></a>
      <nav className="main-nav" aria-label="Main navigation">
        <a href="/features/">Features</a>
        <a href="/pricing/">Pricing</a>
        <a href="/blog/">Resources</a>
      </nav>
      <div className="header-actions">
        <a className="button button-quiet" href={accountUrl('login', returnTo)}>Log in</a>
        <a className="button button-primary button-small" href={accountUrl('signup', returnTo)}>Sign up</a>
      </div>
    </header>
  )
}

const INSTAGRAM_URL = 'https://www.instagram.com/kluzar.official/'
const YOUTUBE_URL = 'https://www.youtube.com/@kluzar.official'

function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-main">
        <div className="footer-brand">
          <LogoDark small />
          <p>Organise. Outreach. Grow.</p>
          <p>Outreach, organised around your own mailbox. Campaigns, sequences, leads and replies in one calm workspace.</p>
          <div className="footer-social">
            <a href={INSTAGRAM_URL} target="_blank" rel="noreferrer">Instagram <span aria-hidden="true">↗</span></a>
            <a href={YOUTUBE_URL} target="_blank" rel="noreferrer">YouTube <span aria-hidden="true">↗</span></a>
          </div>
        </div>
        <nav className="footer-columns" aria-label="Footer navigation">
          <div>
            <h3>Product</h3>
            <a href="/features/">Features</a>
            <a href="/pricing/">Pricing</a>
            <a href="/faq/">FAQ</a>
            <a href="/login/">Sign in</a>
          </div>
          <div>
            <h3>Resources</h3>
            <a href="/blog/">Blog</a>
            <a href="/blog/a-practical-guide-to-email-deliverability/">Deliverability guide</a>
            <a href="/blog/how-to-plan-a-respectful-outreach-sequence/">Sequence planning</a>
            <a href="/blog/testing-an-email-campaign-before-launch/">Testing before launch</a>
          </div>
          <div>
            <h3>Kluzar</h3>
            <a href="https://kluzar.com/">Kluzar home</a>
            <a href={CONTACT_URL}>Contact</a>
            <a href={SUPPORT_URL}>Support</a>
            <a href="/privacy/">Privacy</a>
            <a href="/terms/">Terms</a>
          </div>
        </nav>
      </div>
      <p className="copyright">© {new Date().getFullYear()} Kluzar. All rights reserved.</p>
    </footer>
  )
}

function LandingPage({ onTry, tryError }: { onTry: () => void; tryError: string }) {
  return (
    <>
      <Header />
      <main>
        <section className="hero-section">
          <div className="hero-copy">
            <p className="eyebrow"><span className="eyebrow-dot" /> Kluzar Outreach</p>
            <h1>Good outreach starts with <span className="hero-accent">good organisation.<svg className="hero-swoosh" viewBox="0 0 320 14" aria-hidden="true" focusable="false"><path d="M4 10 C 80 3, 240 3, 316 8" /></svg></span></h1>
            <p className="hero-description">Plan campaigns, build thoughtful follow-ups, manage your leads, and keep every reply in one place.</p>
            <div className="hero-actions">
              <button className="button button-primary" onClick={onTry}>Try now <span aria-hidden="true">→</span></button>
              <a className="button button-outline" href="/features/">Explore features</a>
            </div>
            {tryError && <p className="try-error" role="alert">{tryError}</p>}
            <p className="hero-note">Use your own mailbox. Start with a test sent only to you.</p>
          </div>
          <div className="hero-art" aria-label="Outreach dashboard preview">
            <div className="art-glow" />
            <div className="preview-window">
              <div className="preview-topbar"><span /><span /><span /><b>Campaign overview</b><i>•••</i></div>
              <div className="preview-content">
                <div className="preview-sidebar"><b /><span /><span /><span /><span /></div>
                <div className="preview-main">
                  <div className="preview-heading"><div><small>WORKSPACE</small><strong>Campaign overview</strong></div><i>+ New campaign</i></div>
                  <div className="preview-cards"><div><small>Campaigns</small><strong>Plan</strong><span>Build and review</span></div><div><small>Sequences</small><strong>Follow up</strong><span>Stop on reply</span></div><div><small>Inbox</small><strong>Stay in sync</strong><span>Replies in one place</span></div></div>
                  <div className="preview-table"><div><span>RECENT CAMPAIGNS</span><span>VIEW ALL →</span></div><p><i /> Create your first campaign <em>Draft</em></p><p><i /> Connect a sender <em>Next step</em></p></div>
                </div>
              </div>
            </div>
            <div className="floating-card"><span className="floating-check">✓</span><div><strong>Stop on reply</strong><small>Always enabled</small></div></div>
          </div>
        </section>

        <section className="trust-strip" aria-label="Product principles">
          <p>Designed for real outreach, with practical safeguards built in.</p>
          <div><span>↗</span> Your mailbox, your sender identity</div><div><span>◎</span> Replies stop follow-ups</div><div><span>⌁</span> Suppression checked before sending</div>
        </section>

        <section className="section section-features">
          <div className="section-heading">
            <p className="eyebrow">A clearer workflow</p>
            <h2>Everything in one <span>calm workspace.</span></h2>
            <p>From the first lead to the last reply, keep your outreach easy to understand and manage.</p>
          </div>
          <div className="feature-grid">
            <FeatureCard number="01" title="Campaigns that stay clear" body="Organise senders, messages, audiences, and campaign status in one place." icon="↗" points={['One draft per campaign, reviewed before launch', 'Launch asks you to confirm you have permission to contact the list']} />
            <FeatureCard number="02" title="Follow-ups with a purpose" body="Create timed sequences and branching rules, with stop-on-reply built in." icon="⌁" points={['Set the delay in days for each step', 'Branch when there is no reply, or stop when there is one']} />
            <FeatureCard number="03" title="Leads you can manage" body="Import and organise your own contacts, with workspace-level deduplication." icon="◎" points={['Add leads one by one, or import a CSV', 'Invalid and duplicate addresses are rejected on import']} />
            <FeatureCard number="04" title="Replies together" body="Keep campaign replies in a unified inbox and let conversations stop sequences." icon="↩" points={['Replies detected from connected mailbox threads', 'A reply stops the lead\u2019s active sequence automatically']} />
            <FeatureCard number="05" title="Your sender, your domain" body="Connect a supported mailbox or use the Kluzar sender for testing." icon="✳" points={['Gmail and Microsoft via OAuth — no passwords stored', 'The Kluzar sender is for tests only, never for campaigns']} />
            <FeatureCard number="06" title="Test before you launch" body="Send test messages to your own address without connecting a mailbox." icon="□" points={['Test a single message or a whole campaign draft', 'Tests go only to your verified account email']} />
          </div>
        </section>

        <section className="section steps-section">
          <div className="section-heading">
            <p className="eyebrow">How it works</p>
            <h2>Set up with <span>confidence.</span></h2>
            <p>Three steps, in order. Nothing is sent until you have tested it and confirmed you have permission to contact the list.</p>
          </div>
          <div className="steps-grid">
            <Step number="01" title="Bring your leads" body="Add contacts manually or import a CSV you are authorised to use." detail="Create a lead list for each audience, then add contacts one by one or import a CSV file. Imports are validated on the server: invalid and duplicate addresses are rejected, and addresses that are already suppressed stay suppressed. Only import contacts you are authorised to contact — purchased or scraped lists do not belong here." />
            <Step number="02" title="Build your sequence" body="Write useful messages, set delays, and decide what happens after a reply." detail="Write the first message, then add a follow-up with a delay in days. Use the first-name and company details you already hold to personalise each message. Add a branch if you need one — for example, stop the sequence when a reply is detected, or send a follow-up only when there has been no reply after a few days." />
            <Step number="03" title="Test, then send" body="Preview the experience with a test to your own email before launch." detail="Send a test of the campaign to your own verified email and read it the way a recipient would. When the message, the audience and the sender all look right, launch the draft — and confirm you have permission to contact the list. Sending is paced and suppression is checked before every send." />
          </div>
          <p className="steps-note">New here? Start with test mode: it needs no mailbox at all, and a test reaches only your own email. <a href="/faq/">Read the FAQ</a> or <a href="/blog/testing-an-email-campaign-before-launch/">learn how to test a campaign</a>.</p>
        </section>

        <section className="section security-section" id="security">
          <div className="section-heading section-heading-left">
            <p className="eyebrow">Security first</p>
            <h2>Built to protect your mailbox, your lists, and your recipients.</h2>
            <p>Outreach touches your email account and your contacts, so the safeguards are part of the product — not an afterthought.</p>
          </div>
          <div className="security-grid">
            <article className="security-card"><h3>Your mailbox, connected by OAuth</h3><p>Connect Gmail or Microsoft with OAuth. You sign in with the mailbox provider, and Kluzar Outreach never asks for or stores your mailbox password. Access tokens are encrypted on the server and are never shown in the frontend.</p></article>
            <article className="security-card"><h3>Suppression checked before every send</h3><p>Unsubscribed, bounced and complained addresses are recorded as suppressions and checked immediately before sending — including scheduled follow-ups. A suppression is never bypassed by re-importing the address.</p></article>
            <article className="security-card"><h3>Stop on reply, always</h3><p>Replies are detected from your connected mailbox threads and brought into the workspace inbox. When a lead replies, their active sequence stops. Nobody keeps receiving follow-ups after they have answered you.</p></article>
            <article className="security-card"><h3>Exact-origin API and CSRF protection</h3><p>The API accepts requests only from the Outreach origin, and state-changing requests carry CSRF protection. Workspace data is scoped to its owner — one workspace cannot read another\u2019s campaigns, leads or replies.</p></article>
            <article className="security-card"><h3>Permission confirmed before launch</h3><p>Launching a campaign asks you to confirm you have permission to contact the list. It is a deliberate step, not a formality, and it sits alongside the sending limits that keep volume responsible.</p></article>
            <article className="security-card"><h3>Test-only fallback sender</h3><p>The Kluzar sender exists so you can test without connecting a mailbox. It is test-only: production campaigns require your own connected mailbox, so replies can be monitored and follow-ups can stop.</p></article>
          </div>
        </section>

        <section className="section mailbox-section">
          <div className="mailbox-copy">
            <p className="eyebrow">Why your own mailbox</p>
            <h2>Mail from your own domain lands where people actually look.</h2>
            <p>When outreach is sent from your own mailbox and your own domain, it arrives as a message from a real person at a real business — in the Primary inbox, with replies coming straight back to you.</p>
            <p>Shared sending services send from shared infrastructure, and mailbox providers treat that mail with suspicion: it is far more likely to land in Promotions, or in spam, because its reputation is shared with every other sender on the same system. Your own mailbox carries only your own reputation.</p>
            <ul className="check-list">
              <li><strong>Your sender identity.</strong> The name and domain your recipients see are yours, so a reply goes to you — not to a no-reply address.</li>
              <li><strong>Replies come back to you.</strong> Replies land in your mailbox and in the Outreach inbox, and the follow-up sequence stops.</li>
              <li><strong>Your domain builds its own reputation.</strong> Responsible sending from your domain improves how providers treat your mail over time.</li>
            </ul>
            <a className="text-link" href="/features/">See how senders work <span aria-hidden="true">→</span></a>
          </div>
          <div className="mailbox-card" aria-label="Your mailbox versus a shared sender">
            <div className="mailbox-row mailbox-row-good"><span className="mailbox-tag">Your mailbox</span><strong>Primary inbox</strong><p>From your domain, with your name on it. Replies return to you.</p></div>
            <div className="mailbox-row"><span className="mailbox-tag mailbox-tag-muted">Shared sender</span><strong>Promotions — or spam</strong><p>Shared infrastructure, shared reputation, and replies that go nowhere useful.</p></div>
            <p className="mailbox-foot">Connect Gmail or Microsoft from the dashboard, or start with a test that needs no mailbox at all.</p>
          </div>
        </section>

        <section className="section rules-section">
          <div className="section-heading">
            <p className="eyebrow">Sending rules</p>
            <h2>Plain limits, stated plainly.</h2>
            <p>These limits protect your domain reputation and your recipients. They apply to every workspace, every campaign.</p>
          </div>
          <div className="rules-grid">
            <article className="rule-card"><strong>50</strong><h3>sends per workspace, per day</h3><p>A daily cap keeps volume deliberate and keeps a new domain from burning its reputation in a single afternoon.</p></article>
            <article className="rule-card"><strong>60s</strong><h3>minimum gap between sends</h3><p>At least sixty seconds pass between messages. Outreach is paced like a person sending email — because it is.</p></article>
            <article className="rule-card"><strong>Test only</strong><h3>test mode sends to you alone</h3><p>Test messages go only to your verified account email, never to workspace leads — even when you test a live campaign draft.</p></article>
          </div>
          <p className="rules-note">Suppression is checked before every send, replies stop follow-ups, and launching a campaign asks you to confirm you have permission to contact the list. <a href="/faq/">More in the FAQ</a>.</p>
        </section>

        <section className="section notdo-section">
          <div className="section-heading">
            <p className="eyebrow">Honest limits</p>
            <h2>What Outreach does not do.</h2>
            <p>A tool that says no to the wrong kind of outreach is a tool you can trust with the right kind.</p>
          </div>
          <div className="notdo-grid">
            <article className="notdo-card"><h3>No purchased lists</h3><p>There is no list marketplace and no bought contacts. You bring contacts you are authorised to contact, and imports are validated and deduplicated.</p></article>
            <article className="notdo-card"><h3>No bulk spam</h3><p>Daily limits, a minimum gap between sends, and suppression checks before every send are built in — not optional settings you have to remember to turn on.</p></article>
            <article className="notdo-card"><h3>No LinkedIn</h3><p>Outreach is email outreach. There is no LinkedIn automation, no connection requests, and no social inbox.</p></article>
            <article className="notdo-card"><h3>No AI-written emails</h3><p>Your messages are written by you, in your words. There is no AI drafting, no generated templates, and no invented personalisation.</p></article>
            <article className="notdo-card"><h3>No client mailboxes</h3><p>Kluzar does not provide mailboxes. You connect a mailbox you control, and the Kluzar sender exists only for tests.</p></article>
            <article className="notdo-card"><h3>No fake results</h3><p>There are no invented open rates, no sample dashboards, and no demo data. What you see in your workspace is your own work — or an honest empty state.</p></article>
          </div>
        </section>

        <section className="offer-section">
          <div><p className="eyebrow">Early access</p><h2>Start with the essentials.<br /><span>Stay in control.</span></h2><p>Kluzar Outreach is free for a limited time. No checkout or paid plans in this build.</p><ul className="offer-list"><li>Campaigns, sequences, leads and the replies inbox</li><li>Your own mailbox via Gmail or Microsoft OAuth</li><li>Test mode — no mailbox needed to try it</li></ul></div>
          <div className="offer-side"><button className="button button-light" onClick={onTry}>Try now <span aria-hidden="true">→</span></button><p>No card required. No paid plan to choose.</p></div>
          <div className="offer-orb" aria-hidden="true" />
        </section>

        <section className="section faq-preview">
          <div className="section-heading"><p className="eyebrow">Questions</p><h2>Know before <span>you begin.</span></h2><p>Short answers to the questions people ask first. The full list covers limits, mailboxes, suppression and data handling.</p><a className="text-link" href="/faq/">Read all FAQs <span aria-hidden="true">→</span></a></div>
          <div className="faq-list">
            <details><summary>Do I need to connect a mailbox to try it?</summary><p>No. Test mode lets you send a test to your own email through the Kluzar sender.</p></details>
            <details><summary>Does Kluzar provide me with an email inbox?</summary><p>No. Connect a mailbox you control to send from your own domain. Kluzar does not provide client mailboxes.</p></details>
            <details><summary>What happens when someone replies?</summary><p>Replies are brought into the workspace inbox and the lead's sequence stops.</p></details>
            <details><summary>Are there sending limits?</summary><p>Yes. Each workspace can send up to 50 messages per day, with at least 60 seconds between sends. Suppression is checked before every send.</p></details>
            <details><summary>Is it really free?</summary><p>Yes, for a limited time. There is no checkout and no paid plan in this build.</p></details>
            <details><summary>Can I import any list?</summary><p>Only contacts you are authorised to contact. Invalid and duplicate addresses are rejected, and suppressed addresses stay suppressed.</p></details>
          </div>
        </section>
      </main>
      <Footer />
    </>
  )
}

function FeatureCard({ number, title, body, icon, points }: { number: string; title: string; body: string; icon: string; points?: string[] }) {
  return <article className="feature-card"><div className="feature-card-top"><span>{number}</span><b aria-hidden="true">{icon}</b></div><h3>{title}</h3><p>{body}</p>{points && <ul className="feature-points">{points.map((point) => <li key={point}>{point}</li>)}</ul>}</article>
}

function Step({ number, title, body, detail }: { number: string; title: string; body: string; detail?: string }) {
  return <article className="step-card"><span>{number}</span><h3>{title}</h3><p>{body}</p>{detail && <p className="step-detail">{detail}</p>}</article>
}

function InfoPage({ path }: { path: string }) {
  const [faqOpen, setFaqOpen] = useState<number | null>(null)
  const isFeatures = path === '/features/'
  const isPricing = path === '/pricing/'
  const isFaq = path === '/faq/'
  const heading = isFeatures ? 'A thoughtful workflow for every step.' : isPricing ? 'Simple access, for now.' : isFaq ? 'Frequently asked questions.' : path === '/privacy/' ? 'Privacy at a glance.' : 'Terms of use.'
  const faqs = [
    ['What is Kluzar Outreach?', 'A workspace for campaigns, leads, email sequences, replies, and sender management.'],
    ['Do I need a Kluzar mailbox?', 'No. The primary path is to connect a mailbox you control. The Kluzar sender is available for fallback and test mode.'],
    ['Do I need to connect a mailbox to try it?', 'No. Test mode lets you send a test to your own email through the Kluzar sender, without connecting a mailbox.'],
    ['How do I connect a mailbox?', 'From the dashboard, open Senders & domains and choose Connect Gmail or Connect Microsoft. You sign in with the mailbox provider using OAuth — Kluzar Outreach never asks for your mailbox password.'],
    ['What are the sending limits?', 'Each workspace can send up to 50 messages per day, with at least 60 seconds between sends. These limits protect your domain reputation and your recipients.'],
    ['Can I import any list?', 'Only import contacts you are authorised to contact. Invalid and duplicate addresses are rejected, and unsubscribed or bounced addresses are suppressed.'],
    ['What happens on a reply?', 'Reply detection stops the lead’s active sequence. Replies are detected by polling your connected Gmail or Microsoft mailbox threads and are shown in the workspace inbox.'],
    ['What is the Kluzar sender, and when is it used?', 'The Kluzar sender is a test-only fallback. It is used for test mode, when no mailbox is connected. Production campaigns require your own connected mailbox, so replies can be monitored and follow-ups can stop.'],
    ['How does suppression work?', 'Unsubscribes, bounces and complaints are recorded as suppressions and checked immediately before every send, including scheduled follow-ups. A suppressed address is never revived by re-importing it.'],
    ['How is my data handled?', 'Workspace data is scoped to its owner: one workspace cannot read another’s campaigns, leads or replies. Mailbox tokens are encrypted server-side and never exposed in the frontend. The privacy page describes the intended data flow in more detail.'],
    ['Is there a paid plan?', 'No. The landing page describes the offer as free for a limited time. There is no checkout or paid plan in this build.'],
  ]
  return (
    <>
      <Header />
      <main className="inner-page">
        <div className="inner-intro"><p className="eyebrow">Kluzar Outreach</p><h1>{heading}</h1><p>{pageDescriptions[path]}</p></div>
        {isFeatures && <><div className="feature-grid inner-grid">
          <FeatureCard number="01" title="Campaigns" body="Create and organise messages, sender identities, and campaign status." icon="↗" points={['Draft first, launch deliberately', 'Launch confirms permission to contact the list']} />
          <FeatureCard number="02" title="Lead lists" body="Add leads manually or import CSV files for server-side validation and deduplication." icon="◎" points={['Email column required; first name and company optional', '5 MB CSV limit; invalid and duplicate addresses rejected']} />
          <FeatureCard number="03" title="Sequences" body="Schedule follow-ups with conditional branches and mandatory stop-on-reply." icon="⌁" points={['Delays set in days per step', 'Branch on no-reply, reply, or a status change']} />
          <FeatureCard number="04" title="Inbox" body="Keep detected replies together and stop the corresponding sequence." icon="↩" points={['Replies detected from connected mailbox threads', 'A reply stops the lead\u2019s sequence automatically']} />
          <FeatureCard number="05" title="Tracking" body="Review the available delivery and engagement events for each campaign." icon="▤" points={['Events shown per campaign, as recorded', 'No invented figures — empty means no events yet']} />
          <FeatureCard number="06" title="Test mode" body="Send a test only to your own address using the Kluzar sender." icon="□" points={['No mailbox needed to test', 'Tests never reach workspace leads']} />
        </div>
        <section className="feature-detail">
          <h2>How the features fit together</h2>
          <p>A campaign starts with a lead list and a sender. You write the first message, optionally add a follow-up with a delay in days, and save the campaign as a draft. Before anything is sent, you test it against your own email. When the message, the audience and the sender all look right, you launch — confirming you have permission to contact the list — and the Worker sends at a paced rate, checking suppression before every send.</p>
          <p>Replies come back through your connected mailbox. The Worker polls your Gmail or Microsoft threads, brings detected replies into the workspace inbox, and stops the follow-up sequence for the lead who replied. Notifications record what the sequence rules did, so you can see the result without watching the inbox all day.</p>
          <p>Everything is scoped to your workspace. Your campaigns, lists, leads and replies belong to your account, and another workspace cannot see them. Sending limits — 50 messages per workspace per day, at least 60 seconds between sends — apply to every campaign, and the Kluzar sender is available for tests only, never for production campaigns.</p>
          <p className="feature-detail-links"><a className="text-link" href="/pricing/">See what is included <span aria-hidden="true">→</span></a><a className="text-link" href="/faq/">Questions, answered <span aria-hidden="true">→</span></a><a className="text-link" href="/blog/">Read the guides <span aria-hidden="true">→</span></a></p>
        </section></>}
        {isPricing && <><section className="pricing-card"><span className="pricing-pill">FREE FOR A LIMITED TIME</span><h2>Everything in this build</h2><p>No checkout. No paid plans. The offer is free for a limited time while the product grows.</p><a className="button button-primary" href="/login/?next=%2Fdashboard%2F">Try now <span aria-hidden="true">→</span></a></section>
        <section className="pricing-detail">
          <div className="pricing-columns">
            <div><h2>What is included</h2><ul className="check-list"><li>Campaigns, sequences and branching rules</li><li>Lead lists, manual adds and CSV import</li><li>Unified replies inbox with stop-on-reply</li><li>Gmail and Microsoft mailbox connection via OAuth</li><li>Test mode using the Kluzar sender</li><li>Campaign stats for recorded delivery and engagement events</li></ul></div>
            <div><h2>What is not included</h2><ul className="cross-list"><li>No paid plans and no checkout in this build</li><li>No purchased or supplied contact lists</li><li>No client mailboxes — you connect your own</li><li>No LinkedIn outreach and no AI-written emails</li><li>No bulk sending beyond the stated limits</li></ul></div>
          </div>
          <h2>Free terms, plainly stated</h2>
          <p>Access is free for a limited time. There is no card on file, no trial clock, and no plan to choose — the single free offer covers everything in this build. Features and availability may change as the product grows, and any future paid plan would be announced before it affects your workspace. Sending limits still apply: 50 messages per workspace per day, with at least 60 seconds between sends, and suppression is checked before every send.</p>
          <p>Questions about the offer? <a href="/faq/">Read the FAQ</a> or <a href={CONTACT_URL}>contact Kluzar</a>.</p>
        </section></>}
        {isFaq && <div className="faq-list inner-faq">{faqs.map(([question, answer], index) => <details key={question} open={faqOpen === index} onToggle={(event) => setFaqOpen(event.currentTarget.open ? index : null)}><summary>{question}</summary><p>{answer}</p></details>)}</div>}
        {path === '/privacy/' && <div className="legal-copy"><p className="draft-note">Draft — this page is an implementation draft for review by qualified counsel before public launch. It is not legal advice and does not replace a final published policy.</p><p>This page describes the intended product data flow based on the current Kluzar Outreach specification. Before public launch, Kluzar should confirm its legal entity details, retention periods, subprocessors, and contact details with qualified counsel.</p><h2>Information handled</h2><p>When the service is configured, account identity and workspace data are used to provide access. Lead details, message content, sender configuration, and campaign events are stored to operate the features requested by a workspace.</p><h2>Connected mailboxes</h2><p>Mailbox access is intended to use OAuth. Access tokens must be encrypted server-side and must never be exposed in frontend code or logs. Users should connect only mailboxes they control. Reply detection reads mailbox threads for messages that belong to Outreach campaigns; it does not read unrelated mail.</p><h2>Leads and suppression</h2><p>Lead details are supplied by the workspace owner, who is responsible for having a lawful basis to contact them. Unsubscribes, bounces and complaints are recorded as suppressions so those addresses are not contacted again. Suppression records are scoped to the workspace that owns them and are checked before every send, including scheduled follow-ups.</p><h2>Workspace isolation</h2><p>Workspace data is scoped to its owner. Campaigns, lead lists, replies and sender settings belonging to one workspace are not visible to another workspace. Access to the service is verified through Kluzar Accounts, and the Outreach API accepts requests only from the Outreach origin.</p><h2>Sending limits and safety</h2><p>Sending is limited to 50 messages per workspace per day, with at least 60 seconds between sends. These limits, the launch permission confirmation, and the suppression checks are safety controls that protect recipients and the sender\u2019s domain reputation.</p><h2>Analytics and advertising</h2><p>The site uses Google Analytics and Google AdSense on public pages, as disclosed by the tags loaded on those pages. Analytics data is used to understand how the public site is used; it is not used to read workspace content, mailbox data, or campaign messages.</p><h2>Retention and deletion</h2><p>Retention periods for workspace data, campaign events and suppression records are to be confirmed before launch. Suppression records are expected to be kept longer than ordinary campaign data, because deleting a suppression would risk contacting someone who asked to stop. Account deletion and data requests should be directed to Kluzar through the contact page.</p><h2>Data controls</h2><p>Workspace data must be scoped to its owner. Unsubscribes, bounces, and complaints are recorded as suppressions to prevent later sends. Contact <a href={CONTACT_URL}>Kluzar</a> for privacy-related requests.</p><h2>Launch review needed</h2><p>This is an implementation draft, not legal advice. The final published policy must be checked against the deployed data flows and applicable law.</p></div>}
        {path === '/terms/' && <div className="legal-copy"><p className="draft-note">Draft — these terms are a draft for review by qualified counsel before public launch. They do not replace legal advice or a final agreement.</p><p>These terms are a draft for Kluzar Outreach and must be reviewed before launch. They do not replace legal advice or a final agreement.</p><h2>Responsible use</h2><p>Use the service only for contacts you are authorised to contact. Do not upload purchased or scraped contact lists. Respect unsubscribe requests, applicable email laws, mailbox provider policies, and recipients’ privacy.</p><h2>Sending limits</h2><p>Each workspace may send up to 50 messages per day, with at least 60 seconds between sends. These limits are part of the service and may be adjusted as the product grows. Attempts to bypass the limits, the suppression checks, or the launch confirmation are a breach of these terms.</p><h2>Your account and content</h2><p>You are responsible for your connected sender accounts, campaign content, recipient selection, and keeping account access secure. Do not attempt to access another workspace or bypass suppression controls. You are also responsible for the accuracy of the messages you send: personalisation must use verified information, not guesses about the recipient.</p><h2>Connected mailboxes</h2><p>Connect only mailboxes you control, using the OAuth flow provided. Do not share mailbox credentials with the service — the service never asks for them. If a connected mailbox is compromised, disconnect it from the dashboard and secure the mailbox with its provider.</p><h2>Prohibited uses</h2><p>Do not use the service for spam, phishing, deception, harassment, or any unlawful purpose. Do not send to purchased or scraped lists, do not misrepresent who you are, and do not use the service to contact people who have asked not to be contacted. Kluzar may suspend or close a workspace that breaches these terms.</p><h2>Availability and changes</h2><p>The product is offered as free for a limited time in this build. Availability, features, and legal terms may change; there is no checkout or paid plan in this build. The service is provided as-is while it grows, and Kluzar does not guarantee uninterrupted availability or any particular result from a campaign.</p><h2>Questions</h2><p>Contact <a href={CONTACT_URL}>Kluzar</a> or visit <a href={SUPPORT_URL}>support</a> for assistance.</p></div>}
      </main>
      <Footer />
    </>
  )
}

function BlogPage({ path }: { path: string }) {
  const article = articles.find((item) => path === `/blog/${item.slug}/`)
  return (
    <>
      <Header />
      <main className="inner-page">
        {article ? <article className="blog-article"><a className="text-link" href="/blog/">← All articles</a><p className="eyebrow">Outreach guide</p><h1>{article.title}</h1><p className="article-lede">{article.description}</p>{article.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}<aside className="related-articles"><h2>Keep reading</h2>{articles.filter((item) => item.slug !== article.slug).slice(0, 3).map((item) => <a href={`/blog/${item.slug}/`} key={item.slug}>{item.title} <span aria-hidden="true">→</span></a>)}</aside></article> :
          <><div className="inner-intro"><p className="eyebrow">The Kluzar Outreach blog</p><h1>Clear advice for better outreach.</h1><p>Practical guidance on deliverability, sequences, suppression, and testing.</p></div><div className="article-grid">{articles.map((item, index) => <a className="article-card" href={`/blog/${item.slug}/`} key={item.slug}><span>GUIDE 0{index + 1}</span><h2>{item.title}</h2><p>{item.description}</p><b>Read article <span aria-hidden="true">→</span></b></a>)}</div></>}
      </main>
      <Footer />
    </>
  )
}

function NotFoundPage() {
  return (
    <>
      <Header />
      <main className="inner-page">
        <div className="inner-intro"><p className="eyebrow">404</p><h1>That page is not here.</h1><p>The address may have changed, or the page may not exist. Start from one of the pages below.</p></div>
        <div className="notfound-links">
          <a href="/">Home</a><a href="/features/">Features</a><a href="/pricing/">Pricing</a><a href="/blog/">Blog</a><a href="/faq/">FAQ</a><a href="/login/">Sign in</a>
        </div>
      </main>
      <Footer />
    </>
  )
}

function LoginPage() {
  const params = new URLSearchParams(window.location.search)
  const requestedNext = params.get('next')
  const nextPath = requestedNext?.startsWith('/dashboard/') ? requestedNext : '/dashboard/'
  const returnTo = `${window.location.origin}${nextPath}`
  useEffect(() => {
    let live = true
    fetchAccountSession().then((session) => {
      if (live && session.authenticated && session.csrfToken) window.location.assign(nextPath)
    }).catch(() => {})
    return () => { live = false }
  }, [nextPath])
  return <main className="auth-page"><section className="auth-card"><img className="auth-mark-img" src="/brand/kluzar-logo.png" alt="Kluzar" /><p className="eyebrow">Welcome to Kluzar Outreach</p><h1>Sign in to continue.</h1><p>Use your Kluzar Account to open your outreach workspace.</p><a className="button button-primary auth-button" href={accountUrl('login', returnTo)}>Continue to log in <span aria-hidden="true">→</span></a><p className="auth-subtext">New to Kluzar? <a href={accountUrl('signup', returnTo)}>Create an account</a></p><a className="back-link" href="/">Back to home</a></section></main>
}

const dashboardNav = [
  ['Overview', '/dashboard/', '⌂'],
  ['Campaigns', '/dashboard/campaigns/', '↗'],
  ['Leads', '/dashboard/leads/', '◎'],
  ['Sequences', '/dashboard/sequences/', '⌁'],
  ['Inbox', '/dashboard/inbox/', '↩'],
  ['Senders & domains', '/dashboard/senders/', '✳'],
  ['Deliverability', '/dashboard/deliverability/', '✓'],
  ['Test mode', '/dashboard/test/', '□'],
  ['Settings', '/dashboard/settings/', '⚙'],
]

function DashboardPage({ path }: { path: string }) {
  const [csrfToken, setCsrfToken] = useState('')
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [ownEmail, setOwnEmail] = useState('')
  const [lists, setLists] = useState<LeadList[]>([])
  const [senders, setSenders] = useState<Sender[]>([])
  const [records, setRecords] = useState<(Campaign | Lead | Reply | SequenceStep | Sender)[]>([])
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')
  const [formBusy, setFormBusy] = useState(false)
  const [testEmail, setTestEmail] = useState('')
  const [testCampaignId, setTestCampaignId] = useState('')
  const [newListName, setNewListName] = useState('')
  const [leadEmail, setLeadEmail] = useState('')
  const [leadFirstName, setLeadFirstName] = useState('')
  const [leadCompany, setLeadCompany] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [campaignName, setCampaignName] = useState('')
  const [campaignSubject, setCampaignSubject] = useState('')
  const [campaignBody, setCampaignBody] = useState('')
  const [followupSubject, setFollowupSubject] = useState('')
  const [followupBody, setFollowupBody] = useState('')
  const [followupDelay, setFollowupDelay] = useState('3')
  const [selectedListId, setSelectedListId] = useState('')
  const [selectedSenderId, setSelectedSenderId] = useState('')
  const [branchSequenceId, setBranchSequenceId] = useState('')
  const [branchCondition, setBranchCondition] = useState('no_reply_after_days')
  const [branchConditionValue, setBranchConditionValue] = useState('3')
  const [branchAction, setBranchAction] = useState('stop')
  const [branchActionValue, setBranchActionValue] = useState('')
  const [launchConfirmation, setLaunchConfirmation] = useState('')
  const [stats, setStats] = useState<Record<string, Record<string, number>>>({})
  const [showCampaignForm, setShowCampaignForm] = useState(false)
  const [showLeadForm, setShowLeadForm] = useState(false)
  const [showListForm, setShowListForm] = useState(false)
  const [notice, setNotice] = useState('')
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null)
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [campaignQuery, setCampaignQuery] = useState('')
  const [campaignStatus, setCampaignStatus] = useState('')
  const [campaignSort, setCampaignSort] = useState('created_desc')
  const [leadQuery, setLeadQuery] = useState('')
  const [leadStatus, setLeadStatus] = useState('')
  const [leadSort, setLeadSort] = useState('created_desc')
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([])
  const [bulkStatus, setBulkStatus] = useState('interested')
  const [inboxCampaigns, setInboxCampaigns] = useState<Campaign[]>([])
  const [inboxCampaignFilter, setInboxCampaignFilter] = useState('')
  const [inboxReadFilter, setInboxReadFilter] = useState('')
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [replyingId, setReplyingId] = useState('')
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [snippetTitle, setSnippetTitle] = useState('')
  const [snippetBody, setSnippetBody] = useState('')
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [previewLeads, setPreviewLeads] = useState<Lead[]>([])
  const [previewLeadId, setPreviewLeadId] = useState('')
  const [prelaunch, setPrelaunch] = useState<PrelaunchData | null>(null)
  const [scheduleValue, setScheduleValue] = useState('')
  const [suppressions, setSuppressions] = useState<Suppression[]>([])
  const [suppEmail, setSuppEmail] = useState('')
  const [suppReason, setSuppReason] = useState('unsubscribed')
  const [preferences, setPreferences] = useState<{ notifyReplyEmail: boolean } | null>(null)
  const [timeline, setTimeline] = useState<TimelineData | null>(null)
  const [darkMode, setDarkMode] = useState(() => {
    try {
      return window.localStorage.getItem('kluzar-outreach-theme') === 'dark'
    } catch {
      return false
    }
  })
  const section = path.replace('/dashboard/', '').split('/').filter(Boolean)[0] ?? 'overview'
  const activeTitle = dashboardNav.find(([, href]) => href === path)?.[0] ?? dashboardNav.find(([, href]) => href.endsWith(`${section}/`))?.[0] ?? 'Overview'
  const endpoint = section === 'campaigns' || section === 'test' ? '/campaigns' : section === 'leads' ? '/leads' : section === 'sequences' ? '/sequences' : section === 'inbox' ? '/inbox' : section === 'senders' ? '/senders' : ''

  const request = async <T,>(apiPath: string, options: RequestInit = {}): Promise<T> => {
    const { response, payload } = await apiRequest<T>(apiPath, options, csrfToken)
    if (response.status === 401) {
      window.location.replace(`/login/?next=${encodeURIComponent(path)}`)
      throw new Error('Your session expired. Please sign in again.')
    }
    if (!response.ok || payload.data === undefined) throw new Error(payload.error ?? 'The request could not be completed.')
    return payload.data
  }

  useEffect(() => {
    let active = true
    const bootstrap = async () => {
      try {
        const session = await fetchAccountSession()
        if (!active) return
        if (!session.authenticated || !session.csrfToken) {
          window.location.replace(`/login/?next=${encodeURIComponent(path)}`)
          return
        }
        const assertion = await getAssertion(session.csrfToken)
        if (!active) return
        if (!assertion) {
          window.location.replace(`/login/?next=${encodeURIComponent(path)}`)
          return
        }
        setCsrfToken(session.csrfToken)
        const { response, payload } = await apiRequest<{ user?: { email?: string | null }; workspaces?: Workspace[] }>('/me', {}, session.csrfToken)
        if (!active) return
        if (response.status === 401) {
          window.location.replace(`/login/?next=${encodeURIComponent(path)}`)
          return
        }
        if (!response.ok) throw new Error(payload.error ?? 'We could not verify your session.')
        const ownWorkspaces = payload.data?.workspaces ?? []
        setOwnEmail(payload.data?.user?.email ?? '')
        setTestEmail(payload.data?.user?.email ?? '')
        setWorkspaces(ownWorkspaces)
        setWorkspaceId(ownWorkspaces[0]?.id ?? '')
        setLoading(false)
      } catch (cause: unknown) {
        if (active) {
          setError(cause instanceof Error ? cause.message : 'We could not verify your session.')
          setLoading(false)
        }
      }
    }
    void bootstrap()
    return () => { active = false }
  }, [path])

  useEffect(() => {
    if (!workspaceId) {
      setLists([])
      setSenders([])
      return
    }
    let active = true
    Promise.all([
      apiRequest<LeadList[]>(`/lists?workspaceId=${encodeURIComponent(workspaceId)}`, {}, csrfToken),
      apiRequest<Sender[]>(`/senders?workspaceId=${encodeURIComponent(workspaceId)}`, {}, csrfToken),
    ]).then((results) => {
      if (!active) return
      for (const { response } of results) {
        if (response.status === 401) {
          window.location.replace(`/login/?next=${encodeURIComponent(path)}`)
          return
        }
        if (!response.ok) throw new Error('Workspace settings could not be loaded.')
      }
      setLists(results[0].payload.data ?? [])
      setSenders(results[1].payload.data ?? [])
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Workspace settings could not be loaded.')
    })
    return () => { active = false }
  }, [workspaceId, path, csrfToken])

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? 'dark' : 'light'
    try {
      window.localStorage.setItem('kluzar-outreach-theme', darkMode ? 'dark' : 'light')
    } catch {
    }
  }, [darkMode])

  useEffect(() => {
    if (!endpoint || !workspaceId) {
      setRecords([])
      return
    }
    let active = true
    const params = new URLSearchParams({ workspaceId })
    if (section === 'campaigns') {
      if (campaignQuery.trim()) params.set('q', campaignQuery.trim())
      if (campaignStatus) params.set('status', campaignStatus)
      if (campaignSort !== 'created_desc') params.set('sort', campaignSort)
    }
    if (section === 'leads') {
      if (leadQuery.trim()) params.set('q', leadQuery.trim())
      if (leadStatus) params.set('status', leadStatus)
      if (leadSort !== 'created_desc') params.set('sort', leadSort)
    }
    if (section === 'inbox') {
      if (inboxCampaignFilter) params.set('campaignId', inboxCampaignFilter)
      if (inboxReadFilter) params.set('read', inboxReadFilter)
    }
    apiRequest<(Campaign | Lead | Reply | SequenceStep | Sender)[]>(`${endpoint}?${params.toString()}`, {}, csrfToken).then(({ response, payload }) => {
      if (!active) return
      if (response.status === 401) {
        window.location.replace(`/login/?next=${encodeURIComponent(path)}`)
        return
      }
      if (!response.ok) throw new Error(payload.error ?? 'Could not load this section.')
      setRecords(payload.data ?? [])
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Could not load this section.')
    })
    return () => { active = false }
  }, [endpoint, workspaceId, path, csrfToken, campaignQuery, campaignStatus, campaignSort, leadQuery, leadStatus, leadSort, inboxCampaignFilter, inboxReadFilter])

  useEffect(() => {
    if (!workspaceId || section !== 'overview') {
      setOnboarding(null)
      setActivity([])
      return
    }
    let active = true
    Promise.all([
      apiRequest<OnboardingState>(`/onboarding?workspaceId=${encodeURIComponent(workspaceId)}`, {}, csrfToken),
      apiRequest<ActivityItem[]>(`/activity?workspaceId=${encodeURIComponent(workspaceId)}`, {}, csrfToken),
    ]).then((results) => {
      if (!active) return
      setOnboarding(results[0].payload.data ?? null)
      setActivity(results[1].payload.data ?? [])
    }).catch(() => {
      if (active) {
        setOnboarding(null)
        setActivity([])
      }
    })
    return () => { active = false }
  }, [workspaceId, section, csrfToken])

  useEffect(() => {
    if (!workspaceId || (section !== 'inbox' && section !== 'settings')) return
    let active = true
    Promise.all([
      apiRequest<Campaign[]>(`/campaigns?workspaceId=${encodeURIComponent(workspaceId)}`, {}, csrfToken),
      apiRequest<Snippet[]>(`/snippets?workspaceId=${encodeURIComponent(workspaceId)}`, {}, csrfToken),
    ]).then((results) => {
      if (!active) return
      setInboxCampaigns(results[0].payload.data ?? [])
      setSnippets(results[1].payload.data ?? [])
    }).catch(() => {
      if (active) {
        setInboxCampaigns([])
        setSnippets([])
      }
    })
    return () => { active = false }
  }, [workspaceId, section, csrfToken])

  useEffect(() => {
    if (!workspaceId || section !== 'leads') {
      setSuppressions([])
      return
    }
    let active = true
    apiRequest<Suppression[]>(`/suppressions?workspaceId=${encodeURIComponent(workspaceId)}`, {}, csrfToken).then(({ payload }) => {
      if (active) setSuppressions(payload.data ?? [])
    }).catch(() => {
      if (active) setSuppressions([])
    })
    return () => { active = false }
  }, [workspaceId, section, csrfToken])

  useEffect(() => {
    if (!workspaceId || section !== 'settings') {
      setPreferences(null)
      return
    }
    let active = true
    apiRequest<{ notifyReplyEmail: boolean }>(`/workspaces/${encodeURIComponent(workspaceId)}/preferences`, {}, csrfToken).then(({ payload }) => {
      if (active) setPreferences(payload.data ?? null)
    }).catch(() => {
      if (active) setPreferences(null)
    })
    return () => { active = false }
  }, [workspaceId, section, csrfToken])

  useEffect(() => {
    if (!workspaceId || section !== 'overview') {
      setNotifications([])
      return
    }
    let active = true
    apiRequest<Notification[]>(`/notifications?workspaceId=${encodeURIComponent(workspaceId)}`, {}, csrfToken).then(({ response, payload }) => {
      if (!active) return
      if (response.status === 401) {
        window.location.replace(`/login/?next=${encodeURIComponent(path)}`)
        return
      }
      if (!response.ok) throw new Error(payload.error ?? 'Notifications could not be loaded.')
      setNotifications(payload.data ?? [])
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Notifications could not be loaded.')
    })
    return () => { active = false }
  }, [workspaceId, section, path, csrfToken])

  useEffect(() => {
    if (!lists.length) {
      setSelectedListId('')
      return
    }
    if (!lists.some((list) => list.id === selectedListId)) setSelectedListId(lists[0].id)
  }, [lists, selectedListId])

  useEffect(() => {
    const firstMailbox = senders.find((sender) => sender.type === 'gmail_oauth' || sender.type === 'outlook_oauth')
    if (firstMailbox && !senders.some((sender) => sender.id === selectedSenderId)) setSelectedSenderId(firstMailbox.id)
  }, [senders, selectedSenderId])

  const refreshRecords = async () => {
    if (!endpoint || !workspaceId) return
    const params = new URLSearchParams({ workspaceId })
    if (section === 'campaigns') {
      if (campaignQuery.trim()) params.set('q', campaignQuery.trim())
      if (campaignStatus) params.set('status', campaignStatus)
      if (campaignSort !== 'created_desc') params.set('sort', campaignSort)
    }
    if (section === 'leads') {
      if (leadQuery.trim()) params.set('q', leadQuery.trim())
      if (leadStatus) params.set('status', leadStatus)
      if (leadSort !== 'created_desc') params.set('sort', leadSort)
    }
    if (section === 'inbox') {
      if (inboxCampaignFilter) params.set('campaignId', inboxCampaignFilter)
      if (inboxReadFilter) params.set('read', inboxReadFilter)
    }
    const result = await request<(Campaign | Lead | Reply | SequenceStep | Sender)[]>(`${endpoint}?${params.toString()}`)
    setRecords(result)
  }

  const createWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormBusy(true)
    setError('')
    try {
      const { response, payload } = await apiRequest<Workspace>('/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: workspaceName.trim() }),
      }, csrfToken)
      if (response.status === 401) {
        window.location.replace(`/login/?next=${encodeURIComponent(path)}`)
        return
      }
      if (!response.ok || !payload.data) throw new Error(payload.error ?? 'Workspace could not be created.')
      setWorkspaces((current) => [...current, payload.data!])
      setWorkspaceId(payload.data.id)
      setWorkspaceName('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Workspace could not be created.')
    } finally {
      setFormBusy(false)
    }
  }

  const createList = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormBusy(true)
    setError('')
    try {
      const list = await request<LeadList>('/lists', {
        method: 'POST',
        body: JSON.stringify({ workspaceId, name: newListName.trim() }),
      })
      setLists((current) => [...current, list])
      setSelectedListId(list.id)
      setNewListName('')
      setShowListForm(false)
      setNotice('Lead list created.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Lead list could not be created.')
    } finally {
      setFormBusy(false)
    }
  }

  const createLead = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormBusy(true)
    setError('')
    try {
      await request('/leads', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId,
          listId: selectedListId,
          email: leadEmail.trim(),
          firstName: leadFirstName.trim(),
          company: leadCompany.trim(),
        }),
      })
      setLeadEmail('')
      setLeadFirstName('')
      setLeadCompany('')
      setShowLeadForm(false)
      setNotice('Lead added to the selected list.')
      await refreshRecords()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Lead could not be added.')
    } finally {
      setFormBusy(false)
    }
  }

  const importCsv = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedFile) {
      setError('Choose a CSV file first.')
      return
    }
    setFormBusy(true)
    setError('')
    try {
      const upload = await request<{ uploadId: string; uploadUrl: string; headers: Record<string, string> }>('/leads/import', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId,
          listId: selectedListId,
          filename: selectedFile.name,
          sizeBytes: selectedFile.size,
          contentType: selectedFile.type || 'text/csv',
        }),
      })
      const uploadResponse = await fetch(upload.uploadUrl, {
        method: 'PUT',
        headers: upload.headers,
        body: selectedFile,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      })
      if (!uploadResponse.ok) throw new Error('CSV upload could not be completed.')
      const result = await request<{ accepted: number; parsed: number; duplicates: number; suppressed: number }>(`/leads/import/${encodeURIComponent(upload.uploadId)}/complete`, { method: 'POST' })
      setSelectedFile(null)
      setNotice(`${result.accepted} contacts added from ${result.parsed} valid addresses — ${result.duplicates} duplicates skipped, ${result.suppressed} suppressed addresses skipped.`)
      await refreshRecords()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'CSV import could not be completed.')
    } finally {
      setFormBusy(false)
    }
  }

  const createCampaign = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormBusy(true)
    setError('')
    try {
      const campaign = await request<Campaign>('/campaigns', {
        method: 'POST',
        body: JSON.stringify({ workspaceId, leadListId: selectedListId, senderId: selectedSenderId, name: campaignName.trim() }),
      })
      await request('/sequences', {
        method: 'POST',
        body: JSON.stringify({ campaignId: campaign.id, stepNo: 1, delayDays: 0, subject: campaignSubject.trim(), bodyTemplate: campaignBody }),
      })
      if (followupSubject.trim() && followupBody.trim()) {
        await request('/sequences', {
          method: 'POST',
          body: JSON.stringify({ campaignId: campaign.id, stepNo: 2, delayDays: Number(followupDelay), subject: followupSubject.trim(), bodyTemplate: followupBody }),
        })
      }
      setCampaignName('')
      setCampaignSubject('')
      setCampaignBody('')
      setFollowupSubject('')
      setFollowupBody('')
      setShowCampaignForm(false)
      setNotice('Campaign draft created. Test it before launch.')
      await refreshRecords()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Campaign could not be created.')
    } finally {
      setFormBusy(false)
    }
  }

  const launchCampaign = async (campaignId: string) => {
    setFormBusy(true)
    setError('')
    try {
      const result = await request<{ queued: number }>(`/campaigns/${encodeURIComponent(campaignId)}/launch`, {
        method: 'POST',
        body: JSON.stringify({ confirmAuthorizedRecipients: true }),
      })
      setNotice(`${result.queued} recipients were queued. Sending limits and suppression checks apply.`)
      setLaunchConfirmation('')
      await refreshRecords()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Campaign could not be launched.')
    } finally {
      setFormBusy(false)
    }
  }

  const showCampaignStats = async (campaignId: string) => {
    setError('')
    try {
      const result = await request<Record<string, number>>(`/stats/${encodeURIComponent(campaignId)}?workspaceId=${encodeURIComponent(workspaceId)}`)
      setStats((current) => ({ ...current, [campaignId]: result }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Campaign stats could not be loaded.')
    }
  }

  const updateLeadStatus = async (leadId: string, status: string) => {
    setError('')
    try {
      await request(`/leads/${encodeURIComponent(leadId)}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      await refreshRecords()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Lead status could not be updated.')
    }
  }

  const addBranch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormBusy(true)
    setError('')
    try {
      await request('/branches', {
        method: 'POST',
        body: JSON.stringify({
          sequenceId: branchSequenceId,
          condition: branchCondition,
          conditionValue: branchCondition === 'no_reply_after_days' ? Number(branchConditionValue) : null,
          action: branchAction,
          actionValue: branchActionValue || null,
        }),
      })
      setNotice('Branching rule created.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Branching rule could not be created.')
    } finally {
      setFormBusy(false)
    }
  }

  const connectMailbox = async (provider: 'google' | 'microsoft') => {
    setFormBusy(true)
    setError('')
    try {
      const result = await request<{ authorizationUrl: string }>('/senders/oauth', {
        method: 'POST',
        body: JSON.stringify({ workspaceId, provider }),
      })
      window.location.assign(result.authorizationUrl)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Mailbox connection could not be started.')
      setFormBusy(false)
    }
  }

  const addBrevoSender = async () => {
    setFormBusy(true)
    setError('')
    try {
      await request('/senders', { method: 'POST', body: JSON.stringify({ workspaceId }) })
      const rows = await request<Sender[]>(`/senders?workspaceId=${encodeURIComponent(workspaceId)}`)
      setSenders(rows)
      setNotice('Kluzar sender is available for tests only until reply monitoring is verified.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Kluzar sender could not be added.')
    } finally {
      setFormBusy(false)
    }
  }

  const sendTest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormBusy(true)
    setError('')
    setNotice('')
    try {
      await request('/test/send', {
        method: 'POST',
        body: JSON.stringify({ email: testEmail }),
      })
      setNotice('Your test message has been queued for your address.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Test email could not be sent.')
    } finally {
      setFormBusy(false)
    }
  }

  const sendCampaignTest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormBusy(true)
    setError('')
    setNotice('')
    try {
      await request('/test/campaign', {
        method: 'POST',
        body: JSON.stringify({ email: testEmail, campaignId: testCampaignId }),
      })
      setNotice('A test of the selected campaign has been sent only to your verified account email.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Campaign test could not be sent.')
    } finally {
      setFormBusy(false)
    }
  }

  const markNotificationsRead = async () => {
    try {
      await request('/notifications/read', { method: 'POST', body: JSON.stringify({ workspaceId }) })
      setNotifications((current) => current.map((item) => ({ ...item, read_at: Date.now() })))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Notifications could not be updated.')
    }
  }

  const downloadCsv = async (apiPath: string, filename: string) => {
    setError('')
    try {
      const assertion = await getAssertion(csrfToken)
      if (!assertion) throw new Error('Your session expired. Please sign in again.')
      const response = await fetch(`${API_BASE}${apiPath}`, {
        headers: { Accept: 'text/csv', Authorization: `Bearer ${assertion}` },
        credentials: 'include',
        cache: 'no-store',
      })
      if (response.status === 401) {
        window.location.replace(`/login/?next=${encodeURIComponent(path)}`)
        return
      }
      if (!response.ok) throw new Error('The export could not be completed.')
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.append(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
      setNotice('Export downloaded.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The export could not be completed.')
    }
  }

  const exportListCsv = (list: LeadList) => {
    void downloadCsv(`/lists/${encodeURIComponent(list.id)}/export?workspaceId=${encodeURIComponent(workspaceId)}`, `${list.name}-leads.csv`)
  }

  const exportCampaignStatsCsv = (campaign: Campaign) => {
    void downloadCsv(`/campaigns/${encodeURIComponent(campaign.id)}/stats.csv?workspaceId=${encodeURIComponent(workspaceId)}`, `${campaign.name}-stats.csv`)
  }

  const cloneCampaign = async (campaignId: string) => {
    setError('')
    try {
      const copy = await request<Campaign>(`/campaigns/${encodeURIComponent(campaignId)}/clone`, { method: 'POST' })
      setNotice(`Campaign duplicated as “${copy.name}”.`)
      await refreshRecords()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Campaign could not be duplicated.')
    }
  }

  const cloneSequenceStep = async (sequenceId: string) => {
    setError('')
    try {
      await request(`/sequences/${encodeURIComponent(sequenceId)}/clone`, { method: 'POST' })
      setNotice('Sequence step duplicated at the end of the campaign.')
      await refreshRecords()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sequence step could not be duplicated.')
    }
  }

  const archiveCampaign = async (campaignId: string) => {
    setError('')
    try {
      await request(`/campaigns/${encodeURIComponent(campaignId)}/archive`, { method: 'POST' })
      setNotice('Campaign archived.')
      await refreshRecords()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Campaign could not be archived.')
    }
  }

  const unarchiveCampaign = async (campaignId: string) => {
    setError('')
    try {
      await request(`/campaigns/${encodeURIComponent(campaignId)}/unarchive`, { method: 'POST' })
      setNotice('Campaign restored.')
      await refreshRecords()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Campaign could not be restored.')
    }
  }

  const openPreview = async (campaign: Campaign) => {
    setError('')
    setPreview(null)
    try {
      const [previewData, listLeads] = await Promise.all([
        request<PreviewData>(`/campaigns/${encodeURIComponent(campaign.id)}/preview?workspaceId=${encodeURIComponent(workspaceId)}`),
        request<Lead[]>(`/leads?workspaceId=${encodeURIComponent(workspaceId)}&listId=${encodeURIComponent(campaign.lead_list_id)}`),
      ])
      setPreview(previewData)
      setPreviewLeads(listLeads)
      setPreviewLeadId(previewData.lead?.id ?? '')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Preview could not be loaded.')
    }
  }

  const changePreviewLead = async (campaignId: string, leadId: string) => {
    setPreviewLeadId(leadId)
    setError('')
    try {
      const previewData = await request<PreviewData>(`/campaigns/${encodeURIComponent(campaignId)}/preview?workspaceId=${encodeURIComponent(workspaceId)}&leadId=${encodeURIComponent(leadId)}`)
      setPreview(previewData)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Preview could not be loaded.')
    }
  }

  const openPrelaunch = async (campaign: Campaign) => {
    setError('')
    setPrelaunch(null)
    setScheduleValue('')
    try {
      const data = await request<PrelaunchData>(`/campaigns/${encodeURIComponent(campaign.id)}/prelaunch?workspaceId=${encodeURIComponent(workspaceId)}`)
      setPrelaunch(data)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Pre-launch check could not be loaded.')
    }
  }

  const scheduleCampaign = async (campaignId: string) => {
    if (!scheduleValue) {
      setError('Choose a launch date and time first.')
      return
    }
    const scheduledAt = new Date(scheduleValue).getTime()
    if (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now()) {
      setError('Choose a launch time in the future.')
      return
    }
    setFormBusy(true)
    setError('')
    try {
      await request(`/campaigns/${encodeURIComponent(campaignId)}/schedule`, {
        method: 'POST',
        body: JSON.stringify({ scheduledAt, confirmAuthorizedRecipients: true }),
      })
      setNotice('Launch scheduled. The Worker will launch it at the chosen time.')
      setPrelaunch(null)
      await refreshRecords()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Campaign could not be scheduled.')
    } finally {
      setFormBusy(false)
    }
  }

  const cancelSchedule = async (campaign: Campaign) => {
    setError('')
    try {
      await request(`/campaigns/${encodeURIComponent(campaign.id)}`, { method: 'PATCH', body: JSON.stringify({ name: campaign.name, status: 'draft' }) })
      setNotice('Scheduled launch cancelled. The campaign is a draft again.')
      await refreshRecords()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Scheduled launch could not be cancelled.')
    }
  }

  const sendInboxReply = async (reply: Reply) => {
    const draft = (replyDrafts[reply.id] ?? '').trim()
    if (!draft) {
      setError('Write a reply first.')
      return
    }
    setReplyingId(reply.id)
    setError('')
    try {
      await request(`/inbox/${encodeURIComponent(reply.id)}/reply`, {
        method: 'POST',
        body: JSON.stringify({ workspaceId, body: draft }),
      })
      setReplyDrafts((current) => ({ ...current, [reply.id]: '' }))
      setNotice(`Reply sent to ${reply.lead_email}. The lead stays stopped — no further follow-ups will be sent.`)
      await refreshRecords()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Reply could not be sent.')
    } finally {
      setReplyingId('')
    }
  }

  const toggleInboxRead = async (reply: Reply) => {
    setError('')
    try {
      await request(`/inbox/${encodeURIComponent(reply.id)}/read`, {
        method: 'POST',
        body: JSON.stringify({ read: !reply.read_at }),
      })
      await refreshRecords()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Reply could not be updated.')
    }
  }

  const insertSnippet = (replyId: string, snippetId: string) => {
    const snippet = snippets.find((item) => item.id === snippetId)
    if (!snippet) return
    setReplyDrafts((current) => ({
      ...current,
      [replyId]: current[replyId] ? `${current[replyId]}\n\n${snippet.body}` : snippet.body,
    }))
  }

  const bulkUpdateLeads = async () => {
    if (!selectedLeadIds.length) {
      setError('Select at least one lead first.')
      return
    }
    setError('')
    try {
      const result = await request<{ updated: number }>('/leads/bulk', {
        method: 'PATCH',
        body: JSON.stringify({ workspaceId, leadIds: selectedLeadIds, status: bulkStatus }),
      })
      setNotice(`${result.updated} leads updated.`)
      setSelectedLeadIds([])
      await refreshRecords()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Leads could not be updated.')
    }
  }

  const toggleSelectLead = (leadId: string) => {
    setSelectedLeadIds((current) => current.includes(leadId) ? current.filter((id) => id !== leadId) : [...current, leadId])
  }

  const toggleSelectAllLeads = (leads: Lead[]) => {
    setSelectedLeadIds((current) => current.length === leads.length && leads.length > 0 ? [] : leads.map((lead) => lead.id))
  }

  const openLeadTimeline = async (lead: Lead) => {
    setError('')
    setTimeline(null)
    try {
      const data = await request<TimelineData>(`/leads/${encodeURIComponent(lead.id)}/timeline?workspaceId=${encodeURIComponent(workspaceId)}`)
      setTimeline(data)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Lead timeline could not be loaded.')
    }
  }

  const addSuppression = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormBusy(true)
    setError('')
    try {
      await request('/suppressions', {
        method: 'POST',
        body: JSON.stringify({ workspaceId, email: suppEmail.trim(), reason: suppReason }),
      })
      setSuppEmail('')
      setNotice(`${suppEmail.trim()} is now suppressed and will receive no further outreach.`)
      const rows = await request<Suppression[]>(`/suppressions?workspaceId=${encodeURIComponent(workspaceId)}`)
      setSuppressions(rows)
      await refreshRecords()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Suppression could not be added.')
    } finally {
      setFormBusy(false)
    }
  }

  const removeSuppression = async (suppression: Suppression) => {
    setError('')
    try {
      await request(`/suppressions/${encodeURIComponent(suppression.id)}`, { method: 'DELETE' })
      setNotice(`${suppression.email} was removed from suppression.`)
      const rows = await request<Suppression[]>(`/suppressions?workspaceId=${encodeURIComponent(workspaceId)}`)
      setSuppressions(rows)
      await refreshRecords()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Suppression could not be removed.')
    }
  }

  const saveSnippet = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormBusy(true)
    setError('')
    try {
      const created = await request<Snippet>('/snippets', {
        method: 'POST',
        body: JSON.stringify({ workspaceId, title: snippetTitle.trim(), body: snippetBody.trim() }),
      })
      setSnippets((current) => [...current, created])
      setSnippetTitle('')
      setSnippetBody('')
      setNotice('Snippet saved. You can insert it while replying from the inbox.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Snippet could not be saved.')
    } finally {
      setFormBusy(false)
    }
  }

  const deleteSnippet = async (snippetId: string) => {
    setError('')
    try {
      await request(`/snippets/${encodeURIComponent(snippetId)}`, { method: 'DELETE' })
      setSnippets((current) => current.filter((item) => item.id !== snippetId))
      setNotice('Snippet deleted.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Snippet could not be deleted.')
    }
  }

  const updateNotificationPreference = async (notifyReplyEmail: boolean) => {
    setError('')
    try {
      const updated = await request<{ notifyReplyEmail: boolean }>(`/workspaces/${encodeURIComponent(workspaceId)}/preferences`, {
        method: 'PATCH',
        body: JSON.stringify({ notifyReplyEmail }),
      })
      setPreferences(updated)
      setNotice(notifyReplyEmail ? 'Reply email notifications are on.' : 'Reply email notifications are off. Replies still appear in the dashboard.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Notification preference could not be saved.')
    }
  }

  if (loading) return <main className="dashboard-loading" aria-live="polite"><span className="loading-spinner" /><p>Verifying your session…</p></main>

  return (
    <div className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <a className="dashboard-brand" href="/"><span className="logo-light"><Logo small /></span><span className="logo-dark"><LogoDark small /></span><span className="dashboard-brand-label">OUTREACH</span></a>
        <div className="workspace-switch"><span>WORKSPACE</span>{workspaces.length ? <select aria-label="Workspace" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>{workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}</select> : <strong>No workspace yet</strong>}</div>
        <nav className="dashboard-nav" aria-label="Dashboard navigation">{dashboardNav.map(([title, href, icon]) => <a className={activeTitle === title ? 'active' : ''} href={href} key={href}><span aria-hidden="true">{icon}</span>{title}</a>)}</nav>
        <div className="sidebar-bottom"><a href={CONTACT_URL}>Contact</a><a href={SUPPORT_URL}>Support</a><a href="/">Back to site</a></div>
      </aside>
      <main className="dashboard-main">
        <header className="dashboard-topbar"><div><span>WORKSPACE</span><b>{activeTitle}</b></div><a href={accountUrl('login', `${window.location.origin}/dashboard/`)}>Account ↗</a></header>
        <section className="dashboard-content">
          <div className="dashboard-title"><div><p className="eyebrow">KLUZAR OUTREACH</p><h1>{activeTitle}</h1></div>{section === 'campaigns' && workspaces.length > 0 && <button className="button button-primary button-small" onClick={() => setShowCampaignForm((value) => !value)}>+ New campaign</button>}</div>
          {error && <div className="notice notice-error" role="alert">{error}</div>}
          {notice && <div className="notice notice-success" role="status">{notice}</div>}
          {!workspaces.length && <section className="empty-panel workspace-create"><span className="empty-icon">⌂</span><h2>Create your workspace</h2><p>Your campaigns and leads are private to your workspace. A workspace holds everything for one outreach effort — its lead lists, campaigns, senders and replies — and nothing in it is visible to any other workspace.</p><form onSubmit={createWorkspace}><label htmlFor="workspace-name">Workspace name</label><input id="workspace-name" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} maxLength={100} required /><button className="button button-primary" disabled={formBusy}>{formBusy ? 'Creating…' : 'Create workspace'}</button></form></section>}
          {workspaces.length > 0 && section === 'overview' && <><div className="welcome-panel"><div><p className="eyebrow">Your workspace is ready</p><h2>Build your outreach, one step at a time.</h2><p>Connect a sender, add leads you are authorised to contact, then test your first message.</p></div><a className="button button-primary" href="/dashboard/senders/">Set up a sender <span aria-hidden="true">→</span></a></div>
          <section className="table-panel onboarding-panel"><div className="table-panel-header"><div><h2>Your setup checklist</h2><p>Five steps from an empty workspace to a launched campaign. Each step ticks off as you complete it.</p></div>{onboarding && <span className="status-pill">{[onboarding.senderConnected, onboarding.leadsAdded, onboarding.campaignCreated, onboarding.testSent, onboarding.launched].filter(Boolean).length} of 5 done</span>}</div>{onboarding ? <ol className="onboarding-list">
            <li className={onboarding.senderConnected ? 'done' : ''}><span>{onboarding.senderConnected ? '✓' : '1'}</span><div><strong>Connect a mailbox</strong><p>Gmail or Microsoft via OAuth, so replies can be monitored and follow-ups can stop.</p></div><a href="/dashboard/senders/">{onboarding.senderConnected ? 'Connected' : 'Connect →'}</a></li>
            <li className={onboarding.leadsAdded ? 'done' : ''}><span>{onboarding.leadsAdded ? '✓' : '2'}</span><div><strong>Add your leads</strong><p>Create a lead list and add contacts you are authorised to contact.</p></div><a href="/dashboard/leads/">{onboarding.leadsAdded ? 'Added' : 'Add leads →'}</a></li>
            <li className={onboarding.campaignCreated ? 'done' : ''}><span>{onboarding.campaignCreated ? '✓' : '3'}</span><div><strong>Create a campaign</strong><p>Write the first message and add a follow-up with a delay.</p></div><a href="/dashboard/campaigns/">{onboarding.campaignCreated ? 'Created' : 'Create →'}</a></li>
            <li className={onboarding.testSent ? 'done' : ''}><span>{onboarding.testSent ? '✓' : '4'}</span><div><strong>Send a test</strong><p>Send a test to your own email and read it the way a recipient would.</p></div><a href="/dashboard/test/">{onboarding.testSent ? 'Tested' : 'Test →'}</a></li>
            <li className={onboarding.launched ? 'done' : ''}><span>{onboarding.launched ? '✓' : '5'}</span><div><strong>Launch a campaign</strong><p>Launch when the message, the audience and the sender all look right.</p></div><a href="/dashboard/campaigns/">{onboarding.launched ? 'Launched' : 'Launch →'}</a></li>
          </ol> : <div className="compact-empty">Loading your setup progress…</div>}</section>
          <section className="table-panel checklist-panel"><div className="table-panel-header"><div><h2>Getting started</h2><p>Four steps from an empty workspace to a tested first campaign.</p></div></div><ol className="checklist"><li><strong>Connect a sender.</strong> Gmail or Microsoft via OAuth, so replies can be monitored and follow-ups can stop. <a href="/dashboard/senders/">Open senders</a></li><li><strong>Add your leads.</strong> Create a lead list and add contacts you are authorised to contact, one by one or by CSV import. <a href="/dashboard/leads/">Open leads</a></li><li><strong>Draft a campaign.</strong> Write the first message, add a follow-up with a delay, and save it as a draft. <a href="/dashboard/campaigns/">Open campaigns</a></li><li><strong>Test, then launch.</strong> Send a test to your own email first. Launch only when the message, the audience and the sender look right. <a href="/dashboard/test/">Open test mode</a></li></ol><p className="muted-copy">Sending limits: 50 messages per workspace per day, at least 60 seconds between sends. Suppression is checked before every send, and launching asks you to confirm you have permission to contact the list.</p></section><div className="dashboard-cards"><a href="/dashboard/campaigns/"><span>01</span><h3>Campaigns</h3><p>Create a campaign when you are ready.</p></a><a href="/dashboard/leads/"><span>02</span><h3>Lead lists</h3><p>Add or import your own contacts.</p></a><a href="/dashboard/sequences/"><span>03</span><h3>Sequences</h3><p>Plan follow-ups that stop on reply.</p></a><a href="/dashboard/inbox/"><span>04</span><h3>Replies inbox</h3><p>Review detected campaign replies.</p></a></div><section className="table-panel notification-panel"><div className="table-panel-header"><div><h2>Notifications</h2><p>Updates from sequence rules.</p></div>{notifications.some((item) => !item.read_at) && <button className="text-button" onClick={markNotificationsRead}>Mark all read</button>}</div>{notifications.length ? notifications.map((item) => <div className="notification-row" key={item.id}><span className={!item.read_at ? 'notification-dot unread' : 'notification-dot'} /><p>{item.message}</p><time>{new Date(item.created_at).toLocaleDateString()}</time></div>) : <div className="compact-empty">No notifications yet.</div>}</section>
          <section className="table-panel notification-panel"><div className="table-panel-header"><div><h2>Recent activity</h2><p>What happened in this workspace, newest first.</p></div></div>{activity.length ? activity.slice(0, 10).map((item) => <div className="notification-row" key={item.id}><span className="notification-dot" /><p>{item.message}</p><time>{new Date(item.created_at).toLocaleString()}</time></div>) : <div className="compact-empty">No activity yet. Campaigns, imports, replies and suppressions will appear here.</div>}</section></>}
          {workspaces.length > 0 && section === 'campaigns' && <>
            {showCampaignForm && <section className="table-panel form-panel"><div className="table-panel-header"><div><h2>New campaign</h2><p>Choose an audience and a mailbox that supports reply monitoring.</p></div></div>{!lists.length || !senders.some((sender) => sender.type === 'gmail_oauth' || sender.type === 'outlook_oauth') ? <p className="muted-copy">Create a lead list and connect Gmail or Microsoft before creating a sendable campaign. The Kluzar sender is test-only.</p> : <form onSubmit={createCampaign}><label htmlFor="campaign-name">Campaign name</label><input id="campaign-name" value={campaignName} onChange={(event) => setCampaignName(event.target.value)} maxLength={120} required /><label htmlFor="campaign-list">Lead list</label><select id="campaign-list" value={selectedListId} onChange={(event) => setSelectedListId(event.target.value)} required>{lists.map((list) => <option value={list.id} key={list.id}>{list.name} ({list.lead_count})</option>)}</select><label htmlFor="campaign-sender">Reply-monitored sender</label><select id="campaign-sender" value={selectedSenderId} onChange={(event) => setSelectedSenderId(event.target.value)} required>{senders.filter((sender) => sender.type === 'gmail_oauth' || sender.type === 'outlook_oauth').map((sender) => <option value={sender.id} key={sender.id}>{sender.address}</option>)}</select><label htmlFor="campaign-subject">First email subject</label><input id="campaign-subject" value={campaignSubject} onChange={(event) => setCampaignSubject(event.target.value)} maxLength={200} required /><label htmlFor="campaign-body">First email</label><textarea id="campaign-body" value={campaignBody} onChange={(event) => setCampaignBody(event.target.value)} maxLength={10000} required /><p className="form-hint">Available variables: {'{{first_name}}'}, {'{{company}}'}. Messages are sent as plain text.</p><label htmlFor="followup-subject">Optional follow-up subject</label><input id="followup-subject" value={followupSubject} onChange={(event) => setFollowupSubject(event.target.value)} maxLength={200} /><label htmlFor="followup-days">Follow-up delay in days</label><input id="followup-days" type="number" min="1" max="365" value={followupDelay} onChange={(event) => setFollowupDelay(event.target.value)} /><label htmlFor="followup-body">Optional follow-up message</label><textarea id="followup-body" value={followupBody} onChange={(event) => setFollowupBody(event.target.value)} maxLength={10000} /><button className="button button-primary" disabled={formBusy}>{formBusy ? 'Saving…' : 'Create draft'}</button></form>}</section>}
            <section className="table-panel"><div className="table-panel-header"><div><h2>Campaigns</h2><p>Production launch requires a reply-monitored mailbox. Sending is limited to 50 messages per workspace per day, with at least 60 seconds between sends.</p></div></div>
              <div className="filter-bar"><input aria-label="Search campaigns" type="search" placeholder="Search campaigns…" value={campaignQuery} onChange={(event) => setCampaignQuery(event.target.value)} /><select aria-label="Filter by status" value={campaignStatus} onChange={(event) => setCampaignStatus(event.target.value)}><option value="">All statuses</option><option value="draft">Draft</option><option value="scheduled">Scheduled</option><option value="active">Active</option><option value="paused">Paused</option><option value="done">Done</option><option value="archived">Archived</option></select><select aria-label="Sort campaigns" value={campaignSort} onChange={(event) => setCampaignSort(event.target.value)}><option value="created_desc">Newest first</option><option value="created_asc">Oldest first</option><option value="name_asc">Name A–Z</option><option value="name_desc">Name Z–A</option></select></div>
              {preview && <div className="preview-panel"><div className="table-panel-header"><div><h2>Preview — {preview.campaign.name}</h2><p>Exactly what the lead will receive, with their details filled in.</p></div><button className="text-button" onClick={() => setPreview(null)}>Close preview</button></div>{previewLeads.length > 0 && <label className="preview-lead-select">Preview as<select value={previewLeadId} onChange={(event) => changePreviewLead(preview.campaign.id, event.target.value)}>{previewLeads.map((lead) => <option value={lead.id} key={lead.id}>{lead.email}{lead.first_name ? ` — ${lead.first_name}` : ''}</option>)}</select></label>}{preview.lead && <p className="muted-copy">Previewing with {preview.lead.email}{preview.lead.first_name ? ` (${preview.lead.first_name}${preview.lead.company ? `, ${preview.lead.company}` : ''})` : ''}.</p>}{preview.steps.length ? preview.steps.map((step) => <article className="preview-step" key={step.step_no}><span>Step {step.step_no}{step.delay_days > 0 ? ` · sent ${step.delay_days} days after the previous step` : ' · sent first'}</span><h3>{step.subject}</h3><pre>{step.body}</pre></article>) : <div className="compact-empty">This campaign has no message steps yet.</div>}</div>}
              {prelaunch && <div className="preview-panel"><div className="table-panel-header"><div><h2>Pre-launch check — {prelaunch.campaign.name}</h2><p>Review the audience and the sender before anything is sent.</p></div><button className="text-button" onClick={() => setPrelaunch(null)}>Close check</button></div><ul className="check-summary">
                <li className={prelaunch.senderReady ? 'ok' : 'warn'}><strong>{prelaunch.senderReady ? '✓' : '!'}</strong><span>Sender: {prelaunch.sender ? `${prelaunch.sender.address} (${prelaunch.sender.type === 'gmail_oauth' ? 'Gmail' : 'Microsoft'})` : 'no sender connected'}</span></li>
                <li className={prelaunch.hasFirstStep ? 'ok' : 'warn'}><strong>{prelaunch.hasFirstStep ? '✓' : '!'}</strong><span>{prelaunch.steps} message step{prelaunch.steps === 1 ? '' : 's'}{prelaunch.hasFirstStep ? ', starting with step 1' : ' — a first step is required'}</span></li>
                <li className={prelaunch.readyToSend > 0 ? 'ok' : 'warn'}><strong>{prelaunch.readyToSend > 0 ? '✓' : '!'}</strong><span>{prelaunch.readyToSend} of {prelaunch.totalInList} leads ready to receive the first message</span></li>
                <li className={prelaunch.suppressedInList > 0 ? 'warn' : 'ok'}><strong>{prelaunch.suppressedInList > 0 ? '!' : '✓'}</strong><span>{prelaunch.suppressedInList} suppressed address{prelaunch.suppressedInList === 1 ? '' : 'es'} in this list — they will not be contacted</span></li>
                <li className={prelaunch.excludedInList > 0 ? 'warn' : 'ok'}><strong>{prelaunch.excludedInList > 0 ? '!' : '✓'}</strong><span>{prelaunch.excludedInList} bounced or unsubscribed lead{prelaunch.excludedInList === 1 ? '' : 's'} excluded</span></li>
                {prelaunch.variablesUsed.first_name && <li className={prelaunch.fieldsPresent.first_name ? 'ok' : 'warn'}><strong>{prelaunch.fieldsPresent.first_name ? '✓' : '!'}</strong><span>Uses {'{{first_name}}'} — {prelaunch.fieldsPresent.first_name ? 'at least one lead has a first name' : 'no lead in this list has a first name, so it will be blank'}</span></li>}
                {prelaunch.variablesUsed.company && <li className={prelaunch.fieldsPresent.company ? 'ok' : 'warn'}><strong>{prelaunch.fieldsPresent.company ? '✓' : '!'}</strong><span>Uses {'{{company}}'} — {prelaunch.fieldsPresent.company ? 'at least one lead has a company' : 'no lead in this list has a company, so it will be blank'}</span></li>}
              </ul>
              {prelaunch.campaign.status === 'draft' && <form className="schedule-form" onSubmit={(event) => { event.preventDefault(); void scheduleCampaign(prelaunch.campaign.id) }}><label htmlFor="schedule-at">Schedule launch for</label><input id="schedule-at" type="datetime-local" value={scheduleValue} onChange={(event) => setScheduleValue(event.target.value)} required /><button className="button button-outline button-small" disabled={formBusy}>Schedule launch</button></form>}
              <p className="form-hint">Scheduled launches are picked up by the Worker within a minute of the chosen time. Launching still asks you to confirm you have permission to contact the list.</p></div>}
              {records.filter((record): record is Campaign => 'name' in record && 'status' in record && 'lead_list_id' in record).length ? <div className="campaign-list">{records.filter((record): record is Campaign => 'name' in record && 'status' in record && 'lead_list_id' in record).map((campaign) => <article className="campaign-row" key={campaign.id}><div><strong>{campaign.name}</strong><span>{campaign.status}{campaign.scheduled_at ? ` · scheduled ${new Date(campaign.scheduled_at).toLocaleString()}` : ''} · {lists.find((list) => list.id === campaign.lead_list_id)?.name ?? 'Lead list'}</span>{stats[campaign.id] && <small>{Object.entries(stats[campaign.id]).map(([key, value]) => `${key}: ${value}`).join(' · ') || 'No events recorded'}</small>}</div><div className="row-actions"><button className="text-button" onClick={() => showCampaignStats(campaign.id)}>View stats</button><button className="text-button" onClick={() => openPreview(campaign)}>Preview</button><button className="text-button" onClick={() => openPrelaunch(campaign)}>Check before launch</button><button className="text-button" onClick={() => cloneCampaign(campaign.id)}>Duplicate</button><button className="text-button" onClick={() => exportCampaignStatsCsv(campaign)}>Export stats</button>{campaign.status === 'archived' ? <button className="text-button" onClick={() => unarchiveCampaign(campaign.id)}>Restore</button> : <button className="text-button" onClick={() => archiveCampaign(campaign.id)}>Archive</button>}{campaign.status === 'scheduled' && <button className="text-button" onClick={() => cancelSchedule(campaign)}>Cancel schedule</button>}{campaign.status === 'draft' && <><label className="launch-confirm"><input type="checkbox" checked={launchConfirmation === campaign.id} onChange={(event) => setLaunchConfirmation(event.target.checked ? campaign.id : '')} /> I have permission to contact this list</label><button className="button button-primary button-small" disabled={formBusy || launchConfirmation !== campaign.id} onClick={() => launchCampaign(campaign.id)}>Launch</button></>}</div></article>)}</div> : <div className="table-empty"><span className="empty-icon">↗</span><h3>No campaigns yet</h3><p>Create a draft after connecting a mailbox and adding a lead list. A campaign needs a lead list, a reply-monitored sender, and a first message — then test it to your own email before launch.</p><p className="muted-copy">Drafts are free to create and change. Launching queues recipients for paced sending, with suppression checked before every send.</p></div>}</section>
          </>}
          {workspaces.length > 0 && section === 'leads' && <>
            <section className="table-panel"><div className="table-panel-header"><div><h2>Lead lists</h2><p>Organise contacts you are authorised to contact. Only import lists you have permission to use — purchased or scraped lists do not belong here.</p></div><div className="row-actions"><button className="button button-outline button-small" onClick={() => setShowListForm((value) => !value)}>New list</button><button className="button button-primary button-small" onClick={() => setShowLeadForm((value) => !value)}>Add lead</button></div></div>
              {showListForm && <form className="inline-form" onSubmit={createList}><label htmlFor="new-list-name">List name</label><input id="new-list-name" value={newListName} onChange={(event) => setNewListName(event.target.value)} maxLength={100} required /><button className="button button-primary button-small" disabled={formBusy}>Create list</button></form>}
              {showLeadForm && <form className="form-grid" onSubmit={createLead}><label htmlFor="lead-list">List<select id="lead-list" value={selectedListId} onChange={(event) => setSelectedListId(event.target.value)} required>{lists.map((list) => <option value={list.id} key={list.id}>{list.name}</option>)}</select></label><label htmlFor="lead-email">Email<input id="lead-email" type="email" autoComplete="off" value={leadEmail} onChange={(event) => setLeadEmail(event.target.value)} maxLength={254} required /></label><label htmlFor="lead-first-name">First name<input id="lead-first-name" value={leadFirstName} onChange={(event) => setLeadFirstName(event.target.value)} maxLength={100} /></label><label htmlFor="lead-company">Company<input id="lead-company" value={leadCompany} onChange={(event) => setLeadCompany(event.target.value)} maxLength={150} /></label><button className="button button-primary button-small" disabled={formBusy}>Add lead</button></form>}
              {path.includes('/import/') && <form className="form-panel csv-form" onSubmit={importCsv}><h3>Import a CSV</h3><p className="form-hint">The file is validated server-side. The email column is required; first_name and company are optional. Maximum file size: 5 MB.</p><label htmlFor="csv-list">Add contacts to</label><select id="csv-list" value={selectedListId} onChange={(event) => setSelectedListId(event.target.value)} required>{lists.map((list) => <option value={list.id} key={list.id}>{list.name}</option>)}</select><label htmlFor="csv-file">CSV file</label><input id="csv-file" type="file" accept=".csv,text/csv" onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)} required /><button className="button button-primary button-small" disabled={formBusy}>{formBusy ? 'Importing…' : 'Import contacts'}</button></form>}
              {lists.length > 0 && <div className="list-chips">{lists.map((list) => <button className={selectedListId === list.id ? 'list-chip active' : 'list-chip'} key={list.id} onClick={() => setSelectedListId(list.id)}>{list.name}<span>{list.lead_count}</span></button>)}</div>}
              <div className="filter-bar"><input aria-label="Search leads" type="search" placeholder="Search name, email or company…" value={leadQuery} onChange={(event) => setLeadQuery(event.target.value)} /><select aria-label="Filter leads by status" value={leadStatus} onChange={(event) => setLeadStatus(event.target.value)}><option value="">All statuses</option>{['new', 'contacted', 'replied', 'interested', 'not_interested', 'bounced', 'unsubscribed'].map((status) => <option value={status} key={status}>{status.replaceAll('_', ' ')}</option>)}</select><select aria-label="Sort leads" value={leadSort} onChange={(event) => setLeadSort(event.target.value)}><option value="created_desc">Newest first</option><option value="created_asc">Oldest first</option><option value="email_asc">Email A–Z</option><option value="email_desc">Email Z–A</option></select>{lists.find((list) => list.id === selectedListId) && <button className="button button-outline button-small" onClick={() => exportListCsv(lists.find((list) => list.id === selectedListId)!)}>Export list CSV</button>}</div>
              {selectedLeadIds.length > 0 && <div className="bulk-bar"><span>{selectedLeadIds.length} selected</span><select aria-label="Bulk status" value={bulkStatus} onChange={(event) => setBulkStatus(event.target.value)}>{['new', 'contacted', 'replied', 'interested', 'not_interested', 'bounced', 'unsubscribed'].map((status) => <option value={status} key={status}>{status.replaceAll('_', ' ')}</option>)}</select><button className="button button-primary button-small" onClick={() => void bulkUpdateLeads()}>Apply status</button><button className="text-button" onClick={() => setSelectedLeadIds([])}>Clear selection</button></div>}
              {records.filter((record): record is Lead => 'email' in record && 'status' in record).length ? <div className="data-list"><div className="lead-row lead-row-header"><input type="checkbox" aria-label="Select all leads shown" checked={records.filter((record): record is Lead => 'email' in record && 'status' in record).length > 0 && selectedLeadIds.length === records.filter((record): record is Lead => 'email' in record && 'status' in record).length} onChange={() => toggleSelectAllLeads(records.filter((record): record is Lead => 'email' in record && 'status' in record))} /><div><strong>Lead</strong></div><span>Status</span></div>{records.filter((record): record is Lead => 'email' in record && 'status' in record).map((lead) => <div className="lead-row" key={lead.id}><input type="checkbox" aria-label={`Select ${lead.email}`} checked={selectedLeadIds.includes(lead.id)} onChange={() => toggleSelectLead(lead.id)} /><div><button className="text-button lead-email-button" onClick={() => openLeadTimeline(lead)}>{lead.email}</button><span>{[lead.first_name, lead.company].filter(Boolean).join(' · ')}</span></div><select aria-label={`Status for ${lead.email}`} value={lead.status} onChange={(event) => updateLeadStatus(lead.id, event.target.value)}>{['new', 'contacted', 'replied', 'interested', 'not_interested', 'bounced', 'unsubscribed'].map((status) => <option value={status} key={status}>{status.replaceAll('_', ' ')}</option>)}</select></div>)}</div> : <div className="table-empty"><span className="empty-icon">◎</span><h3>No leads yet</h3><p>Add contacts manually or import a CSV into a list. The CSV needs an email column; first name and company are optional. Invalid and duplicate addresses are rejected, and suppressed addresses stay suppressed.</p><p className="muted-copy">Change a lead\u2019s status any time — marking someone unsubscribed stops future sends to them.</p><a className="button button-outline button-small" href="/dashboard/leads/import/">Import CSV</a></div>}
            </section>
            {timeline && <section className="table-panel"><div className="table-panel-header"><div><h2>Activity — {timeline.lead.email}</h2><p>Every recorded event for this lead, from import to reply.</p></div><button className="text-button" onClick={() => setTimeline(null)}>Close timeline</button></div><ol className="timeline-list">{timeline.timeline.map((event, index) => <li key={`${event.type}-${event.at}-${index}`}><span>{new Date(event.at).toLocaleString()}</span><div><strong>{event.type.replaceAll('_', ' ')}</strong>{event.campaign_name && <p>{event.campaign_name}{event.sequence_step ? ` · step ${event.sequence_step}` : ''}</p>}</div></li>)}</ol></section>}
            <section className="table-panel"><div className="table-panel-header"><div><h2>Suppression manager</h2><p>Suppressed addresses never receive outreach. Add an address here, or remove one to allow contact again.</p></div></div>
              <form className="inline-form" onSubmit={addSuppression}><label htmlFor="supp-email">Email address<input id="supp-email" type="email" autoComplete="off" value={suppEmail} onChange={(event) => setSuppEmail(event.target.value)} maxLength={254} required /></label><label htmlFor="supp-reason">Reason<select id="supp-reason" value={suppReason} onChange={(event) => setSuppReason(event.target.value)}><option value="unsubscribed">Unsubscribed</option><option value="bounced">Bounced</option><option value="complaint">Complaint</option></select></label><button className="button button-primary button-small" disabled={formBusy}>Suppress address</button></form>
              {suppressions.length ? <div className="data-list">{suppressions.map((item) => <div className="lead-row" key={item.id}><div><strong>{item.email}</strong><span>{item.reason} · {new Date(item.created_at).toLocaleDateString()}</span></div><button className="text-button" onClick={() => removeSuppression(item)}>Remove suppression</button></div>)}</div> : <div className="compact-empty">No suppressed addresses in this workspace.</div>}
            </section>
          </>}
          {workspaces.length > 0 && section === 'sequences' && <><section className="table-panel"><div className="table-panel-header"><div><h2>Sequence steps</h2><p>Follow-ups stop automatically when a reply is detected. Each step has a subject, a delay in days, and a message written by you.</p></div></div>{records.filter((record): record is SequenceStep => 'step_no' in record).length ? <div className="data-list">{records.filter((record): record is SequenceStep => 'step_no' in record).map((step) => <div key={step.id}><strong>Step {step.step_no}: {step.subject}</strong><span>Day {step.delay_days} · {step.campaign_id}</span><button className="text-button" onClick={() => cloneSequenceStep(step.id)}>Duplicate step</button></div>)}</div> : <div className="table-empty"><span className="empty-icon">⌁</span><h3>No sequence steps yet</h3><p>Create a campaign and add its first message. A sequence is the campaign\u2019s messages in order: the first message, then each follow-up after its delay. Keep the number of steps small and give each one a reason to exist.</p><a className="text-link" href="/dashboard/campaigns/">Go to campaigns <span aria-hidden="true">→</span></a></div>}</section>
            {records.filter((record): record is SequenceStep => 'step_no' in record).length > 0 && <section className="table-panel form-panel"><div className="table-panel-header"><div><h2>Add a conditional branch</h2><p>Branch rules are evaluated by the Worker scheduler.</p></div></div><form onSubmit={addBranch}><label htmlFor="branch-step">Sequence step</label><select id="branch-step" value={branchSequenceId} onChange={(event) => setBranchSequenceId(event.target.value)} required>{records.filter((record): record is SequenceStep => 'step_no' in record).map((step) => <option value={step.id} key={step.id}>Step {step.step_no}: {step.subject}</option>)}</select><label htmlFor="branch-condition">Condition</label><select id="branch-condition" value={branchCondition} onChange={(event) => setBranchCondition(event.target.value)}><option value="no_reply_after_days">No reply after a delay</option><option value="replied">A reply is detected</option></select>{branchCondition === 'no_reply_after_days' && <><label htmlFor="branch-days">Days without reply</label><input id="branch-days" type="number" min="1" max="365" value={branchConditionValue} onChange={(event) => setBranchConditionValue(event.target.value)} required /></>}<label htmlFor="branch-action">Action</label><select id="branch-action" value={branchAction} onChange={(event) => setBranchAction(event.target.value)}><option value="stop">Stop sequence</option><option value="send_followup">Send a follow-up step</option><option value="change_status">Change lead status</option><option value="notify">Notify workspace owner</option></select>{branchAction === 'change_status' && <select aria-label="New lead status" value={branchActionValue} onChange={(event) => setBranchActionValue(event.target.value)} required>{['contacted', 'replied', 'interested', 'not_interested', 'bounced', 'unsubscribed'].map((status) => <option value={status} key={status}>{status.replaceAll('_', ' ')}</option>)}</select>}{branchAction === 'send_followup' && <input aria-label="Follow-up step number (optional)" type="number" min="1" max="50" placeholder="Next step, or enter a step number" value={branchActionValue} onChange={(event) => setBranchActionValue(event.target.value)} />}<button className="button button-primary button-small" disabled={formBusy}>Save branch</button></form></section>}</>}
          {workspaces.length > 0 && section === 'inbox' && <section className="table-panel"><div className="table-panel-header"><div><h2>Replies</h2><p>Replies are detected by polling connected Gmail and Microsoft threads. When a reply arrives, the lead\u2019s active sequence stops.</p></div></div>
            <div className="filter-bar"><select aria-label="Filter replies by campaign" value={inboxCampaignFilter} onChange={(event) => setInboxCampaignFilter(event.target.value)}><option value="">All campaigns</option>{inboxCampaigns.map((campaign) => <option value={campaign.id} key={campaign.id}>{campaign.name}</option>)}</select><select aria-label="Filter replies by read state" value={inboxReadFilter} onChange={(event) => setInboxReadFilter(event.target.value)}><option value="">All replies</option><option value="unread">Unread</option><option value="read">Read</option></select></div>
            {records.filter((record): record is Reply => 'sender_email' in record && 'body_text' in record).length ? <div className="reply-list">{records.filter((record): record is Reply => 'sender_email' in record && 'body_text' in record).map((reply) => <article key={reply.id} className={reply.read_at ? '' : 'reply-unread'}><div className="reply-header"><div><strong>{reply.sender_email}</strong><span>{reply.lead_email}{reply.campaign_id ? ` · ${inboxCampaigns.find((item) => item.id === reply.campaign_id)?.name ?? ''}` : ''}</span></div><time>{new Date(reply.received_at).toLocaleString()}</time></div><h3>{reply.subject || '(no subject)'}</h3><pre>{reply.body_text}</pre>
            <div className="reply-actions"><button className="text-button" onClick={() => toggleInboxRead(reply)}>{reply.read_at ? 'Mark unread' : 'Mark read'}</button>{reply.lead_id && <><button className="text-button" onClick={() => updateLeadStatus(reply.lead_id!, 'interested')}>Mark interested</button><button className="text-button" onClick={() => updateLeadStatus(reply.lead_id!, 'not_interested')}>Mark not interested</button></>}</div>
            <div className="reply-composer"><label htmlFor={`reply-${reply.id}`}>Reply to {reply.lead_email}</label>{snippets.length > 0 && <select aria-label="Insert a saved reply" value="" onChange={(event) => { if (event.target.value) insertSnippet(reply.id, event.target.value) }}><option value="">Insert a saved reply…</option>{snippets.map((snippet) => <option value={snippet.id} key={snippet.id}>{snippet.title}</option>)}</select>}<textarea id={`reply-${reply.id}`} value={replyDrafts[reply.id] ?? ''} onChange={(event) => setReplyDrafts((current) => ({ ...current, [reply.id]: event.target.value }))} maxLength={10000} placeholder="Write your reply…" /><p className="form-hint">Sent from the connected mailbox, threaded to the original message. The daily limit of 50 sends applies, and the lead stays stopped afterwards — no further follow-ups will be sent.</p><button className="button button-primary button-small" disabled={replyingId === reply.id || !(replyDrafts[reply.id] ?? '').trim()} onClick={() => sendInboxReply(reply)}>{replyingId === reply.id ? 'Sending…' : 'Send reply'}</button></div>
            </article>)}</div> : <div className="table-empty"><span className="empty-icon">↩</span><h3>No replies detected</h3><p>Replies from monitored mailbox threads will appear here. Reply detection needs a connected Gmail or Microsoft mailbox — the Kluzar test sender cannot receive replies, so campaigns sent from it would never stop on reply. That is why production campaigns require your own mailbox.</p></div>}</section>}
          {workspaces.length > 0 && section === 'senders' && <><section className="table-panel"><div className="table-panel-header"><div><h2>Connected mailboxes</h2><p>Connected mailbox tokens are encrypted server-side. Read access is used only to detect replies on Outreach threads.</p></div></div>{records.filter((record): record is Sender => 'type' in record && 'address' in record).map((sender) => <div className="sender-row" key={sender.id}><div><strong>{sender.address}</strong><span>{sender.type === 'gmail_oauth' ? 'Gmail · reply monitoring enabled' : sender.type === 'outlook_oauth' ? 'Microsoft · reply monitoring enabled' : 'Kluzar sender · test mode only'}</span></div><span className="status-pill">{sender.type === 'brevo_default' ? 'Test only' : 'Connected'}</span></div>)}{!records.length && <div className="compact-empty">No senders connected yet. Connect a mailbox below to send production campaigns — or enable the Kluzar test sender to try test mode first.</div>}</section><section className="table-panel form-panel"><h2>Connect a mailbox</h2><p className="muted-copy">Production campaigns require Gmail or Microsoft OAuth so replies can stop follow-ups. Consent includes sending mail and reading mailbox threads for reply detection. You sign in with the mailbox provider — Kluzar Outreach never asks for your mailbox password, and tokens are encrypted server-side.</p><div className="row-actions"><button className="button button-outline button-small" disabled={formBusy || !workspaceId} onClick={() => connectMailbox('google')}>Connect Gmail</button><button className="button button-outline button-small" disabled={formBusy || !workspaceId} onClick={() => connectMailbox('microsoft')}>Connect Microsoft</button><button className="button button-primary button-small" disabled={formBusy || !workspaceId} onClick={addBrevoSender}>Enable Kluzar test sender</button></div><p className="form-hint">OAuth callback URLs: <code>https://outreach.kluzar.com/oauth/google/callback</code> and <code>https://outreach.kluzar.com/oauth/microsoft/callback</code>.</p><p className="form-hint">The Kluzar test sender is for tests only. It cannot receive replies, so a campaign sent from it could never stop on reply — that is why production campaigns need your own mailbox.</p></section><section className="table-panel"><h2>Domain management</h2><p className="muted-copy">Check SPF, DKIM, and DMARC status with your mailbox provider. This dashboard does not claim verification until a provider integration is configured. These three records tell receiving mailboxes that your domain is allowed to send, that messages have not been altered, and what to do when a check fails — without them, even good mail can land in spam.</p><a className="text-link" href={SUPPORT_URL}>Contact support <span aria-hidden="true">→</span></a></section></>}
          {workspaces.length > 0 && section === 'test' && <><section className="empty-panel test-panel"><span className="empty-icon">□</span><p className="eyebrow">SAFE TESTING</p><h2>Send a test only to yourself.</h2><p>Test messages go only to your verified Accounts email, never to workspace leads. Use test mode to read the message the way a recipient would — check the sender name, the subject, the links, and the plain-text rendering — before you launch anything.</p><p className="muted-copy">No mailbox is needed to test: the Kluzar sender handles test messages. To test a campaign draft, pick it from the list below; the test carries that draft\u2019s subject and message, sent only to you.</p><form onSubmit={sendTest}><label htmlFor="test-email">Your verified email</label><input id="test-email" type="email" autoComplete="email" value={testEmail} onChange={(event) => setTestEmail(event.target.value)} maxLength={254} required /><button className="button button-primary" disabled={formBusy || !ownEmail}>{formBusy ? 'Sending…' : 'Send test email'}</button></form><form onSubmit={sendCampaignTest}><label htmlFor="test-campaign">Test a campaign draft</label><select id="test-campaign" value={testCampaignId} onChange={(event) => setTestCampaignId(event.target.value)} required><option value="">Select a campaign</option>{records.filter((record): record is Campaign => 'name' in record && 'status' in record && 'lead_list_id' in record && record.status === 'draft').map((campaign) => <option value={campaign.id} key={campaign.id}>{campaign.name}</option>)}</select><button className="button button-outline" disabled={formBusy || !testCampaignId || !ownEmail}>Send campaign test</button></form></section></>}
          {workspaces.length > 0 && !endpoint && !['overview', 'test', 'settings'].includes(section) && <section className="empty-panel"><h2>{activeTitle}</h2><p>This section will show items from your workspace when configured.</p></section>}
          {workspaces.length > 0 && section === 'settings' && <><section className="table-panel"><h2>Workspace settings</h2><p className="muted-copy">Your workspace is private to your account. Account identity and sign-in are managed by Kluzar Accounts. Campaigns, leads, replies and sender settings in this workspace are visible only to your account — another workspace cannot read them.</p><p className="muted-copy">Sending limits for this workspace: 50 messages per day, at least 60 seconds between sends. Suppression is checked before every send, and the Kluzar sender is available for tests only.</p><div className="row-actions"><a className="button button-outline button-small" href={accountUrl('login', `${window.location.origin}/dashboard/settings/`)}>Manage account</a><a className="button button-outline button-small" href={SUPPORT_URL}>Visit support</a><a className="button button-outline button-small" href={CONTACT_URL}>Contact Kluzar</a></div></section>
          <section className="table-panel"><div className="table-panel-header"><div><h2>Appearance</h2><p>Dark mode applies to the dashboard and is saved on this device.</p></div></div><label className="launch-confirm"><input type="checkbox" checked={darkMode} onChange={(event) => setDarkMode(event.target.checked)} /> Dark mode for the dashboard</label></section>
          <section className="table-panel"><div className="table-panel-header"><div><h2>Notifications</h2><p>Choose whether new replies also reach you by email. Replies always appear in the dashboard inbox.</p></div></div>{preferences ? <label className="launch-confirm"><input type="checkbox" checked={preferences.notifyReplyEmail} onChange={(event) => updateNotificationPreference(event.target.checked)} /> Email me when a lead replies</label> : <div className="compact-empty">Loading notification preferences…</div>}</section>
          <section className="table-panel"><div className="table-panel-header"><div><h2>Saved replies</h2><p>Your own short reply texts — written by you, inserted with one click while replying from the inbox. No AI writing involved.</p></div></div>
            <form className="form-panel" onSubmit={saveSnippet}><label htmlFor="snippet-title">Snippet title</label><input id="snippet-title" value={snippetTitle} onChange={(event) => setSnippetTitle(event.target.value)} maxLength={100} required /><label htmlFor="snippet-body">Reply text</label><textarea id="snippet-body" value={snippetBody} onChange={(event) => setSnippetBody(event.target.value)} maxLength={2000} required /><button className="button button-primary button-small" disabled={formBusy}>Save snippet</button></form>
            {snippets.length ? <div className="data-list">{snippets.map((snippet) => <div className="lead-row" key={snippet.id}><div><strong>{snippet.title}</strong><span>{snippet.body.slice(0, 120)}{snippet.body.length > 120 ? '…' : ''}</span></div><button className="text-button" onClick={() => deleteSnippet(snippet.id)}>Delete</button></div>)}</div> : <div className="compact-empty">No saved replies yet. Save the short replies you send most often.</div>}
          </section></>}
          {workspaces.length > 0 && section === 'deliverability' && <section className="table-panel"><div className="table-panel-header"><div><h2>Deliverability checklist</h2><p>Plain-language steps that keep your mail in the inbox — not in spam.</p></div></div>
            <div className="feature-grid inner-grid">
              <article className="feature-card"><div className="feature-card-top"><span>01</span><b aria-hidden="true">✓</b></div><h3>Authenticate your domain</h3><p>SPF, DKIM and DMARC tell receiving mailboxes that your domain is allowed to send, that messages have not been altered, and what to do when a check fails. Set them up with your mailbox or domain provider — without them, even good mail can land in spam.</p></article>
              <article className="feature-card"><div className="feature-card-top"><span>02</span><b aria-hidden="true">✓</b></div><h3>Send from your own mailbox</h3><p>Mail from your own domain arrives as a message from a real person at a real business. Shared sending services send from shared infrastructure, so their reputation is shared with every other sender on the same system — and your mail is far more likely to land in Promotions, or in spam.</p></article>
              <article className="feature-card"><div className="feature-card-top"><span>03</span><b aria-hidden="true">✓</b></div><h3>Respect the daily limit</h3><p>50 messages per workspace per day, with at least 60 seconds between sends. A sudden spike from a domain with no sending history is one of the most common reasons new senders land in spam — start small and grow slowly.</p></article>
              <article className="feature-card"><div className="feature-card-top"><span>04</span><b aria-hidden="true">✓</b></div><h3>Keep lists clean</h3><p>Only contact people you are authorised to contact. Remove invalid addresses instead of retrying them, and honour every unsubscribe immediately. Every bounce and complaint is a signal to mailbox providers.</p></article>
              <article className="feature-card"><div className="feature-card-top"><span>05</span><b aria-hidden="true">✓</b></div><h3>Stop on reply</h3><p>A reply is the strongest signal a recipient can send. Outreach stops the follow-up sequence automatically when a reply is detected — nobody keeps receiving messages after they have answered you.</p></article>
              <article className="feature-card"><div className="feature-card-top"><span>06</span><b aria-hidden="true">✓</b></div><h3>Test before you launch</h3><p>Send a test to your own email and read it the way a recipient would. Check the sender name, the subject, the links, and the plain-text rendering before anything reaches a real lead.</p></article>
            </div>
            <p className="muted-copy">Keep reading: <a href="/blog/a-practical-guide-to-email-deliverability/">A practical guide to email deliverability</a> · <a href="/blog/how-to-plan-a-respectful-outreach-sequence/">How to plan a respectful outreach sequence</a> · <a href="/blog/using-suppression-lists-correctly/">Using suppression lists correctly</a> · <a href="/blog/testing-an-email-campaign-before-launch/">Testing an email campaign before launch</a></p>
          </section>}
        </section>
      </main>
    </div>
  )
}

function InstallPrompt() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null)
  useEffect(() => {
    const listener = (event: Event) => {
      event.preventDefault()
      setInstallEvent(event as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', listener)
    return () => window.removeEventListener('beforeinstallprompt', listener)
  }, [])
  if (!installEvent) return null
  return <button className="install-prompt" onClick={async () => { await installEvent.prompt(); setInstallEvent(null) }}>Install Kluzar Outreach</button>
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
}

function OAuthCallbackPage({ provider }: { provider: 'google' | 'microsoft' }) {
  const [code] = useState(() => new URLSearchParams(window.location.search).get('code') ?? '')
  const [state] = useState(() => new URLSearchParams(window.location.search).get('state') ?? '')
  const [providerError] = useState(() => new URLSearchParams(window.location.search).has('error'))
  const [message, setMessage] = useState('Finishing mailbox connection…')

  useEffect(() => {
    window.history.replaceState({}, '', `/oauth/${provider}/callback/`)
    if (providerError || !code || !state) {
      setMessage('Mailbox connection was not completed. You can try again from sender settings.')
      return
    }
    let active = true
    const complete = async () => {
      try {
        const session = await fetchAccountSession()
        if (!session.authenticated || !session.csrfToken) throw new Error('Your session could not be verified.')
        const assertion = await getAssertion(session.csrfToken)
        if (!assertion) throw new Error('Your sign-in expired. Sign in again, then reconnect your mailbox.')
        const exchanged = await apiRequest('/oauth/' + provider + '/exchange', {
          method: 'POST',
          body: JSON.stringify({ code, state }),
        }, session.csrfToken)
        if (!exchanged.response.ok) throw new Error(exchanged.payload.error ?? 'Mailbox connection could not be completed.')
        if (active) {
          setMessage('Mailbox connected. Returning to sender settings…')
          window.location.replace('/dashboard/senders/')
        }
      } catch (cause) {
        if (active) setMessage(cause instanceof Error ? cause.message : 'Mailbox connection could not be completed.')
      }
    }
    void complete()
    return () => { active = false }
  }, [code, provider, providerError, state])

  return <main className="auth-page"><a href="/" className="brand-link"><Logo /></a><section className="auth-card"><span className="loading-spinner" /><h1>Mailbox setup</h1><p role="status">{message}</p><a className="back-link" href="/dashboard/senders/">Back to sender settings</a></section></main>
}

function App() {
  const [path, setPath] = useState(window.location.pathname)
  const [tryError, setTryError] = useState('')
  const normalizedPath = useMemo(() => path.endsWith('/') ? path : `${path}/`, [path])
  usePageMetadata(normalizedPath)
  useAnalytics(normalizedPath)
  useEffect(() => {
    const handleNavigation = () => setPath(window.location.pathname)
    window.addEventListener('popstate', handleNavigation)
    const handleClick = (event: MouseEvent) => {
      const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
      if (!link || link.origin !== window.location.origin || link.target || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const target = new URL(link.href)
      if (target.pathname.startsWith('/dashboard/') || target.pathname === '/login/' || target.pathname.startsWith('/blog/') || ['/', '/features/', '/pricing/', '/faq/', '/privacy/', '/terms/'].includes(target.pathname)) {
        event.preventDefault()
        window.history.pushState({}, '', `${target.pathname}${target.search}${target.hash}`)
        setPath(target.pathname)
        window.scrollTo(0, 0)
      }
    }
    document.addEventListener('click', handleClick)
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/service-worker.js').catch(() => {
      window.dispatchEvent(new CustomEvent('kluzar-service-worker-error'))
    })
    return () => {
      window.removeEventListener('popstate', handleNavigation)
      document.removeEventListener('click', handleClick)
    }
  }, [])

  const tryNow = async () => {
    setTryError('')
    try {
      const session = await fetchAccountSession()
      if (!session.authenticated || !session.csrfToken) {
        window.location.assign('/login/?next=%2Fdashboard%2F')
        return
      }
      const { response, payload } = await apiRequest('/me', {}, session.csrfToken)
      if (response.ok) {
        window.location.assign('/dashboard/')
      } else if (response.status === 401) {
        window.location.assign('/login/?next=%2Fdashboard%2F')
      } else {
        setTryError(payload.error ?? 'We could not verify your session. Please try again.')
      }
    } catch {
      setTryError('We could not reach the sign-in service. Please try again.')
    }
  }

  let page
  if (normalizedPath === '/') page = <LandingPage onTry={tryNow} tryError={tryError} />
  else if (normalizedPath === '/login/') page = <LoginPage />
  else if (normalizedPath.startsWith('/dashboard/')) page = <DashboardPage path={normalizedPath} />
  else if (normalizedPath === '/oauth/google/callback/') page = <OAuthCallbackPage provider="google" />
  else if (normalizedPath === '/oauth/microsoft/callback/') page = <OAuthCallbackPage provider="microsoft" />
  else if (normalizedPath === '/blog/' || normalizedPath.startsWith('/blog/')) page = <BlogPage path={normalizedPath} />
  else if (['/features/', '/pricing/', '/faq/', '/privacy/', '/terms/'].includes(normalizedPath)) page = <InfoPage path={normalizedPath} />
  else page = <NotFoundPage />

  return <><InstallPrompt />{page}</>
}

export default App
