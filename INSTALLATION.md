# Installation For Agents

This guide is for agents or agent harnesses that need a browser capability they
can install globally and call from any workspace.

## Requirements

- Node.js 18 or newer
- npm
- A system browser: Google Chrome, Microsoft Edge, or Chromium

`browser-for-agents` uses `playwright-core`, so it does not download a browser
by default. This keeps installs small and makes the visible browser closer to
the user's real browsing environment.

## Global Install

```sh
npm install -g browser-for-agents
```

Verify the CLI is available:

```sh
bfa status --pretty
```

Expected result:

```json
{
  "home": "/Users/you/.browser-for-agents",
  "profile": "/Users/you/.browser-for-agents/profile",
  "storageState": "/Users/you/.browser-for-agents/storage-state.json",
  "downloads": "/Users/you/.browser-for-agents/downloads",
  "latestObservation": "/Users/you/.browser-for-agents/latest-observation.json",
  "savedStateExists": false,
  "savedCookies": 0,
  "savedOrigins": 0
}
```

## Browser Selection

By default, `bfa` looks for Chrome, Edge, or Chromium in common locations.

If your environment has a non-standard browser path, set:

```sh
export BFA_BROWSER_EXE="/path/to/chrome"
```

Or pass it per command:

```sh
bfa observe https://example.com --browser "/path/to/chrome"
```

For headless runs:

```sh
export BFA_HEADLESS=1
```

Or:

```sh
bfa session --headless
```

## Runtime State

Runtime files are stored outside the agent's current repo:

```text
~/.browser-for-agents/
  profile/
  storage-state.json
  downloads/
  latest-observation.json
```

To isolate state per agent, job, or user:

```sh
export BFA_HOME="/tmp/my-agent-browser"
```

Or:

```sh
bfa session --home /tmp/my-agent-browser
```

## First Login

For websites that require authentication, open a visible browser once and let
the user sign in:

```sh
bfa open https://example.com/login
```

The session is saved under `BFA_HOME` so later `observe`, `act`, and `session`
commands can reuse cookies and local storage.

## Recommended Agent Loop

Use the long-running JSONL session when the agent will take multiple steps.
This preserves observed element ids like `e3` while the page stays alive.

```sh
bfa session https://example.com
```

The process emits an initial observation on stdout. Send one JSON command per
line on stdin:

```jsonl
{"action":"fill","target":"e3","value":"purchase order tracking"}
{"action":"press","target":"e3","key":"Enter"}
{"action":"wait","ms":1000}
```

Every command returns a fresh observation on stdout.

## One-Shot Commands

Observe:

```sh
bfa observe https://example.com --pretty
```

Act:

```sh
bfa act '{"action":"goto","url":"https://example.com"}' --pretty
```

Act from a file:

```sh
bfa act ./action.json --pretty
```

## Actions

Supported actions:

- `goto`: `{ "action": "goto", "url": "https://example.com" }`
- `click`: `{ "action": "click", "target": "e1" }`
- `fill`: `{ "action": "fill", "target": "e2", "value": "hello" }`
- `type`: `{ "action": "type", "target": "e2", "value": "hello" }`
- `press`: `{ "action": "press", "target": "e2", "key": "Enter" }`
- `select`: `{ "action": "select", "target": "e3", "value": "option-value" }`
- `hover`: `{ "action": "hover", "target": "e4" }`
- `scroll`: `{ "action": "scroll", "direction": "down", "amount": 600 }`
- `wait`: `{ "action": "wait", "ms": 1000 }`

Targets should usually be observed ids like `e12`. Fallback targets are
available when needed:

```text
text=Export
label=Email
placeholder=Search
role=button:Submit
css=button.primary
```

## JavaScript Usage

```js
import { close, createAgentBrowser } from "browser-for-agents";

const browser = await createAgentBrowser({
  homeDir: "/tmp/my-agent-browser"
});

let observation = await browser.observe("https://example.com");

observation = await browser.act({
  action: "click",
  target: observation.elements[0].id
});

await close(browser);
```

## Troubleshooting

If `bfa` cannot launch a browser, install Chrome, Edge, or Chromium, then set
`BFA_BROWSER_EXE` to the executable path.

If observed ids stop working, use `bfa session` instead of separate one-shot
commands. Element ids are stable inside an active session, not across unrelated
browser processes.

If login state is wrong, use a fresh runtime directory:

```sh
BFA_HOME=/tmp/fresh-bfa bfa open https://example.com/login
```
