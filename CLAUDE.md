# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Zoniq Test Runner is an Electron desktop application for recording and running Playwright UAT tests against Mendix applications. It provides a GUI for test management and an embedded REST API for remote test execution.

## Commands

```bash
npm install           # Install dependencies
npm run install-browsers  # Install Playwright Chromium browser
npm start             # Launch the Electron app
npm run build:win     # Build Windows portable .exe
npm run build:mac     # Build macOS .dmg
npm run build:linux   # Build Linux AppImage
```

## Architecture

### Electron Main Process (`main.js`)
- Runs embedded Express server on port 3100
- Handles IPC communication with renderer (UI)
- Manages Playwright test execution via child_process
- Stores data in JSON files at user data directory

### IPC Bridge (`preload.js`)
- Exposes `window.zoniq` API to renderer
- Main methods: `healthCheck`, `getScenarios`, `saveScenario`, `deleteScenario`, `getRuns`, `launchRecorder`, `importScript`, `executeScenario`

### Test Execution Flow
1. Script wrapping via `wrapScript()` - adds Playwright imports and Mendix helpers
2. For step-based tests, `generateScriptFromSteps()` converts visual steps to Playwright code
3. `runPlaywright()` executes via `npx playwright test` with JSON reporter
4. Results parsed from JSON report and stored in scenarios.json

### Mendix Helpers (`helpers/mendix-helpers.js`)
Utility functions for Mendix-specific testing:
- `waitForMendix(page)` - Wait for loading spinners/overlays
- `login(page, url, username, password)` - Standard Mendix login
- `clickWidget(page, widgetName)` - Click by mx-name-* selector
- `fillWidget(page, widgetName, value)` - Fill text inputs
- `selectDropdown(page, widgetName, value)` - Select dropdown option
- `waitForPopup(page)` / `closePopup(page)` - Dialog handling
- `waitForMicroflow(page)` - Wait for microflow completion

### REST API Endpoints (port 3100)
- `POST /api/execute` - Run raw Playwright script
- `POST /api/execute-steps` - Run structured step definitions
- `GET /api/runs/:runId` - Get specific run result
- `GET /api/runs` - List recent runs
- `GET /api/health` - Health check

## Data Storage

User data stored in platform-specific directories:
- Windows: `%APPDATA%/zoniq-test-runner/`
- macOS: `~/Library/Application Support/zoniq-test-runner/`
- Linux: `~/.config/zoniq-test-runner/`

Files:
- `scenarios.json` - Test scenarios and run history
- `scripts/` - Recorded/imported scripts
- `results/` - Test artifacts (screenshots, videos, traces)

## Mendix Widget Selectors

Use `mx:` prefix in step definitions, which translates to `.mx-name-*` CSS selectors:
- `mx:btnSave` → `.mx-name-btnSave`
- `mx:txtTitle` → `.mx-name-txtTitle input`
