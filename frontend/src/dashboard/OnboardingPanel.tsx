import { BentoIcon } from './icons'
import type { OnboardingState } from './types'

type Step = {
  key: keyof OnboardingState
  number: number
  title: string
  body: string
  action: string
  href: string
  doneLabel: string
}

const STEPS: Step[] = [
  {
    key: 'senderConnected',
    number: 1,
    title: 'Connect a mailbox',
    body: 'Connect your Google or Microsoft account via OAuth. This allows Kluzar to monitor replies and automatically pause follow-ups.',
    action: 'Set up sender',
    href: '/dashboard/senders/',
    doneLabel: 'Connected',
  },
  {
    key: 'leadsAdded',
    number: 2,
    title: 'Add your leads',
    body: 'Create a lead list and import contacts you are authorized to contact.',
    action: 'Add leads',
    href: '/dashboard/leads/import/',
    doneLabel: 'Added',
  },
  {
    key: 'campaignCreated',
    number: 3,
    title: 'Create a campaign',
    body: 'Write your initial message and design automated follow-up sequences.',
    action: 'Create',
    href: '/dashboard/campaigns/',
    doneLabel: 'Created',
  },
  {
    key: 'testSent',
    number: 4,
    title: 'Send a test',
    body: 'Dispatch a test to your own email to preview formatting.',
    action: 'Test',
    href: '/dashboard/test/',
    doneLabel: 'Tested',
  },
  {
    key: 'launched',
    number: 5,
    title: 'Launch a campaign',
    body: 'Launch when the message, the audience and the sender all look right.',
    action: 'Launch',
    href: '/dashboard/campaigns/',
    doneLabel: 'Launched',
  },
]

export function OnboardingPanel({ onboarding }: { onboarding: OnboardingState }) {
  const doneCount = STEPS.filter((step) => onboarding[step.key]).length
  const percent = Math.round((doneCount / STEPS.length) * 100)
  const currentIndex = STEPS.findIndex((step) => !onboarding[step.key])

  if (currentIndex === -1) {
    return (
      <div className="bento-onboarding">
        <div className="bento-onboarding-head">
          <div>
            <h2>Welcome to your Workspace</h2>
            <p>Setup is complete — all 5 steps done. Your outreach engine is ready.</p>
          </div>
          <div className="bento-onboarding-progress">
            <div className="bento-onboarding-progress-top">
              <span>Setup Progress</span>
              <strong>100%</strong>
            </div>
            <div className="bento-onboarding-bar">
              <div className="bento-onboarding-fill" style={{ width: '100%' }} />
            </div>
            <div className="bento-onboarding-count">5 of 5 steps completed</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="bento-onboarding">
      <div className="bento-onboarding-head">
        <div>
          <h2>Welcome to your Workspace</h2>
          <p>Build your outreach engine, one step at a time.</p>
        </div>
        <div className="bento-onboarding-progress">
          <div className="bento-onboarding-progress-top">
            <span>Setup Progress</span>
            <strong>{percent}%</strong>
          </div>
          <div className="bento-onboarding-bar">
            <div className="bento-onboarding-fill" style={{ width: `${percent > 0 ? Math.max(percent, 4) : 0}%` }} />
          </div>
          <div className="bento-onboarding-count">{doneCount} of 5 steps completed</div>
        </div>
      </div>

      <div className="bento-stepper">
        {STEPS.map((step, index) => {
          const done = onboarding[step.key]
          const isCurrent = index === currentIndex
          if (done) {
            return (
              <div className="bento-step done" key={step.key}>
                <div className="bento-step-marker">
                  <span className="bento-step-circle done">
                    <BentoIcon name="checkPlain" size={14} />
                  </span>
                </div>
                <div className="bento-step-row">
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.body}</p>
                  </div>
                  <a className="bento-step-link" href={step.href}>{step.doneLabel} →</a>
                </div>
              </div>
            )
          }
          if (isCurrent) {
            return (
              <div className="bento-step active" key={step.key}>
                <div className="bento-step-marker">
                  <span className="bento-step-circle active">{step.number}</span>
                </div>
                <div className="bento-step-card">
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.body}</p>
                  </div>
                  <a className="bento-btn-dark" href={step.href}>
                    {step.action}
                    <BentoIcon name="arrowRight" size={16} />
                  </a>
                </div>
              </div>
            )
          }
          return (
            <a className="bento-step later" key={step.key} href={step.href}>
              <div className="bento-step-marker">
                <span className="bento-step-circle">{step.number}</span>
              </div>
              <div className="bento-step-row">
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
                <span className="bento-step-link">
                  {step.action}
                  <BentoIcon name="arrowRight" size={14} />
                </span>
              </div>
            </a>
          )
        })}
      </div>
    </div>
  )
}
