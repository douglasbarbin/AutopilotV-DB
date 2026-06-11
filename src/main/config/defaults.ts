import { homedir } from 'os'
import { join } from 'path'
import type { HarnessConfig, Settings } from '@shared/types/domain'

export const DEFAULT_SETTINGS: Settings = {
  pollIntervalSeconds: 60,
  maxConcurrentSessions: 3,
  cloneParentDir: join(homedir(), 'repos'),
  tracker: 'jira',
  trackerConfig: {
    jira: {
      jql: 'assignee = currentUser() AND sprint in openSprints() AND issuetype != Epic AND statusCategory != Done ORDER BY priority DESC'
    },
    ghproject: { owner: '', projectNumber: '', username: '', statusField: 'Status' },
    vikunja: { endpoint: '', token: '', projectId: '', assigneeFilter: '' },
    azuredevops: { org: '', project: '', pat: '', assigneeFilter: '' }
  },
  forge: 'github',
  forgeConfig: {
    github: {},
    azuredevops: { org: '', project: '', pat: '', reviewerFilter: '' }
  },
  githubUsername: '',
  watchRepos: [],
  githubReviewFilter: 'is:open is:pr review-requested:@me -author:@me',
  llmProvider: 'local',
  llmModel: 'gemma-4-e4b-it-mlx',
  localLlmEndpoint: 'http://127.0.0.1:1234',
  autoDrive: {
    enabled: true,
    maxInjectionsPerSession: 5,
    destructiveDenylist: [
      'rm -rf',
      'git push --force',
      'force push',
      'delete',
      'drop table',
      'DROP DATABASE',
      ':(){',
      'mkfs'
    ]
  },
  notifications: {
    reviewReady: true,
    needsHuman: true,
    prReadyToMerge: true
  },
  mergePolicy: 'await_user',
  autoPublish: false,
  requiredApprovals: 1,
  verifyBeforeReady: true,
  verifySpecConformance: true,
  verifyTimeoutSeconds: 600,
  maxRunningApps: 2,
  branchPrefix: 'autopilotv/',
  terminalCommand: '',
  theme: 'tomorrow-night-80s',
  onboarded: false,
  agentsTemplate: [
    '## AutopilotV coding standards',
    '',
    '- Match the style, naming, and conventions of the surrounding code.',
    '- Keep the change focused on the task; avoid unrelated refactors.',
    "- Run and pass the project's tests and linters before opening the PR.",
    '- Write clear, scoped commits that reference the issue key.',
    '- Update or add tests for the behavior you change.'
  ].join('\n')
}

const COMMON_STALL_PATTERNS = [
  '\\(y/n\\)',
  '\\[y/N\\]',
  'Continue\\?',
  'Press enter',
  'Press return',
  'Do you want to proceed',
  'Overwrite\\?',
  '\\? \\(use arrow keys\\)'
]

const REVIEW_PROMPT = `You are reviewing a pull request in a READ-ONLY worktree. You cannot push, call gh, or mutate GitHub in any way.
Analyze the diff against the base branch. Produce a concise review covering correctness, security, and clarity.
When finished, write your review as a single JSON object to a file named .review.json in the worktree root with this exact shape:
{ "recommendation": "approve" | "request_changes" | "comment", "summary": "<2-4 sentence overview>", "findings": [ { "severity": "info"|"minor"|"major"|"blocker", "file": "<path>", "line": <number?>, "note": "<finding>" } ] }
Do not attempt any network writes. Your only output artifact is .review.json.`

export const SEED_HARNESSES: HarnessConfig[] = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    enabled: true,
    isReviewDefault: true,
    isBrainDefault: false,
    isCodingDefault: true,
    launch: {
      command: 'claude',
      args: ['--permission-mode', 'auto'],
      env: {}
    },
    ready: { promptPattern: '' },
    stall: { idleSeconds: 45, waitingPatterns: COMMON_STALL_PATTERNS },
    inject: { method: 'stdin', submitKey: '\r' },
    reviewPrompt: REVIEW_PROMPT
  },
  {
    id: 'codex',
    displayName: 'Codex CLI',
    enabled: false,
    isReviewDefault: false,
    isBrainDefault: false,
    isCodingDefault: false,
    launch: { command: 'codex', args: [], env: {} },
    stall: { idleSeconds: 45, waitingPatterns: COMMON_STALL_PATTERNS },
    inject: { method: 'stdin', submitKey: '\r' },
    reviewPrompt: REVIEW_PROMPT
  },
  {
    id: 'cursor',
    displayName: 'Cursor Agent',
    enabled: false,
    isReviewDefault: false,
    isBrainDefault: false,
    isCodingDefault: false,
    launch: { command: 'cursor-agent', args: [], env: {} },
    stall: { idleSeconds: 45, waitingPatterns: COMMON_STALL_PATTERNS },
    inject: { method: 'stdin', submitKey: '\r' },
    reviewPrompt: REVIEW_PROMPT
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    enabled: false,
    isReviewDefault: false,
    isBrainDefault: false,
    isCodingDefault: false,
    launch: { command: 'opencode', args: [], env: {} },
    stall: { idleSeconds: 45, waitingPatterns: COMMON_STALL_PATTERNS },
    inject: { method: 'stdin', submitKey: '\r' },
    reviewPrompt: REVIEW_PROMPT
  },
  {
    id: 'pi',
    displayName: 'Pi · Qwen3 Coder',
    enabled: false,
    isReviewDefault: false,
    isBrainDefault: false,
    isCodingDefault: false,
    launch: { command: 'pi', args: [], env: {} }, // managed provider/model added by the session manager
    nativeReviewConfig: false,
    stall: { idleSeconds: 45, waitingPatterns: COMMON_STALL_PATTERNS },
    inject: { method: 'stdin', submitKey: '\r' },
    localModel: {
      name: 'qwen/qwen3-coder-30b',
      endpoint: 'http://127.0.0.1:1234',
      start: { command: 'lms', args: ['server', 'start'] },
      health: { path: '/v1/models', timeoutMs: 3000 }
    },
    reviewPrompt: REVIEW_PROMPT
  }
]
