# Zoniq Test Runner — Desktop App

Desktop application for recording and running Playwright UAT tests against Mendix applications. Built with Electron.

![Zoniq Test Runner]

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Install Playwright browsers
npm run install-browsers

# 3. Launch the app
npm start
```

That's it. The app opens with a UI where you can:

- **Record** — Click "Record from Browser", enter the target Mendix app URL, click through your scenario. The script is captured automatically.
- **Create** — Manually create scenarios with Playwright scripts and Mendix widget selectors.
- **Import** — Import `.js` script files recorded with `npx playwright codegen` or exported from other tools.
- **Run** — Hit the play button on any scenario. Results show pass/fail, error messages, and screenshots.
- **Review** — Browse all test runs with status, timing, and artifacts.

## Embedded REST API

The app also runs an Express server on **port 3100** so your Zoniq Club Mendix app can trigger tests remotely:

| Endpoint | Description |
|---|---|
| `POST /api/execute` | Run a script (raw Playwright JS) |
| `POST /api/execute-steps` | Run structured steps (from Zoniq visual editor) |
| `GET /api/runs/:runId` | Poll for results |
| `GET /api/runs` | List recent runs |
| `GET /api/health` | Health check |

### Example: Trigger from Mendix

```json
POST http://localhost:3100/api/execute
{
  "testRunId": "TR-0042",
  "testName": "Login Flow",
  "targetUrl": "https://client-app.mendixcloud.com",
  "script": "test('login', async ({ page }) => { ... })",
  "credentials": { "username": "test", "password": "Test123!" },
  "callbackUrl": "https://zoniq.example.com/rest/testresult/callback"
}
```

Results are POSTed to `callbackUrl` when the test completes, or you can poll `GET /api/runs/TR-0042`.

## Building a Portable Executable

### Windows (.exe — portable, no installer)

```bash
npm run build:win
```

Output: `dist/Zoniq Test Runner.exe` — single file, no installation needed.

### macOS

```bash
npm run build:mac
```

### Linux

```bash
npm run build:linux
```

## Mendix Widget Naming Convention

For stable test selectors, ensure testable widgets in your Mendix apps have meaningful names:

| Widget | Convention | Example Selector |
|---|---|---|
| Button | `btn` + Action | `mx:btnSave` |
| Text input | `txt` + Field | `mx:txtTitle` |
| Dropdown | `dd` + Field | `mx:ddPriority` |
| Data grid | `dg` + Entity | `mx:dgTickets` |
| Label | `lbl` + Content | `mx:lblStatus` |

In Playwright scripts, these translate to `.mx-name-btnSave`, etc.

## Data Storage

All data is stored in your user data directory:
- **Windows**: `%APPDATA%/zoniq-test-runner/`
- **macOS**: `~/Library/Application Support/zoniq-test-runner/`
- **Linux**: `~/.config/zoniq-test-runner/`

Files:
- `scenarios.json` — All saved test scenarios
- `scripts/` — Imported/recorded script files
- `results/` — Test run artifacts (screenshots, videos, traces)
