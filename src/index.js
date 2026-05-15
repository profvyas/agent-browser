import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const DEFAULT_VIEWPORT = { width: 1365, height: 900 };
const MAX_RECENT_EVENTS = 40;
const MAX_DOWNLOAD_EVENTS = 20;
const REDACTED_ACTION_FIELDS = new Set(["value", "values", "text", "password", "token", "secret"]);
const BUILT_IN_POLICIES = {
  open: { allowedOrigins: ["*"] },
  local: { allowedOrigins: ["http://localhost:*", "http://127.0.0.1:*", "file://*"] }
};

export class BrowserActionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BrowserActionError";
    this.code = details.code || "BFA_ACTION_FAILED";
    this.action = details.action;
    this.actionIndex = details.actionIndex;
    this.cause = details.cause;
  }

  toJSON() {
    return serializeError(this);
  }
}

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
    this.downloadEvents = [];
    this.latestScreenshotPath = "";
  }

  async start() {
    if (this.context) return this;

    ensureDir(this.options.homeDir);
    ensureDir(this.options.profileDir);
    ensureDir(this.options.downloadsDir);
    ensureDir(this.options.screenshotsDir);

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
    this.context.on("page", (page) => {
      page.setDefaultTimeout(this.options.defaultTimeoutMs);
      this.attachPageListeners(page);
    });
    return this;
  }

  async open(url) {
    await this.ensureStarted();
    assertUrlAllowed(url, this.options.allowedOrigins);
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    await this.saveStorageState();
    return this.page;
  }

  async observe(url) {
    await this.ensureStarted();
    if (url) {
      assertUrlAllowed(url, this.options.allowedOrigins);
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
    }

    if (this.options.observeScreenshots) {
      await this.screenshot({ name: "observe", fullPage: this.options.observeScreenshotFullPage });
    }

    const observation = await buildObservation(this.page, {
      networkEvents: this.networkEvents,
      consoleEvents: this.consoleEvents,
      downloadEvents: this.downloadEvents,
      latestScreenshotPath: this.latestScreenshotPath
    });
    observation.pages = await this.describePages();

    ensureDir(path.dirname(this.options.latestObservationPath));
    fs.writeFileSync(this.options.latestObservationPath, `${JSON.stringify(observation, null, 2)}\n`);
    await this.saveStorageState();
    return observation;
  }

  async act(input) {
    await this.ensureStarted();
    const actions = Array.isArray(input?.actions) ? input.actions : [input];

    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      const action = actions[actionIndex];
      this.writeAuditEvent("action:start", { actionIndex, action });
      try {
        await performAction(this.page, action, this);
        this.writeAuditEvent("action:finish", { actionIndex, action });
      } catch (error) {
        const wrapped = error instanceof BrowserActionError
          ? error
          : new BrowserActionError(error.message, { action, actionIndex, cause: error });
        this.writeAuditEvent("action:error", { actionIndex, action, error: serializeError(wrapped) });
        throw wrapped;
      }
    }

    return this.observe();
  }

  async status() {
    return readStatus(this.options);
  }

  async screenshot(options = {}) {
    await this.ensureStarted();
    const fileName = screenshotFileName(options.name);
    const screenshotPath = path.join(this.options.screenshotsDir, fileName);
    await this.page.screenshot({
      path: screenshotPath,
      fullPage: Boolean(options.fullPage)
    });
    this.latestScreenshotPath = screenshotPath;
    return {
      path: screenshotPath,
      fullPage: Boolean(options.fullPage)
    };
  }

  async newPage(url) {
    await this.ensureStarted();
    if (url) assertUrlAllowed(url, this.options.allowedOrigins);
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.options.defaultTimeoutMs);
    this.attachPageListeners(this.page);
    if (url) {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
    }
    return this.page;
  }

  async switchPage(selector = {}) {
    await this.ensureStarted();
    const pages = this.context.pages();
    const index = selector.index !== undefined ? Number(selector.index) : undefined;

    if (Number.isInteger(index)) {
      if (!pages[index]) throw new Error(`No page at index ${index}.`);
      this.page = pages[index];
      return this.page;
    }

    if (selector.url || selector.title) {
      for (const page of pages) {
        const title = await page.title().catch(() => "");
        const url = page.url();
        if ((selector.url && url.includes(selector.url)) || (selector.title && title.includes(selector.title))) {
          this.page = page;
          return this.page;
        }
      }
    }

    throw new Error("switchPage requires a matching index, url, or title.");
  }

  async closePage(selector = {}) {
    await this.ensureStarted();
    const page = selector.index !== undefined || selector.url || selector.title
      ? await this.switchPage(selector)
      : this.page;
    await page.close();
    this.page = this.context.pages()[0] || await this.context.newPage();
    return this.page;
  }

  async describePages() {
    if (!this.context) return [];
    const pages = this.context.pages();
    return Promise.all(pages.map(async (page, index) => ({
      index,
      active: page === this.page,
      url: page.url(),
      title: await page.title().catch(() => "")
    })));
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

    page.on("download", async (download) => {
      const suggested = download.suggestedFilename();
      const fileName = uniqueArtifactName(suggested || "download");
      const downloadPath = path.join(this.options.downloadsDir, fileName);

      try {
        await download.saveAs(downloadPath);
        this.pushDownloadEvent({
          url: download.url(),
          suggestedFilename: suggested,
          path: downloadPath
        });
      } catch (error) {
        this.pushDownloadEvent({
          url: download.url(),
          suggestedFilename: suggested,
          path: downloadPath,
          failed: true,
          error: error.message
        });
      }
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

  pushDownloadEvent(event) {
    this.downloadEvents.push(event);
    this.downloadEvents = this.downloadEvents.slice(-MAX_DOWNLOAD_EVENTS);
  }

  writeAuditEvent(type, details = {}) {
    if (!this.options.auditEnabled || !this.options.auditLogPath) return;

    ensureDir(path.dirname(this.options.auditLogPath));
    const event = {
      ts: new Date().toISOString(),
      type,
      page: this.page?.url?.() || "",
      ...details,
      action: details.action ? redactAction(details.action, this.options.redactAction) : undefined
    };
    fs.appendFileSync(this.options.auditLogPath, `${JSON.stringify(removeUndefined(event))}\n`);
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
    screenshots: options.screenshotsDir,
    latestObservation: options.latestObservationPath,
    auditLog: options.auditLogPath,
    auditEnabled: options.auditEnabled,
    profileName: options.profileName,
    profileRoot: options.profileRoot,
    policyName: options.policyName,
    policyFile: options.policyFile,
    allowedOrigins: options.allowedOrigins,
    savedStateExists: stateExists,
    savedCookies: cookieCount,
    savedOrigins: originCount
  };
}

function normalizeOptions(options) {
  const policyOptions = loadPolicyOptions(options);
  const merged = { ...policyOptions, ...options };
  const homeDir = path.resolve(expandHome(merged.homeDir || process.env.BFA_HOME || "~/.browser-for-agents"));
  const profileName = merged.profileName || process.env.BFA_PROFILE || "";
  const profileRoot = profileName ? path.join(homeDir, "profiles", safeName(profileName)) : homeDir;
  const allowedOrigins = normalizeAllowedOrigins(merged.allowedOrigins || process.env.BFA_ALLOWED_ORIGINS);
  return {
    homeDir,
    profileName,
    profileRoot,
    policyName: merged.policyName || process.env.BFA_POLICY || "",
    policyFile: merged.policyFile || process.env.BFA_POLICY_FILE || "",
    profileDir: path.resolve(merged.profileDir || path.join(profileRoot, "profile")),
    storageStatePath: path.resolve(merged.storageStatePath || path.join(profileRoot, "storage-state.json")),
    downloadsDir: path.resolve(merged.downloadsDir || path.join(profileRoot, "downloads")),
    screenshotsDir: path.resolve(merged.screenshotsDir || path.join(profileRoot, "screenshots")),
    latestObservationPath: path.resolve(merged.latestObservationPath || path.join(profileRoot, "latest-observation.json")),
    auditLogPath: path.resolve(merged.auditLogPath || path.join(profileRoot, "audit.jsonl")),
    auditEnabled: merged.auditEnabled ?? process.env.BFA_AUDIT_DISABLED !== "1",
    redactAction: typeof merged.redactAction === "function" ? merged.redactAction : undefined,
    executablePath: merged.executablePath || process.env.BFA_BROWSER_EXE,
    browserChannel: merged.browserChannel || "chrome",
    headless: merged.headless ?? process.env.BFA_HEADLESS === "1",
    defaultTimeoutMs: merged.defaultTimeoutMs || 30000,
    viewport: merged.viewport || DEFAULT_VIEWPORT,
    observeScreenshots: merged.observeScreenshots ?? process.env.BFA_OBSERVE_SCREENSHOTS === "1",
    observeScreenshotFullPage: merged.observeScreenshotFullPage ?? process.env.BFA_OBSERVE_SCREENSHOT_FULL_PAGE === "1",
    allowedOrigins
  };
}

function loadPolicyOptions(options) {
  const policyName = options.policyName || process.env.BFA_POLICY || "";
  const policyFile = options.policyFile || process.env.BFA_POLICY_FILE || "";
  const builtIn = policyName ? BUILT_IN_POLICIES[policyName] : undefined;

  if (policyName && !builtIn) {
    throw new Error(`Unknown policy preset: ${policyName}`);
  }

  if (!policyFile) return builtIn || {};

  const parsed = JSON.parse(fs.readFileSync(path.resolve(expandHome(policyFile)), "utf8"));
  return { ...(builtIn || {}), ...parsed };
}

function normalizeAllowedOrigins(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  return raw
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry === "*") return entry;
      if (entry.includes("*")) return entry;
      try {
        return new URL(entry).origin;
      } catch {
        return new URL(`https://${entry}`).origin;
      }
    });
}

function assertUrlAllowed(url, allowedOrigins = []) {
  if (!allowedOrigins.length || allowedOrigins.includes("*")) return;

  const origin = new URL(url).origin;
  if (!allowedOrigins.some((allowedOrigin) => originMatches(origin, allowedOrigin))) {
    throw new Error(`Navigation blocked by allowed origins policy: ${origin}`);
  }
}

function originMatches(origin, pattern) {
  if (pattern === "*") return true;
  if (pattern === origin) return true;
  if (!pattern.includes("*")) return false;
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`).test(origin);
}

function expandHome(value) {
  if (!value || !value.startsWith("~")) return value;
  return path.join(os.homedir(), value.slice(1));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(value) {
  return String(value || "default").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "default";
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
    state: pageData.state,
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
    downloads: {
      count: events.downloadEvents.length,
      recent: events.downloadEvents.slice(-10)
    },
    artifacts: {
      latestScreenshot: events.latestScreenshotPath || ""
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
    state: {
      activeElement: describeActiveElement(),
      scroll: {
        x: Math.round(window.scrollX),
        y: Math.round(window.scrollY),
        maxX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight
      }
    },
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
    const type = (element.getAttribute("type") || "").toLowerCase();
    const actions = ["click", "hover"];
    if (["textbox", "searchbox"].includes(role) || element.isContentEditable) {
      actions.push("fill", "type", "press");
    }
    if (tagName === "input" && type === "file") {
      actions.push("upload", "setInputFiles");
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

  function describeActiveElement() {
    const element = document.activeElement;
    if (!element || element === document.body || element === document.documentElement) {
      return null;
    }

    return {
      tagName: element.tagName.toLowerCase(),
      role: roleFor(element),
      name: firstNonEmpty(
        element.getAttribute("aria-label"),
        labelFor(element),
        element.getAttribute("name"),
        element.getAttribute("placeholder"),
        element.getAttribute("title"),
        element.innerText || element.textContent || ""
      )
    };
  }
}

async function performAction(page, action, browser) {
  if (!action || typeof action !== "object") {
    throw new Error("Action must be an object.");
  }

  if (Array.isArray(action.actions)) {
    for (const childAction of action.actions) {
      await performAction(page, childAction, browser);
    }
    return;
  }

  switch (action.action) {
    case "goto":
      if (!action.url) throw new Error("goto requires url.");
      assertUrlAllowed(action.url, browser?.options.allowedOrigins);
      await page.goto(action.url, { waitUntil: action.waitUntil || "domcontentloaded", timeout: actionTimeout(action) });
      return;
    case "click":
      await withTarget(page, action.target, (locator) => locator.click({ timeout: actionTimeout(action) }));
      return;
    case "type":
      await withTarget(page, action.target, (locator) => locator.pressSequentially(action.value || action.text || "", { timeout: actionTimeout(action) }));
      return;
    case "fill":
      await withTarget(page, action.target, (locator) => locator.fill(action.value || "", { timeout: actionTimeout(action) }));
      return;
    case "press":
      if (!action.key) throw new Error("press requires key.");
      if (action.target) {
        await withTarget(page, action.target, (locator) => locator.press(action.key, { timeout: actionTimeout(action) }));
      } else {
        await page.keyboard.press(action.key, { timeout: actionTimeout(action) });
      }
      return;
    case "select":
      await withTarget(page, action.target, (locator) => locator.selectOption(action.value ?? action.values, { timeout: actionTimeout(action) }));
      return;
    case "hover":
      await withTarget(page, action.target, (locator) => locator.hover({ timeout: actionTimeout(action) }));
      return;
    case "upload":
    case "setInputFiles":
      await uploadFiles(page, action);
      return;
    case "scroll":
      await scrollPage(page, action);
      return;
    case "wait":
      await waitFor(page, action);
      return;
    case "screenshot":
      await browser.screenshot(action);
      return;
    case "newPage":
    case "openPage":
      await browser.newPage(action.url);
      return;
    case "switchPage":
      await browser.switchPage(action);
      return;
    case "closePage":
      await browser.closePage(action);
      return;
    default:
      throw new Error(`Unsupported action: ${action.action}`);
  }
}

function actionTimeout(action) {
  return action.timeoutMs || action.timeout || undefined;
}

async function waitFor(page, action) {
  const timeout = action.timeoutMs || action.timeout || undefined;

  if (action.selector) {
    await page.locator(action.selector).first().waitFor({ state: action.state || "visible", timeout });
    return;
  }

  if (action.target) {
    const locator = await resolveTarget(page, action.target);
    await locator.waitFor?.({ state: action.state || "visible", timeout });
    return;
  }

  if (action.text) {
    await page.getByText(action.text, { exact: Boolean(action.exact) }).first().waitFor({ timeout });
    return;
  }

  if (action.url) {
    await page.waitForURL(action.url, { timeout });
    return;
  }

  if (action.loadState) {
    await page.waitForLoadState(action.loadState, { timeout });
    return;
  }

  await page.waitForTimeout(action.ms || 1000);
}

async function uploadFiles(page, action) {
  if (!action.target) throw new Error(`${action.action} requires target.`);
  const files = action.path || action.paths || action.files || action.file;
  if (!files) throw new Error(`${action.action} requires path, paths, file, or files.`);
  const normalized = Array.isArray(files) ? files.map(resolveFilePath) : resolveFilePath(files);
  await withTarget(page, action.target, (locator) => locator.setInputFiles(normalized, { timeout: actionTimeout(action) }));
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
    waitFor: (...args) => element.waitForElementState("visible", ...args),
    pressSequentially: async (value) => {
      await element.focus();
      await page.keyboard.type(value);
    },
    selectOption: (...args) => element.selectOption(...args),
    hover: (...args) => element.hover(...args),
    setInputFiles: (...args) => element.setInputFiles(...args)
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

function screenshotFileName(name) {
  if (name) return uniqueArtifactName(name.endsWith(".png") ? name : `${name}.png`);
  return uniqueArtifactName("screenshot.png");
}

function uniqueArtifactName(name) {
  const parsed = path.parse(name);
  const safeBase = (parsed.name || "artifact").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
  const safeExt = parsed.ext || "";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${safeBase}${safeExt}`;
}

function resolveFilePath(filePath) {
  return path.resolve(expandHome(String(filePath)));
}

function redactAction(action, customRedactor) {
  if (customRedactor) return customRedactor(action);
  return redactValue(action);
}

function redactValue(value, key = "") {
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, key));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactValue(entryValue, entryKey)
    ]));
  }

  if (REDACTED_ACTION_FIELDS.has(key) || /password|token|secret/i.test(key)) {
    return "[redacted]";
  }

  return value;
}

export function serializeError(error) {
  return removeUndefined({
    name: error.name || "Error",
    code: error.code,
    message: error.message,
    actionIndex: error.actionIndex,
    action: error.action ? redactAction(error.action) : undefined
  });
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined));
}
