<div align="center">

<img src="build/icon.png" width="128" alt="AutopilotV" />

# 🚀 AutopilotV

**An autonomous agent orchestrator for your software work.**

A local "brain" decides what work is yours to do  tracker tasks assigned to you
and pull requests awaiting your review  and drives it to completion through the
coding agents you already use, running in real terminals, while keeping you in the
loop for the decisions that matter.

[![CI](https://github.com/JustinWoodring/AutopilotV/actions/workflows/ci.yml/badge.svg)](https://github.com/JustinWoodring/AutopilotV/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
&nbsp;·&nbsp; Electron · TypeScript · React

</div>

---

## Overview

<img width="1552" height="1012" alt="image" src="https://github.com/user-attachments/assets/e06072b8-8c83-4557-b4c4-0bbd9751c6f7" />


AutopilotV is a single-user desktop application that watches two lanes of work and
automates their full lifecycle using whatever agent CLIs you have installed 
Claude Code, Pi, Codex, Cursor, OpenCode, and others:

- **PR Reviewing.** It finds pull requests where review is requested from you,
  reviews each in an isolated, sandboxed git worktree that physically cannot push
  or call your forge CLI, summarizes the findings into a card, and posts your
  verdict to the forge on a single click.
- **Software Development.** It claims a tracker task, implements it in a feature
  worktree, opens a draft PR, and shepherds that PR through review feedback until
  it satisfies your merge gates  then stops and waits for you to merge.

A deterministic poll loop handles the bookkeeping; an LLM is invoked only for
judgment  reviewing a change, deciding how to unstick a stalled session, triaging
work. The consequential actions, approving a review and merging a PR, are always an
explicit human click.

For the complete design rationale, see [`SPEC.md`](./SPEC.md).

## Why it exists

Coding agents are capable but high-maintenance: you still hunt for the work, paste
context, babysit terminals, and shuttle results between your tracker, your editor,
and your forge. AutopilotV automates that connective tissue. It treats your agents
as interchangeable workers, keeps the orchestration deterministic and inspectable,
and reserves human judgment for approvals and merges  so you supervise outcomes
instead of typing prompts.

## ✨ Highlights

- **Headful agent sessions.** Each agent runs in a real PTY rendered with xterm.js;
  watch any session live and type into it whenever you want.
- **Auto-drive.** The brain detects stalled sessions — on what's visibly on
  screen, not raw byte flow, so spinners and timers can't mask a stuck prompt —
  and answers them with text or raw keypresses (Enter, arrow-key menus), gated
  by a destructive-command denylist, an injection-effectiveness check, and a
  per-session toggle. Kickoff is closed-loop too: the task prompt is typed only
  once the harness looks ready and is verified to have echoed before submitting.
- **Pluggable by design.**
  - *Trackers:* Jira (`acli`), GitHub Projects (`gh`), Azure DevOps Boards
    (REST), and Vikunja — the active adapter drives the settings UI.
  - *Forges:* GitHub (`gh` CLI) and Azure DevOps Repos (REST). Tracker and forge
    are independent — e.g. Jira work shipped to Azure DevOps PRs is a valid setup.
  - *Harnesses:* any CLI agent; flag one as the review, brain, or coding default.
  - *Brain LLM:* a local OpenAI-compatible endpoint, or any harness run headless.
- **A complete dev lifecycle:** `unclaimed → implementing → draft → in_review →
  ready_to_merge → done`, including internal "Request changes" and review-feedback
  rounds, coordinated through git-ignored JSON signal files (`.autopilotv-impl`,
  `.autopilotv-revise`, `.autopilotv-address-comments`; the legacy bare-file
  names still work). Signals carry structured reports — summary, follow-up work
  items, learned knowledge — that feed the post-implementation analysis engine.
- **Runbooks: per-repo "init to runnable" as data.** A `RUNBOOK.md` (committed
  in the repo, or pasted as an override in Settings) holds a plain-English
  narrative for agents plus optional yaml lifecycle slots — setup / secrets /
  build / test / app / e2e — all operator-defined shell. AutopilotV supplies the
  slots, opt-in port allocation, readiness waiting, caching, and evidence
  collection; it has no opinion about what runs inside them.
- **Staged verification with checkpoints.** Cheap test runs per pushed commit;
  the FULL pipeline (including booting the app and running e2e, e.g. Cypress)
  proves the change runnable when the PR reaches draft and again at the
  ready-to-merge gate. Per-stage verdicts and artifacts (screenshots, videos)
  are recorded as evidence; failures auto-spawn a fix session.
- **Secrets caching.** Runbook secrets steps (e.g. 1Password `op inject`) run
  once against your unlocked session; the produced config files are encrypted
  with the OS keychain and re-materialized into every worktree from cache —
  agents and repeat verifications never touch the secrets tool.
- **Running apps registry.** Apps started from runbooks (verification or a
  manual run) are supervised: allocated ports, readiness probes, log capture,
  one-click stop, and clean teardown — multiple projects side by side.
- **A PM loop.** Merged work is analyzed (agent reports, PR conversation, TODOs
  the diff introduced, verification history) into follow-up story candidates and
  learned repo conventions. The **Backlog & Insights** pane turns follow-ups
  into tracker stories on a click (all four trackers can create issues) and
  curates which learnings are injected into future sessions.
- **Project-to-repo mapping, sprint scoping, and epic filtering.**
- **AGENTS.md template** injected (git-ignored) into every worktree, plus an
  auto-curated "learned conventions" section per repo and role — accepted
  learnings flow back into every future session, and a daily consolidation pass
  keeps the set small and sharp.
- **Crash recovery.** Work leases expire and are re-claimable on the next launch;
  orphaned sessions and worktrees are reconciled at boot.
- **Themes.** Tomorrow Night 80s (default), Tokyo Night, Synthwave, and a light
  Tomorrow  native window chrome follows the choice.
- **System tray** (Windows/Linux). Close the window to minimize to tray; the tray
  icon shows live status, lets you toggle the brain, force a tick, or quit.
- A brain reasoning feed, an audit log, OS notifications, a "drop a terminal in this
  worktree" action, and a one-click database wipe.

## 🛰️ How it works

```
                 ┌──────────── the brain (poll loop) ────────────┐
   trackers ───▶ │  refresh work · reconcile sessions ·          │
   forge    ───▶ │  schedule (claim/lease) · advance dev tasks   │ ──▶ SQLite
                 └───────────────────────┬───────────────────────┘
                                         │ spawns / supervises
                          ┌──────────────▼──────────────┐
                          │  node-pty sessions (harness) │ ◀─ auto-drive (LLM)
                          │  review = sandboxed worktree  │
                          └──────────────┬──────────────┘
                                         │ streamed over typed IPC
                          ┌──────────────▼──────────────┐
                          │  React UI (xterm.js, cards)  │ ──▶ your approve / merge
                          └──────────────────────────────┘
```

The renderer is deliberately thin: every privileged operation  CLIs, PTYs, the
database, secrets, LLM calls  lives in the main process behind a narrow, typed
preload bridge.

## Requirements

- **Node 22+**
- A code forge — pick one (independent of your project tracker):
  - **[`gh`](https://cli.github.com/)** authenticated (`gh auth login`), for GitHub
    PR discovery, reviews, and GitHub Projects.
  - **Azure DevOps Repos** via REST, using a Personal Access Token. No `az` CLI
    is required.
- A project tracker — pick one (independent of your forge):
  - **Jira** via Atlassian **`acli`**
  - **GitHub Projects** (via `gh`)
  - **Azure DevOps Boards** via REST (PAT)
  - **Vikunja** (REST API with personal API token)
- For LLM judgment: a local **OpenAI-compatible** server (for example LM Studio,
  default `http://127.0.0.1:1234`), or any agent CLI you are already logged into —
  no API key required in that case.
- Clone the repositories you work in under your configured **clone parent dir**
  (default `~/repos`) so AutopilotV can resolve `<owner>/<repo>` →
  `<cloneParentDir>/<repo>`.

Built and tested on macOS; the build matrix also targets Windows and Linux. The
review sandbox relies on POSIX shims, so macOS and Linux are first-class.

## 🚀 Getting started

```bash
git clone https://github.com/JustinWoodring/AutopilotV.git
cd AutopilotV
npm install     # rebuilds native modules (better-sqlite3, node-pty) for Electron
npm run dev
```

Then, in **Settings**: choose your tracker and fill in its fields, set your GitHub
username and watched repos, choose the brain LLM, and flag your review, brain, and
coding default harnesses. Turn the brain on (or use **Tick now**) and your work
appears in the queue.

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Launch with hot reload |
| `npm test` | Unit and sandbox/security tests (vitest) |
| `npm run typecheck` | `tsc` for main and renderer |
| `npm run build` | Production bundle into `out/` |
| `npm run dist` | Package an app into `release/` (mac dmg/zip · win nsis · linux AppImage) |

### Installing a packaged build (macOS)

Release builds are **unsigned and unnotarized** (no Apple Developer certificate),
so macOS Gatekeeper quarantines them and may say the app **"is damaged and can't be
opened."** That's expected. The builds are ad-hoc signed, so after clearing the
download quarantine they'll launch. In Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/AutopilotV.app
# if it still says "damaged" (older builds / Apple Silicon), ad-hoc sign it too:
codesign --force --deep --sign - /Applications/AutopilotV.app
```

If you'd rather not deal with Gatekeeper, build from source with `npm run dist`.

## Configuration

Everything is configured in the app and stored in a local SQLite database under
your OS app-data directory  there are no config files to edit:

- **Appearance**  theme.
- **Brain**  poll interval, max concurrent sessions, clone directory.
- **GitHub**  username and watched repos.
- **Tracker**  active adapter and its fields; per-project enable and repo mapping.
- **LLM**  local endpoint/model or a brain harness, with a connectivity test.
- **Dev line**  auto-publish drafts, required approvals, branch prefix, terminal.
- **Auto-drive**  default-on, injection cap, destructive-command denylist.
- **AGENTS.md template**  universal coding instructions injected per worktree.
- **Harnesses**  enable and role defaults; Pi can opt out of the managed local model.

Secrets reuse your existing `gh`, tracker, and agent CLI logins; nothing sensitive
is stored in the database or logs.

## 🔒 Security model

- Only the main process holds tokens or invokes CLIs and the LLM.
- **Review sessions are sandboxed:** the worktree's `PATH` is shadowed with
  hard-failing `gh`/push shims and forge authentication is stripped from the
  environment, so a review agent cannot mutate your repositories. This is enforced
  in code and covered by tests.
- PR approval and PR merge are never performed autonomously.
- Auto-drive injections are checked against a destructive-command denylist and a
  per-session cap before being sent.

## Project layout

```
src/
  main/         Electron main process
    brain/        poll loop, scheduling, stall auto-drive
    trackers/     project-tracker adapters (jira · ghproject · vikunja · azuredevops)
    forges/       code-forge adapters (github · azuredevops)
    review/       sandboxed PR-review orchestration
    dev/          dev-task lifecycle state machine
    sessions/     node-pty session manager
    worktree/     worktree provisioning and the review sandbox
    llm/          brain LLM providers (local · harness)
  preload/      typed IPC bridge
  renderer/     React UI (themable)
  shared/       types shared across processes
test/           vitest unit and sandbox/security tests
```

## 🤝 Contributing

Issues and pull requests are welcome. Please run `npm run typecheck && npm test`
before opening a PR; CI runs the same on every push, along with a best-effort
cross-platform build.

## License

[MIT](./LICENSE) © Justin Woodring

<sub>Built for people who'd rather supervise outcomes than babysit terminals. 🛰️</sub>
