import { DAILY_SEND_LIMIT, SEND_INTERVAL_SECONDS } from './api'
import { BentoIcon } from './icons'
import type { Sender } from './types'

const DELIVERABILITY_CARDS = [
  { number: '01', title: 'Authenticate your domain', body: 'SPF, DKIM and DMARC tell receiving mailboxes that your domain is allowed to send, that messages have not been altered, and what to do when a check fails. Set them up with your mailbox or domain provider — without them, even good mail can land in spam.' },
  { number: '02', title: 'Send from your own mailbox', body: 'Mail from your own domain arrives as a message from a real person at a real business. Shared sending services send from shared infrastructure, so their reputation is shared with every other sender on the same system — and your mail is far more likely to land in Promotions, or in spam.' },
  { number: '03', title: 'Respect the daily limit', body: `${DAILY_SEND_LIMIT} messages per workspace per day, with at least ${SEND_INTERVAL_SECONDS} seconds between sends. A sudden spike from a domain with no sending history is one of the most common reasons new senders land in spam — start small and grow slowly.` },
  { number: '04', title: 'Keep lists clean', body: 'Only contact people you are authorised to contact. Remove invalid addresses instead of retrying them, and honour every unsubscribe immediately. Every bounce and complaint is a signal to mailbox providers.' },
  { number: '05', title: 'Stop on reply', body: 'A reply is the strongest signal a recipient can send. Outreach stops the follow-up sequence automatically when a reply is detected — nobody keeps receiving messages after they have answered you.' },
  { number: '06', title: 'Test before you launch', body: 'Send a test to your own email and read it the way a recipient would. Check the sender name, the subject, the links, and the plain-text rendering before anything reaches a real lead.' },
]

export function DeliverabilityWarmupPage({ senders, suppressionCount }: { senders: Sender[]; suppressionCount: number }) {
  const monitored = senders.filter((sender) => sender.type === 'gmail_oauth' || sender.type === 'outlook_oauth')

  return (
    <div className="bento-page">
      <div className="bento-page-head">
        <div>
          <h1>Deliverability &amp; Warm-up</h1>
          <p className="bento-page-sub">Keep your mail in the inbox — and warm up a new mailbox gradually, instead of all at once.</p>
        </div>
      </div>

      <div className="bento-panel">
        <div className="bento-panel-head">
          <div>
            <h2>Warm-up</h2>
            <p className="bento-panel-sub">A new mailbox starts small and grows slowly. Warm-up is being set up — this page shows the real state today.</p>
          </div>
          <span className="bento-pill">Setting up</span>
        </div>
        {senders.length > 0 ? (
          <div className="bento-list">
            {senders.map((sender) => (
              <div className="bento-list-row" key={sender.id}>
                <div>
                  <strong>{sender.address}</strong>
                  <span>{sender.type === 'gmail_oauth' ? 'Gmail' : sender.type === 'outlook_oauth' ? 'Microsoft' : 'Kluzar sender · test mode only'}</span>
                </div>
                <span className="bento-badge draft">Not started</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="bento-empty">
            <p>No mailbox to warm up yet.</p>
            <p>Warm-up applies to a connected Gmail or Microsoft mailbox. Connect one first.</p>
            <a className="bento-btn-outline" href="/dashboard/senders/">Connect a mailbox</a>
          </div>
        )}
        <div className="bento-health-rows bento-health-rows-inset">
          <div><span>Warm-up mailboxes</span><strong>{monitored.length} connected</strong></div>
          <div><span>Daily limit</span><strong>{DAILY_SEND_LIMIT}/day · {SEND_INTERVAL_SECONDS}s gap</strong></div>
          <div><span>Suppressed addresses</span><strong>{suppressionCount}</strong></div>
        </div>
        <p className="bento-panel-foot">
          <BentoIcon name="flame" size={14} />
          Warm-up ramps a mailbox’s daily volume gradually from a small start, instead of sending the full daily limit on day one. The warm-up schedule and per-mailbox progress need the warm-up endpoint described in the integration doc — no progress is shown here until it exists.
        </p>
      </div>

      <div className="bento-panel">
        <div className="bento-panel-head">
          <div>
            <h2>Deliverability checklist</h2>
            <p className="bento-panel-sub">Plain-language steps that keep your mail in the inbox — not in spam.</p>
          </div>
        </div>
        <div className="bento-feature-grid">
          {DELIVERABILITY_CARDS.map((card) => (
            <article className="bento-feature-card" key={card.number}>
              <div className="bento-feature-top"><span>{card.number}</span><b aria-hidden="true">✓</b></div>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </article>
          ))}
        </div>
        <p className="bento-panel-foot">
          Keep reading: <a href="/blog/a-practical-guide-to-email-deliverability/">A practical guide to email deliverability</a> · <a href="/blog/how-to-plan-a-respectful-outreach-sequence/">How to plan a respectful outreach sequence</a> · <a href="/blog/using-suppression-lists-correctly/">Using suppression lists correctly</a> · <a href="/blog/testing-an-email-campaign-before-launch/">Testing an email campaign before launch</a>
        </p>
      </div>
    </div>
  )
}
