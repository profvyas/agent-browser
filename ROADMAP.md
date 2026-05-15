# Agent Browser Extension Plan

This branch is an independent root for turning `browser-for-agents` from a
minimal Playwright wrapper into a safer agent browser runtime.

## Phase 1: Safer Runtime Defaults

- [x] Add explicit origin allowlists for real-account sessions.
- [x] Keep runtime artifacts outside project directories.
- [x] Make status report profile, storage, screenshot, download, and allowlist
  settings.
- [x] Preserve the existing simple JSON action loop.

## Phase 2: Better Observability

- [x] Capture screenshots on demand and optionally during observations.
- [x] Include focused element, scroll position, page dimensions, network failures,
  console errors, and downloads in observations.
- [x] Keep observations compact enough for agents to consume without raw HTML.

## Phase 3: Stronger Actions

- [x] Add wait primitives for selectors, text, URLs, load states, and timeouts.
- [x] Add first-class screenshot and file upload actions.
- [x] Track downloads with filenames and saved paths.
- [x] Improve action errors with the failed action and resolved target.

## Phase 4: OpenClaw Integration

- [x] Wrap the CLI as a long-lived tool with one profile per user/domain/task.
- [x] Add domain policy presets for internal tools.
- [x] Emit artifact paths and structured errors that upstream agents can reason
  about.
- [x] Add smoke tests against local fixtures plus browser-skipped integration tests.

## Phase 5: Production Hardening

- [x] Add audit logging and redaction hooks.
- [x] Add multi-tab/page selection.
- [x] Add per-command timeout overrides.
- [blocked] Add CI packaging checks. The available GitHub PAT cannot create or
  update `.github/workflows/*` without `workflow` scope.
- Add release automation.
