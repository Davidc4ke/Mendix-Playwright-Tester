/**
 * mendix-helpers.js
 * 
 * Utility functions for testing Mendix applications with Playwright.
 * These handle Mendix-specific quirks like loading spinners, dynamic widgets,
 * and the mx-name-* selector convention.
 * 
 * Usage in test scripts:
 *   const mx = require('./helpers/mendix-helpers');
 *   await mx.waitForMendix(page);
 *   await mx.clickWidget(page, 'btnSubmit');
 */

/**
 * Wait until Mendix has fully loaded the page.
 * Waits for the progress bar/spinner to disappear and network to settle.
 */
async function waitForMendix(page, options = {}) {
  const { timeout = 30000 } = options;

  // Wait for the Mendix progress indicator to disappear
  try {
    await page.waitForSelector(".mx-progress", {
      state: "hidden",
      timeout,
    });
  } catch {
    // Progress bar might never appear on fast loads — that's fine
  }

  // Also wait for the loading overlay if present
  try {
    await page.waitForSelector(".mx-overlay", {
      state: "hidden",
      timeout: 5000,
    });
  } catch {
    // May not exist
  }

  // Wait for network to settle
  await page.waitForLoadState("networkidle", { timeout });
}

/**
 * Login to a Mendix application.
 * Works with the standard Mendix login page.
 */
async function login(page, url, username, password) {
  await page.goto(url);
  await waitForMendix(page);

  // Standard Mendix login form selectors
  await page.fill("#usernameInput", username);
  await page.fill("#passwordInput", password);
  await page.click("#loginButton");

  // Wait for the app to load after login
  await waitForMendix(page, { timeout: 45000 });
}

/**
 * Click a Mendix widget by its widget name (mx-name-*).
 * In Studio Pro, this is the "Name" property of the widget.
 * 
 * Example: clickWidget(page, 'btnSave') clicks the element with class 'mx-name-btnSave'
 */
async function clickWidget(page, widgetName, options = {}) {
  const selector = `.mx-name-${widgetName}`;
  await page.waitForSelector(selector, { state: "visible", ...options });
  await page.click(selector);
}

/**
 * Fill a Mendix text input widget by its widget name.
 * Handles the fact that Mendix wraps inputs inside container divs.
 */
async function fillWidget(page, widgetName, value) {
  const selector = `.mx-name-${widgetName} input, .mx-name-${widgetName} textarea`;
  await page.waitForSelector(selector, { state: "visible" });
  await page.fill(selector, value);
}

/**
 * Get the text content of a Mendix widget.
 */
async function getWidgetText(page, widgetName) {
  const selector = `.mx-name-${widgetName}`;
  await page.waitForSelector(selector, { state: "visible" });
  return await page.textContent(selector);
}

/**
 * Select a value in a Mendix dropdown widget.
 */
async function selectDropdown(page, widgetName, value) {
  const selector = `.mx-name-${widgetName} select`;
  await page.waitForSelector(selector, { state: "visible" });
  await page.selectOption(selector, { label: value });
}

/**
 * Wait for a Mendix popup/dialog to appear.
 */
async function waitForPopup(page, options = {}) {
  const { timeout = 10000 } = options;
  await page.waitForSelector(".modal-dialog, .mx-dialog", {
    state: "visible",
    timeout,
  });
  // Small delay for Mendix animation
  await page.waitForTimeout(300);
}

/**
 * Close a Mendix popup/dialog by clicking the close button.
 */
async function closePopup(page) {
  await page.click(".modal-dialog .close, .mx-dialog .close");
  try {
    await page.waitForSelector(".modal-dialog, .mx-dialog", {
      state: "hidden",
      timeout: 5000,
    });
  } catch {
    // Dialog might already be gone
  }
}

/**
 * Click a button in a Mendix datagrid row.
 * Finds the row containing `rowText` and clicks the button named `buttonName` in that row.
 */
async function clickDataGridRowButton(page, gridName, rowText, buttonName) {
  const grid = `.mx-name-${gridName}`;
  const row = page.locator(`${grid} .mx-datagrid-row`).filter({ hasText: rowText });
  await row.locator(`.mx-name-${buttonName}`).click();
}

/**
 * Get the row count of a Mendix datagrid.
 */
async function getDataGridRowCount(page, gridName) {
  const selector = `.mx-name-${gridName} .mx-datagrid-row`;
  await page.waitForSelector(selector, { timeout: 10000 }).catch(() => {});
  return await page.locator(selector).count();
}

/**
 * Wait for a Mendix microflow to complete.
 * Watches for the progress indicator to appear and then disappear.
 */
async function waitForMicroflow(page, options = {}) {
  const { timeout = 30000 } = options;

  // Wait for progress to appear (microflow started)
  try {
    await page.waitForSelector(".mx-progress", {
      state: "visible",
      timeout: 3000,
    });
  } catch {
    // Fast microflow — may have already completed
    return;
  }

  // Wait for it to disappear (microflow completed)
  await page.waitForSelector(".mx-progress", {
    state: "hidden",
    timeout,
  });
}

/**
 * Take a named screenshot and save it to the results folder.
 */
async function takeScreenshot(page, name, resultsDir) {
  const path = `${resultsDir}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  return path;
}

async function selectComboBox(page, widgetName, value) {
  const widget = `.mx-name-${widgetName}`;

  await page.click(widget);
  await page.waitForTimeout(300);

  const nativeSelect = page.locator(`${widget} select`);
  if (await nativeSelect.count() > 0) {
    await nativeSelect.selectOption({ label: value });
    return;
  }

  const searchInput = page.locator(`${widget} input[role="combobox"], ${widget} input[type="text"]`);
  if (await searchInput.count() > 0) {
    await searchInput.fill(value);
    await page.waitForTimeout(500);
    await page.getByRole("option", { name: value }).first().click();
    return;
  }

  const menuItem = page
    .locator('[role="listbox"] [role="option"]')
    .filter({ hasText: value });
  if (await menuItem.count() > 0) {
    await menuItem.first().click();
    return;
  }

  await page.getByText(value, { exact: true }).first().click();
}

async function selectAutoComplete(page, widgetName, value) {
  const widget = `.mx-name-${widgetName}`;
  const input = page.locator(`${widget} input`);
  await input.click();
  await input.fill(value);
  await page.waitForTimeout(800);
  await page.getByRole("option", { name: value }).first().click();
}

module.exports = {
  waitForMendix,
  login,
  clickWidget,
  fillWidget,
  getWidgetText,
  selectDropdown,
  waitForPopup,
  closePopup,
  clickDataGridRowButton,
  getDataGridRowCount,
  waitForMicroflow,
  takeScreenshot,
  selectComboBox,
  selectAutoComplete,
};
