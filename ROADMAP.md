# Agent Browser Extension Plan

This branch is an independent root for turning `browser-for-agents` from a
minimal Playwright wrapper into a safer agent browser runtime.

## Phase 1: Safer Runtime Defaults

- Add explicit origin allowlists for real-account sessions.
- Keep runtime artifacts outside project directories.
- Make status report profile, storage, screenshot, download, and allowlist
  settings.
- Preserve the existing simple JSON action loop.

## Phase 2: Better Observability

- Capture screenshots on demand and optionally during observations.
- Include focused element, scroll position, page dimensions, network failures,
  console errors, and downloads in observations.
- Keep observations compact enough for agents to consume without raw HTML.

## Phase 3: Stronger Actions

- Add wait primitives for selectors, text, URLs, load states, and timeouts.
- Add first-class screenshot and file upload actions.
- Track downloads with filenames and saved paths.
- Improve action errors with the failed action and resolved target.

## Phase 4: OpenClaw Integration

- Wrap the CLI as a long-lived tool with one profile per user/domain/task.
- Add domain policy presets for internal tools.
- Emit artifact paths and structured errors that upstream agents can reason
  about.
- Add smoke tests against local fixtures plus browser-skipped integration tests.

## Phase 5: Production Hardening

- Add audit logging and redaction hooks.
- Add multi-tab/page selection.
- Add per-command timeout overrides.
- Add CI packaging checks and release automation.
