import { SIGNAL, type SignalKind } from '../worktree/signals'
export { SIGNAL }

// Back-compat: existing tests / callers may import PR_URL_FILE.
export const PR_URL_FILE = SIGNAL.IMPL

/**
 * Appended to every spawned session prompt. The injected block in a TRACKED
 * AGENTS.md is protected with git skip-worktree, and git refuses to start any
 * merge/rebase that touches a locally-modified file — so agents must know the
 * unprotect → merge → reapply dance instead of getting wedged on
 * "Your local changes would be overwritten by merge".
 */
export const AGENTS_MERGE_UNBLOCK =
  'If git refuses a merge/rebase/checkout because of local changes to AGENTS.md (it carries an injected block between the TASKMAN:BEGIN/TASKMAN:END markers, protected with skip-worktree), unblock it like this:\n' +
  '1. Save the injected block: `cp AGENTS.md /tmp/AGENTS.injected.md`\n' +
  '2. Unprotect and restore: `git update-index --no-skip-worktree AGENTS.md && git checkout -- AGENTS.md`\n' +
  '3. Complete the merge/rebase.\n' +
  '4. Reapply: append the saved block (everything from `<!-- TASKMAN:BEGIN` through `TASKMAN:END -->` in /tmp/AGENTS.injected.md) back onto AGENTS.md, then re-protect: `git update-index --skip-worktree AGENTS.md`\n' +
  'Never commit the injected block.'

/**
 * Completion-signal instruction shared by every dev-phase prompt. Asks for the
 * v2 JSON report (summary, follow-ups, learnings) but spells out the degraded
 * fallback — orchestration must advance even when an agent can't or won't
 * produce JSON, so the bare v1-style signal is always allowed.
 */
export function buildSignalInstruction(kind: SignalKind, opts: { includePrUrl: boolean }): string {
  const prUrlField = opts.includePrUrl ? '  "prUrl": "<the full PR URL — required>",\n' : ''
  const fallback = opts.includePrUrl
    ? `If you cannot produce JSON, writing just the PR URL to ${kind} also works as a bare signal.`
    : `If you cannot produce JSON, an empty file (\`touch ${kind}\`) also works as a bare signal.`
  return (
    `As the very last step, signal completion by writing a JSON file named ${kind} in this directory. ` +
    `That file is how the orchestrator detects you are done — do not skip it. Format:\n\n` +
    '{\n' +
    '  "version": 1,\n' +
    prUrlField +
    '  "summary": "<1-3 sentences: what you did>",\n' +
    '  "followUps": [{"title": "<short imperative>", "description": "<detail>", "kind": "todo|tech_debt|bug|enhancement|test_gap", "priority": "low|medium|high", "files": ["<path>"]}],\n' +
    '  "learnings": [{"role": "coding", "insight": "<a durable, repo-specific convention or gotcha future agents should know>", "evidence": "<file or PR reference>", "confidence": "low|medium|high"}],\n' +
    '  "deviations": "<where you diverged from the task and why, or empty string>"\n' +
    '}\n\n' +
    'List a followUp for every TODO you left behind, tech debt you noticed, test you skipped, or improvement that was out of scope. ' +
    'Keep learnings to genuinely reusable insights about THIS repo (max 3); use [] when there are none. ' +
    fallback
  )
}

/**
 * Make a tracker task title safe to embed in a prompt. Titles come from
 * external tracker adapters and can carry embedded newlines, control
 * characters, balanced or unbalanced double quotes, backticks, and Unicode
 * formatting that the model is happy to mirror back. Strip control chars,
 * collapse whitespace, and trim so the prompt's structural quoting stays
 * intact and the title can't be used to "spoof" the rest of the prompt.
 */
export function sanitizeTitle(title: string): string {
  return title
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface DevStartPromptInput {
  issueKey: string
  title: string
  branch: string
  baseBranch: string
  repoName: string
  worktreePath: string
}

/**
 * Build the prompt sent to the implementing harness that startDevTask spawns.
 *
 * The previous inline string interpolated `${task.title}` inside literal
 * double quotes (`task KEY: "title"`) and never told the agent where the
 * injected AGENTS.md lived, what its working directory was, or which branch
 * it was on. A title containing `"`, a newline, or a backtick would
 * silently break the prompt's structure and, worse, could be used to
 * inject instructions that look like the rest of the orchestrator's
 * message. This builder sanitizes the title and lays out the run's
 * context up front so the agent can act on it without parsing the
 * surrounding prose.
 */
export function buildDevStartPrompt(input: DevStartPromptInput): string {
  const { issueKey, title, branch, baseBranch, repoName, worktreePath } = input
  const safeTitle = sanitizeTitle(title)
  return [
    `You are implementing tracker task ${issueKey}: ${safeTitle}`,
    '',
    `Working directory (your worktree): ${worktreePath}`,
    `Branch: ${branch}`,
    `Base branch (target of your PR): ${baseBranch}`,
    `Repository: ${repoName}`,
    '',
    'Coding standards for this run have been injected into ./AGENTS.md in the worktree root (git-ignored/skip-worktree, do not commit the injected block). Read it before you start.',
    '',
    AGENTS_MERGE_UNBLOCK,
    '',
    'If a RUNBOOK.md (or RUNBOOK.autopilotv.md — the operator override, which wins) exists in the worktree root, read it before building, running, or testing — it explains how to get THIS repo to a runnable state (setup, secrets, app startup). Never run secrets-manager commands (e.g. `op`) yourself; the orchestrator materializes any required config files before you start.',
    '',
    `Implement the change on \`${branch}\`, commit, and open a DRAFT pull request against \`${baseBranch}\` with:`,
    '',
    '    gh pr create --draft',
    '',
    buildSignalInstruction(SIGNAL.IMPL, { includePrUrl: true }),
    '',
    'Adjacent work context (other active branches and files currently being edited) is available in the git-ignored ADJACENT_WORK.md file. Read it to coordinate and avoid conflicts on shared files.',
    ''
  ].join('\n')
}
