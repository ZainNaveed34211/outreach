import { BentoIcon } from './icons'
import type { BentoIconName } from './icons'
import type { Workspace } from './types'

const CONTACT_URL = 'https://contact.kluzar.com'
const SUPPORT_URL = 'https://support.kluzar.com'

type NavItem = { title: string; href: string; icon: BentoIconName }

const NAV_ITEMS: NavItem[] = [
  { title: 'Overview', href: '/dashboard/', icon: 'home' },
  { title: 'Campaigns', href: '/dashboard/campaigns/', icon: 'trend' },
  { title: 'Leads', href: '/dashboard/leads/', icon: 'users' },
  { title: 'Sequences', href: '/dashboard/sequences/', icon: 'list' },
  { title: 'Inbox', href: '/dashboard/inbox/', icon: 'inbox' },
]

const NAV_ITEMS_LIBRARY: NavItem[] = [
  { title: 'Templates', href: '/dashboard/templates/', icon: 'grid' },
  { title: 'Workflows', href: '/dashboard/workflows/', icon: 'list' },
  { title: 'A/B testing', href: '/dashboard/ab-testing/', icon: 'flask' },
  { title: 'DNS setup', href: '/dashboard/dns/', icon: 'check' },
  { title: 'Deliverability & Warm-up', href: '/dashboard/warmup/', icon: 'shield' },
  { title: 'Integrations', href: '/dashboard/integrations/', icon: 'link' },
  { title: 'Senders & domains', href: '/dashboard/senders/', icon: 'send' },
  { title: 'Test mode', href: '/dashboard/test/', icon: 'flask' },
  { title: 'Team', href: '/dashboard/team/', icon: 'team' },
  { title: 'Settings', href: '/dashboard/settings/', icon: 'gear' },
]

export function DashboardSidebar({
  workspaces,
  workspaceId,
  onWorkspaceChange,
  activeTitle,
}: {
  workspaces: Workspace[]
  workspaceId: string
  onWorkspaceChange: (workspaceId: string) => void
  activeTitle: string
}) {
  const renderItem = (item: NavItem) => (
    <a href={item.href} key={item.href} className={activeTitle === item.title ? 'bento-nav-item active' : 'bento-nav-item'}>
      <BentoIcon name={item.icon} size={16} />
      <span>{item.title}</span>
    </a>
  )
  return (
    <aside className="dashboard-sidebar bento-sidebar">
      <div>
        <div className="bento-brand">
          <a href="/" className="bento-brand-link">
            <img src="/brand/kluzar-logo.png" alt="Kluzar" className="bento-brand-logo bento-brand-logo-light" />
            <img src="/brand/logo-dark.png" alt="Kluzar" className="bento-brand-logo bento-brand-logo-dark" />
            <span className="bento-brand-label">Outreach</span>
          </a>
        </div>
        <div className="bento-workspace">
          <div className="bento-workspace-label">Workspace</div>
          {workspaces.length > 0 ? (
            <div className="bento-workspace-select">
              <select aria-label="Workspace" value={workspaceId} onChange={(event) => onWorkspaceChange(event.target.value)}>
                {workspaces.map((workspace) => (
                  <option value={workspace.id} key={workspace.id}>{workspace.name}</option>
                ))}
              </select>
              <BentoIcon name="chevron" size={16} className="bento-workspace-chevron" />
            </div>
          ) : (
            <div className="bento-workspace-empty">No workspace yet</div>
          )}
        </div>
        <nav className="bento-nav" aria-label="Dashboard navigation">
          {NAV_ITEMS.map(renderItem)}
          <div className="bento-nav-spacer" aria-hidden="true" />
          {NAV_ITEMS_LIBRARY.map(renderItem)}
        </nav>
      </div>
      <div className="bento-sidebar-bottom">
        <nav aria-label="Help links">
          <a href={CONTACT_URL}>Contact</a>
          <a href={SUPPORT_URL}>Support</a>
          <a href="/">Back to site</a>
        </nav>
      </div>
    </aside>
  )
}
