import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const DEFAULT_VIEWPORT = { width: 1365, height: 900 };
const MAX_RECENT_EVENTS = 40;

export async function createAgentBrowser(options = {}) {
  const browser = new AgentBrowser(options);
  await browser.start();
  return browser;
}

export async function observe(url, options = {}) {
  const browser = await createAgentBrowser(options);
  try {
    return await browser.observe(url);
  } finally {
    await browser.close();
  }
}

export async function act(action, options = {}) {
  const browser = await createAgentBrowser(options);
  try {
    return await browser.act(action);
  } finally {
    await browser.close();
  }
}

export async function close(browser) {
  await browser?.close?.();
}

export function getAgentBrowserStatus(options = {}) {
  const normalized = normalizeOptions(options);
  return readStatus(normalized);
}

export class AgentBrowser {
  constructor(options = {}) {
    this.options = normalizeOptions(options);
    this.context = undefined;
    this.page = undefined;
    this.networkEvents = [];
    this.consoleEvents = [];
  }

  async start() {
    if (this.context) return this;

    ensureDir(this.options.homeDir);
    ensureDir(this.options.profileDir);
    ensureDir(this.options.downloadsDir);

    const launchOptions = {
      acceptDownloads: true,
      downloadsPath: this.options.downloadsDir,
      headless: this.options.headless,
      viewport: this.options.viewport,
      timeout: this.options.defaultTimeoutMs
    };

    if (this.options.executablePath) {
      launchOptions.executablePath = this.options.executablePath;
    } else {
      const executablePath = findBrowserExecutable();
      if (executablePath) {
        launchOptions.executablePath = executablePath;
      } else {
        launchOptions.channel = this.options.browserChannel;
      }
    }

    this.context = await chromium.launchPersistentContext(this.options.profileDir, launchOptions);
    this.context.setDefaultTimeout(this.options.defaultTimeoutMs);
    await loadStorageState(this.context, this.options.storageStatePath);

    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.setDefaultTimeout(this.options.defaultTimeoutMs);
    this.attachPageListeners(this.page);
    this.context.on("page", (page) => this.attachPageListeners(page));
    return this;
  }

  async open(url) {
    await this.ensureStarted();
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    await this.saveStorageState();
    return this.page;
  }

  async observe(url) {
    await this.ensureStarted();
    if (url) {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
    }

    const observation = await buildObservation(this.page, {
      networkEvents: this.networkEvents,
      consoleEvents: this.consoleEvents
    });

    ensureDir(path.dirname(this.options.latestObservationPath));
    fs.writeFileSync(this.options.latestObservationPath, `${JSON.stringify(observation, null, 2)}\n`);
    await this.saveStorageState();
    return observation;
  }

  async act(input) {
    await this.ensureStarted();
    const actions = Array.isArray(input?.actions) ? input.actions : [input];

    for (const action of actions) {
      await performAction(this.page, action);
    }

    return this.observe();
  }

  async status() {
    return readStatus(this.options);
  }

  async close() {
    if (!this.context) return;
    await this.saveStorageState();
    await this.context.close();
    this.context = undefined;
    this.page = undefined;
  }

  async saveStorageState() {
    if (!this.context) return;
    ensureDir(path.dirname(this.options.storageStatePath));
    await this.context.storageState({ path: this.options.storageStatePath });
  }

  async ensureStarted() {
    if (!this.context) {
      await this.start();
    }
  }

  attachPageListeners(page) {
    page.on("requestfinished", (request) => {
      this.pushNetworkEvent({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        status: request.response().then((response) => response?.status()).catch(() => undefined)
      });
    });

    page.on("requestfailed", (request) => {
      this.pushNetworkEvent({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        failed: true,
        failure: request.failure()?.errorText
      });
    });

    page.on("console", (message) => {
      this.consoleEvents.push({
        type: message.type(),
        text: message.text(),
        location: message.location()
      });
      this.consoleEvents = this.consoleEvents.slice(-MAX_RECENT_EVENTS);
    });
  }

  async pushNetworkEvent(event) {
    const resolved = { ...event };
    if (event.status && typeof event.status.then === "function") {
      resolved.status = await event.status;
    }
    this.networkEvents.push(resolved);
    this.networkEvents = this.networkEvents.slice(-MAX_RECENT_EVENTS);
  }
}

function readStatus(options) {
  const stateExists = fs.existsSync(options.storageStatePath);
  let cookieCount = 0;
  let originCount = 0;

  if (stateExists) {
    const state = JSON.parse(fs.readFileSync(options.storageStatePath, "utf8"));
    cookieCount = Array.isArray(state.cookies) ? state.cookies.length : 0;
    originCount = Array.isArray(state.origins) ? state.origins.length : 0;
  }

  return {
    home: options.homeDir,
    profile: options.profileDir,
    storageState: options.storageStatePath,
    downloads: options.downloadsDir,
    latestObservation: options.latestObservationPath,
    savedStateExists: stateExists,
    savedCookies: cookieCount,
    savedOrigins: originCount
  };
}

function normalizeOptions(options) {
  const homeDir = path.resolve(expandHome(options.homeDir || process.env.BFA_HOME || "~/.browser-for-agents"));
  return {
    homeDir,
    profileDir: path.resolve(options.profileDir || path.join(homeDir, "profile")),
    storageStatePath: path.resolve(options.storageStatePath || path.join(homeDir, "storage-state.json")),
    downloadsDir: path.resolve(options.downloadsDir || path.join(homeDir, "downloads")),
    latestObservationPath: path.resolve(options.latestObservationPath || path.join(homeDir, "latest-observation.json")),
    executablePath: options.executablePath || process.env.BFA_BROWSER_EXE,
    browserChannel: options.browserChannel || "chrome",
    headless: options.headless ?? process.env.BFA_HEADLESS === "1",
    defaultTimeoutMs: options.defaultTimeoutMs || 30000,
    viewport: options.viewport || DEFAULT_VIEWPORT
  };
}

function expandHome(value) {
  if (!value || !value.startsWith("~")) return value;
  return path.join(os.homedir(), value.slice(1));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function findBrowserExecutable() {
  const candidates = [
    process.env.BFA_BROWSER_EXE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge"
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function loadStorageState(context, storageStatePath) {
  if (!storageStatePath || !fs.existsSync(storageStatePath)) return;

  const state = JSON.parse(fs.readFileSync(storageStatePath, "utf8"));

  if (Array.isArray(state.cookies) && state.cookies.length > 0) {
    await context.addCookies(state.cookies);
  }

  if (Array.isArray(state.origins) && state.origins.length > 0) {
    await context.addInitScript((origins) => {
      const originState = origins.find((entry) => entry.origin === window.location.origin);
      if (!originState || !Array.isArray(originState.localStorage)) return;

      for (const item of originState.localStorage) {
        window.localStorage.setItem(item.name, item.value);
      }
    }, state.origins);
  }
}

async function buildObservation(page, events) {
  const pageInfo = await page.evaluate(() => ({
    url: window.location.href,
    title: document.title,
    readyState: document.readyState
  }));

  const viewport = page.viewportSize();
  const pageData = await page.evaluate(collectPageData);
  const networkEvents = await Promise.all(events.networkEvents.map(async (event) => ({
    ...event,
    status: typeof event.status?.then === "function" ? await event.status : event.status
  })));
  const failedRequests = networkEvents.filter((event) => event.failed || (event.status && event.status >= 400));
  const consoleErrors = events.consoleEvents.filter((event) => ["error", "warning"].includes(event.type));

  return {
    page: pageInfo,
    viewport,
    meta: pageData.meta,
    headings: pageData.headings,
    forms: pageData.forms,
    network: {
      requests: networkEvents.length,
      failed: failedRequests.length,
      recent: networkEvents.slice(-10).map(trimNetworkEvent)
    },
    console: {
      messages: events.consoleEvents.length,
      errors: consoleErrors.length,
      recent: events.consoleEvents.slice(-10)
    },
    elements: pageData.elements
  };
}

function trimNetworkEvent(event) {
  return {
    method: event.method,
    url: event.url,
    resourceType: event.resourceType,
    status: event.status,
    failed: event.failed || undefined
  };
}

function collectPageData() {
  if (!window.__bfaElementIds) {
    window.__bfaElementIds = new WeakMap();
    window.__bfaElementById = new Map();
    window.__bfaNextId = 1;
  }

  const elementSelector = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "summary",
    "[role]",
    "[contenteditable='true']",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");

  const metaByName = (name) => document.querySelector(`meta[name="${name}"]`)?.content || "";
  const metaByProperty = (property) => document.querySelector(`meta[property="${property}"]`)?.content || "";
  const canonical = document.querySelector("link[rel='canonical']")?.href || "";

  const elements = Array.from(document.querySelectorAll(elementSelector))
    .filter(isElementVisible)
    .slice(0, 200)
    .map(describeElement)
    .filter(Boolean);

  return {
    meta: {
      description: metaByName("description"),
      canonical,
      viewport: metaByName("viewport"),
      robots: metaByName("robots"),
      ogTitle: metaByProperty("og:title"),
      ogDescription: metaByProperty("og:description")
    },
    headings: Array.from(document.querySelectorAll("h1,h2,h3"))
      .filter(isElementVisible)
      .slice(0, 30)
      .map((element) => ({
        level: Number(element.tagName.slice(1)),
        text: cleanText(element.innerText || element.textContent || "")
      }))
      .filter((heading) => heading.text),
    forms: Array.from(document.forms).slice(0, 20).map((form, index) => ({
      index,
      name: form.getAttribute("name") || "",
      id: form.id || "",
      action: form.action || "",
      method: (form.method || "get").toLowerCase(),
      fields: Array.from(form.elements).slice(0, 50).map((field) => ({
        name: field.getAttribute("name") || "",
        type: field.getAttribute("type") || field.tagName.toLowerCase(),
        label: labelFor(field),
        value: field.value || ""
      }))
    })),
    elements
  };

  function describeElement(element) {
    const id = getElementId(element);
    const rect = element.getBoundingClientRect();
    const role = roleFor(element);
    const tagName = element.tagName.toLowerCase();
    const type = element.getAttribute("type") || "";
    const text = cleanText(element.innerText || element.textContent || "");
    const label = labelFor(element);
    const ariaLabel = element.getAttribute("aria-label") || "";
    const title = element.getAttribute("title") || "";
    const placeholder = element.getAttribute("placeholder") || "";
    const name = firstNonEmpty(ariaLabel, label, element.getAttribute("name"), placeholder, title, text);

    return {
      id,
      role,
      tagName,
      type,
      name,
      label,
      text,
      value: valueFor(element),
      placeholder,
      href: tagName === "a" ? element.href : "",
      checked: "checked" in element ? Boolean(element.checked) : undefined,
      disabled: "disabled" in element ? Boolean(element.disabled) : element.getAttribute("aria-disabled") === "true",
      bbox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      actions: actionsFor(element, role)
    };
  }

  function getElementId(element) {
    let id = window.__bfaElementIds.get(element);
    if (!id) {
      id = `e${window.__bfaNextId}`;
      window.__bfaNextId += 1;
      window.__bfaElementIds.set(element, id);
      window.__bfaElementById.set(id, element);
    }
    return id;
  }

  function isElementVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0;
  }

  function roleFor(element) {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;

    const tagName = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") || "").toLowerCase();
    if (tagName === "a") return "link";
    if (tagName === "button" || ["button", "submit", "reset"].includes(type)) return "button";
    if (tagName === "textarea" || (tagName === "input" && ["", "email", "password", "search", "tel", "text", "url", "number"].includes(type))) return "textbox";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (tagName === "select") return "combobox";
    if (tagName === "summary") return "button";
    if (element.isContentEditable) return "textbox";
    return "generic";
  }

  function actionsFor(element, role) {
    const tagName = element.tagName.toLowerCase();
    const actions = ["click", "hover"];
    if (["textbox", "searchbox"].includes(role) || element.isContentEditable) {
      actions.push("fill", "type", "press");
    }
    if (["button", "link", "checkbox", "radio"].includes(role)) {
      actions.push("press");
    }
    if (tagName === "select") {
      actions.push("select");
    }
    return Array.from(new Set(actions));
  }

  function valueFor(element) {
    if (element.tagName.toLowerCase() === "select") {
      return Array.from(element.selectedOptions).map((option) => option.value || option.text).join(", ");
    }
    if ("value" in element) return element.value || "";
    return "";
  }

  function labelFor(element) {
    if (element.labels?.length) {
      return cleanText(Array.from(element.labels).map((label) => label.innerText || label.textContent || "").join(" "));
    }

    const id = element.id;
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label) return cleanText(label.innerText || label.textContent || "");
    }

    return cleanText(element.getAttribute("aria-labelledby")?.split(/\s+/).map((labelId) => {
      const labelElement = document.getElementById(labelId);
      return labelElement?.innerText || labelElement?.textContent || "";
    }).join(" ") || "");
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
  }

  function firstNonEmpty(...values) {
    return values.map((value) => cleanText(value)).find(Boolean) || "";
  }
}

async function performAction(page, action) {
  if (!action || typeof action !== "object") {
    throw new Error("Action must be an object.");
  }

  if (Array.isArray(action.actions)) {
    for (const childAction of action.actions) {
      await performAction(page, childAction);
    }
    return;
  }

  switch (action.action) {
    case "goto":
      if (!action.url) throw new Error("goto requires url.");
      await page.goto(action.url, { waitUntil: action.waitUntil || "domcontentloaded" });
      return;
    case "click":
      await withTarget(page, action.target, (locator) => locator.click());
      return;
    case "type":
      await withTarget(page, action.target, (locator) => locator.pressSequentially(action.value || action.text || ""));
      return;
    case "fill":
      await withTarget(page, action.target, (locator) => locator.fill(action.value || ""));
      return;
    case "press":
      if (!action.key) throw new Error("press requires key.");
      if (action.target) {
        await withTarget(page, action.target, (locator) => locator.press(action.key));
      } else {
        await page.keyboard.press(action.key);
      }
      return;
    case "select":
      await withTarget(page, action.target, (locator) => locator.selectOption(action.value ?? action.values));
      return;
    case "hover":
      await withTarget(page, action.target, (locator) => locator.hover());
      return;
    case "scroll":
      await scrollPage(page, action);
      return;
    case "wait":
      await page.waitForTimeout(action.ms || 1000);
      return;
    default:
      throw new Error(`Unsupported action: ${action.action}`);
  }
}

async function withTarget(page, target, fn) {
  const locator = await resolveTarget(page, target);
  await fn(locator);
}

async function resolveTarget(page, target) {
  if (!target || typeof target !== "string") {
    throw new Error("A non-empty target is required.");
  }

  if (/^e\d+$/.test(target)) {
    const handle = await page.evaluateHandle((id) => {
      const element = window.__bfaElementById?.get(id);
      return element || null;
    }, target);

    const element = handle.asElement();
    if (!element) {
      await handle.dispose();
      throw new Error(`Could not find observed element id: ${target}`);
    }

    return locatorForElementHandle(page, element);
  }

  if (target.startsWith("css=")) return page.locator(target.slice(4)).first();
  if (target.startsWith("text=")) return page.getByText(target.slice(5), { exact: false }).first();
  if (target.startsWith("label=")) return page.getByLabel(target.slice(6), { exact: false }).first();
  if (target.startsWith("placeholder=")) return page.getByPlaceholder(target.slice(12), { exact: false }).first();
  if (target.startsWith("role=")) {
    const [role, ...nameParts] = target.slice(5).split(":");
    const name = nameParts.join(":");
    return page.getByRole(role, name ? { name, exact: false } : {}).first();
  }

  const candidates = [
    () => page.getByRole("button", { name: target, exact: false }).first(),
    () => page.getByRole("link", { name: target, exact: false }).first(),
    () => page.getByLabel(target, { exact: false }).first(),
    () => page.getByPlaceholder(target, { exact: false }).first(),
    () => page.getByText(target, { exact: false }).first(),
    () => page.locator(target).first()
  ];

  for (const makeLocator of candidates) {
    try {
      const locator = makeLocator();
      if (await locator.count()) return locator;
    } catch {
      // Try the next target strategy.
    }
  }

  throw new Error(`Could not find target: ${target}`);
}

function locatorForElementHandle(page, element) {
  return {
    click: (...args) => element.click(...args),
    fill: (...args) => element.fill(...args),
    press: (...args) => element.press(...args),
    pressSequentially: async (value) => {
      await element.focus();
      await page.keyboard.type(value);
    },
    selectOption: (...args) => element.selectOption(...args),
    hover: (...args) => element.hover(...args)
  };
}

async function scrollPage(page, action) {
  const dx = Number(action.x || 0);
  const dy = Number(action.y || action.pixels || 0);
  const direction = action.direction || "down";
  const amount = Number(action.amount || action.pixels || 600);

  if (dx || dy) {
    await page.mouse.wheel(dx, dy);
    return;
  }

  const byDirection = {
    down: [0, amount],
    up: [0, -amount],
    right: [amount, 0],
    left: [-amount, 0]
  };
  const [wheelX, wheelY] = byDirection[direction] || byDirection.down;
  await page.mouse.wheel(wheelX, wheelY);
}
