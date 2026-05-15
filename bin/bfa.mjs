#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import readline from "node:readline";
import { createAgentBrowser, getAgentBrowserStatus, serializeError } from "../src/index.js";

function printUsage() {
  console.log(`Usage:
  bfa observe [url] [--pretty] [--home <dir>] [--profile <name>] [--browser <path>] [--headless] [--allow-origin <origin>] [--observe-screenshots]
  bfa act <json-or-file> [--pretty] [--home <dir>] [--profile <name>] [--browser <path>] [--headless] [--allow-origin <origin>]
  bfa session [url] [--home <dir>] [--profile <name>] [--browser <path>] [--headless] [--allow-origin <origin>]
  bfa screenshot [url] [--full-page] [--name <file>] [--home <dir>] [--profile <name>] [--browser <path>] [--headless]
  bfa open <url> [--home <dir>] [--profile <name>] [--browser <path>] [--allow-origin <origin>]
  bfa status [--home <dir>] [--profile <name>]

Actions:
  goto, click, type, fill, press, select, hover, scroll, wait, screenshot, upload`);
}

function parseCli(argv) {
  const positionals = [];
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [rawKey, rawValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replaceAll("-", "_");
    if (rawValue !== undefined) {
      setFlag(flags, key, rawValue);
    } else if (booleanFlag(key)) {
      flags[key] = true;
    } else {
      setFlag(flags, key, argv[i + 1]);
      i += 1;
    }
  }

  return { positionals, flags };
}

function setFlag(flags, key, value) {
  if (key === "allow_origin") {
    flags[key] = [...(Array.isArray(flags[key]) ? flags[key] : []), value];
    return;
  }

  if (booleanFlag(key)) {
    flags[key] = value === true || value === "true";
    return;
  }

  flags[key] = value;
}

function booleanFlag(key) {
  return [
    "pretty",
    "headless",
    "full_page",
    "observe_screenshots",
    "observe_screenshot_full_page",
    "audit_disabled"
  ].includes(key);
}

function browserOptions(flags) {
  return {
    homeDir: flags.home,
    profileName: flags.profile,
    executablePath: flags.browser,
    headless: flags.headless,
    screenshotsDir: flags.screenshots,
    auditLogPath: flags.audit_log,
    auditEnabled: flags.audit_disabled === undefined ? undefined : !flags.audit_disabled,
    observeScreenshots: flags.observe_screenshots,
    observeScreenshotFullPage: flags.observe_screenshot_full_page,
    allowedOrigins: flags.allow_origin
  };
}

function printJson(value, pretty) {
  console.log(JSON.stringify(value, null, pretty ? 2 : 0));
}

function parseActionInput(input) {
  if (!input) {
    throw new Error("act requires an action JSON string or a JSON file path.");
  }

  if (fs.existsSync(input)) {
    return JSON.parse(fs.readFileSync(input, "utf8"));
  }

  return JSON.parse(input);
}

async function runSession(browser, startUrl) {
  if (startUrl) {
    process.stdout.write(`${JSON.stringify(await browser.observe(startUrl))}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(await browser.observe())}\n`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
    terminal: false
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const command = JSON.parse(trimmed);
      const observation = await browser.act(command);
      process.stdout.write(`${JSON.stringify(observation)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ error: serializeError(error) })}\n`);
    }
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "-h" || command === "--help") {
    printUsage();
    return;
  }

  const { positionals, flags } = parseCli(rest);

  if (command === "status") {
    printJson(getAgentBrowserStatus(browserOptions(flags)), flags.pretty);
    return;
  }

  const browser = await createAgentBrowser(browserOptions(flags));

  try {
    if (command === "observe") {
      printJson(await browser.observe(positionals[0]), flags.pretty);
      return;
    }

    if (command === "act") {
      const action = parseActionInput(positionals[0]);
      printJson(await browser.act(action), flags.pretty);
      return;
    }

    if (command === "session") {
      await runSession(browser, positionals[0]);
      return;
    }

    if (command === "screenshot") {
      if (positionals[0]) {
        await browser.open(positionals[0]);
      }
      printJson(await browser.screenshot({ name: flags.name, fullPage: flags.full_page }), flags.pretty);
      return;
    }

    if (command === "open") {
      const url = positionals[0];
      if (!url) throw new Error("open requires a URL.");
      await browser.open(url);
      console.error("Browser opened. Close the browser window or press Ctrl+C when finished.");
      await new Promise((resolve) => {
        process.once("SIGINT", resolve);
        browser.context.once("close", resolve);
      });
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } finally {
    if (command !== "open") {
      await browser.close();
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
