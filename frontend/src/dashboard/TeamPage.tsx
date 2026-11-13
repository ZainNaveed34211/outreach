import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { TeamInvite, TeamMember } from './types'

const ROLES = ['owner', 'admin', 'member', 'viewer']

export function TeamPage({
  ownerEmail,
  workspaceName,
  members,
  invites,
  isOwner,
  membersUnavailable,
  inviteResult,
  onInvite,
  onRemoveMember,
  onChangeRole,
  onAcceptInvite,
}: {
  ownerEmail: string
  workspaceName: string
  members?: TeamMember[] | null
  invites?: TeamInvite[]
  isOwner?: boolean
  membersUnavailable?: boolean
  inviteResult?: string
  onInvite?: (email: string, role: string) => Promise<void>
  onRemoveMember?: (userId: string) => Promise<void>
  onChangeRole?: (userId: string, role: string) => Promise<void>
  onAcceptInvite?: (inviteId: string, token: string) => Promise<string>
}) {
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('member')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyMemberId, setBusyMemberId] = useState('')
  const acceptAttempted = useRef(false)

  useEffect(() => {
    if (acceptAttempted.current || !onAcceptInvite) return
    const params = new URLSearchParams(window.location.search)
    const inviteId = params.get('invite')
    const token = params.get('token')
    if (!inviteId || !token) return
    acceptAttempted.current = true
    window.history.replaceState({}, '', window.location.pathname)
    onAcceptInvite(inviteId, token)
      .then((message) => setNotice(message))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The invite could not be accepted.'))
  }, [onAcceptInvite])

  const submitInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!onInvite) return
    setError('')
    setNotice('')
    setBusy(true)
    try {
      await onInvite(inviteEmail.trim(), inviteRole)
      setNotice(`Invite sent to ${inviteEmail.trim()}. They join with the link in their invite email.`)
      setInviteEmail('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The invite could not be sent.')
    } finally {
      setBusy(false)
    }
  }

  const removeMember = async (member: TeamMember) => {
    if (!onRemoveMember) return
    setError('')
    setBusyMemberId(member.userId)
    try {
      await onRemoveMember(member.userId)
      setNotice(`${member.email} was removed from the workspace.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The member could not be removed.')
    } finally {
      setBusyMemberId('')
    }
  }

  const changeRole = async (member: TeamMember, role: string) => {
    if (!onChangeRole) return
    setError('')
    setBusyMemberId(member.userId)
    try {
      await onChangeRole(member.userId, role)
      setNotice(`${member.email} is now ${role}.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The role could not be changed.')
    } finally {
      setBusyMemberId('')
    }
  }

  const shownMembers = members ?? []
  const shownInvites = invites ?? []

  return (
    <div className="bento-page">
      <div className="bento-page-head">
        <div>
          <h1>Team</h1>
          <p className="bento-page-sub">Who can work in {workspaceName || 'this workspace'} — and who can be invited.</p>
        </div>
      </div>

      {error && <div className="bento-notice-error" role="alert">{error}</div>}
      {(notice || inviteResult) && <div className="bento-notice-success" role="status">{notice || inviteResult}</div>}

      <div className="bento-panel">
        <div className="bento-panel-head">
          <div>
            <h2>Members</h2>
            <p className="bento-panel-sub">Everyone who can open this workspace, with their role.</p>
          </div>
          <span className="bento-pill">{shownMembers.length} {shownMembers.length === 1 ? 'member' : 'members'}</span>
        </div>
        {membersUnavailable ? (
          <div className="bento-empty">
            <p>Invites are not available yet.</p>
            <p>The workspace members endpoint is not answering yet, so the member list and invites cannot be loaded. Only you can open this workspace for now.</p>
          </div>
        ) : shownMembers.length > 0 ? (
          <div className="bento-list">
            {shownMembers.map((member) => {
              const isSelf = member.email.toLowerCase() === ownerEmail.toLowerCase()
              const isWorkspaceOwner = member.role === 'owner'
              return (
                <div className="bento-list-row" key={member.userId}>
                  <div>
                    <strong>{member.email}</strong>
                    <span>{member.role}{isWorkspaceOwner ? ' · created this workspace' : ''}{isSelf ? ' · you' : ''} · joined {new Date(member.created_at).toLocaleDateString()}</span>
                  </div>
                  <div className="bento-row-actions">
                    {isOwner && !isWorkspaceOwner && onChangeRole ? (
                      <select aria-label={`Role for ${member.email}`} value={member.role} disabled={busyMemberId === member.userId} onChange={(event) => void changeRole(member, event.target.value)}>
                        {ROLES.filter((role) => role !== 'owner').map((role) => <option value={role} key={role}>{role}</option>)}
                      </select>
                    ) : (
                      <span className={isWorkspaceOwner ? 'bento-badge running' : 'bento-badge paused'}>{member.role}</span>
                    )}
                    {isOwner && !isWorkspaceOwner && onRemoveMember && (
                      <button type="button" className="bento-text-btn danger" disabled={busyMemberId === member.userId} onClick={() => void removeMember(member)}>Remove</button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="bento-list">
            <div className="bento-list-row">
              <div>
                <strong>{ownerEmail || 'Workspace owner'}</strong>
                <span>Owner · created this workspace</span>
              </div>
              <span className="bento-badge running">You</span>
            </div>
          </div>
        )}
      </div>

      {shownInvites.length > 0 && (
        <div className="bento-panel">
          <div className="bento-panel-head">
            <div>
              <h2>Pending invites</h2>
              <p className="bento-panel-sub">Invites sent from this session. The invite link is in the invite email — it expires at the time shown.</p>
            </div>
            <span className="bento-pill">{shownInvites.length} pending</span>
          </div>
          <div className="bento-list">
            {shownInvites.map((invite) => (
              <div className="bento-list-row" key={invite.id}>
                <div>
                  <strong>{invite.email}</strong>
                  <span>{invite.role}{invite.expires_at ? ` · expires ${new Date(invite.expires_at).toLocaleString()}` : ''}</span>
                </div>
                <span className="bento-badge draft">Invited</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bento-panel">
        <div className="bento-panel-head">
          <div>
            <h2>Invite a teammate</h2>
            <p className="bento-panel-sub">They receive an invite link by email and join this workspace when they accept it.</p>
          </div>
        </div>
        {isOwner === false ? (
          <div className="bento-empty">
            <p>Only the workspace owner can invite teammates.</p>
            <p>Ask the workspace owner to send the invite.</p>
          </div>
        ) : onInvite ? (
          <form className="bento-form" onSubmit={submitInvite}>
            <label>
              Email address
              <input type="email" autoComplete="off" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} maxLength={254} required placeholder="teammate@example.com" />
            </label>
            <label>
              Role
              <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}>
                <option value="member">Member — campaigns, leads and replies</option>
                <option value="admin">Admin — member settings too</option>
                <option value="viewer">Viewer — read-only</option>
              </select>
            </label>
            <button type="submit" className="bento-btn-dark" disabled={busy}>{busy ? 'Sending…' : 'Send invite'}</button>
          </form>
        ) : (
          <div className="bento-empty">
            <p>Team invites are not available yet.</p>
            <p>Inviting teammates needs the workspace members endpoint — roles, invites and member removal are not built yet, so no one else can be added here today.</p>
          </div>
        )}
        <p className="bento-panel-foot">Roles: owner runs the workspace, admin manages members, member works on campaigns and leads, viewer reads without changing anything.</p>
      </div>
    </div>
  )
}
