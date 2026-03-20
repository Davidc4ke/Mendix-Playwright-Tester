/**
 * mendix-helpers.js
 *
 * Utility functions for testing Mendix applications with Playwright.
 * Supports Mendix 9 and Mendix 10 widget conventions.
 *
 * Widget naming convention:
 *   All helpers accept a `widgetName` that maps to the Mendix Studio Pro
 *   "Name" property of the widget (e.g. "btnSave" → `.mx-name-btnSave`).
 *
 * Usage in test scripts:
 *   const mx = require('./helpers/mendix-helpers');
 *   await mx.waitForMendix(page);
 *   await mx.clickWidget(page, 'btnSubmit');
 */

const { expect } = require("@playwright/test");

// ── Loading / Navigation ──────────────────────────────────────────────────────

/**
 * Wait until Mendix has fully loaded the current page/view.
 * Handles the progress bar, loading overlay, and network idle state.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ timeout?: number }} [options]
 */
async function waitForMendix(page, options = {}) {
  const { timeout = 30000 } = options;

  // Mendix 9/10 progress bar (.mx-progress) and loading cover (.mx-progress-bar)
  for (const selector of [".mx-progress", ".mx-progress-bar"]) {
    try {
      await page.locator(selector).waitFor({ state: "hidden", timeout });
    } catch {
      // May never appear on fast loads — that is fine
    }
  }

  // Loading overlay (modal blocker shown during microflow execution)
  try {
    await page.locator(".mx-overlay").waitFor({ state: "hidden", timeout: 5000 });
  } catch {
    // May not be present
  }

  // Ensure the DOM is fully parsed before proceeding.
  // Note: we intentionally avoid 'networkidle' here — Mendix apps use WebSockets
  // and background polling that prevent the network from ever truly going idle.
  await page.waitForLoadState("domcontentloaded");
}

/**
 * Login to a Mendix application using the standard Mendix login page.
 * Tries Mendix 9 selectors first, then falls back to Mendix 10 / custom themes.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} url       Base URL of the Mendix app
 * @param {string} username
 * @param {string} password
 */
async function login(page, url, username, password) {
  await page.goto(url);
  await waitForMendix(page, { timeout: 45000 });

  // Mendix 9 uses #usernameInput / #passwordInput / #loginButton
  // Mendix 10 switched to [data-testid] or role-based selectors
  const usernameLocator = page
    .locator("#usernameInput, [data-testid='username-input'], input[name='username'], input[placeholder*='user' i]")
    .first();

  const passwordLocator = page
    .locator("#passwordInput, [data-testid='password-input'], input[name='password'], input[type='password']")
    .first();

  await usernameLocator.waitFor({ state: "visible", timeout: 30000 });
  await usernameLocator.fill(username);
  await passwordLocator.fill(password);

  // Click the login button — try several common patterns
  const loginButton = page
    .locator("#loginButton, [data-testid='login-button'], button[type='submit'], .mx-name-loginButton")
    .first();
  await loginButton.click();

  // Wait for the app shell to appear after login
  await waitForMendix(page, { timeout: 60000 });
}

/**
 * Login and save browser storage state for reuse in later tests.
 * Playwright recommends logging in once and reusing the auth state via
 * `storageState` to avoid repeating the login flow before every test.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} url        Base URL of the Mendix app
 * @param {string} username
 * @param {string} password
 * @param {string} savePath   File path to save the storage state JSON (e.g. "playwright/.auth/user.json")
 */
async function saveAuthState(page, url, username, password, savePath) {
  await login(page, url, username, password);
  await page.context().storageState({ path: savePath });
}

// ── Widget Interaction ────────────────────────────────────────────────────────

/**
 * Click a Mendix widget by its Studio Pro "Name" property.
 * Waits for the widget to be visible before clicking.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} widgetName  e.g. "btnSave"
 * @param {{ timeout?: number }} [options]
 */
async function clickWidget(page, widgetName, options = {}) {
  const { timeout = 15000 } = options;
  const locator = page.locator(`.mx-name-${widgetName}`).first();
  await locator.waitFor({ state: "visible", timeout });
  await locator.click();
}

/**
 * Fill a Mendix text input or textarea widget.
 * Clears existing content before typing.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} widgetName
 * @param {string} value
 * @param {{ timeout?: number }} [options]
 */
async function fillWidget(page, widgetName, value, options = {}) {
  const { timeout = 15000 } = options;
  // Mendix wraps inputs: .mx-name-widget > .form-control / input / textarea
  const locator = page
    .locator(`.mx-name-${widgetName} input, .mx-name-${widgetName} textarea`)
    .first();
  await locator.waitFor({ state: "visible", timeout });
  await locator.clear();
  await locator.fill(value);
}

/**
 * Get the trimmed text content of a Mendix widget.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} widgetName
 * @returns {Promise<string>}
 */
async function getWidgetText(page, widgetName) {
  const locator = page.locator(`.mx-name-${widgetName}`).first();
  await locator.waitFor({ state: "visible" });
  return (await locator.textContent() ?? "").trim();
}

/**
 * Assert that a Mendix widget is visible on the page.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} widgetName
 * @param {{ timeout?: number }} [options]
 */
async function assertWidgetVisible(page, widgetName, options = {}) {
  const { timeout = 15000 } = options;
  await expect(page.locator(`.mx-name-${widgetName}`).first()).toBeVisible({ timeout });
}

// ── Dropdowns & Selects ───────────────────────────────────────────────────────

/**
 * Select a value in a Mendix standard dropdown widget (<select>-based).
 * For reference selectors and combo boxes use `selectReferenceSelector` or `selectComboBox`.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} widgetName
 * @param {string} value       Visible label of the option to select
 */
async function selectDropdown(page, widgetName, value) {
  const select = page.locator(`.mx-name-${widgetName} select`).first();
  await select.waitFor({ state: "visible" });
  await select.selectOption({ label: value });
}

/**
 * Select a value in a Mendix Reference Selector widget.
 * These render as either a <select> (Mendix 9) or a searchable input (Mendix 10).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} widgetName
 * @param {string} value
 */
async function selectReferenceSelector(page, widgetName, value) {
  const widget = page.locator(`.mx-name-${widgetName}`).first();
  await widget.waitFor({ state: "visible" });

  // Mendix 9: native <select>
  const nativeSelect = widget.locator("select");
  try {
    await nativeSelect.waitFor({ state: "visible", timeout: 2000 });
    await nativeSelect.selectOption({ label: value });
    return;
  } catch {
    // Fall through to searchable input strategy
  }

  // Mendix 10: searchable combobox
  const input = widget.locator("input").first();
  await input.click();
  await input.fill(value);
  await page
    .locator('[role="listbox"] [role="option"]')
    .filter({ hasText: value })
    .first()
    .waitFor({ state: "visible", timeout: 5000 });
  await page
    .locator('[role="listbox"] [role="option"]')
    .filter({ hasText: value })
    .first()
    .click();
}

/**
 * Select a value in a Mendix ComboBox widget.
 * Tries native select, then searchable input, then ARIA listbox.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} widgetName
 * @param {string} value
 */
async function selectComboBox(page, widgetName, value) {
  const widget = page.locator(`.mx-name-${widgetName}`).first();
  await widget.waitFor({ state: "visible" });

  // Strategy 1: native <select>
  const nativeSelect = widget.locator("select");
  try {
    await nativeSelect.waitFor({ state: "visible", timeout: 1000 });
    await nativeSelect.selectOption({ label: value });
    return;
  } catch {
    // Not a native select
  }

  // Strategy 2: open the widget and type to filter
  await widget.click();
  const searchInput = widget.locator('input[role="combobox"], input[type="text"]').first();
  try {
    await searchInput.waitFor({ state: "visible", timeout: 2000 });
    await searchInput.fill(value);
  } catch {
    // Widget opens a listbox without a text input
  }

  // Wait for and click the matching option
  const option = page
    .locator('[role="listbox"] [role="option"], [role="option"]')
    .filter({ hasText: value })
    .first();
  await option.waitFor({ state: "visible", timeout: 5000 });
  await option.click();
}

/**
 * Select a value in a Mendix AutoComplete widget.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} widgetName
 * @param {string} value
 */
async function selectAutoComplete(page, widgetName, value) {
  const widget = page.locator(`.mx-name-${widgetName}`).first();
  await widget.waitFor({ state: "visible" });

  const input = widget.locator("input").first();
  await input.click();
  await input.fill(value);

  const option = page
    .locator('[role="option"]')
    .filter({ hasText: value })
    .first();
  await option.waitFor({ state: "visible", timeout: 8000 });
  await option.click();
}

/**
 * Fill a Mendix DatePicker widget.
 * Clears existing content, types the date string, then closes the picker.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} widgetName
 * @param {string} dateValue  e.g. "12/31/2025" (locale format as shown in the app)
 */
async function fillDatePicker(page, widgetName, dateValue) {
  const input = page.locator(`.mx-name-${widgetName} input`).first();
  await input.waitFor({ state: "visible" });
  await input.click();
  await input.clear();
  await input.type(dateValue, { delay: 50 });
  // Press Escape to close the datepicker popup without changing focus issues
  await page.keyboard.press("Escape");
}

// ── Dialogs / Popups ──────────────────────────────────────────────────────────

/**
 * Wait for a Mendix popup or modal dialog to appear.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ timeout?: number }} [options]
 */
async function waitForPopup(page, options = {}) {
  const { timeout = 10000 } = options;
  const dialog = page
    .locator(".modal-dialog, .mx-dialog, .mx-window-active")
    .first();
  await dialog.waitFor({ state: "visible", timeout });
  // Wait for an interactive element inside the dialog to be ready,
  // ensuring open-animations have settled (replaces hard waitForTimeout)
  try {
    await dialog
      .locator("input, button, textarea, select, [tabindex]")
      .first()
      .waitFor({ state: "visible", timeout: 2000 });
  } catch {
    // Dialog may not contain interactive elements — that is fine
  }
}

/**
 * Close the currently visible Mendix popup/dialog.
 * Tries Bootstrap 5 (.btn-close), Bootstrap 4 (.close), and Mendix-specific close buttons.
 *
 * @param {import('@playwright/test').Page} page
 */
async function closePopup(page) {
  // Try close buttons in order of priority
  const closeSelectors = [
    ".modal-dialog .btn-close",   // Bootstrap 5 (Mendix 10)
    ".modal-dialog .close",       // Bootstrap 4 (Mendix 9)
    ".mx-dialog .btn-close",
    ".mx-dialog .close",
    ".mx-window-active .mx-close-button",
    ".mx-window-active .close",
  ];

  for (const sel of closeSelectors) {
    const btn = page.locator(sel).first();
    try {
      await btn.waitFor({ state: "visible", timeout: 1000 });
      await btn.click();
      break;
    } catch {
      // Try next selector
    }
  }

  // Confirm the dialog has gone
  try {
    await page
      .locator(".modal-dialog, .mx-dialog, .mx-window-active")
      .first()
      .waitFor({ state: "hidden", timeout: 5000 });
  } catch {
    // Dialog may have already been dismissed
  }
}

// ── Data Grid ─────────────────────────────────────────────────────────────────

/**
 * Click a button inside a specific row of a Mendix Data Grid (classic).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} gridName    Widget name of the datagrid
 * @param {string} rowText     Text to identify the row (partial match)
 * @param {string} buttonName  Widget name of the button inside the row
 */
async function clickDataGridRowButton(page, gridName, rowText, buttonName) {
  const row = page
    .locator(`.mx-name-${gridName} .mx-datagrid-row, .mx-name-${gridName} tr`)
    .filter({ hasText: rowText })
    .first();
  await row.waitFor({ state: "visible" });
  await row.locator(`.mx-name-${buttonName}`).click();
}

/**
 * Return the number of visible rows in a Mendix Data Grid (classic).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} gridName
 * @returns {Promise<number>}
 */
async function getDataGridRowCount(page, gridName) {
  const rows = page.locator(
    `.mx-name-${gridName} .mx-datagrid-row, .mx-name-${gridName} tbody tr`
  );
  try {
    await rows.first().waitFor({ state: "visible", timeout: 10000 });
  } catch {
    // Empty grid
    return 0;
  }
  return rows.count();
}

/**
 * Return the number of visible rows in a Mendix Data Grid 2 widget (Mendix 9+).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} gridName
 * @returns {Promise<number>}
 */
async function getDataGrid2RowCount(page, gridName) {
  const rows = page.locator(`.mx-name-${gridName} [role="row"]:not([role="columnheader"])`);
  try {
    await rows.first().waitFor({ state: "visible", timeout: 10000 });
  } catch {
    return 0;
  }
  return rows.count();
}

/**
 * Click a button in a specific row of a Mendix Data Grid 2 widget.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} gridName
 * @param {string} rowText
 * @param {string} buttonName
 */
async function clickDataGrid2RowButton(page, gridName, rowText, buttonName) {
  const row = page
    .locator(`.mx-name-${gridName} [role="row"]`)
    .filter({ hasText: rowText })
    .first();
  await row.waitFor({ state: "visible" });
  await row.locator(`.mx-name-${buttonName}`).click();
}

// ── Microflows ────────────────────────────────────────────────────────────────

/**
 * Wait for a Mendix microflow to complete.
 * Watches the progress indicator appear (started) then disappear (completed).
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ timeout?: number }} [options]
 */
async function waitForMicroflow(page, options = {}) {
  const { timeout = 30000 } = options;

  // Wait for the progress bar to appear (microflow triggered)
  try {
    await page.locator(".mx-progress, .mx-progress-bar").first().waitFor({
      state: "visible",
      timeout: 3000,
    });
  } catch {
    // Fast microflow — may have already completed before we started watching
    return;
  }

  // Wait for it to go away (microflow completed)
  await page.locator(".mx-progress, .mx-progress-bar").first().waitFor({
    state: "hidden",
    timeout,
  });
}

// ── Screenshots ───────────────────────────────────────────────────────────────

/**
 * Take a full-page screenshot and save it to the given directory.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} name        Filename without extension
 * @param {string} resultsDir  Absolute or relative path to output directory
 * @returns {Promise<string>}  Full path to the saved screenshot
 */
async function takeScreenshot(page, name, resultsDir) {
  const filePath = `${resultsDir}/${name}.png`;
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

// ── Web-First Assertions ──────────────────────────────────────────────────────

/**
 * Assert that a Mendix widget contains (or exactly matches) the expected text.
 * Uses Playwright's web-first `toContainText` / `toHaveText` assertions which
 * auto-retry until the timeout — preferred over getWidgetText() + manual expect().
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} widgetName
 * @param {string} expectedText
 * @param {{ timeout?: number, exact?: boolean }} [options]
 */
async function assertWidgetText(page, widgetName, expectedText, options = {}) {
  const { timeout = 15000, exact = false, soft = false } = options;
  const locator = page.locator(`.mx-name-${widgetName}`).first();
  const assertion = soft ? expect.soft(locator) : expect(locator);
  if (exact) {
    await assertion.toHaveText(expectedText, { timeout });
  } else {
    await assertion.toContainText(expectedText, { timeout });
  }
}

/**
 * Assert the number of elements matching a Mendix widget name.
 * Uses Playwright's web-first `toHaveCount` which auto-retries.
 * Useful for verifying Data Grid row counts, list sizes, etc.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} widgetName
 * @param {number} expectedCount
 * @param {{ timeout?: number }} [options]
 */
async function assertWidgetCount(page, widgetName, expectedCount, options = {}) {
  const { timeout = 15000 } = options;
  await expect(page.locator(`.mx-name-${widgetName}`)).toHaveCount(expectedCount, { timeout });
}

/**
 * Assert that a Mendix widget's input/button/select is enabled.
 * Uses Playwright's web-first `toBeEnabled` which auto-retries.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} widgetName
 * @param {{ timeout?: number }} [options]
 */
async function assertWidgetEnabled(page, widgetName, options = {}) {
  const { timeout = 15000 } = options;
  const locator = page
    .locator(`.mx-name-${widgetName} input, .mx-name-${widgetName} button, .mx-name-${widgetName} select`)
    .first();
  await expect(locator).toBeEnabled({ timeout });
}

/**
 * Assert that a Mendix widget's input/button/select is disabled.
 * Uses Playwright's web-first `toBeDisabled` which auto-retries.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} widgetName
 * @param {{ timeout?: number }} [options]
 */
async function assertWidgetDisabled(page, widgetName, options = {}) {
  const { timeout = 15000 } = options;
  const locator = page
    .locator(`.mx-name-${widgetName} input, .mx-name-${widgetName} button, .mx-name-${widgetName} select`)
    .first();
  await expect(locator).toBeDisabled({ timeout });
}

// ── Mendix 10 data-testid Helpers ─────────────────────────────────────────────

/**
 * Click an element by its data-testid attribute.
 * Useful for Mendix 10 widgets that expose data-testid attributes.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} testId
 * @param {{ timeout?: number }} [options]
 */
async function clickByTestId(page, testId, options = {}) {
  const { timeout = 15000 } = options;
  await page.getByTestId(testId).click({ timeout });
}

/**
 * Fill an input element identified by its data-testid attribute.
 * Useful for Mendix 10 widgets that expose data-testid attributes.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} testId
 * @param {string} value
 * @param {{ timeout?: number }} [options]
 */
async function fillByTestId(page, testId, value, options = {}) {
  const { timeout = 15000 } = options;
  const locator = page.getByTestId(testId);
  await locator.waitFor({ state: "visible", timeout });
  await locator.clear();
  await locator.fill(value);
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Loading
  waitForMendix,
  // Auth
  login,
  saveAuthState,
  // Widget interaction
  clickWidget,
  fillWidget,
  getWidgetText,
  assertWidgetVisible,
  assertWidgetText,
  assertWidgetCount,
  assertWidgetEnabled,
  assertWidgetDisabled,
  // Mendix 10 data-testid
  clickByTestId,
  fillByTestId,
  // Dropdowns & selects
  selectDropdown,
  selectReferenceSelector,
  selectComboBox,
  selectAutoComplete,
  fillDatePicker,
  // Dialogs
  waitForPopup,
  closePopup,
  // Data Grid (classic)
  clickDataGridRowButton,
  getDataGridRowCount,
  // Data Grid 2 (Mendix 9+)
  getDataGrid2RowCount,
  clickDataGrid2RowButton,
  // Microflows
  waitForMicroflow,
  // Screenshots
  takeScreenshot,
};
