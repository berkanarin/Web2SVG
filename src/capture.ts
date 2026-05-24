import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { PNG } from "pngjs";
import type { CaptureOptions, CaptureResult, LayerAsset, LayerCandidate } from "./types.js";
import { ensureCleanDir, sanitizeFilePart } from "./utils.js";

interface PngSize {
  width: number;
  height: number;
}

interface TrimmedPng {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function captureSite(options: CaptureOptions): Promise<CaptureResult> {
  const outDir = path.resolve(options.outDir);
  const layersDir = path.join(outDir, "layers");
  await ensureCleanDir(outDir);
  await mkdir(layersDir, { recursive: true });

  const viewport = {
    width: options.viewportWidth,
    height: options.viewportHeight
  };
  let browser: Browser | null = null;
  let context: BrowserContext;

  if (options.profileDir) {
    await mkdir(path.resolve(options.profileDir), { recursive: true });
    context = await chromium.launchPersistentContext(path.resolve(options.profileDir), {
      headless: !options.interactive,
      viewport,
      deviceScaleFactor: options.scale,
      colorScheme: "light",
      reducedMotion: "reduce"
    });
  } else {
    browser = await chromium.launch({ headless: !options.interactive });
    context = await browser.newContext({
      viewport,
      deviceScaleFactor: options.scale,
      colorScheme: "light",
      reducedMotion: "reduce"
    });
  }

  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(options.timeoutMs);

  try {
    const interactiveSignal = options.interactive ? await installInteractiveControls(page) : null;

    await page.goto(options.url, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs
    });
    await page.waitForLoadState("networkidle", { timeout: options.timeoutMs }).catch(() => undefined);

    if (options.waitMs > 0) {
      await page.waitForTimeout(options.waitMs);
    }

    await preparePage(page);
    await page.evaluate(() => window.scrollTo(0, 0));

    if (interactiveSignal) {
      console.log("Interactive mode is ready.");
      console.log("Use the browser normally, then press Ctrl+Shift+S in the page to capture the current state.");
      console.log("Keep the mouse over hover menus while pressing the shortcut.");
      await interactiveSignal;
      await page.evaluate(() => document.getElementById("web2svg-hud")?.remove());
      await page.waitForTimeout(100);
    }

    return await captureCurrentPage(page, layersDir, options);
  } finally {
    await context.close();
    await browser?.close();
  }
}

export async function captureCurrentPage(
  page: Page,
  layersDir: string,
  options: CaptureOptions
): Promise<CaptureResult> {
  const title = await page.title();
  const url = page.url();
  const pageCssHeight = await page.evaluate(() => {
    const body = document.body;
    const html = document.documentElement;
    return Math.max(
      body?.scrollHeight ?? 0,
      body?.offsetHeight ?? 0,
      html.scrollHeight,
      html.offsetHeight,
      html.clientHeight
    );
  });

  const captureCssHeight = options.fullPage ? pageCssHeight : options.viewportHeight;
  const candidates = await collectCandidates(page, options, captureCssHeight);
  if (candidates.length > 0) {
    await markSelectedLayers(page, candidates.map((candidate) => candidate.id));
  }
  const background = await captureBackground(page, layersDir, options, "full");
  const cleanBackground =
    candidates.length > 0 ? await captureBackground(page, layersDir, options, "clean") : undefined;
  const layers = candidates.length > 0 ? await captureLayers(page, layersDir, candidates, options) : [];

  return {
    url,
    title,
    capturedAt: new Date().toISOString(),
    viewport: {
      cssWidth: options.viewportWidth,
      cssHeight: options.viewportHeight,
      scale: options.scale,
      svgWidth: options.viewportWidth * options.scale,
      svgHeight: captureCssHeight * options.scale,
      pageCssHeight
    },
    background: {
      fileName: background.fileName,
      width: background.width,
      height: options.fullPage ? background.height : options.viewportHeight * options.scale
    },
    cleanBackground: cleanBackground
      ? {
          fileName: cleanBackground.fileName,
          width: cleanBackground.width,
          height: options.fullPage ? cleanBackground.height : options.viewportHeight * options.scale
        }
      : undefined,
    layers
  };
}

async function installInteractiveControls(page: Page): Promise<Promise<void>> {
  let resolveCapture: () => void;
  const signal = new Promise<void>((resolve) => {
    resolveCapture = resolve;
  });

  await page.exposeBinding("web2svgCapture", () => {
    resolveCapture();
  });

  await page.addInitScript(`
    (() => {
    const install = () => {
      if (document.getElementById("web2svg-hud")) return;

      const hud = document.createElement("div");
      hud.id = "web2svg-hud";
      hud.textContent = "Web2SVG: Ctrl+Shift+S captures this state";
      hud.setAttribute("aria-hidden", "true");
      hud.style.cssText = [
        "position:fixed",
        "left:16px",
        "bottom:16px",
        "z-index:2147483647",
        "padding:10px 12px",
        "border-radius:10px",
        "background:rgba(24,24,27,0.88)",
        "color:#fff",
        "font:13px/1.4 system-ui,sans-serif",
        "box-shadow:0 10px 30px rgba(0,0,0,0.18)",
        "pointer-events:none"
      ].join(";");
      document.documentElement.appendChild(hud);

      window.addEventListener(
        "keydown",
        (event) => {
          if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "s") {
            event.preventDefault();
            event.stopPropagation();
            hud.textContent = "Web2SVG: capturing...";
            if (typeof window.web2svgCapture === "function") {
              window.web2svgCapture();
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

  return signal;
}

export async function preparePage(page: Page): Promise<void> {
  await page.evaluate(
    "Object.defineProperty(globalThis, '__name', { value: (fn) => fn, configurable: true })"
  );

  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        scroll-behavior: auto !important;
      }
      html {
        scroll-behavior: auto !important;
      }
    `
  });

  await page.evaluate(() => {
    for (const video of Array.from(document.querySelectorAll("video"))) {
      video.pause();
    }
  });
}

async function collectCandidates(
  page: Page,
  options: CaptureOptions,
  captureCssHeight: number
): Promise<LayerCandidate[]> {
  return page.evaluate(
    ({ mode, minArea, maxLayers, captureCssHeight, splitRepeatedItems }) => {
      const semanticTags = new Set([
        "HEADER",
        "NAV",
        "MAIN",
        "SECTION",
        "ARTICLE",
        "ASIDE",
        "FOOTER",
        "FORM",
        "DIALOG"
      ]);
      const roleHints = new Set([
        "banner",
        "navigation",
        "main",
        "contentinfo",
        "complementary",
        "dialog",
        "menu",
        "menubar",
        "toolbar",
        "tablist",
        "list",
        "listitem"
      ]);
      const nameHint = /(header|nav|menu|hero|section|card|panel|grid|list|footer|sidebar|banner|toolbar|modal|drawer|block|content|feature|pricing|cta|gallery|slider|carousel)/i;
      const mediaTags = new Set(["IMG", "PICTURE", "VIDEO", "CANVAS", "SVG"]);
      const textTags = new Set(["H1", "H2", "H3", "P", "A", "BUTTON"]);
      const candidates: Array<LayerCandidate & { score: number }> = [];
      const all = Array.from(document.body?.querySelectorAll<HTMLElement>("*") ?? []);
      const splitItemElements = new WeakSet<HTMLElement>();
      let domIndex = 0;

      function visibleBox(element: HTMLElement): DOMRect | null {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number.parseFloat(style.opacity || "1") <= 0 ||
          rect.width < 12 ||
          rect.height < 12 ||
          rect.width * rect.height < minArea ||
          rect.left + rect.width <= 0 ||
          rect.left >= window.innerWidth ||
          rect.top + rect.height <= 0 ||
          rect.top >= captureCssHeight
        ) {
          return null;
        }

        return rect;
      }

      function selectorFor(element: HTMLElement): string {
        const tag = element.tagName.toLowerCase();
        if (element.id) return `${tag}#${CSS.escape(element.id)}`;
        const classPart = Array.from(element.classList)
          .slice(0, 3)
          .map((item) => `.${CSS.escape(item)}`)
          .join("");
        const parent = element.parentElement;
        if (!parent) return tag + classPart;
        const sameTag = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
        const nth = sameTag.length > 1 ? `:nth-of-type(${sameTag.indexOf(element) + 1})` : "";
        return `${tag}${classPart}${nth}`;
      }

      function labelFor(element: HTMLElement, tag: string, role: string | null, reason: string): string {
        const textHint = reason === "split-item" ? element.innerText?.trim().slice(0, 64) : "";
        const source =
          element.getAttribute("aria-label") ||
          element.id ||
          Array.from(element.classList).find((item) => nameHint.test(item)) ||
          textHint ||
          role ||
          reason ||
          tag.toLowerCase();
        return source
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 64);
      }

      function depthOf(element: HTMLElement): number {
        let depth = 0;
        let cursor: HTMLElement | null = element;
        while (cursor?.parentElement) {
          depth += 1;
          cursor = cursor.parentElement;
        }
        return depth;
      }

      if (splitRepeatedItems) {
        for (const parent of all) {
          const children = Array.from(parent.children).filter(
            (child): child is HTMLElement => child instanceof HTMLElement
          );
          if (children.length < 3) continue;

          const visibleChildren = children
            .map((child) => ({ child, rect: visibleBox(child) }))
            .filter((item): item is { child: HTMLElement; rect: DOMRect } => Boolean(item.rect));
          if (visibleChildren.length < 3) continue;

          const groups = new Map<string, Array<{ child: HTMLElement; rect: DOMRect }>>();
          for (const item of visibleChildren) {
            const key = [
              Math.round(item.rect.width / 24),
              Math.round(item.rect.height / 24),
              Math.round(item.rect.top / 24)
            ].join(":");
            const group = groups.get(key) ?? [];
            group.push(item);
            groups.set(key, group);
          }

          for (const group of groups.values()) {
            if (group.length < 3) continue;
            for (const item of group) {
              splitItemElements.add(item.child);
              const fillChild = item.child.querySelector<HTMLElement>("a, button, [role='button'], [role='link']");
              if (fillChild) {
                const fillRect = fillChild.getBoundingClientRect();
                const similarSize =
                  Math.abs(fillRect.width - item.rect.width) <= 8 &&
                  Math.abs(fillRect.height - item.rect.height) <= 8;
                if (similarSize) splitItemElements.add(fillChild);
              }
            }
          }
        }
      }

      for (const element of all) {
        domIndex += 1;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const width = Math.round(rect.width * 100) / 100;
        const height = Math.round(rect.height * 100) / 100;
        const area = width * height;
        const x = rect.left;
        const y = rect.top;
        const role = element.getAttribute("role");
        const classAndId = `${element.id} ${element.className}`;
        const zIndex = Number.parseInt(style.zIndex || "0", 10);
        const normalizedZ = Number.isFinite(zIndex) ? zIndex : 0;
        const tag = element.tagName;

        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number.parseFloat(style.opacity || "1") <= 0 ||
          width < 12 ||
          height < 12 ||
          area < minArea ||
          x + width <= 0 ||
          x >= window.innerWidth ||
          y + height <= 0 ||
          y >= captureCssHeight
        ) {
          continue;
        }

        const isSemanticTag = semanticTags.has(tag);
        const isRoleHint = role ? roleHints.has(role) : false;
        const isNameHint = nameHint.test(classAndId);
        const isMedia = mediaTags.has(tag);
        const isText = mode === "dense" && textTags.has(tag) && Boolean(element.innerText?.trim());
        const isLargeBlock = tag === "DIV" && element.children.length > 0 && area >= minArea * 8;
        const isInteractive =
          mode === "dense" && Boolean(element.closest("a, button")) && area >= minArea * 2;
        const isFloating = style.position === "fixed" || style.position === "sticky";
        const hasPaint = style.backgroundImage !== "none" || style.boxShadow !== "none";
        const isSplitItem = splitRepeatedItems && splitItemElements.has(element);
        const includeDense = mode === "dense" && (area >= minArea * 2 || isMedia || isInteractive || isText);
        const includeSemantic =
          isSemanticTag ||
          isRoleHint ||
          isNameHint ||
          isMedia ||
          isText ||
          isLargeBlock ||
          isFloating ||
          hasPaint ||
          isSplitItem ||
          isInteractive;

        if (!includeSemantic && !includeDense) continue;

        let reason = "dense";
        if (isFloating) reason = "floating";
        else if (isSemanticTag) reason = "semantic";
        else if (isRoleHint) reason = "role";
        else if (isNameHint) reason = "name";
        else if (isMedia) reason = "media";
        else if (isText) reason = "text";
        else if (isSplitItem) reason = "split-item";
        else if (isLargeBlock) reason = "block";
        else if (hasPaint) reason = "paint";
        else if (isInteractive) reason = "interactive";

        const depth = depthOf(element);
        const score =
          (isFloating ? 80 : 0) +
          (isSemanticTag ? 60 : 0) +
          (isRoleHint ? 45 : 0) +
          (isNameHint ? 35 : 0) +
          (isMedia ? 30 : 0) +
          (isText ? 25 : 0) +
          (isSplitItem ? 70 : 0) +
          (isLargeBlock ? 20 : 0) +
          (hasPaint ? 15 : 0) +
          Math.min(40, area / 20000) +
          Math.min(20, Math.max(0, normalizedZ));
        const id = `w2s-${domIndex}`;
        element.setAttribute("data-web2svg-id", id);

        candidates.push({
          id,
          tag,
          selector: selectorFor(element),
          label: labelFor(element, tag, role, reason),
          role,
          x,
          y,
          width,
          height,
          zIndex: normalizedZ,
          domIndex,
          depth,
          position: style.position,
          opacity: Number.parseFloat(style.opacity || "1"),
          reason,
          score
        });
      }

      const deduped = new Map<string, LayerCandidate & { score: number }>();
      for (const candidate of candidates) {
        const key = [
          Math.round(candidate.x / 4),
          Math.round(candidate.y / 4),
          Math.round(candidate.width / 4),
          Math.round(candidate.height / 4)
        ].join(":");
        const current = deduped.get(key);
        if (!current || candidate.score > current.score || candidate.depth < current.depth) {
          deduped.set(key, candidate);
        }
      }

      function contains(parent: LayerCandidate, child: LayerCandidate): boolean {
        if (parent.id === child.id) return false;
        return (
          child.x >= parent.x - 2 &&
          child.y >= parent.y - 2 &&
          child.x + child.width <= parent.x + parent.width + 2 &&
          child.y + child.height <= parent.y + parent.height + 2
        );
      }

      function keepsDescendants(candidate: LayerCandidate): boolean {
        return (
          ["HEADER", "NAV", "ASIDE", "FOOTER"].includes(candidate.tag) ||
          /(sidebar|header|nav|menu|topbar|toolbar|breadcrumb)/i.test(candidate.label) ||
          candidate.role === "navigation" ||
          candidate.role === "banner"
        );
      }

      function isHugeGeneric(candidate: LayerCandidate): boolean {
        const viewportArea = window.innerWidth * window.innerHeight;
        return (
          ["DIV", "MAIN", "SECTION"].includes(candidate.tag) &&
          candidate.width * candidate.height > viewportArea * 0.42 &&
          !keepsDescendants(candidate)
        );
      }

      const ranked = Array.from(deduped.values()).sort(
        (a, b) => b.score - a.score || a.domIndex - b.domIndex
      );
      const pruned: Array<LayerCandidate & { score: number }> = [];

      for (const candidate of ranked) {
        const containsManyCandidates =
          ranked.filter((other) => contains(candidate, other)).length >= 2;
        if (isHugeGeneric(candidate) && containsManyCandidates) {
          continue;
        }

        const keptContainer = pruned.find((parent) => keepsDescendants(parent) && contains(parent, candidate));
        if (keptContainer) {
          continue;
        }

        pruned.push(candidate);
      }

      return pruned
        .sort((a, b) => b.score - a.score || a.domIndex - b.domIndex)
        .slice(0, maxLayers)
        .sort((a, b) => a.zIndex - b.zIndex || a.domIndex - b.domIndex)
        .map(({ score: _score, ...candidate }) => candidate);
    },
    {
      mode: options.mode,
      minArea: options.minArea,
      maxLayers: options.maxLayers,
      captureCssHeight,
      splitRepeatedItems: options.splitRepeatedItems
    }
  );
}

async function captureBackground(
  page: Page,
  layersDir: string,
  options: CaptureOptions,
  kind: "full" | "clean"
): Promise<{ fileName: string; width: number; height: number }> {
  const fileName = kind === "full" ? "000-background.png" : "000-background-clean.png";
  const filePath = path.join(layersDir, fileName);

  const backgroundStyle = await page.addStyleTag({
    content:
      kind === "full"
        ? `#web2svg-hud { visibility: hidden !important; }`
        : `
          #web2svg-hud {
            visibility: hidden !important;
          }
          [data-web2svg-layer-selected="true"],
          [data-web2svg-layer-selected="true"] *,
          [data-web2svg-layer-selected="true"]::before,
          [data-web2svg-layer-selected="true"]::after,
          [data-web2svg-layer-selected="true"] *::before,
          [data-web2svg-layer-selected="true"] *::after {
            visibility: hidden !important;
          }
        `
  });
  await page.screenshot({
    path: filePath,
    fullPage: options.fullPage,
    omitBackground: false
  });
  await backgroundStyle.evaluate((element) => (element as HTMLElement).remove());

  const size = await readPngSize(filePath);
  return { fileName, width: size.width, height: size.height };
}

async function captureLayers(
  page: Page,
  layersDir: string,
  candidates: LayerCandidate[],
  options: CaptureOptions
): Promise<LayerAsset[]> {
  const layers: LayerAsset[] = [];
  await markSelectedLayers(page, candidates.map((candidate) => candidate.id));

  const pageBounds = await page.evaluate(
    (fullPage) => {
      const body = document.body;
      const html = document.documentElement;
      return {
        width: window.innerWidth,
        height: fullPage
          ? Math.max(
              body?.scrollHeight ?? 0,
              body?.offsetHeight ?? 0,
              html.scrollHeight,
              html.offsetHeight,
              html.clientHeight
            )
          : window.innerHeight
      };
    },
    options.fullPage
  );

  for (const [index, candidate] of candidates.entries()) {
    const fileName = `${String(index + 1).padStart(3, "0")}-${sanitizeFilePart(candidate.label)}.png`;
    const filePath = path.join(layersDir, fileName);
    const padding = layerPadding(candidate);
    const clipX = Math.max(0, candidate.x - padding);
    const clipY = Math.max(0, candidate.y - padding);
    const clipRight = Math.min(pageBounds.width, candidate.x + candidate.width + padding);
    const clipBottom = Math.min(pageBounds.height, candidate.y + candidate.height + padding);
    const clipWidth = clipRight - clipX;
    const clipHeight = clipBottom - clipY;

    await addLayerIsolationStyle(page, candidate.id);
    try {
      if (clipWidth <= 1 || clipHeight <= 1) continue;

      await page.screenshot({
        path: filePath,
        omitBackground: true,
        clip: {
          x: clipX,
          y: clipY,
          width: clipWidth,
          height: clipHeight
        },
        timeout: options.timeoutMs
      });
      const trimmed = await trimTransparentPng(filePath);
      if (!trimmed) continue;

      layers.push({
        ...candidate,
        x: clipX + trimmed.x / options.scale,
        y: clipY + trimmed.y / options.scale,
        width: trimmed.width / options.scale,
        height: trimmed.height / options.scale,
        fileName,
        imageWidth: trimmed.width,
        imageHeight: trimmed.height
      });
    } catch {
      // Dynamic pages can detach elements during capture; keep the export usable with successful layers.
    } finally {
      await removeLayerIsolationStyle(page);
    }
  }

  return layers;
}

function layerPadding(candidate: LayerCandidate): number {
  if (["block", "floating", "name", "paint", "role", "semantic"].includes(candidate.reason)) {
    return 160;
  }

  if (candidate.position === "fixed" || candidate.position === "sticky") {
    return 160;
  }

  return 32;
}

async function markSelectedLayers(page: Page, selectedIds: string[]): Promise<void> {
  await page.evaluate((ids) => {
    for (const element of Array.from(document.querySelectorAll("[data-web2svg-layer-selected]"))) {
      element.removeAttribute("data-web2svg-layer-selected");
    }

    for (const id of ids) {
      document.querySelector(`[data-web2svg-id="${id}"]`)?.setAttribute("data-web2svg-layer-selected", "true");
    }
  }, selectedIds);
}

async function addLayerIsolationStyle(page: Page, id: string): Promise<void> {
  await page.evaluate((targetId) => {
    document.getElementById("web2svg-layer-isolation")?.remove();
    const style = document.createElement("style");
    style.id = "web2svg-layer-isolation";
    style.textContent = `
      html, body {
        background: transparent !important;
      }
      #web2svg-hud {
        visibility: hidden !important;
      }
      body *, body *::before, body *::after {
        visibility: hidden !important;
      }
      [data-web2svg-id="${targetId}"],
      [data-web2svg-id="${targetId}"] *,
      [data-web2svg-id="${targetId}"]::before,
      [data-web2svg-id="${targetId}"]::after,
      [data-web2svg-id="${targetId}"] *::before,
      [data-web2svg-id="${targetId}"] *::after {
        visibility: visible !important;
      }
      [data-web2svg-id="${targetId}"] [data-web2svg-layer-selected="true"],
      [data-web2svg-id="${targetId}"] [data-web2svg-layer-selected="true"] *,
      [data-web2svg-id="${targetId}"] [data-web2svg-layer-selected="true"]::before,
      [data-web2svg-id="${targetId}"] [data-web2svg-layer-selected="true"]::after,
      [data-web2svg-id="${targetId}"] [data-web2svg-layer-selected="true"] *::before,
      [data-web2svg-id="${targetId}"] [data-web2svg-layer-selected="true"] *::after {
        visibility: hidden !important;
      }
    `;
    document.head.appendChild(style);
  }, id);
}

async function removeLayerIsolationStyle(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById("web2svg-layer-isolation")?.remove());
}

async function readPngSize(filePath: string): Promise<PngSize> {
  const buffer = await readFile(filePath);
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`Not a PNG file: ${filePath}`);
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

async function trimTransparentPng(filePath: string): Promise<TrimmedPng | null> {
  const source = PNG.sync.read(await readFile(filePath));
  let minX = source.width;
  let minY = source.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const alpha = source.data[(source.width * y + x) * 4 + 3] ?? 0;
      if (alpha === 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) return null;

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const cropped = new PNG({ width, height });

  for (let y = 0; y < height; y += 1) {
    const sourceStart = ((minY + y) * source.width + minX) * 4;
    const targetStart = y * width * 4;
    source.data.copy(cropped.data, targetStart, sourceStart, sourceStart + width * 4);
  }

  await writeFile(filePath, PNG.sync.write(cropped));
  return { x: minX, y: minY, width, height };
}
