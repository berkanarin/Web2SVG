# Web2SVG

Web2SVG is a desktop capture tool for turning a live website state into animation-friendly files.

It opens a real Chromium window, lets you log in and interact with the site, then captures the current screen as layered exports:

- `web2svg_PPTX.pptx` for PowerPoint, with selectable image layers.
- `web2svg_AE.jsx` for After Effects, which creates a comp and places the captured layers.
- `web2svg_AE_assets/` with the PNG files used by the After Effects script.

Web2SVG does not export a layered SVG. PowerPoint's SVG ungroup behavior is unreliable for complex web layouts, so the app writes a real PPTX file instead.

## Requirements

- Windows
- Node.js 20+
- Corepack

## Install

```powershell
corepack enable
corepack prepare pnpm@9.15.4 --activate
corepack pnpm install
```

The install step also downloads the Chromium browser used by Playwright.

## Start The App

Double-click:

```text
Web2SVG.bat
```

The control panel opens in Chromium at:

```text
http://127.0.0.1:4782
```

If a site requires login, use the opened Chromium window normally. Cookies and sessions are kept under the selected profile name, so the next run can reuse the login.

## Basic Workflow

1. Enter a website URL.
2. Click `Open Browser`.
3. Use the opened browser until the page is exactly in the state you want.
4. Click `Capture Now`.
5. Open `exports/current`.

Each new capture replaces the previous files in `exports/current`.

## Outputs

```text
exports/current/web2svg_PPTX.pptx
exports/current/web2svg_AE.jsx
exports/current/web2svg_AE_assets/
```

### PowerPoint

Open `web2svg_PPTX.pptx` directly in PowerPoint.

Do not import an SVG and do not use SVG ungroup. The PPTX already contains the captured elements as separate selectable image objects.

### After Effects

In After Effects:

```text
File > Scripts > Run Script File...
```

Choose:

```text
exports/current/web2svg_AE.jsx
```

Keep `web2svg_AE.jsx` and `web2svg_AE_assets/` in the same folder. The script creates a comp at the capture size and imports each captured element as a separate layer.

## Hover Menus, Modals, And Popups

Open the site from the Web2SVG panel, then interact with the browser normally.

For hover-only UI, keep the mouse over the menu or panel and press:

```text
Ctrl+Shift+S
```

The app captures the current browser state without needing to move the mouse back to the control panel.

## Quality Settings

The default UI setting is:

```text
1280 x 720 viewport
3x scale
3840 x 2160 export
```

This keeps the interactive browser usable while producing 4K output.

## CLI Usage

The UI is the recommended workflow, but the CLI is available:

```powershell
corepack pnpm capture -- --url https://example.com --out exports/current
```

More detailed layer detection:

```powershell
corepack pnpm capture -- --url https://example.com --out exports/current --mode dense --max-layers 140
```

Full page capture:

```powershell
corepack pnpm capture -- --url https://example.com --out exports/current --full-page
```

## Development

```powershell
corepack pnpm check
corepack pnpm build
corepack pnpm app
```

Generated folders are intentionally ignored by git:

```text
dist/
exports/
logs/
node_modules/
profiles/
```
