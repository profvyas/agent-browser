import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAgentBrowser, findBrowserExecutable, getAgentBrowserStatus } from "../src/index.js";

const browserExecutable = findBrowserExecutable();
const fixtureUrl = new URL("./fixtures/form.html", import.meta.url).href;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bfa-${name}-`));
}

function shouldSkipWithoutBrowser(t) {
  if (!browserExecutable) {
    t.skip("No system Chrome, Edge, or Chromium executable found.");
    return true;
  }
  return false;
}

test("observe returns page meta and actionable elements", async (t) => {
  if (shouldSkipWithoutBrowser(t)) return;
  const browser = await createAgentBrowser({
    homeDir: tmpHome("observe"),
    executablePath: browserExecutable,
    headless: true
  });

  try {
    const observation = await browser.observe(fixtureUrl);

    assert.equal(observation.page.title, "BFA Fixture");
    assert.equal(observation.meta.description, "Fixture page for browser-for-agents tests.");
    assert.ok(observation.headings.some((heading) => heading.text === "Agent Test Page"));
    assert.ok(observation.elements.some((element) => element.role === "textbox" && element.name === "Search query"));
    assert.ok(observation.elements.some((element) => element.role === "button" && element.name === "Run search"));
  } finally {
    await browser.close();
  }
});

test("status reads runtime paths without launching a browser", () => {
  const homeDir = tmpHome("status");
  const status = getAgentBrowserStatus({ homeDir });

  assert.equal(status.home, homeDir);
  assert.equal(status.savedStateExists, false);
  assert.equal(status.savedCookies, 0);
  assert.match(status.profile, /profile$/);
});

test("act supports observed ids and returns a fresh observation", async (t) => {
  if (shouldSkipWithoutBrowser(t)) return;
  const browser = await createAgentBrowser({
    homeDir: tmpHome("act"),
    executablePath: browserExecutable,
    headless: true
  });

  try {
    let observation = await browser.observe(fixtureUrl);
    const input = observation.elements.find((element) => element.role === "textbox");
    const select = observation.elements.find((element) => element.role === "combobox");
    const button = observation.elements.find((element) => element.role === "button" && element.name === "Run search");

    observation = await browser.act({
      actions: [
        { action: "fill", target: input.id, value: "purchase order" },
        { action: "select", target: select.id, value: "blinkit" },
        { action: "click", target: button.id }
      ]
    });

    assert.ok(observation.elements.some((element) => element.value === "purchase order"));
    assert.match(await browser.page.locator("#result").innerText(), /purchase order on blinkit/);
  } finally {
    await browser.close();
  }
});

test("act supports fallback targets", async (t) => {
  if (shouldSkipWithoutBrowser(t)) return;
  const browser = await createAgentBrowser({
    homeDir: tmpHome("fallback"),
    executablePath: browserExecutable,
    headless: true
  });

  try {
    await browser.observe(fixtureUrl);
    await browser.act({ action: "fill", target: "label=Search query", value: "fallback" });
    await browser.act({ action: "click", target: "role=button:Run search" });

    assert.match(await browser.page.locator("#result").innerText(), /fallback on zepto/);
  } finally {
    await browser.close();
  }
});

test("session preserves element ids across JSONL actions", async (t) => {
  if (shouldSkipWithoutBrowser(t)) return;
  const child = spawn(process.execPath, [
    "bin/bfa.mjs",
    "session",
    fixtureUrl,
    "--home",
    tmpHome("session"),
    "--browser",
    browserExecutable,
    "--headless"
  ], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"]
  });

  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

  let buffer = "";
  const observations = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) observations.push(JSON.parse(line));
      index = buffer.indexOf("\n");
    }
  });

  while (observations.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const input = observations[0].elements.find((element) => element.role === "textbox");
  child.stdin.write(`${JSON.stringify({ action: "fill", target: input.id, value: "session value" })}\n`);

  while (observations.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.ok(observations[1].elements.some((element) => element.id === input.id && element.value === "session value"));

  child.stdin.end();
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr.join(""));
});
