# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Self-Maintenance Rule

After completing any task that changes the project's architecture, APIs, data models, commands, conventions, or key implementation details, check whether CLAUDE.md needs to be updated to reflect those changes. If it does, update it as part of the same commit. This ensures CLAUDE.md stays accurate and useful as the codebase evolves.

## Project Overview

Zoniq Test Runner is an Electron desktop application for recording and running Playwright UAT tests against Mendix applications. It provides a GUI for test management and an embedded REST API for remote test execution.

## Commands

```bash
npm install               # Install dependencies
npm run install-browsers  # Install Playwright Chromium browser
npm start                 # Launch the Electron app
npm run build:win         # Build Windows portable .exe
npm run build:mac         # Build macOS .dmg
npm run build:linux       # Build Linux AppImage
```

## Architecture

### Core Design: Script as Single Source of Truth

The script is always the source of truth. Steps are an ephemeral, bidirectional editing view derived from the script — they are never stored.

```
Record/Import → Script (stored, always executed)
                  ↓
         parseScriptToSteps() → Steps (ephemeral, for UI editing only)
                  ↓ (on step field edit)
         generateStepCode() + replaceInScript() → modifies script directly
                  ↓ (on run)
         wrapScript() → injectStepMarkers() → execute via Playwright
```

- Users always start by recording or importing a script
- The step editor allows editing fields (selector, value, action type) of existing parsed steps
- Each step edit regenerates the step's code and replaces it in the script text
- Steps are not stored in the database — `scenario.steps` is stripped on save
- Adding/removing/reordering steps is done by re-recording or editing the script directly
- "Record from here" allows users to select a step and re-record from that point — replays prefix steps on a live browser, then enables codegen

### Electron Main Process (`main.js`)
- Runs embedded Express server on port 3100
- Handles IPC communication with renderer (UI)
- Manages Playwright test execution via `spawn` (not `exec`)
- `wrapScript()` — strips imports, cleans fragile Mendix selectors, wraps bare code in a `test()` block, injects per-statement progress markers via `injectStepMarkers()`
- `injectStepMarkers()` — parses the test body into statements, wraps each with `[ZONIQ_STEP:START/DONE/FAIL]` console.log markers for real-time progress tracking
- `runPlaywright()` — spawns `playwright test` with JSON reporter, streams step progress via stdout parsing
- Stores data in JSON files at user data directory

### Shared Utilities (`lib/script-utils.js`)
UMD module used by both main process (`require()`) and renderer (`<script>` tag, exposes `window.ScriptUtils`).

Key functions:
- `extractTestBody(script)` — strips imports/config, extracts body from `test()` or IIFE wrapper
- `splitIntoStatements(body)` — splits test body into statement objects `{ text, startLine, endLine }`, handles multi-line chained calls (`.filter().click()`)
- `parseStatement(stmt)` — regex-based parser, returns `{ action, selector?, value? }` or null (becomes Raw step)
- `parseScriptToSteps(script)` — full pipeline: extract body → split → parse → filter codegen boilerplate → skip redundant navigates. Returns steps with `sourceText` for edit tracking
- `generateStepCode(step)` — converts a step object back to Playwright code
- `replaceInScript(script, sourceText, newCode, occurrence)` — finds and replaces a statement in the script by text matching, supports occurrence index for duplicate statements
- `splitScriptAtStep(script, stepIndex)` — splits script at a step boundary, returning prefix statements (for replay) and suffix code (to be replaced)
- `mergeRecordedCode(originalScript, stepIndex, newCode)` — merges newly recorded code into an existing script, replacing everything from stepIndex onward
- `resolveLocator(selector)` — converts selector strings (mx:, label:, text:, role:Name) to Playwright locator code
- `describeStatement(stmtText)` — short human-readable description for progress markers

### IPC Bridge (`preload.js`)
Exposes `window.zoniq` API to renderer:
- Scenario CRUD: `getScenarios`, `saveScenario`, `deleteScenario`
- Execution: `executeScenario`, `launchRecorder`, `launchRecorderFromStep`, `importScript`
- Settings: `getSettings`, `saveSettings`, `testLLMConnection`
- Agent operations: `agentHeal`, `agentPreheal`, `agentHealApply`, `agentCancel`
- Events: `onRunStarted`, `onRunCompleted`, `onRunsUpdated`, `onStepList`, `onStepProgress`, `onAgentProgress`, `onRecorderFromStepProgress`, `onRecorderFromStepStatus`

### Renderer (`index.html`)
Single-file UI with embedded `<script>`. Imports `ScriptUtils` from `lib/script-utils.js`.

Step editing flow:
- `showScenarioDetail()` — always re-parses steps from `sc.script` via `parseScriptToSteps()`
- `onStepFieldChange()` / `onStepActionChange()` — updates step, calls `_updateStepInScript()` which uses `generateStepCode()` + `replaceInScript()` to modify the script directly
- `_autoSaveScenario()` — debounced save (600ms), strips ephemeral `steps` before sending to main process

### AI Healer Agent (`agents/healer-agent.js`)
- Derives steps from script on-the-fly via `ScriptUtils.parseScriptToSteps()` (does not rely on stored steps)
- Hybrid healing: tries static analysis (screenshot + errors) first, falls back to browser-based replay
- `_replayToFailurePoint()` — replays parsed steps up to the failure point using a live browser
- LLM orchestration loop with tool use for live page inspection

### Test Execution Flow
1. `wrapScript()` — strips Codegen imports, cleans fragile `#mxui_widget_*` selectors, wraps bare code in `test()` block, adds `require` for Playwright and Mendix helpers
2. `injectStepMarkers()` — parses test body into statements, wraps each with progress markers (`[ZONIQ_STEP:START/DONE/FAIL]`)
3. `runPlaywright()` — spawns `npx playwright test` with JSON reporter, parses stdout for real-time step progress
4. Results parsed from JSON report and stored in `scenarios.json`

### Mendix Helpers (`helpers/mendix-helpers.js`)
Utility functions for Mendix-specific testing:
- `waitForMendix(page)` — Wait for loading spinners/overlays
- `login(page, url, username, password)` — Standard Mendix login
- `clickWidget(page, widgetName)` — Click by `.mx-name-*` selector
- `fillWidget(page, widgetName, value)` — Fill text inputs
- `selectDropdown(page, widgetName, value)` — Select dropdown option
- `waitForPopup(page)` / `closePopup(page)` — Dialog handling
- `waitForMicroflow(page)` — Wait for microflow completion
- `assertWidgetText`, `assertWidgetVisible`, `assertWidgetEnabled`, `assertWidgetDisabled` — Assertion helpers

### REST API Endpoints (port 3100)
- `POST /api/execute` — Run raw Playwright script
- `POST /api/execute-steps` — Run structured step definitions (builds a script from steps internally)
- `GET /api/runs/:runId` — Get specific run result
- `GET /api/runs` — List recent runs
- `GET /api/runs/:runId/artifacts/:filename` — Download test artifact
- `GET /api/health` — Health check
- `POST /api/agent/heal` — Run AI healer on a failed test
- `POST /api/agent/preheal` — Run test then auto-heal if it fails
- `GET /api/agent/status` — Check if an agent is running
- `POST /api/agent/cancel` — Cancel running agent

## Data Storage

User data stored in platform-specific directories:
- Windows: `%APPDATA%/zoniq-test-runner/`
- macOS: `~/Library/Application Support/zoniq-test-runner/`
- Linux: `~/.config/zoniq-test-runner/`

Files:
- `scenarios.json` — Test scenarios and run history (steps are NOT stored, only scripts)
- `scripts/` — Recorded/imported script files
- `results/` — Test artifacts (screenshots, videos, traces, debug logs)

### Scenario Data Model
```json
{
  "id": "uuid",
  "name": "Login Flow",
  "targetUrl": "https://app.mendixcloud.com",
  "credentials": { "username": "test", "password": "..." },
  "script": "test('...', async ({ page }) => { ... });",
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601"
}
```
Note: `steps` is never persisted. It is always derived from `script` via `parseScriptToSteps()`.

## Mendix Widget Selectors

Use `mx:` prefix in step definitions, which translates to `.mx-name-*` CSS selectors:
- `mx:btnSave` → `.mx-name-btnSave`
- `mx:txtTitle` → `.mx-name-txtTitle input`

Other supported selector formats:
- `label:Username` → `page.getByLabel('Username')`
- `text:Submit` → `page.getByText('Submit')`
- `placeholder:Search` → `page.getByPlaceholder('Search')`
- `button:Save` (role:name) → `page.getByRole('button', { name: 'Save' })`
- `keyboard:Enter` → `page.keyboard.press('Enter')`
- Raw CSS selectors are passed through to `page.locator()`

## Zero Manual Editing Principle

**Users must NEVER be asked to manually edit steps, selectors, or values to fix targeting issues.** All Mendix quirks (dynamic GUIDs, disabled-while-loading elements, async option loading, fragile widget IDs) must be handled automatically at runtime by `wrapScript()` transformations and `mendix-helpers.js`. If a recorded script doesn't work out of the box, that is a bug in the runtime layer — fix it there, not by telling the user to edit their script. This applies to:

- Reference selectors / dropdowns that use internal Mendix GUIDs as `<option>` values — see GUID elimination below
- Elements that start disabled while Mendix loads data — `smartSelect` waits for enabled state
- Fragile `#mxui_widget_*` selectors — `wrapScript()` strips these automatically
- Any other Mendix-specific selector or timing issue

When implementing new fixes: always solve at the `wrapScript()` / helper layer so recorded scripts just work.

## GUIDs Are Never the Source of Truth

**Mendix GUIDs are internal, ephemeral, environment-specific IDs. They MUST NEVER appear in stored scripts or the step editor.** This is a UAT (User Acceptance Testing) tool — users select by human-readable labels, not internal IDs. GUIDs change between environments, deploys, and even page loads. They are meaningless for test targeting.

**Primary mechanism — resolve GUIDs at recording time (no DOM mutation):**
- `recorder.js` uses `page.exposeFunction()` + `addInitScript` to collect GUID→label mappings from `<option>` elements without mutating the DOM — Mendix form handling works normally during recording
- A `MutationObserver` catches dynamically loaded options (Mendix loads these async)
- After the user closes the browser, the recorder reads the output script and replaces any GUID values with their human-readable labels
- By the time the script is returned to the UI, GUIDs are already gone

**Fallback layers (defense in depth):**
1. **Step editor UI** — `parseScriptToSteps()` strips any remaining GUID values so the user never sees them
2. **Runtime** — `smartSelect()` is label-first. If a value still looks like a GUID, it resolves to the visible `<option>` label before selecting
3. **Auto-heal after run** — `runPlaywright()` captures GUID resolution markers and permanently replaces any remaining GUIDs in the stored script

## Key Implementation Details

- `wrapScript()` auto-transforms `.selectOption()` calls into `mx.smartSelect()` calls. `smartSelect` is label-first: it never matches by GUID value
- `looksLikeGuid()` in `lib/script-utils.js` is the shared GUID detector used by `parseScriptToSteps()`, `smartSelect`, and the auto-heal logic. Detects: numeric IDs 10+ digits, UUIDs, and long hex strings
- `activeAgent.agent` can be `null` during prehealer phase (before the healer is created) — always guard with `if (activeAgent.agent)` before calling `.cancel()`
- `replaceInScript()` takes an `occurrence` parameter (0-indexed) to handle duplicate statements — the caller must count prior steps with matching `sourceText`
- `splitIntoStatements()` peeks ahead for `.` continuation lines to handle multi-line method chaining
- Codegen boilerplate (`browser.launch()`, `context.newPage()`, `page.close()`, etc.) is filtered out during `parseScriptToSteps()`
- `wrapScript()` is idempotent regarding import stripping — safe to call on already-processed scripts
