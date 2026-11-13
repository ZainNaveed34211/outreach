export function TeamPage({ ownerEmail, workspaceName }: { ownerEmail: string; workspaceName: string }) {
  return (
    <div className="bento-page">
      <div className="bento-page-head">
        <div>
          <h1>Team</h1>
          <p className="bento-page-sub">Who can work in {workspaceName || 'this workspace'} — and who can be invited.</p>
        </div>
      </div>

      <div className="bento-panel">
        <div className="bento-panel-head">
          <div>
            <h2>Members</h2>
            <p className="bento-panel-sub">Workspaces are private to one account today. The member list below is the real membership — just you.</p>
          </div>
          <span className="bento-pill">1 member</span>
        </div>
        <div className="bento-list">
          <div className="bento-list-row">
            <div>
              <strong>{ownerEmail || 'Workspace owner'}</strong>
              <span>Owner · created this workspace</span>
            </div>
            <span className="bento-badge running">You</span>
          </div>
        </div>
        <div className="bento-empty">
          <p>Team invites are not available yet.</p>
          <p>Inviting teammates needs the workspace members endpoint described in the integration doc — roles, invites and member removal are not built yet, so no one else can be added here today.</p>
        </div>
      </div>
    </div>
  )
}
