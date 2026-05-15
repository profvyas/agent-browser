import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BrowserActionError,
  createAgentBrowser,
  findBrowserExecutable,
  getAgentBrowserStatus,
  serializeError
} from "../src/index.js";

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
    assert.ok(observation.elements.some((element) => element.type === "file" && element.actions.includes("upload")));
  } finally {
    await browser.close();
  }
});

test("status reads runtime paths without launching a browser", () => {
  const homeDir = tmpHome("status");
  const status = getAgentBrowserStatus({
    homeDir,
    profileName: "customer/a",
    allowedOrigins: ["https://example.com"]
  });

  assert.equal(status.home, homeDir);
  assert.equal(status.savedStateExists, false);
  assert.equal(status.savedCookies, 0);
  assert.equal(status.profileName, "customer/a");
  assert.match(status.profileRoot, /profiles\/customer-a$/);
  assert.match(status.profile, /profile$/);
  assert.match(status.screenshots, /screenshots$/);
  assert.match(status.auditLog, /audit\.jsonl$/);
  assert.equal(status.auditEnabled, true);
  assert.deepEqual(status.allowedOrigins, ["https://example.com"]);
});

test("policy presets can provide wildcard allowed origins", () => {
  const status = getAgentBrowserStatus({
    homeDir: tmpHome("policy"),
    policyName: "local"
  });

  assert.equal(status.policyName, "local");
  assert.deepEqual(status.allowedOrigins, ["http://localhost:*", "http://127.0.0.1:*", "file://*"]);
});

test("serializeError redacts action payload values", () => {
  const error = new BrowserActionError("Fill failed", {
    actionIndex: 2,
    action: {
      action: "fill",
      target: "label=Password",
      value: "secret-value"
    }
  });

  assert.deepEqual(serializeError(error), {
    name: "BrowserActionError",
    code: "BFA_ACTION_FAILED",
    message: "Fill failed",
    actionIndex: 2,
    action: {
      action: "fill",
      target: "label=Password",
      value: "[redacted]"
    }
  });
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

test("allowed origins block unexpected navigation", async (t) => {
  if (shouldSkipWithoutBrowser(t)) return;
  const browser = await createAgentBrowser({
    homeDir: tmpHome("allowlist"),
    executablePath: browserExecutable,
    headless: true,
    allowedOrigins: ["https://allowed.example"]
  });

  try {
    await assert.rejects(
      () => browser.observe(fixtureUrl),
      /Navigation blocked by allowed origins policy/
    );
  } finally {
    await browser.close();
  }
});

test("screenshot action saves an artifact and records it in observations", async (t) => {
  if (shouldSkipWithoutBrowser(t)) return;
  const homeDir = tmpHome("screenshot");
  const browser = await createAgentBrowser({
    homeDir,
    executablePath: browserExecutable,
    headless: true
  });

  try {
    await browser.observe(fixtureUrl);
    const observation = await browser.act({ action: "screenshot", name: "fixture", fullPage: true });

    assert.match(observation.artifacts.latestScreenshot, /fixture\.png$/);
    assert.ok(fs.existsSync(observation.artifacts.latestScreenshot));
    assert.match(observation.artifacts.latestScreenshot, new RegExp(`${path.basename(homeDir)}/screenshots`));
  } finally {
    await browser.close();
  }
});

test("wait action supports visible text", async (t) => {
  if (shouldSkipWithoutBrowser(t)) return;
  const browser = await createAgentBrowser({
    homeDir: tmpHome("wait"),
    executablePath: browserExecutable,
    headless: true
  });

  try {
    let observation = await browser.observe(fixtureUrl);
    const input = observation.elements.find((element) => element.role === "textbox");
    const button = observation.elements.find((element) => element.role === "button" && element.name === "Run search");

    observation = await browser.act({
      actions: [
        { action: "fill", target: input.id, value: "wait check" },
        { action: "click", target: button.id },
        { action: "wait", text: "wait check on zepto", timeoutMs: 1000 }
      ]
    });

    assert.ok(observation.state.scroll.maxY > 0);
    assert.ok(observation.elements.some((element) => element.value === "wait check"));
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
