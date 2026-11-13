import { BentoIcon } from './icons'
import type { Sender } from './types'

function senderLabel(sender: Sender): { title: string; detail: string; status: string; statusClass: string } {
  if (sender.type === 'gmail_oauth') {
    return { title: 'Gmail', detail: 'Send mail and read mailbox threads for reply detection.', status: 'Connected', statusClass: 'bento-badge running' }
  }
  if (sender.type === 'outlook_oauth') {
    return { title: 'Microsoft', detail: 'Send mail and read mailbox threads for reply detection.', status: 'Connected', statusClass: 'bento-badge running' }
  }
  return { title: 'Kluzar sender', detail: 'Test mode only. It cannot receive replies.', status: 'Test only', statusClass: 'bento-badge paused' }
}

export function IntegrationsPage({ senders }: { senders: Sender[] }) {
  const gmailConnected = senders.some((sender) => sender.type === 'gmail_oauth')
  const microsoftConnected = senders.some((sender) => sender.type === 'outlook_oauth')
  const brevoEnabled = senders.some((sender) => sender.type === 'brevo_default')

  return (
    <div className="bento-page">
      <div className="bento-page-head">
        <div>
          <h1>Integrations</h1>
          <p className="bento-page-sub">The mailboxes and senders this workspace is connected to. Nothing else is connected.</p>
        </div>
        <a className="bento-btn-dark" href="/dashboard/senders/">
          Manage senders
        </a>
      </div>

      <div className="bento-panel">
        <div className="bento-panel-head">
          <div>
            <h2>Connected</h2>
            <p className="bento-panel-sub">Tokens are encrypted server-side. Kluzar Outreach never asks for your mailbox password.</p>
          </div>
        </div>
        {senders.length > 0 ? (
          <div className="bento-list">
            {senders.map((sender) => {
              const label = senderLabel(sender)
              return (
                <div className="bento-list-row" key={sender.id}>
                  <div>
                    <strong>{sender.address}</strong>
                    <span>{label.title} · {label.detail}{sender.is_default ? ' · Default sender' : ''}</span>
                  </div>
                  <span className={label.statusClass}>{label.status}</span>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="bento-empty">
            <p>No senders connected yet.</p>
            <p>Connect a mailbox to send production campaigns — or enable the Kluzar test sender to try test mode first.</p>
            <a className="bento-btn-outline" href="/dashboard/senders/">Connect a mailbox</a>
          </div>
        )}
      </div>

      <div className="bento-panel">
        <div className="bento-panel-head">
          <div>
            <h2>Available integrations</h2>
            <p className="bento-panel-sub">These are the only integrations in this build.</p>
          </div>
        </div>
        <div className="bento-list">
          <div className="bento-list-row">
            <div>
              <strong>Gmail</strong>
              <span>Send from your Gmail or Google Workspace mailbox, with reply monitoring. OAuth only.</span>
            </div>
            <span className={gmailConnected ? 'bento-badge running' : 'bento-badge paused'}>{gmailConnected ? 'Connected' : 'Not connected'}</span>
          </div>
          <div className="bento-list-row">
            <div>
              <strong>Microsoft</strong>
              <span>Send from your Microsoft 365 or personal Microsoft mailbox, with reply monitoring. OAuth only.</span>
            </div>
            <span className={microsoftConnected ? 'bento-badge running' : 'bento-badge paused'}>{microsoftConnected ? 'Connected' : 'Not connected'}</span>
          </div>
          <div className="bento-list-row">
            <div>
              <strong>Kluzar sender</strong>
              <span>Fallback sender for tests only. It cannot receive replies, so campaigns sent from it never stop on reply.</span>
            </div>
            <span className={brevoEnabled ? 'bento-badge paused' : 'bento-badge draft'}>{brevoEnabled ? 'Test only' : 'Not enabled'}</span>
          </div>
        </div>
        <p className="bento-panel-foot">
          <BentoIcon name="shield" size={14} />
          Read access is used only to detect replies on Outreach threads. No other service is connected, and no other integration is claimed here.
        </p>
      </div>
    </div>
  )
}
