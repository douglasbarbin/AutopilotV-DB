import { SIGNAL } from '../worktree/signals'
export { SIGNAL }

// Back-compat: existing tests / callers may import PR_URL_FILE.
export const PR_URL_FILE = SIGNAL.PR_URL

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
    'Coding standards for this run have been injected into ./AGENTS.md in the worktree root (git-ignored, do not commit it). Read it before you start.',
    '',
    `Implement the change on \`${branch}\`, commit, and open a DRAFT pull request against \`${baseBranch}\` with:`,
    '',
    '    gh pr create --draft',
    '',
    `As the very last step, write the full PR URL to a file named ${PR_URL_FILE} in this directory (e.g. \`gh pr view --json url -q .url > ${PR_URL_FILE}\`). That file is how the orchestrator detects the PR — do not skip it.`,
    '',
    'Adjacent work context (other active branches and files currently being edited) is available in the git-ignored ADJACENT_WORK.md file. Read it to coordinate and avoid conflicts on shared files.',
    ''
  ].join('\n')
}
