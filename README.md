# Browser For Agents

`browser-for-agents` is a tiny visible browser interface for agents. It avoids
making the agent read HTML. The loop is:

```text
observe JSON -> choose an element/action -> act -> observe JSON
```

It uses `playwright-core` with your system Chrome or Edge by default, keeps a
persistent profile under `~/.browser-for-agents`, and exposes both a global CLI
and a JavaScript API.

## Install

```sh
npm install -g browser-for-agents
```

Agent setup details live in [INSTALLATION.md](./INSTALLATION.md).

For local development:

```sh
npm install
npm link
```

## CLI

Open a visible browser for manual login:

```sh
bfa open https://example.com/login
```

Observe a page as JSON:

```sh
bfa observe https://example.com --pretty
```

Run one action and receive a fresh observation:

```sh
bfa act '{"action":"goto","url":"https://example.com"}' --pretty
```

Run a long-lived JSONL session:

```sh
bfa session https://example.com
```

Then send commands on stdin:

```jsonl
{"action":"fill","target":"e3","value":"purchase order tracking"}
{"action":"press","target":"e3","key":"Enter"}
```

Each command emits one JSON observation on stdout.

## Actions

Supported primitives:

- `goto`
- `click`
- `type`
- `fill`
- `press`
- `select`
- `hover`
- `scroll`
- `wait`

Prefer observed ids such as `e12`. Fallback targets are also supported:

```text
text=Search
label=Email
placeholder=Search
role=button:Submit
css=button.primary
```

## Observation Shape

Observations are intentionally compact and machine-readable:

```json
{
  "page": {
    "url": "https://example.com/",
    "title": "Example Domain",
    "readyState": "complete"
  },
  "meta": {
    "description": "",
    "canonical": ""
  },
  "network": {
    "requests": 1,
    "failed": 0,
    "recent": []
  },
  "elements": [
    {
      "id": "e1",
      "role": "link",
      "name": "More information...",
      "text": "More information...",
      "bbox": { "x": 10, "y": 20, "width": 180, "height": 20 },
      "actions": ["click", "hover"]
    }
  ]
}
```

Raw HTML is not returned by default.

## JavaScript API

```js
import { close, createAgentBrowser } from "browser-for-agents";

const browser = await createAgentBrowser();
let observation = await browser.observe("https://example.com");

observation = await browser.act({
  action: "click",
  target: observation.elements[0].id
});

await close(browser);
```

## Configuration

Runtime files are stored outside your project:

```text
~/.browser-for-agents/
  profile/
  storage-state.json
  downloads/
  latest-observation.json
```

Environment overrides:

- `BFA_HOME`: runtime directory
- `BFA_BROWSER_EXE`: explicit Chrome/Edge/Chromium executable
- `BFA_HEADLESS=1`: run headless

Useful flags:

```sh
bfa observe https://example.com --home /tmp/bfa --browser /path/to/chrome
bfa session --headless
```

## Development

```sh
npm test
npm run pack:check
```

Browser-backed tests skip automatically when no system Chrome, Edge, or Chromium
executable is available.
