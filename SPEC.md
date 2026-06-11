# AutopilotV — Specification

> An autopilot-style agent orchestrator that automates the lifecycle of the work
> you are inclined to do, across two lines: **Software Development** and **PR Reviewing**.

Status: **implemented** — living document kept in sync with the application.

---

## 1. Summary

AutopilotV is a single-user **desktop application** (Electron) that acts as a
"brain" + session manager. It continuously asks _"what work is mine to do?"_ —
**tracker** tasks assigned to me (Jira, GitHub Projects, or Vikunja), and GitHub
PRs awaiting my review — and drives that work toward completion by spawning and
supervising **CLI coding-agent sessions** ("harnesses") running in real PTYs,
visualized in the UI via xterm.js.

There are two lines of work:

1. **Software Development** — claim a tracker task → implement it in a worker
   session → open a draft PR → babysit through review feedback until it clears
   your merge gates.
2. **PR Reviewing** — find PRs where review is requested from me that I did not
   open → review them in an **isolated, sandboxed worktree** → post a summary
   into AutopilotV that I can one-click **Approve** → AutopilotV posts the
   approval to GitHub → prune the worktree.

**Status:** both lines are built. PR Reviewing came first; Software Development is
a complete phase-driven lifecycle (§9). Project trackers and harnesses are
pluggable adapters (§6, §6.4). A first-run setup walkthrough (§24) guides
environment + integration setup.

---

## 2. Goals & non-goals

### Goals
- Surface my actionable work (assigned Jira tasks, PRs awaiting my review) without me hunting for it.
- Run multiple coding-agent sessions concurrently in headful, visible terminals.
- Be **harness-agnostic**: Pi, OpenCode, Codex, Cursor, Claude, etc. are configurable adapters.
- **Auto-drive** stalled sessions: detect when a session is blocked waiting on input and inject a sensible response, or nudge a session that has gone quiet without finishing back into motion.
- Keep PR review work **sandboxed** — the review worktree must not be able to call `gh` (or otherwise mutate GitHub).
- Cleanly **prune worktrees** when review work is done.
- Keep a human in the loop for the consequential action (PR approval) via an explicit Approve button.

### Non-goals (v1)
- Multi-user / team server. This is a single-user desktop app.
- Replacing Jira/GitHub as a source of truth. They remain authoritative.
- Auto-merging PRs without any human gate (babysitting watches; merge policy is configurable — see §9, open question OQ-4).
- Mobile / web client.

---

## 3. Key decisions (locked)

| Area | Decision |
|------|----------|
| App platform | **Electron** desktop app |
| Terminal layer | **node-pty** (PTYs owned by main process) rendered with **xterm.js** in the renderer |
| Brain | **Deterministic poll loop** for fetch/detect; **LLM only for judgment** (ambiguous decisions, review reasoning, stall responses) |
| State | **Local SQLite** in the app data dir |
| Integrations | `gh` (GitHub) + **pluggable project-tracker adapters** — shelled out from the main process |
| Project trackers | **Adapter model** — `jira` (acli), `ghproject` (GitHub Projects via gh), `vikunja` (REST API). Active adapter is selectable; its settings fields drive the UI |
| First milestone | **PR Reviewing** first; **Software Development now built as a full lifecycle** (see §9) |
| Repos | **Multiple configured repos**; AutopilotV manages clones + per-repo worktree root |
| Review sandbox | **PATH-scrub + `gh` shim + env-strip** (no OS/container sandbox in v1) |
| Dev merge policy | **Stop at "ready, awaiting your merge"** — never auto-merge |
| Harness roles | Each harness can be flagged **review / brain / coding** default (one per role; setting one clears the others). Claude is just a harness. |
| Local model | AutopilotV **polls** each local endpoint every tick (never auto-starts); start is explicit (Start model). For **Pi** it writes an isolated `models.json` (`PI_CODING_AGENT_DIR`) unless the per-Pi **native-review** opt-out is set |
| Notifications | OS notifications on: review ready to approve · session needs a human · PR ready to merge |
| Stall judgment | **LLM-first for every stall** (deterministic denylist rails still apply) |
| Tracker flow | on claim → **In Progress**, on publish → **In Review**; Done left to the user (QA owns it) |
| Worktree layout | **Per-repo root beside the clone** (`<repo>/.autopilotv-worktrees/`); clones under a configured parent dir |
| Themes | Selectable: **Tomorrow Night 80s** (default), Tokyo Night, Synthwave, Tomorrow (light). Native window chrome follows (dark/light) |
| First run | A **setup walkthrough** (env check + recommendations + GitHub/tracker/LLM/harness steps), gated by an `onboarded` flag, re-runnable from Settings (§24) |
| Branch / terminal | Configurable **branch prefix** (default `autopilotv/`) and **terminal command** (default kitty per-OS) |
| Renderer | **React + Vite + TypeScript** |
| Brain LLM | **Local** OpenAI-compatible endpoint **or** the **Brain-default harness** run headless (`-p`). Choosing Local skips the brain-harness step. |
| Claude invocation | Always `claude --permission-mode auto` (sessions + headless judgment) |
| PR discovery | Explicit: **GitHub username + watched repos**, queried per-repo via `gh pr list --search review-requested:<user>` (avoids the `@me` raw-search pitfall); falls back to a global search filter |
| Jira scoping | **Current sprint, epics excluded**; raw Jira status surfaced; **per-project → repo mapping** for dev work |
| Dev control signals | Agents emit git-ignored JSON signal files in the worktree: `.autopilotv-impl` (PR opened), `.autopilotv-revise` (revision done), `.autopilotv-address-comments` (feedback addressed) — AutopilotV watches these to advance/kill sessions, and harvests the follow-ups/learnings they carry (legacy v1 names still accepted) |
| Agent instructions | Configurable **AGENTS.md template** injected (git-ignored) into every worktree |
| Auto-drive | **Per-session toggle** (global setting seeds the default) |
| Session recovery | **Graceful kill + resumable work items** — PTYs die with the app; work returns to claimable, resumes next launch |
| Packaging | **Cross-platform** electron-builder (mac dmg/zip, win nsis, linux AppImage); GitHub Actions CI runs typecheck + tests and best-effort per-OS builds |
| License | **MIT** |
| Testing | **Unit + integration on core** (mocked `gh`/`acli`); **manual** UI verification |

---

## 4. High-level architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ Electron Main Process (Node)                                           │
│                                                                        │
│  ┌────────────┐   ┌──────────────────┐   ┌──────────────────────────┐  │
│  │  Brain     │   │ Integration layer│   │ Session Manager          │  │
│  │ (poll loop │──▶│  tracker adapter │   │  - node-pty processes    │  │
│  │  + LLM     │   │  gh   (GitHub)   │   │  - per-session adapter   │  │
│  │  judgment) │   │  (main proc only)│   │  - stdout ring buffer    │  │
│  └─────┬──────┘   └──────────────────┘   │  - stall detector        │  │
│        │                                  │  - input injector        │  │
│        ▼                                  └───────────┬──────────────┘  │
│  ┌────────────┐   ┌──────────────────┐                │                 │
│  │  SQLite    │   │ Worktree Manager │                │ IPC (stream)    │
│  │  (state)   │   │  create/prune,   │                │                 │
│  └────────────┘   │  sandbox enforce │                │                 │
│                   └──────────────────┘                │                 │
└───────────────────────────────────────────────────────┼─────────────────┘
                                                         │
┌────────────────────────────────────────────────────────▼───────────────┐
│ Renderer (UI)                                                            │
│  - Work queue (tracker tasks / PRs to review)                            │
│  - Session grid: each session = an xterm.js terminal                     │
│  - Review cards: Approve / Approve only / Request changes / Comment / …  │
│  - Brain reasoning feed · Activity log · Settings · setup walkthrough     │
└──────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Process boundaries (security-relevant)
- **Only the main process** holds GitHub/Jira credentials and may call `gh`/`acli`.
- **Worker sessions never get `gh`.** They run with a scrubbed `PATH` and env so that `gh`
  is not resolvable, plus a wrapper that hard-fails any `gh` invocation (defense in depth — see §7.3).
- The **Approve** action is performed by the main process, not by any session.

---

## 5. The Brain (deterministic loop + LLM judgment)

The brain runs a tick on an interval (default **60s**, configurable). Each tick is
**idempotent** — safe to run repeatedly.

### 5.1 Tick algorithm
```
on each tick:
  1. REFRESH WORK + HEALTH
     - active tracker adapter: list assigned items (sprint-scoped, epics excluded,
       disabled projects skipped) → upsert into `tasks`
     - gh: per watched repo, list open PRs review-requested from me, author != me
       → upsert into `pr_reviews`
     - probe integration health (gh/tracker/llm/local-model)
  2. RECONCILE SESSIONS
     - for each active session: run stall detector; auto-drive (LLM) or escalate
     - harvest review outputs; renew leases for in-flight work
  3. SCHEDULE WORK (respect max-concurrency)
     - claim highest-priority unclaimed item (atomic), provision worktree, spawn session
  4. ADVANCE DEV TASKS (§9)
     - drive each in-flight dev task through its phase machine via control files
  5. EMIT STATE → renderer (incl. brain-reasoning notes)
```

- **Deterministic** parts: fetching, parsing, claiming, scheduling, worktree
  lifecycle, prune, phase transitions.
- **LLM** parts (the only places we call the model): (a) the **stall response**
  to inject (§8), (b) **reviewing** a PR → ReviewSummary (§7.4), (c) ambiguous
  triage, (d) babysitting reactions to review feedback.

### 5.2 Concurrency & priority
- `max_concurrent_sessions` (default 3) global cap; optionally per-line caps.
- Priority: explicit user pin > review requests aging > Jira priority/rank.
- One work item ↔ at most one active session (enforced by claim row in SQLite).

---

## 6. Harness adapters (configurable)

Each coding-agent CLI is described by a **harness adapter** config. The session
manager is generic; adapters supply the specifics.

```jsonc
// harness adapter (stored in SQLite / editable in UI)
{
  "id": "claude",
  "displayName": "Claude Code",
  "launch": {
    "command": "claude",
    "args": ["--permission-mode", "auto"],        // headful PTY runs unattended
    "cwd": "{worktree}",
    "env": { /* merged over a scrubbed base env */ }
  },
  "ready": { "promptPattern": "..." },             // regex: agent is idle/ready
  "stall": {
    "idleSeconds": 45,                             // no new stdout for N seconds
    "waitingPatterns": [                           // regexes signaling "waiting for input"
      "\\(y/n\\)", "Continue\\?", "Press enter", "Do you want to proceed"
    ]
  },
  "inject": { "method": "stdin", "submitKey": "\r" }
}
```

Built-in adapters to ship/seed: **Claude, Codex, Cursor, OpenCode, Pi**.
Adapters are data, not code — adding a new harness = adding a config row.

### 6.1 "Headful mode bypasses harness human-requirements"
Some harnesses refuse certain automated actions unless they appear to run
interactively. Running each session in a **real PTY** (not a pipe) makes the
harness believe it has a human terminal, satisfying that check while still
letting AutopilotV read stdout and write stdin programmatically.

### 6.2 Harness roles
Each harness can be flagged as the default for one or more **roles** — *review*,
*brain*, *coding* — with at most one default per role (setting one clears it on the
others). Claude is just a harness; there is no special-cased Claude provider.

- **review** → drives PR-review sessions (locked down, sandboxed env — §7.3).
- **coding** → drives dev/implement/revise/address-comments sessions.
- **brain** → used as the brain's LLM when the LLM provider is `harness` (§17).

### 6.3 Local model management (AutopilotV-managed endpoint)
When a harness adapter is configured to use a **local model**, AutopilotV owns the
endpoint lifecycle rather than treating it as opaque:
```jsonc
"localModel": {
  "name": "qwen/qwen3-coder-30b",
  "endpoint": "http://127.0.0.1:1234",          // OpenAI-compatible (LM Studio)
  "start": { "command": "lms", "args": ["server", "start"] },  // optional managed start
  "health": { "path": "/v1/models", "timeoutMs": 3000 }
}
```
- **Health-check** (poll) each configured local endpoint every tick — never starts
  a server implicitly; starting is explicit (the **Start model** button).
- Surface **status** (online/offline, model name) in the UI.
- For generic harnesses, inject OpenAI-compatible env. For **Pi**, AutopilotV writes
  an isolated `models.json` and points Pi at it via `PI_CODING_AGENT_DIR`, then
  launches `pi --provider lmstudio --model <name>` (so the user's global `~/.pi`
  config is untouched). The managed args/env are injected by the session manager,
  not stored on the harness.
- **Pi opt-out:** a per-Pi `nativeReviewConfig` flag makes **review** sessions use
  Pi's own `~/.pi` config instead of the managed one (coding sessions stay managed).

### 6.4 Project-tracker adapters
The tracker is a pluggable adapter behind a `ProjectTracker` interface
(`listAssigned`, `transition`, `checkAuth`). Built-in adapters: **`jira`** (acli),
**`ghproject`** (GitHub Projects via `gh`), **`vikunja`** (REST API with personal token). The
**active** adapter is selectable in Settings, and its declared fields (a shared
descriptor) render the tracker settings UI. Items are normalized to a neutral work
shape (key, title, status, assignee, priority, type, sprint, project).

---

## 7. PR Reviewing (full depth)

### 7.1 Discovery
- For each **watched repo**, the brain runs
  `gh pr list --repo <r> --search "review-requested:<username>" --state open`,
  dropping PRs authored by the user. (A raw `review-requested:@me` search query does
  **not** resolve `@me`, so explicit username + per-repo queries are used; a global
  search filter is the fallback when no repos are watched.)
- Upsert each into `pr_reviews` with state `discovered`.

### 7.2 Provisioning the review worktree
- Precondition (per your requirement): **the branch to review already exists**
  on the remote and locally.
- Worktree Manager runs (from main process, which _does_ have `gh`/`git`):
  ```
  git fetch <remote> <pr-branch>
  git worktree add <repo>/.autopilotv-worktrees/review-<pr-number> <pr-branch>
  ```
  Worktrees live in a **per-repo root beside the clone** (`<repo>/.autopilotv-worktrees/`).
  Repos not yet present locally are cloned under the configured parent dir first.
- Record worktree path + PR id in `worktrees` table; state → `review_in_progress`.

### 7.3 Sandbox: no `gh` inside the review session  (hard requirement)
The review session must be unable to mutate the forge. Layered enforcement:
1. **Shim** — prepend a sandbox `.sandbox-bin/` to PATH containing hard-failing
   `gh`/`hub` shims and a `git` wrapper that blocks `push`/`fetch`/`remote`/`clone`
   (exit 87) while delegating other git commands to the real binary.
2. **No tokens** — `GH_TOKEN`/`GITHUB_TOKEN`/`GIT_ASKPASS`/`SSH_AUTH_SOCK` and
   related auth are stripped from the session env; `GIT_TERMINAL_PROMPT=0`.
3. The review prompt instructs the agent it is read-only with no network write.

> The review session's only job is to read the diff/code and write its verdict to
> a `.review.json` file in the worktree, which AutopilotV harvests on a later tick.

### 7.4 Producing the review
- The review session runs the configured harness against the worktree with a
  **review prompt** (template, configurable): summarize the change, flag
  correctness/security/style issues, give an overall recommendation.
- AutopilotV captures the output and (LLM judgment step) normalizes it into a
  structured **ReviewSummary**:
  ```jsonc
  {
    "prNumber": 1234,
    "recommendation": "approve" | "request_changes" | "comment",
    "summary": "…",
    "findings": [ { "severity": "...", "file": "...", "note": "..." } ]
  }
  ```
- Persist to `reviews`; surface as a **card** in the UI. State → `awaiting_user`.

### 7.5 Approval flow (human gate)
- The card shows the summary + findings with buttons:
  **[Approve]** · **[Request changes]** · **[Comment only]** · **[Dismiss]**.
- On click, the **main process** (sandbox-free) posts to GitHub via `gh`:
  ```
  gh pr review <num> --approve   -b "<summary>"          # Approve
  gh pr review <num> --request-changes -b "<summary>"    # Request changes
  gh pr review <num> --comment   -b "<summary>"          # Comment
  ```
- Record the action + timestamp; state → `submitted`.

### 7.6 Pruning
- When a review reaches a terminal state (`submitted` or `dismissed`), or its PR
  is closed/merged:
  ```
  git worktree remove <path> --force   (if branch unchanged)
  git worktree prune
  ```
- Guard: never prune a worktree with uncommitted changes that AutopilotV didn't expect;
  log and surface instead.
- A periodic GC also removes orphaned `review-*` worktrees with no live session.

### 7.7 PR Reviewing — state machine
```
discovered → provisioning → review_in_progress → awaiting_user
   → submitted → pruned
   (any → dismissed → pruned)
   (PR closed/merged externally → pruned)
```

---

## 8. Auto-driving (stall detection & input injection)

Per session, the session manager keeps a **stdout ring buffer** and timestamps
the last output. A session is a **stall candidate** when:
- no new output for `stall.idleSeconds`, **or**
- the tail matches any `stall.waitingPatterns` (e.g. `(y/n)`, `Continue?`).

On a stall candidate (**LLM-first** — OQ-5):
1. **LLM judgment** — send the recent stdout tail (plus a hint of why it stalled:
   a matched prompt vs. plain idle) to the model, which picks one **action**:
   - `respond` — paused at an interactive prompt; returns the exact safe text to submit.
   - `nudge` — gone quiet without finishing and **not** at a prompt; returns a short
     message (or null → a default nudge) to get the agent moving again.
   - `wait` — still actively working (e.g. a build is progressing); take no action.
   - `escalate` — needs a human (unrecoverable error, destructive/irreversible
     decision, ambiguous requirements, or the model is unsure).
2. **Rails check** — before injecting, the response/nudge is validated against the
   destructive-prompt denylist; a flagged injection forces escalation instead.
3. **Inject, wait, or escalate** — write the response/nudge to the PTY stdin; or
   leave a `wait` session alone for the next tick (no injection, so it can't burn
   the cap); or flag the session in the UI as **needs human** and stop driving it.

Safety rails:
- Max auto-injections per session before forced escalation (default 5).
- Never auto-confirm destructive prompts (configurable denylist of patterns).
- Every injection is logged (what was injected, why, by deterministic vs LLM).

---

## 9. Software Development (full lifecycle)

A claimed dev task moves through an explicit **phase** machine (AutopilotV's own
`phase`, tracked independently of the tracker status). Branch naming is
`<branchPrefix><key>-<slug>` (prefix configurable, default `autopilotv/`). The dev
line is **not** sandboxed from `gh` (it must push and open PRs).

```
unclaimed
  → (claim: brain auto-claims an enabled-project To Do, or you click Start)
  → (take over: you click "Take over" on an in-flight item the brain won't auto-claim
     — In Progress / In Review etc. AutopilotV adopts an existing PR (discovered by
     issue key, or the number you hand it) and jumps straight to draft/in_review on a
     worktree checked out to that PR's branch. With no PR to adopt it falls back to a
     fresh implementation, exactly like Start.)
implementing   — feature worktree + branch; Jira → In Progress; agent implements
               and opens a DRAFT PR, signalling completion by writing .autopilotv-impl
draft          — PR detected; awaits publish
  → publish    — auto (setting) or your click; gh pr ready; Jira → In Review
revising       — internal "Request changes" (draft or in_review): agent edits in the
               same worktree, pushes, writes .autopilotv-revise → returns to prior phase
in_review      — babysit: poll readiness; on changes-requested / unresolved threads,
               spawn an address-comments session (writes .autopilotv-address-comments when done)
  → ready_to_merge  when approvals ≥ configured count AND 0 unresolved threads
                    AND mergeable AND checks green
ready_to_merge — pending your Merge click (squash via gh); never auto-merges
done           — PR merged (by you or externally) → prune worktree, stop tracking.
                 No Jira Done transition (QA owns it).
error          — recoverable via Retry/Reset (force-discards the worktree + branch)
```

**Repo selection.** A task routes to its project's mapped repo (§ project→repo
mapping); otherwise the first watched, locally-cloned repo. If the target isn't
cloned, the task errors with a clear reason.

**Control-file protocol (v2).** Because interactive harnesses don't exit on their
own, agents signal completion by writing a git-ignored file in the worktree, which
AutopilotV watches each tick: `.autopilotv-impl` (implementation done — carries the
PR URL), `.autopilotv-revise` (revision done), `.autopilotv-address-comments`
(review feedback addressed). Each is consumed (deleted) so the next round can run.

Signals are versioned JSON reports carrying metadata beyond the bare completion
bit: `{ version, prUrl?, summary, followUps[], learnings[], deviations }`.
Parsing is layered so orchestration never depends on the agent writing perfect
JSON — valid JSON is fully harvested; a bare URL or empty `touch` (the v1
formats, including the legacy `.pr-url`/`.revise`/`.address-comments` names)
still advances the lifecycle; malformed JSON has its PR URL salvaged, is flagged
via a `signal.malformed` event, and advances anyway.

**Post-implementation analysis.** When a PR merges, an analysis pass (before the
worktree is pruned) harvests: the agent-reported followUps/learnings, TODO/FIXME
lines the diff introduced, the PR conversation, and verification failures — a
single schema-validated LLM distillation on top of a deterministic baseline.
Results land in the `followups` and `knowledge` tables and surface in the
**Backlog & Insights** pane: follow-ups become tracker stories on an explicit
click (all tracker adapters implement `createIssue`); accepted learnings are
injected into future sessions' AGENTS.md as a per-repo/per-role "learned
conventions" section, capped and consolidated daily (merge duplicates, retire
stale items) so the set stays signal rather than noise.

**Settings.** `autoPublish` (default off → awaits your Publish), `requiredApprovals`
(default 1).

**Runbooks & staged verification.** A repo's runbook is its "init to
runnable" as data — AutopilotV stays project-agnostic by supplying only the
lifecycle slots, substitution variables ({port:name}, {instance}, {worktree}),
caching, readiness waiting, and evidence collection; every command in a slot is
operator-defined shell.

Resolution (first match wins): the per-repo Settings override (stored in the
DB; saving clears verified-SHA caches and stamps verdicts with a runbook
revision so edits re-verify the same commit) → `RUNBOOK.md` committed in the
repo, read from the TRUNK clone, never the task worktree (a branch under test
cannot weaken its own verification) → legacy `verify_command` as a single test
step. Overrides only materialize into worktrees (git-excluded) when the repo
has no RUNBOOK.md of its own; stages execute from the DB regardless.

Slots: `setup` (cached on a git-pathspec content hash of declared `cacheOn`
inputs) · `secrets` (run once against the user's unlocked secrets manager;
declared `produces` files are encrypted via safeStorage and re-materialized
per worktree from cache with a TTL; outputs are pre-deleted before fresh runs
so inject-style tools stay re-runnable; failures notify the operator and never
spawn fix sessions) · `build` · `test` · `app` (run + readiness probe by URL or
log pattern + teardown; `detached: true` for launchers that exit after starting
the real app, e.g. `aspire start`; `persist` roams app-created state like
emulator seed locks across worktrees; `auto` ports opt into allocation and
concurrent instances, otherwise one instance per repo; global maxRunningApps
cap) · `e2e` (per-step `gate: blocking|advisory`; declared artifacts are copied
out as evidence before teardown).

Checkpoints: the `test` slot runs per pushed commit; the FULL pipeline runs
when the PR reaches **draft** (auto-publish is held until the change is proven
runnable) and at the **ready_to_merge gate** (skipped when the draft
checkpoint proved the same SHA under the same runbook revision). Each stage
records a `task_verifications` row (`checkpoint` column) surfaced as
clickable per-stage chips with a live "verifying now" indicator; a synthetic
`pipeline` rollup carries the verdict. Failures spawn the verification-fix
session, guarded to one attempt per (task, commit); unmergeable PRs dispatch a
conflict-resolution session under the same per-commit guard. Running apps are
supervised in-process and surfaced in the UI with logs and one-click stop.

---

## 10. Data model (SQLite)

Schema is migration-driven (`schema_migrations`); current head is **v7**.

```
harnesses(id, display_name, config_json, enabled, is_review_default)
repos(id, name, path, remote, default_branch, clone_state)
jira_projects(key, name, enabled, repo_name, first_seen)   -- toggle + project→repo map
tasks(id, jira_key, project_key, title, status, jira_status, assignee, priority,
      issue_type, sprint, phase[unclaimed|implementing|draft|revising|in_review|
        ready_to_merge|done|error], pr_number, pr_url, repo_id, worktree_id,
      claim_state, lease_owner, lease_expires_at, session_id, created_at, updated_at)
pr_reviews(id, pr_number, repo_id, title, author, branch, url, state,
      claim_state, lease_owner, lease_expires_at, session_id, discovered_at, updated_at)
reviews(id, pr_review_id, recommendation, summary, findings_json, created_at, action, acted_at)
sessions(id, kind[dev|review], work_ref, harness_id, worktree_id, pid,
      status[starting|running|stalled|needs_human|exited|killed],
      auto_drive, auto_inject_count, last_output_at, title, started_at, exited_at, exit_reason)
worktrees(id, path, repo_id, branch, kind, session_id, created_at, pruned_at)
events(id, ts, level, session_id, kind, payload_json)   -- audit log + brain.note reasoning feed
kv(key, value)                                           -- settings, integration health, flags
schema_migrations(version, applied_at)
```

`status` is AutopilotV's mapped enum; `jira_status` preserves the raw Jira status
name for display. `phase` is AutopilotV's dev lifecycle, refreshed independently of
Jira. `brain.note` events back the Brain reasoning feed.

**Claim/lease model (resumability).** Work items carry a `claim_state` plus a
`lease_owner`/`lease_expires_at`. A session takes a lease when it claims work;
the brain renews the lease each tick while the session is alive. On graceful
quit, leases are released. On crash, leases simply **expire** — the next launch's
brain finds expired leases and returns those items to `unclaimed`, making work
**resumable without manual cleanup** (see §15). All claim transitions are atomic
SQLite `UPDATE ... WHERE claim_state = ?` statements (no row claimed twice).

---

## 11. UI (renderer)

Sidebar-nav (LM-Studio-style) layout, **themable** (Tomorrow Night 80s default,
Tokyo Night, Synthwave, Tomorrow light) via CSS variables on `data-theme`; native
window chrome follows. Tabs: **Work queue · Sessions · Reviews · Brain · Activity ·
Settings**, with badge counts and a live "tick #N · Ns ago" status + Tick-now.

- **Work queue** — _PRs awaiting my review_ (Review / Approve-only / Retry on error)
  and _Tasks assigned to me_ showing the real tracker status while unclaimed and the
  AutopilotV phase once driving. Per-task actions by phase: Start, **Take over** (for
  in-flight items not in To Do — optionally with an explicit PR # to adopt), Publish,
  Request changes, Merge, Reset/Retry, **Terminal**, plus a PR link. A project chip
  bar filters by project (epics excluded).
- **Session grid** — one xterm.js terminal per live session, replayed from the
  captured buffer on view; per-session **auto-drive** toggle; kill.
- **Review cards** — summary + findings + **Approve · Approve only · Request
  changes · Comment · Dismiss**.
- **Brain** — reasoning feed grouped by tick (the `brain.note` stream).
- **Activity** — raw `events` audit log.
- **Settings** — Appearance (theme, re-run setup), Brain, GitHub, Project tracker
  (active adapter fields + per-project enable/repo map), LLM (provider/model + Test),
  Dev line (auto-publish, required approvals, branch prefix, terminal), Auto-drive
  rails, AGENTS.md template, Harnesses (enable + role defaults; Pi native-review),
  Repos, and a **Wipe database** danger zone.
- **First-run walkthrough** — overlay wizard (§24) shown until `onboarded`.
- **OS notifications** — review ready · session needs a human · PR ready to merge;
  click to deep-link.

---

## 12. Configuration

- App config (in `kv.settings`): `theme`, `onboarded`, poll interval,
  `maxConcurrentSessions`, `cloneParentDir`, GitHub username + watched repos +
  fallback filter, `tracker` + `trackerConfig` (per-adapter), LLM `provider`/`model`
  + `localLlmEndpoint`, auto-drive rails, `autoPublish`, `requiredApprovals`,
  `branchPrefix`, `terminalCommand`, notification toggles, and the AGENTS.md template.
- Per-harness adapter config incl. role-default flags (§6); per-project enable +
  repo mapping (`jira_projects`).
- Secrets: rely on existing `gh` / tracker (`acli`) / agent CLI logins — **no API
  key required**. Electron `safeStorage` (OS keychain) is used for any future creds;
  nothing sensitive is stored in SQLite or logs.

---

## 13. Tech stack & dependencies

| Layer | Choice |
|-------|--------|
| Shell | Electron (main + renderer + preload) |
| Language | TypeScript everywhere |
| Renderer | React + Vite |
| Terminals | `node-pty` (main process) ↔ `xterm.js` (renderer), streamed over IPC |
| State | SQLite via `better-sqlite3` (synchronous, in main process) |
| GitHub | `gh` CLI (shelled out, JSON output via `--json`) |
| Trackers | adapter model: `jira` (`acli`), `ghproject` (`gh`), `vikunja` (REST API) |
| LLM | Configurable provider — `local` (`openai` client → local endpoint) or `harness` (any agent CLI run headless `-p`, no API key) |
| Packaging | `electron-builder`, cross-platform (mac dmg/zip · win nsis · linux AppImage) |
| CI | GitHub Actions — typecheck + vitest on Ubuntu; best-effort per-OS packaging matrix |
| Test | `vitest` (unit), integration harness with mocked `gh`/`acli` |

Principle: **the renderer is dumb**. All privileged work (CLIs, PTYs, DB,
secrets, LLM calls) lives in the main process; the renderer only renders state
and sends intents. `contextIsolation: true`, `nodeIntegration: false`, a narrow
`preload` bridge.

---

## 14. IPC contract (main ↔ renderer)

A single typed, versioned bridge exposed via `preload`. Three channel kinds:

- **Commands** (renderer → main, request/response): `work.claim(id)`,
  `work.delegate(id, prNumber?)`, `work.skip(id)`, `review.act(reviewId, action)`, `session.spawn/kill(id)`,
  `session.sendInput(id, data)`, `harness.upsert(cfg)`, `settings.update(patch)`,
  `localModel.start/stop(id)`.
- **Streams** (main → renderer, push): `session.output(id, chunk)` (PTY data,
  backpressure-aware), `state.patch(delta)` (queue/session/review changes),
  `notification(event)`.
- **Queries** (renderer → main): `state.snapshot()` on mount, then live via
  `state.patch`.

Rules: every payload is a typed DTO (shared `types/ipc.ts`); the renderer never
receives raw secrets; PTY output is streamed in chunks with a per-session
sequence number so xterm.js can detect gaps after reconnect.

---

## 15. Session lifecycle & crash recovery

### 15.1 Session states
```
starting → running → (stalled ⇄ running) → exited
                    ↘ needs_human (auto-drive gave up) ↗
       any state → killed (user or shutdown)
```

### 15.2 Spawn
1. Brain claims work (lease) → 2. Worktree provisioned → 3. node-pty spawns the
harness with the resolved adapter (env scrubbed for review sessions) → 4. status
`running`, `last_output_at` stamped on each chunk.

### 15.3 Graceful shutdown (app quit)
- `before-quit`: stop scheduling new work; send each PTY a soft interrupt, then
  `SIGTERM`, then `SIGKILL` after a grace period.
- Release all leases (`claim_state` back to `unclaimed` for unfinished work;
  finished work keeps its terminal state).
- Persist session rows with `status = killed`, `exit_reason = app_quit`.

### 15.4 Crash recovery (next launch)
- On boot the brain runs **reconciliation** before its first tick:
  - Any `running`/`stalled` session row with a dead PID → mark `killed`,
    `exit_reason = orphaned`.
  - Expired leases → work item back to `unclaimed`.
  - Orphaned worktrees (no live session) → GC per §7.6 rules.
- Result: interrupted work is **automatically re-claimable**; no manual cleanup.
- Worker harnesses are assumed resumable (they re-read the repo/worktree state);
  AutopilotV does not try to checkpoint mid-implementation agent state in v1.

---

## 16. Security model (consolidated)

- **Privilege containment:** only the main process holds tokens and may invoke
  `gh` / the tracker CLI / the LLM. Renderer is sandboxed (§13).
- **Review-session sandbox (§7.3):** PATH-shadow `gh`/`hub`/remote-write-`git` shims
  + env-strip of `GH_TOKEN`/`GITHUB_TOKEN`/auth. The review worktree cannot mutate
  the forge. This is the security-critical invariant of the PR-review line.
- **Human gates:** PR approval (review line) and PR merge (dev line) are never
  performed autonomously — both require an explicit click.
- **Auto-drive rails:** destructive-prompt denylist blocks risky injections;
  per-session injection cap forces escalation (§8).
- **Secrets:** no Claude API key — judgment uses the `claude` CLI login. CLI auth
  reuses the machine's existing `gh`/`acli`/`claude` sessions; any future creds go
  in the OS keychain, never in SQLite or logs.
- **Logging hygiene:** event payloads and PTY captures are scrubbed of obvious
  secret patterns before persistence/display.

---

## 17. LLM integration (configurable provider)

The brain's judgment calls go through a single `LlmProvider` interface so the
backend is swappable per the locked decision:

```ts
interface LlmProvider {
  judge(input: JudgeRequest): Promise<JudgeResult>   // structured output enforced
}
```
- **Providers:** `local` (OpenAI-compatible client → the configured local endpoint,
  §6.3) and `harness` (runs the **Brain-default harness** headlessly via `-p`,
  reusing its model/login + local-model env; Claude is just a harness here). Both
  extract JSON from the response. Choosing `local` skips the brain-harness step.
- **Call sites:** (a) stall response (§8), (b) PR review reasoning → ReviewSummary
  (§7.4), (c) ambiguous task triage, (d) babysitting reactions.
- **Structured output:** every call requests a JSON schema and validates the
  result; on validation failure, one retry, then escalate/skip rather than guess.
- **Failure handling:** provider/network errors never crash a tick — they
  degrade to "escalate to human" for that decision and are logged as events.
- Note: the **review session itself** runs via a *harness* (Claude Code/Pi/…),
  which is separate from this brain `LlmProvider`. The provider here is for the
  brain's own reasoning, not for driving terminals.

---

## 18. Error handling & failure modes

| Failure | Behavior |
|---------|----------|
| `gh`/`acli` non-zero or unparseable | Log event, surface a banner, skip that item this tick; retry next tick with backoff |
| GitHub/Jira auth expired | Detect, mark integration degraded, notify; pause dependent scheduling |
| Worktree provision fails (branch missing, dirty) | Mark work `error`, surface, do not spawn; never force-destroy unexpected changes |
| Harness binary missing / adapter misconfigured | Block that harness, surface in config editor |
| Local model endpoint down | Block sessions needing it; attempt managed start; show status |
| PTY dies unexpectedly | Mark session `exited`, record `exit_reason`, release lease |
| Prune blocked (uncommitted changes) | Skip + surface, never `--force` over unexpected work (§7.6) |
| LLM error/timeout | Degrade decision to escalate; log |

Cross-cutting: ticks are idempotent and isolated — one failing item never aborts
the whole tick; everything notable becomes an `events` row.

---

## 19. Observability & audit

- **Audit log (`events`):** every consequential action — claim, spawn, inject
  (with what + why + deterministic-vs-LLM), approval/merge click, prune, error —
  is an append-only event, viewable and filterable in the UI.
- **Session transcripts:** PTY output retained per session (ring buffer live +
  full transcript persisted to disk), linkable from the audit log.
- **Structured app logs:** leveled logs in the main process to a rotating file in
  the app data dir; secret-scrubbed.
- **Health surface:** integration status (github / tracker / llm / local-model) in
  the sidebar, plus a live tick counter; the setup walkthrough (§24) runs a deeper
  environment check on demand.

---

## 20. Testing strategy

- **Unit (vitest):** brain tick logic, claim/lease transitions, stall detection
  & rails, sandbox env construction, `gh`/`acli` output parsers, IPC DTO mapping.
- **Integration:** the **PR-review vertical slice** end to end with `gh`/`acli`
  **mocked** (fixture JSON) and a fake harness binary that emits scripted stdout —
  asserts worktree provision → sandboxed session → ReviewSummary → approve →
  prune, including the crash-recovery reconciliation path.
- **Sandbox test (critical):** assert a review session genuinely cannot run `gh`
  / push (shim fires, env stripped) — this guards the core security invariant.
- **Manual:** UI flows (session grid, review cards, notifications) verified by hand.

---

## 21. Packaging & distribution

- `electron-builder`, **cross-platform**: macOS (dmg/zip, `.icns`), Windows
  (nsis, `.ico` from png), Linux (AppImage). Single source icon in `build/`.
- **GitHub Actions CI** (`.github/workflows/ci.yml`): a `test` job (typecheck +
  vitest, with `libsecret` for native rebuilds) and a best-effort `build` matrix
  across macOS/Windows/Linux that uploads packaged artifacts.
- App data (SQLite, logs, transcripts, config) under the OS app-data dir.
- macOS code signing skipped for CI artifacts (`CSC_IDENTITY_AUTO_DISCOVERY=false`);
  signing/notarization + auto-update deferred.

---

## 22. Open questions

### Resolved
- **OQ-1 (repos):** ✅ Multiple configured repos; AutopilotV manages clones + per-repo worktree root.
- **OQ-2 (review harness):** ✅ Dedicated, swappable review adapter (default Claude Code; can be Pi/etc. on a local model).
- **OQ-3 (sandbox depth):** ✅ PATH-scrub + `gh` shim + env-strip (no OS/container sandbox in v1).
- **OQ-4 (merge policy, dev line):** ✅ Stop at "ready, awaiting your merge" — never auto-merge.
- **OQ-6 (notifications):** ✅ OS notifications on review-ready, needs-human, and PR-ready-to-merge.

- **OQ-5 (stall judgment):** ✅ LLM-first for every stall; destructive-prompt denylist rails still apply.
- **OQ-7 (Jira states):** ✅ `assignee = currentUser()`; claim → In Progress, PR open → In Review; Done left to the user.
- **OQ-8 (worktree layout):** ✅ Per-repo root beside the clone (`<repo>/.autopilotv-worktrees/`); clones under configured parent dir.

All v1 open questions resolved. Remaining unknowns are implementation-level
(exact Jira project key/board, repo list) and will be captured as config, not design.

---

## 23. Milestones

1. **M0 — Skeleton:** Electron app (React+Vite+TS), SQLite + migrations, typed
   IPC bridge, settings, integration status panel.
2. **M1 — Session manager:** node-pty + xterm.js streaming, one harness adapter
   (Claude), manual spawn, stdout capture, manual input, session state machine.
3. **M2 — PR Review vertical slice:** discovery (`gh`) → worktree provision →
   sandboxed review session → ReviewSummary → review card → Approve posts via `gh`
   → prune. Includes the sandbox test and crash-recovery reconciliation.
   **(first milestone, full depth)**
4. **M3 — Brain loop:** idempotent tick, claim/lease scheduling, reconcile,
   notifications.
5. **M4 — Auto-drive:** stall detection + LLM-first judgment + denylist rails +
   injection cap + audit log.
6. **M5 — Multi-harness + local model:** seed Codex/Cursor/OpenCode/Pi adapters,
   config editor, AutopilotV-managed local endpoint.
7. **M6 — Software-dev lifecycle (full):** phase machine
   claim→implement→draft→publish→in_review→ready_to_merge→done, with internal
   Request-changes (`revising`), address-comments, and control-file signals
   (`.autopilotv-impl`/`.autopilotv-revise`/`.autopilotv-address-comments`); stops at ready-to-merge (never auto-merges).
8. **M7 — Productionization:** sprint/epic scoping + project→repo mapping,
   per-session auto-drive, AGENTS.md template, terminal, Wipe DB,
   cross-platform packaging + CI, MIT license.
9. **M8 — Pluggability & polish:** project-tracker adapters (jira · ghproject ·
   vikunja) with adapter-driven settings; harness role defaults + any-harness brain;
   themes; first-run setup walkthrough + environment check; agnostic/neutral naming.

---

## 24. First-run setup walkthrough

On first launch (until the `onboarded` flag is set) an overlay wizard guides setup;
it is re-runnable from **Settings → Appearance → Setup walkthrough**. Steps:

1. **Welcome** — what AutopilotV does + the recommended toolkit.
2. **Environment check** — `env.check` (main) inspects the machine and reports each
   dependency with status, role, version/auth detail, and an install hint:
   - **required:** `git`, `gh` (+ auth);
   - **recommended:** the active tracker's tool (`acli` + auth for Jira / endpoint
     reachability for Vikunja), `claude`, `pi`, and the local LLM endpoint (pinged);
   - **optional:** other configured harness commands.
   Has a Re-check button.
3. **GitHub** — username + watched repos.
4. **Project tracker** — pick the adapter; its fields render from the descriptor.
5. **Brain LLM** — local endpoint/model or a harness, with a Test button.
6. **Harnesses & roles** — enable agents and pick review/brain/coding defaults.
7. **Done** — Finish sets `onboarded` and starts the brain.

Each field writes settings immediately, so Back/Next never lose input; a Skip is
also offered.
