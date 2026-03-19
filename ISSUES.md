# Zoniq Test Runner - Known Issues & Fixes

This document tracks all identified issues and their resolution status.

---

## Status Legend

- [ ] **Open** - Not yet addressed
- [~] **In Progress** - Currently being worked on
- [x] **Fixed** - Resolved and tested

---

## High Priority Issues

### 1. [x] Missing `fetch` polyfill for older Node.js versions
**Location:** `main.js:340, 378`
**Severity:** High

**Problem:**
The API uses `fetch()` for callback URLs, but native fetch requires Node.js v18+. The project doesn't specify Node version requirements.

**Fix:**
1. Add `node-fetch` as a dependency, OR
2. Use `axios` / native `https` module, OR
3. Document Node.js v18+ requirement in package.json:
```json
"engines": {
  "node": ">=18.0.0"
}
```

---

### 2. [x] No API authentication
**Location:** `main.js:296-412`
**Severity:** High (Security)

**Problem:**
The REST API on port 3100 has no authentication. Anyone on the network can execute arbitrary Playwright scripts, access test results, and view credentials.

**Fix:**
Add API key authentication middleware:
```javascript
const API_KEY = process.env.ZONIQ_API_KEY || null;

api.use((req, res, next) => {
  if (!API_KEY) return next(); // Skip if no key configured
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});
```

---

### 3. [x] Script injection vulnerability in `wrapScript`
**Location:** `main.js:81`
**Severity:** High (Security)

**Problem:**
```javascript
const TARGET_URL = '${targetUrl}';
const CREDENTIALS = ${JSON.stringify(credentials || {})};
```
If `targetUrl` contains `'` or malicious JS, it breaks out of the string literal.

**Fix:**
Use JSON.stringify for URL too:
```javascript
const TARGET_URL = ${JSON.stringify(targetUrl)};
```

---

### 4. [x] Step value injection in `generateScriptFromSteps`
**Location:** `main.js:134-164`
**Severity:** High (Security)

**Problem:**
User inputs (step.value, step.selector) are directly interpolated into code strings without escaping:
```javascript
return `  await page.fill('${step.selector}', '${step.value}');`;
```

**Fix:**
Create an escape function for string literals:
```javascript
function escapeJsString(str) {
  return String(str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}
```
Use template literals with JSON.stringify for values where possible.

---

### 5. [x] No validation of UUID format for runId
**Location:** `main.js:274, 319, 356, 403`
**Severity:** Medium (Security)

**Problem:**
User-provided `testRunId` is used in file paths without validation. Could allow path traversal if `testRunId` contains `../`.

**Fix:**
Validate UUID format:
```javascript
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateRunId(runId) {
  if (!UUID_REGEX.test(runId)) {
    throw new Error('Invalid runId format');
  }
  return runId;
}
```

---

### 6. [ ] Empty catch blocks swallow errors
**Location:** Multiple (15+ locations)
**Severity:** Medium

**Problem:**
Over 15 empty `catch {}` blocks hide potentially important errors, making debugging difficult.

**Locations:**
- `main.js:34` - loadDB()
- `main.js:200` - copyFileSync
- `main.js:220` - writeFileSync debug
- `main.js:227` - report parsing
- `main.js:233` - stdout parsing
- `main.js:248` - artifact walking
- `main.js:345, 384` - callback fetch
- `main.js:348, 387` - unlink
- And more...

**Fix:**
At minimum, log errors:
```javascript
catch (err) {
  console.error('[loadDB] Error:', err.message);
}
```

---

### 7. [x] `--headed` flag forces headed mode
**Location:** `main.js:210`
**Severity:** Medium

**Problem:**
Tests always run in headed mode:
```javascript
const cmd = `"${playwrightCli}" test "${runIdPrefix}" --config="${configPath}" --reporter=json --output="${runResultsDir}" --headed`;
```
This fails on headless CI/CD servers and is slower.

**Fix:**
Make it configurable:
```javascript
const headed = process.env.ZONIQ_HEADED === 'true' || process.platform === 'darwin';
const headedFlag = headed ? '--headed' : '';
const cmd = `"${playwrightCli}" test "${runIdPrefix}" --config="${configPath}" --reporter=json --output="${runResultsDir}" ${headedFlag}`;
```

---

### 8. [x] Missing cleanup of temp files in IPC handler
**Location:** `main.js:576`
**Severity:** Low

**Problem:**
API endpoints clean up temp files, but `execute-scenario` IPC handler has cleanup commented out:
```javascript
} finally {
  // try { fs.unlinkSync(scriptPath); } catch {}
}
```

**Fix:**
Uncomment and enable cleanup:
```javascript
} finally {
  try { fs.unlinkSync(scriptPath); } catch {}
}
```

---

## Low Priority / Code Quality Issues

### 9. [ ] No input validation on selectors
**Location:** `main.js:134-164` (generateScriptFromSteps)

**Problem:**
Selectors are used directly without validation.

**Fix:**
Basic selector validation to prevent obvious issues:
```javascript
function validateSelector(selector) {
  if (typeof selector !== 'string') return false;
  if (selector.length > 1000) return false; // Prevent excessively long selectors
  return true;
}
```

---

### 10. [ ] Hardcoded timeouts scattered throughout
**Location:** Multiple files
**Severity:** Low

**Problem:**
Timeouts like 30000ms, 45000ms, 3000ms are hardcoded everywhere.

**Fix:**
Create a config object:
```javascript
const TIMEOUTS = {
  mendixLoad: 30000,
  loginLoad: 45000,
  microflow: 3000,
  testExecution: 300000,
  apiCallback: 10000,
};
```

---

### 11. [x] Event listener memory leak in preload.js
**Location:** `preload.js:15-17`

**Problem:**
```javascript
onRunStarted: (cb) => ipcRenderer.on("run-started", (_, data) => cb(data)),
```
Event listeners are never removed, potential memory leak.

**Fix:**
Return unsubscribe functions:
```javascript
onRunStarted: (cb) => {
  const handler = (_, data) => cb(data);
  ipcRenderer.on("run-started", handler);
  return () => ipcRenderer.removeListener("run-started", handler);
},
```

---

### 12. [x] Race conditions in selectComboBox/selectAutoComplete
**Location:** `mendix-helpers.js:183-211`

**Problem:**
Multiple `await locator.count() > 0` checks without proper waiting can have timing issues.

**Fix:**
Use Playwright's built-in waiting mechanisms:
```javascript
// Instead of:
if (await nativeSelect.count() > 0) { ... }

// Use:
const nativeSelect = page.locator(`${widget} select`);
try {
  await nativeSelect.waitFor({ state: 'visible', timeout: 1000 });
  await nativeSelect.selectOption({ label: value });
  return;
} catch { /* Continue to next strategy */ }
```

---

### 13. [ ] Missing .gitignore
**Location:** Project root

**Problem:**
No `.gitignore` file to exclude `node_modules/`, `dist/`, `temp/`, etc.

**Fix:**
Create `.gitignore`:
```
node_modules/
dist/
temp/
*.log
.DS_Store
```

---

### 14. [ ] No README.md
**Location:** Project root

**Problem:**
Project lacks basic documentation for new users.

**Fix:**
Create README with installation, usage, and API documentation.

---

## Summary

| Category | Count |
|----------|-------|
| High Severity | 8 |
| Medium Severity | 2 |
| Low Severity | 4 |
| **Total** | **14** |

---

## Changelog

| Date | Issue # | Description |
|------|---------|-------------|
| _pending_ | - | Initial issue tracking created |
