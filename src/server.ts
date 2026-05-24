import { exec } from "node:child_process";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { captureCurrentPage, preparePage } from "./capture.js";
import { captureScreenshot } from "./screenshot.js";
import { writeSvgPackage } from "./svg.js";
import type { CaptureMode, CaptureOptions } from "./types.js";
import { ensureCleanDir, sanitizeFilePart } from "./utils.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.WEB2SVG_PORT ?? 4782);

interface SessionState {
  context: BrowserContext;
  page: Page;
  options: CaptureOptions;
  captureCount: number;
  profileDir: string;
}

let session: SessionState | null = null;
let busy = false;
let lastCapture: Record<string, unknown> | null = null;

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function normalizeUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("URL is required.");
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function stringValue(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return !["false", "0", "off"].includes(value.toLowerCase());
  return fallback;
}

function screenshotDetail(value: unknown): "coarse" | "normal" | "detailed" {
  const detail = stringValue(value, "normal");
  return detail === "coarse" || detail === "detailed" ? detail : "normal";
}

function screenshotEngine(value: unknown): "fast" | "advanced" {
  return stringValue(value, "fast") === "advanced" ? "advanced" : "fast";
}

function makeOptions(body: Record<string, unknown>, url: string): CaptureOptions {
  const profileName = sanitizeFilePart(stringValue(body.profileName, "default"));
  const mode = stringValue(body.mode, "semantic") as CaptureMode;
  const outputRoot = path.resolve(rootDir, stringValue(body.outputRoot, "exports/current"));

  return {
    url,
    outDir: outputRoot,
    viewportWidth: numberValue(body.width, 1280),
    viewportHeight: numberValue(body.height, 720),
    scale: numberValue(body.scale, 3),
    fullPage: booleanValue(body.fullPage, false),
    maxLayers: numberValue(body.maxLayers, 100),
    minArea: numberValue(body.minArea, 2500),
    waitMs: 0,
    timeoutMs: numberValue(body.timeout, 45000),
    mode: mode === "dense" ? "dense" : "semantic",
    embed: booleanValue(body.embed, true),
    interactive: false,
    profileDir: path.resolve(rootDir, "profiles", profileName),
    flatOnly: true
  };
}

async function closeSession(): Promise<void> {
  if (!session) return;
  await session.context.close().catch(() => undefined);
  session = null;
}

async function openSession(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = normalizeUrl(body.url);
  const options = makeOptions(body, url);
  await closeSession();
  lastCapture = null;
  await mkdir(options.profileDir ?? path.resolve(rootDir, "profiles", "default"), { recursive: true });

  const context = await chromium.launchPersistentContext(options.profileDir ?? "", {
    headless: false,
    viewport: {
      width: options.viewportWidth,
      height: options.viewportHeight
    },
    deviceScaleFactor: options.scale,
    colorScheme: "light",
    reducedMotion: "reduce",
    args: [`--window-size=${options.viewportWidth},${options.viewportHeight}`]
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(options.timeoutMs);
  await installTargetCaptureBridge(page);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: options.timeoutMs }).catch(() => undefined);
  await preparePage(page);

  session = {
    context,
    page,
    options,
    captureCount: 0,
    profileDir: options.profileDir ?? ""
  };

  return {
    status: "ready",
    url: page.url(),
    title: await page.title(),
    profileDir: session.profileDir
  };
}

async function installTargetCaptureBridge(page: Page): Promise<void> {
  await page.exposeBinding("web2svgCaptureFromTarget", async () => {
    lastCapture = await captureSession();
  });

  await page.addInitScript(`
    (() => {
      const install = () => {
        window.addEventListener(
          "keydown",
          (event) => {
            if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "s") {
              event.preventDefault();
              event.stopPropagation();
              if (typeof window.web2svgCaptureFromTarget === "function") {
                window.web2svgCaptureFromTarget();
              }
            }
          },
          true
        );
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", install, { once: true });
      } else {
        install();
      }
    })();
  `);
}

async function captureSession(): Promise<Record<string, unknown>> {
  if (!session) throw new Error("Open a website first.");
  if (busy) throw new Error("A capture is already running.");
  busy = true;

  try {
    session.captureCount += 1;
    const currentUrl = session.page.url();
    const outDir = path.resolve(session.options.outDir);
    const layersDir = path.join(outDir, "layers");

    await ensureCleanDir(outDir);
    await mkdir(layersDir, { recursive: true });

    const options: CaptureOptions = {
      ...session.options,
      url: currentUrl,
      outDir
    };
    const result = await captureCurrentPage(session.page, layersDir, options);
    await writeSvgPackage(result, outDir, options.embed);

    return {
      status: "captured",
      outDir,
      layers: result.layers.length,
      ae: path.join(outDir, "web2svg_AE.jsx"),
      pptx: path.join(outDir, "web2svg_PPTX.pptx")
    };
  } finally {
    busy = false;
  }
}

async function captureScreenshotUpload(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (busy) throw new Error("A capture is already running.");
  busy = true;

  try {
    const outDir = path.resolve(rootDir, stringValue(body.outputRoot, "exports/current"));
    const imageData = String(body.imageData ?? "");
    if (!imageData) throw new Error("Screenshot image is required.");

    const result = await captureScreenshot({
      imageData,
      fileName: stringValue(body.fileName, "screenshot.png"),
      outDir,
      engine: screenshotEngine(body.engine),
      detail: screenshotDetail(body.detail),
      maxLayers: numberValue(body.maxLayers, 80),
      minArea: numberValue(body.minArea, 1800),
      cleanBackground: booleanValue(body.cleanBackground, false)
    });
    await writeSvgPackage(result, outDir, true);

    return {
      status: "captured",
      outDir,
      layers: result.layers.length,
      ae: path.join(outDir, "web2svg_AE.jsx"),
      pptx: path.join(outDir, "web2svg_PPTX.pptx")
    };
  } finally {
    busy = false;
  }
}

async function route(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);

  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderApp());
    return;
  }

  if (request.method === "GET" && url.pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    sendJson(response, 200, {
      hasSession: Boolean(session),
      busy,
      url: session?.page.url() ?? null,
      profileDir: session?.profileDir ?? null,
      captureCount: session?.captureCount ?? 0,
      lastCapture
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/open") {
    sendJson(response, 200, await openSession(await readBody(request)));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/capture") {
    lastCapture = await captureSession();
    sendJson(response, 200, lastCapture);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/screenshot") {
    lastCapture = await captureScreenshotUpload(await readBody(request));
    sendJson(response, 200, lastCapture);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/close") {
    await closeSession();
    sendJson(response, 200, { status: "closed" });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/reveal") {
    const outDir = typeof lastCapture?.outDir === "string" ? lastCapture.outDir : null;
    if (!outDir) throw new Error("No export folder yet.");
    if (process.platform === "win32") exec(`explorer "${outDir}"`);
    else if (process.platform === "darwin") exec(`open "${outDir}"`);
    else exec(`xdg-open "${outDir}"`);
    sendJson(response, 200, { status: "opened", outDir });
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

async function openControlPanel(url: string): Promise<void> {
  const profileDir = path.resolve(rootDir, "profiles", "__web2svg-panel");
  await mkdir(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: {
      width: 1280,
      height: 820
    },
    deviceScaleFactor: 1,
    colorScheme: "light",
    args: ["--window-size=1280,820"]
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url);
}

function renderApp(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Web2SVG</title>
  <style>
    :root {
      --canvas: #F9FAFB;
      --surface: #FFFFFF;
      --ink: #18181B;
      --secondary: #71717A;
      --muted: #94A3B8;
      --border: rgba(226,232,240,0.5);
      --accent: #3B82F6;
      --success: #10B981;
      --danger: #E11D48;
      --shadow: 0 -15px 40px rgba(0,0,0,0.05);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--canvas);
      color: var(--ink);
      font-family: Outfit, Satoshi, Geist, Arial, sans-serif;
    }
    .app {
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(320px, 0.92fr) minmax(420px, 1.08fr);
      gap: 2rem;
      padding: 2rem;
    }
    .panel, .activity {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 2rem;
      box-shadow: var(--shadow);
    }
    .panel {
      padding: 2rem;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }
    .brand {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 1rem;
    }
    h1 {
      margin: 0;
      font-size: clamp(2.25rem, 4vw, 4rem);
      line-height: 1.1;
      letter-spacing: -0.025em;
      font-weight: 900;
    }
    .status-pill {
      border: 1px solid var(--border);
      border-radius: 9999px;
      color: var(--secondary);
      padding: 0.5rem 0.75rem;
      white-space: nowrap;
      font-size: 0.875rem;
    }
    label {
      display: block;
      color: var(--secondary);
      font-size: 0.875rem;
      margin-bottom: 0.5rem;
    }
    input, select {
      width: 100%;
      min-height: 3rem;
      border: 1px solid var(--border);
      border-radius: 0.625rem;
      background: var(--canvas);
      color: var(--ink);
      padding: 0.75rem 1rem;
      font: inherit;
      outline: none;
    }
    input:focus, select:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 4px rgba(59,130,246,0.12);
    }
    input[type="file"] {
      padding: 0.65rem 1rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 1rem;
    }
    .divider {
      height: 1px;
      background: var(--border);
      margin: 0.25rem 0;
    }
    .block-title {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 1rem;
    }
    .block-title h2 {
      margin: 0;
      font-size: 1rem;
      line-height: 1.2;
    }
    .actions {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 1rem;
      margin-top: auto;
    }
    button {
      min-height: 3.25rem;
      border: 0;
      border-radius: 0.75rem;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
      transition: transform 180ms ease, opacity 180ms ease;
    }
    button:hover { transform: translateY(-1px); }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
      transform: none;
    }
    .primary {
      background: var(--accent);
      color: white;
    }
    .capture {
      background: var(--ink);
      color: white;
    }
    .secondary {
      background: var(--canvas);
      color: var(--ink);
      border: 1px solid var(--border);
    }
    .activity {
      padding: 1.5rem;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 1rem;
      min-height: calc(100vh - 4rem);
    }
    .activity-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    .activity h2 {
      margin: 0;
      font-size: 1.25rem;
      line-height: 1.2;
    }
    .log {
      overflow: auto;
      border-radius: 1.5rem;
      background: var(--canvas);
      border: 1px solid var(--border);
      padding: 1rem;
      font-family: "Geist Mono", "JetBrains Mono", Consolas, monospace;
      font-size: 0.875rem;
      line-height: 1.65;
      color: var(--secondary);
      white-space: pre-wrap;
    }
    .success { color: var(--success); }
    .danger { color: var(--danger); }
    .small {
      color: var(--muted);
      font-size: 0.875rem;
      line-height: 1.65;
      margin: 0;
      max-width: 65ch;
    }
    @media (max-width: 900px) {
      .app {
        grid-template-columns: 1fr;
        padding: 1rem;
      }
      .activity {
        min-height: 24rem;
      }
    }
  </style>
</head>
<body>
  <main class="app">
    <section class="panel">
      <div class="brand">
        <h1>Web2SVG</h1>
        <div id="status" class="status-pill">Idle</div>
      </div>

      <div>
        <label for="url">Website URL</label>
        <input id="url" placeholder="https://example.com" autocomplete="url" />
      </div>

      <div class="grid">
        <div>
          <label for="profile">Login Profile</label>
          <input id="profile" value="default" />
        </div>
        <div>
          <label for="output">Output Root</label>
          <input id="output" value="exports/current" />
        </div>
      </div>

      <div class="grid">
        <div>
          <label for="mode">Layer Mode</label>
          <select id="mode">
            <option value="semantic">Semantic</option>
            <option value="dense">Dense</option>
          </select>
        </div>
        <div>
          <label for="scale">Quality Scale</label>
          <select id="scale">
            <option value="3">4K from 1280</option>
            <option value="2">Large</option>
            <option value="1">Native</option>
          </select>
        </div>
      </div>

      <div class="grid">
        <div>
          <label for="width">Viewport Width</label>
          <input id="width" type="number" value="1280" min="800" step="10" />
        </div>
        <div>
          <label for="height">Viewport Height</label>
          <input id="height" type="number" value="720" min="600" step="10" />
        </div>
      </div>

      <label>
        <input id="fullPage" type="checkbox" style="width:auto;min-height:auto;margin-right:0.5rem" />
        Full page capture
      </label>

      <div class="actions">
        <button id="open" class="primary">Open Browser</button>
        <button id="capture" class="capture" disabled>Capture Now</button>
      </div>
      <div class="actions">
        <button id="reveal" class="secondary" disabled>Open Last Export</button>
        <button id="close" class="secondary">Close Browser</button>
      </div>

      <div class="divider"></div>

      <div class="block-title">
        <h2>Screenshot Mode</h2>
        <p class="small">Optional pixel-based layer split.</p>
      </div>

      <div>
        <label for="screenshot">Screenshot Image</label>
        <input id="screenshot" type="file" accept="image/png,image/jpeg,image/webp" />
      </div>

      <div class="grid">
        <div>
          <label for="shotEngine">Screenshot Engine</label>
          <select id="shotEngine">
            <option value="advanced">Advanced Local</option>
            <option value="fast">Fast Local</option>
          </select>
        </div>
        <div>
          <label for="shotDetail">Layer Detail</label>
          <select id="shotDetail">
            <option value="normal">Normal</option>
            <option value="coarse">Coarse</option>
            <option value="detailed">Detailed</option>
          </select>
        </div>
      </div>

      <div class="grid">
        <div>
          <label for="shotMaxLayers">Max Layers</label>
          <input id="shotMaxLayers" type="number" value="80" min="1" step="1" />
        </div>
        <div>
          <label for="shotMinArea">Min Area</label>
          <input id="shotMinArea" type="number" value="1800" min="100" step="100" />
        </div>
      </div>

      <label>
        <input id="shotCleanBg" type="checkbox" style="width:auto;min-height:auto;margin-right:0.5rem" />
        Clean background fill (experimental)
      </label>

      <button id="captureScreenshot" class="secondary">Capture Screenshot</button>
    </section>

    <section class="activity">
      <div class="activity-head">
        <h2>Session</h2>
        <p class="small">Login stays in the selected profile.</p>
      </div>
      <div id="log" class="log">Ready.</div>
    </section>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);
    const log = $("log");
    const status = $("status");
    const openButton = $("open");
    const captureButton = $("capture");
    const closeButton = $("close");
    const revealButton = $("reveal");
    const screenshotButton = $("captureScreenshot");

    function write(message, kind) {
      const line = document.createElement("div");
      line.textContent = "[" + new Date().toLocaleTimeString() + "] " + message;
      if (kind) line.className = kind;
      log.appendChild(line);
      log.scrollTop = log.scrollHeight;
    }

    function setBusy(value, label) {
      openButton.disabled = value;
      captureButton.disabled = value || captureButton.dataset.ready !== "true";
      closeButton.disabled = value;
      revealButton.disabled = value || revealButton.dataset.ready !== "true";
      screenshotButton.disabled = value;
      status.textContent = label || (value ? "Working" : "Ready");
    }

    function payload() {
      return {
        url: $("url").value,
        profileName: $("profile").value,
        outputRoot: $("output").value,
        mode: $("mode").value,
        scale: Number($("scale").value),
        width: Number($("width").value),
        height: Number($("height").value),
        fullPage: $("fullPage").checked
      };
    }

    async function post(url, body) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body || {})
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Request failed.");
        return data;
      } catch (error) {
        if (error instanceof TypeError) {
          throw new Error("Web2SVG app server is not reachable. Reopen Web2SVG.bat.");
        }
        throw error;
      }
    }

    function readScreenshotAsPng(file) {
      return new Promise((resolve, reject) => {
        if (!file) {
          reject(new Error("Choose a screenshot image first."));
          return;
        }

        const image = new Image();
        const objectUrl = URL.createObjectURL(file);
        image.onload = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Could not prepare screenshot canvas.");
            context.drawImage(image, 0, 0);
            resolve({
              dataUrl: canvas.toDataURL("image/png"),
              width: canvas.width,
              height: canvas.height
            });
          } catch (error) {
            reject(error);
          } finally {
            URL.revokeObjectURL(objectUrl);
          }
        };
        image.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          reject(new Error("Could not read the selected image."));
        };
        image.src = objectUrl;
      });
    }

    openButton.addEventListener("click", async () => {
      setBusy(true, "Opening");
      write("Opening browser...");
      try {
        const result = await post("/api/open", payload());
        seenCaptureCount = 0;
        revealButton.dataset.ready = "false";
        revealButton.disabled = true;
        captureButton.dataset.ready = "true";
        captureButton.disabled = false;
        status.textContent = "Browser Ready";
        write("Opened: " + result.url, "success");
        write("Profile: " + result.profileDir);
      } catch (error) {
        captureButton.dataset.ready = "false";
        status.textContent = "Error";
        write(error.message, "danger");
      } finally {
        openButton.disabled = false;
        closeButton.disabled = false;
      }
    });

    captureButton.addEventListener("click", async () => {
      setBusy(true, "Capturing");
      write("Capturing current browser state...");
      try {
        const result = await post("/api/capture");
        status.textContent = "Captured";
        write("Saved: " + result.outDir, "success");
        write("Layers: " + result.layers);
        if (result.pptx) write("PPTX: " + result.pptx, "success");
        if (result.ae) write("AE JSX: " + result.ae, "success");
        revealButton.dataset.ready = "true";
        revealButton.disabled = false;
      } catch (error) {
        status.textContent = "Error";
        write(error.message, "danger");
      } finally {
        setBusy(false, "Browser Ready");
      }
    });

    screenshotButton.addEventListener("click", async () => {
      setBusy(true, "Capturing");
      write("Preparing screenshot upload...");
      try {
        const file = $("screenshot").files && $("screenshot").files[0];
        const image = await readScreenshotAsPng(file);
        write("Screenshot loaded: " + image.width + "x" + image.height);
        write("Splitting screenshot into visual layers...");
        const result = await post("/api/screenshot", {
          imageData: image.dataUrl,
          fileName: file.name,
          outputRoot: $("output").value,
          engine: $("shotEngine").value,
          detail: $("shotDetail").value,
          maxLayers: Number($("shotMaxLayers").value),
          minArea: Number($("shotMinArea").value),
          cleanBackground: $("shotCleanBg").checked
        });
        status.textContent = "Captured";
        write("Saved: " + result.outDir, "success");
        write("Layers: " + result.layers);
        if (result.pptx) write("PPTX: " + result.pptx, "success");
        if (result.ae) write("AE JSX: " + result.ae, "success");
        revealButton.dataset.ready = "true";
        revealButton.disabled = false;
      } catch (error) {
        status.textContent = "Error";
        write(error.message, "danger");
      } finally {
        setBusy(false, captureButton.dataset.ready === "true" ? "Browser Ready" : "Ready");
      }
    });

    closeButton.addEventListener("click", async () => {
      setBusy(true, "Closing");
      try {
        await post("/api/close");
        captureButton.dataset.ready = "false";
        captureButton.disabled = true;
        revealButton.dataset.ready = "false";
        revealButton.disabled = true;
        status.textContent = "Idle";
        write("Browser closed.");
      } catch (error) {
        write(error.message, "danger");
      } finally {
        openButton.disabled = false;
        closeButton.disabled = false;
      }
    });

    revealButton.addEventListener("click", async () => {
      try {
        const result = await post("/api/reveal");
        write("Opened folder: " + result.outDir);
      } catch (error) {
        write(error.message, "danger");
      }
    });

    let seenCaptureCount = 0;
    setInterval(async () => {
      try {
        const response = await fetch("/api/status");
        const data = await response.json();
        if (data.captureCount > seenCaptureCount) {
          seenCaptureCount = data.captureCount;
          if (data.lastCapture && data.lastCapture.outDir) {
            write("Saved: " + data.lastCapture.outDir, "success");
            write("Layers: " + data.lastCapture.layers);
            if (data.lastCapture.pptx) write("PPTX: " + data.lastCapture.pptx, "success");
            if (data.lastCapture.ae) write("AE JSX: " + data.lastCapture.ae, "success");
            revealButton.dataset.ready = "true";
            revealButton.disabled = false;
            status.textContent = "Captured";
          }
        }
      } catch {}
    }, 1800);
  </script>
</body>
</html>`;
}

const server = http.createServer((request, response) => {
  route(request, response).catch((error) => {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`Web2SVG app is running at ${url}`);
  if (process.env.WEB2SVG_NO_AUTO_OPEN !== "1") {
    openControlPanel(url).catch((error) => {
      console.error(`Could not open Chromium control panel: ${error instanceof Error ? error.message : String(error)}`);
      console.log(`Open manually: ${url}`);
    });
  }
});
