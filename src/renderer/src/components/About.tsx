import logoUrl from '../../../../build/icon.png'

export function About({ version, onClose }: { version: string; onClose: () => void }) {
  return (
    <div className="onboard-overlay" onClick={onClose}>
      <div className="about-card" onClick={(e) => e.stopPropagation()}>
        <img className="about-logo" src={logoUrl} alt="AutopilotV" />
        <h2>AutopilotV</h2>
        <div className="about-version">v{version}</div>
        <p className="about-tagline">
          An autonomous agent orchestrator for your software work — it finds what's yours to do and
          drives it through coding agents, keeping you in the loop for approvals and merges.
        </p>
        <div className="about-links">
          <a href="https://github.com/JustinWoodring/AutopilotV" target="_blank" rel="noreferrer">
            github.com/JustinWoodring/AutopilotV
          </a>
        </div>
        <div className="about-foot">
          <span className="muted">MIT · © Justin Woodring</span>
          <button className="btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
