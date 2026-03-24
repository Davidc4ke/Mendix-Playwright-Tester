/**
 * browser-context.js — Bridge between Playwright browser and LLM
 *
 * Extracts structured page state (Mendix widgets, accessibility tree, dialogs)
 * and executes LLM-decided actions using Mendix helpers.
 */

const path = require("path");
const mx = require(path.resolve(__dirname, "..", "helpers", "mendix-helpers"));

class BrowserContext {
  constructor(page) {
    this.page = page;
  }

  /**
   * Extract a compact, LLM-friendly representation of the current page.
   */
  async getPageState() {
    const page = this.page;

    const url = page.url();
    const title = await page.title();

    // Extract Mendix widgets via page.evaluate
    const mendixWidgets = await page.evaluate(() => {
      const widgets = [];
      const elements = document.querySelectorAll("[class*='mx-name-']");
      for (const el of elements) {
        const classes = Array.from(el.classList);
        const mxClass = classes.find((c) => c.startsWith("mx-name-"));
        if (!mxClass) continue;

        const name = mxClass.replace("mx-name-", "");
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden";
        if (!visible) continue;

        // Determine widget type from classes
        let type = "unknown";
        if (classes.some((c) => /button|btn/i.test(c)) || el.tagName === "BUTTON") type = "button";
        else if (el.querySelector("input[type='text'], input:not([type])")) type = "textbox";
        else if (el.querySelector("textarea")) type = "textarea";
        else if (el.querySelector("select")) type = "dropdown";
        else if (el.querySelector("input[type='checkbox']")) type = "checkbox";
        else if (el.querySelector("input[type='radio']")) type = "radio";
        else if (el.querySelector("input[type='date'], input[type='datetime-local']")) type = "datepicker";
        else if (classes.some((c) => /datagrid/i.test(c))) type = "datagrid";
        else if (classes.some((c) => /listview/i.test(c))) type = "listview";
        else if (el.tagName === "A" || el.querySelector("a")) type = "link";
        else if (el.querySelector("img")) type = "image";
        else type = "container";

        // Get current value if it's an input
        let value = null;
        const input = el.querySelector("input, textarea, select");
        if (input) value = input.value || null;

        // Get text content (truncated)
        const textContent = el.textContent?.trim().substring(0, 100) || null;

        const enabled = !el.hasAttribute("disabled") && !el.classList.contains("disabled");

        widgets.push({ name, type, visible: true, enabled, value, text: textContent });
      }
      return widgets;
    });

    // Check for open dialogs/modals
    const dialogs = await page.evaluate(() => {
      const modals = [];
      const selectors = [".modal-dialog", ".mx-dialog", ".mx-window-active"];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el.offsetWidth > 0 && el.offsetHeight > 0) {
            modals.push({
              type: sel.replace(".", ""),
              title: el.querySelector(".modal-title, .mx-title, h4, h3")?.textContent?.trim() || "",
              text: el.textContent?.trim().substring(0, 300) || "",
            });
          }
        }
      }
      return modals;
    });

    // Get page navigation elements
    const navigation = await page.evaluate(() => {
      const navItems = [];
      const navEls = document.querySelectorAll("nav a, .mx-navigationtree a, [class*='mx-name-'] a");
      for (const el of navEls) {
        if (el.offsetWidth > 0 && el.offsetHeight > 0) {
          navItems.push({
            text: el.textContent?.trim().substring(0, 80) || "",
            href: el.getAttribute("href") || "",
          });
        }
      }
      return navItems.slice(0, 20);
    });

    return { url, title, mendixWidgets, dialogs, navigation };
  }

  /**
   * Format page state as a string for LLM consumption.
   */
  async getPageStateText() {
    const state = await this.getPageState();
    const lines = [];

    lines.push(`## Current Page`);
    lines.push(`URL: ${state.url}`);
    lines.push(`Title: ${state.title}`);

    if (state.dialogs.length) {
      lines.push(`\n### Open Dialogs`);
      state.dialogs.forEach((d) => {
        lines.push(`- [${d.type}] "${d.title}" — ${d.text.substring(0, 100)}`);
      });
    }

    if (state.mendixWidgets.length) {
      lines.push(`\n### Mendix Widgets (${state.mendixWidgets.length} visible)`);
      for (const w of state.mendixWidgets) {
        let desc = `- ${w.type}: **${w.name}**`;
        if (!w.enabled) desc += " (disabled)";
        if (w.value) desc += ` [value="${w.value}"]`;
        if (w.text && w.type !== "container" && w.text.length < 60) desc += ` "${w.text}"`;
        lines.push(desc);
      }
    }

    if (state.navigation.length) {
      lines.push(`\n### Navigation`);
      state.navigation.forEach((n) => {
        lines.push(`- "${n.text}" → ${n.href}`);
      });
    }

    return lines.join("\n");
  }

  /**
   * Execute a single action decided by the LLM.
   * @param {object} action — { action: string, widget?: string, selector?: string, value?: string, ... }
   * @returns {{ success: boolean, error?: string }}
   */
  async executeAction(action) {
    const page = this.page;

    try {
      switch (action.action) {
        case "click":
          if (action.widget) {
            await mx.clickWidget(page, action.widget, { timeout: 10000 });
          } else if (action.selector) {
            await mx.resolveLocator(page, action.selector).click({ timeout: 10000 });
          } else {
            return { success: false, error: "click requires widget or selector" };
          }
          await this._waitBriefly();
          return { success: true };

        case "fill":
          if (action.widget) {
            await mx.fillWidget(page, action.widget, action.value || "", { timeout: 10000 });
          } else if (action.selector) {
            await mx.resolveLocator(page, action.selector).fill(action.value || "", { timeout: 10000 });
          } else {
            return { success: false, error: "fill requires widget or selector" };
          }
          return { success: true };

        case "select":
          if (action.widget) {
            await mx.selectDropdown(page, action.widget, action.value || "");
          } else {
            return { success: false, error: "select requires widget" };
          }
          return { success: true };

        case "navigate":
          await page.goto(action.url || action.value, { waitUntil: "domcontentloaded" });
          await mx.waitForMendix(page);
          return { success: true };

        case "login":
          await mx.login(page, action.url || page.url(), action.username, action.password);
          return { success: true };

        case "waitForMendix":
          await mx.waitForMendix(page);
          return { success: true };

        case "waitForPopup":
          await mx.waitForPopup(page);
          return { success: true };

        case "closePopup":
          await mx.closePopup(page);
          return { success: true };

        case "screenshot":
          await page.screenshot({ path: action.path || "agent-screenshot.png", fullPage: true });
          return { success: true };

        case "scroll":
          await page.evaluate((direction) => {
            window.scrollBy(0, direction === "up" ? -400 : 400);
          }, action.direction || "down");
          return { success: true };

        case "wait":
          await page.waitForTimeout(Math.min(action.ms || 1000, 5000));
          return { success: true };

        case "done":
          return { success: true, done: true };

        default:
          return { success: false, error: `Unknown action: ${action.action}` };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async _waitBriefly() {
    try {
      await mx.waitForMendix(this.page, { timeout: 3000 });
    } catch {}
  }
}

module.exports = { BrowserContext };
