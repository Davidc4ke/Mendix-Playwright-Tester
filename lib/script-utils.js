/**
 * Shared utilities for script ↔ step conversion.
 * Used by both the Electron main process (main.js) and the renderer (index.html).
 */
(function (exports) {
  'use strict';

  // ── Constants ──────────────────────────────────────────

  const STEP_ACTION_CONFIG = {
    Navigate:         { selector: false, value: true,  valuePlaceholder: "URL" },
    Login:            { selector: false, value: false },
    Click:            { selector: true,  value: false, selectorPlaceholder: "mx:widgetName or CSS selector" },
    Fill:             { selector: true,  value: true,  selectorPlaceholder: "mx:widgetName or CSS selector", valuePlaceholder: "Text to fill" },
    SelectDropdown:   { selector: true,  value: true,  selectorPlaceholder: "mx:widgetName", valuePlaceholder: "Option text" },
    AssertText:       { selector: true,  value: true,  selectorPlaceholder: "mx:widgetName or CSS selector", valuePlaceholder: "Expected text" },
    AssertVisible:    { selector: true,  value: false, selectorPlaceholder: "mx:widgetName or CSS selector" },
    AssertEnabled:    { selector: true,  value: false, selectorPlaceholder: "mx:widgetName or CSS selector" },
    AssertDisabled:   { selector: true,  value: false, selectorPlaceholder: "mx:widgetName or CSS selector" },
    Wait:             { selector: false, value: true,  valuePlaceholder: "Milliseconds" },
    WaitForMendix:    { selector: false, value: false },
    WaitForPopup:     { selector: false, value: false },
    ClosePopup:       { selector: false, value: false },
    WaitForMicroflow: { selector: false, value: false },
    Screenshot:       { selector: false, value: true,  valuePlaceholder: "Filename (no extension)" },
    Raw:              { selector: false, value: true,  valuePlaceholder: "Raw Playwright statement" },
  };

  const ARIA_ROLES = new Set([
    'alert','alertdialog','application','article','banner','blockquote','button',
    'caption','cell','checkbox','code','columnheader','combobox','complementary',
    'contentinfo','definition','deletion','dialog','directory','document',
    'emphasis','feed','figure','form','generic','grid','gridcell','group',
    'heading','img','insertion','link','list','listbox','listitem','log','main',
    'marquee','math','meter','menu','menubar','menuitem','menuitemcheckbox',
    'menuitemradio','navigation','none','note','option','paragraph','presentation',
    'progressbar','radio','radiogroup','region','row','rowgroup','rowheader',
    'scrollbar','search','searchbox','separator','slider','spinbutton','status',
    'strong','subscript','superscript','switch','tab','table','tablist','tabpanel',
    'term','textbox','time','timer','toolbar','tooltip','tree','treegrid','treeitem',
  ]);

  // ── Helpers ────────────────────────────────────────────

  /** Escape a value for safe embedding inside a single-quoted JS string literal. */
  function escapeJsString(str) {
    return String(str ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n");
  }

  function resolveLocator(selector) {
    if (!selector) return null;
    if (selector.startsWith('label:'))
      return `page.getByLabel('${escapeJsString(selector.slice(6))}')`;
    if (selector.startsWith('text:'))
      return `page.getByText('${escapeJsString(selector.slice(5))}')`;
    if (selector.startsWith('placeholder:'))
      return `page.getByPlaceholder('${escapeJsString(selector.slice(12))}')`;
    if (selector.startsWith('keyboard:'))
      return null; // Handled separately in Click case
    const colonIdx = selector.indexOf(':');
    if (colonIdx > 0) {
      const role = selector.slice(0, colonIdx).toLowerCase();
      const name = selector.slice(colonIdx + 1);
      if (ARIA_ROLES.has(role)) {
        const escapedName = escapeJsString(name);
        return `page.getByRole('${role}', { name: '${escapedName}' })`;
      }
    }
    return `page.locator('${escapeJsString(selector)}')`;
  }

  function selectorToMx(sel) {
    const mxMatch = sel.match(/^\.mx-name-(\w+)/);
    if (mxMatch) return 'mx:' + mxMatch[1];
    return sel;
  }

  // ── Step → Code generation ─────────────────────────────

  function generateStepCode(step) {
    const widgetName = (sel) =>
      escapeJsString(String(sel || "").replace(/^mx:/, ""));
    const val = escapeJsString(step.value);
    const sel = escapeJsString(step.selector);

    const SELECTOR_REQUIRED = ['Click', 'Fill', 'SelectDropdown', 'AssertText', 'AssertVisible', 'AssertEnabled', 'AssertDisabled'];
    if (SELECTOR_REQUIRED.includes(step.action) && !step.selector?.trim()) {
      throw new Error(`Step ${(step.order ?? 0) + 1} ("${step.action}") is missing a selector. Please provide a CSS selector or mx:widgetName.`);
    }

    switch (step.action) {
      case "Navigate":
        return `  await page.goto('${val}');`;
      case "Login": {
        if (step.username && step.password) {
          const u = escapeJsString(step.username);
          const p = escapeJsString(step.password);
          return `  await mx.login(page, TARGET_URL, '${u}', '${p}');`;
        }
        return `  await mx.login(page, TARGET_URL, CREDENTIALS.username, CREDENTIALS.password);`;
      }
      case "Click":
        if (step.selector?.startsWith("mx:"))
          return `  await mx.clickWidget(page, '${widgetName(step.selector)}');`;
        if (step.selector?.startsWith("keyboard:"))
          return `  await page.keyboard.press('${escapeJsString(step.selector.replace(/^keyboard:/, ''))}');`;
        return `  await ${resolveLocator(step.selector)}.click();`;
      case "Fill":
        if (step.selector?.startsWith("mx:"))
          return `  await mx.fillWidget(page, '${widgetName(step.selector)}', '${val}');`;
        return `  await ${resolveLocator(step.selector)}.fill('${val}');`;
      case "SelectDropdown":
        if (step.selector?.startsWith("mx:"))
          return `  await mx.selectDropdown(page, '${widgetName(step.selector)}', '${val}');`;
        return `  await mx.smartSelect(page, ${resolveLocator(step.selector)}, '${val}');`;
      case "AssertText":
        if (step.selector?.startsWith("mx:"))
          return `  await mx.assertWidgetText(page, '${widgetName(step.selector)}', '${val}', { soft: true });`;
        return `  await expect.soft(${resolveLocator(step.selector)}, 'Step ${step.order}: "${sel}" should contain "${val}"').toContainText('${val}');`;
      case "AssertVisible":
        if (step.selector?.startsWith("mx:"))
          return `  await expect.soft(page.locator('.mx-name-${widgetName(step.selector)}').first(), 'Step ${step.order}: "${widgetName(step.selector)}" should be visible').toBeVisible();`;
        return `  await expect.soft(${resolveLocator(step.selector)}, 'Step ${step.order}: "${sel}" should be visible').toBeVisible();`;
      case "AssertEnabled":
        if (step.selector?.startsWith("mx:"))
          return `  await mx.assertWidgetEnabled(page, '${widgetName(step.selector)}');`;
        return `  await expect.soft(${resolveLocator(step.selector)}, 'Step ${step.order}: "${sel}" should be enabled').toBeEnabled();`;
      case "AssertDisabled":
        if (step.selector?.startsWith("mx:"))
          return `  await mx.assertWidgetDisabled(page, '${widgetName(step.selector)}');`;
        return `  await expect.soft(${resolveLocator(step.selector)}, 'Step ${step.order}: "${sel}" should be disabled').toBeDisabled();`;
      case "Wait":
        return `  await page.waitForTimeout(${parseInt(step.value, 10) || 1000}); // WARNING: Hard wait — prefer mx.waitForMendix() or a specific condition`;
      case "WaitForMendix":
        return `  await mx.waitForMendix(page);`;
      case "WaitForPopup":
        return `  await mx.waitForPopup(page);`;
      case "ClosePopup":
        return `  await mx.closePopup(page);`;
      case "WaitForMicroflow":
        return `  await mx.waitForMicroflow(page);`;
      case "Logout":
        return `  await page.goto(TARGET_URL + '/logout');`;
      case "Screenshot":
        return `  await page.screenshot({ path: 'results/${val || "screenshot"}.png', fullPage: true });`;
      case "Raw":
        return `  ${step.value}`;
      default:
        return `  // Unknown action: ${escapeJsString(step.action)}`;
    }
  }

  // ── Script → Steps parsing ─────────────────────────────

  /**
   * Extract the test body from a full Playwright script.
   * Strips imports, config, and the test() wrapper.
   */
  function extractTestBody(script) {
    let cleaned = script
      .replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]*['"];\s*$/gm, '')
      .replace(/^import\s+\*\s+as\s+\w+\s+from\s+['"][^'"]*['"];\s*$/gm, '')
      .replace(/^import\s+\w+\s+from\s+['"][^'"]*['"];\s*$/gm, '')
      .replace(/^const\s+\{[^}]*\}\s*=\s*require\s*\([^)]*\);\s*$/gm, '')
      .replace(/^const\s+\w+\s*=\s*require\s*\([^)]*\);\s*$/gm, '')
      .replace(/^const\s+TARGET_URL\s*=\s*.*;\s*$/gm, '')
      .replace(/^const\s+CREDENTIALS\s*=\s*\{[\s\S]*?\}\s*;\s*$/gm, '')
      .trim();
    cleaned = cleaned.replace(/test\.use\s*\(\s*\{[\s\S]*?\}\s*\)\s*;/g, '').trim();

    const testMatch = cleaned.match(/test\s*\(\s*['"][^'"]*['"]\s*,\s*async\s*\(\s*\{\s*page\s*\}\s*\)\s*=>\s*\{([\s\S]*)\}\s*\)\s*;?\s*$/);
    if (testMatch) return testMatch[1].trim();

    const iifeMatch = cleaned.match(/\(\s*async\s*\(\s*\)\s*=>\s*\{([\s\S]*)\}\s*\)\s*\(\s*\)\s*;?\s*$/);
    if (iifeMatch) return iifeMatch[1].trim();

    if (/await\s+page\./.test(cleaned) || /await\s+mx\./.test(cleaned)) return cleaned;
    return null;
  }

  /**
   * Split a test body into individual statements, tracking source text.
   * Returns array of { text, startLine, endLine } where lines are 0-indexed
   * relative to the test body string.
   */
  function splitIntoStatements(body) {
    const statements = [];
    const lines = body.split('\n');
    let current = '';
    let braceDepth = 0;
    let parenDepth = 0;
    let stmtStartLine = -1;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('console.log')) continue;
      if (/^\}\s*catch\s*\(/.test(trimmed) || /^try\s*\{/.test(trimmed) || /^throw\s+/.test(trimmed)) continue;
      if (/^\[ZONIQ_STEP/.test(trimmed)) continue;

      if (!current) stmtStartLine = lineIdx;
      current += (current ? '\n' : '') + trimmed;
      for (const ch of trimmed) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
        else if (ch === '(') parenDepth++;
        else if (ch === ')') parenDepth--;
      }

      if (braceDepth <= 0 && parenDepth <= 0 && (trimmed.endsWith(';') || trimmed.endsWith(')'))) {
        // Don't finalize if the next non-empty line starts with '.' (method chaining)
        let isChained = false;
        if (!trimmed.endsWith(';')) {
          for (let peek = lineIdx + 1; peek < lines.length; peek++) {
            const nextTrimmed = lines[peek].trim();
            if (!nextTrimmed || nextTrimmed.startsWith('//')) continue;
            if (nextTrimmed.startsWith('.')) isChained = true;
            break;
          }
        }
        if (!isChained) {
          const stmt = current.trim();
          if (stmt.startsWith('await ') || (stmt.startsWith('const ') && stmt.includes('await '))) {
            statements.push({ text: stmt, startLine: stmtStartLine, endLine: lineIdx });
          }
          current = '';
          braceDepth = 0;
          parenDepth = 0;
        }
      }
    }
    if (current.trim()) {
      const stmt = current.trim();
      if (stmt.startsWith('await ') || (stmt.startsWith('const ') && stmt.includes('await '))) {
        statements.push({ text: stmt, startLine: stmtStartLine, endLine: lines.length - 1 });
      }
    }
    return statements;
  }

  /**
   * Parse a single statement into a step object.
   * Returns { action, selector?, value? } or null if unrecognized.
   */
  function parseStatement(stmt) {
    let m;

    // ── Mendix helpers ──
    if (/mx\.login\s*\(/.test(stmt)) return { action: 'Login' };
    if (/mx\.waitForMendix\s*\(/.test(stmt)) return { action: 'WaitForMendix' };
    if (/mx\.waitForPopup\s*\(/.test(stmt)) return { action: 'WaitForPopup' };
    if (/mx\.closePopup\s*\(/.test(stmt)) return { action: 'ClosePopup' };
    if (/mx\.waitForMicroflow\s*\(/.test(stmt)) return { action: 'WaitForMicroflow' };

    m = stmt.match(/mx\.clickWidget\s*\(\s*page\s*,\s*['"]([^'"]+)['"]/);
    if (m) return { action: 'Click', selector: 'mx:' + m[1] };

    m = stmt.match(/mx\.fillWidget\s*\(\s*page\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]/);
    if (m) return { action: 'Fill', selector: 'mx:' + m[1], value: m[2] };

    m = stmt.match(/mx\.selectDropdown\s*\(\s*page\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]/);
    if (m) return { action: 'SelectDropdown', selector: 'mx:' + m[1], value: m[2] };

    m = stmt.match(/mx\.assertWidgetText\s*\(\s*page\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]/);
    if (m) return { action: 'AssertText', selector: 'mx:' + m[1], value: m[2] };

    m = stmt.match(/mx\.assertWidgetEnabled\s*\(\s*page\s*,\s*['"]([^'"]+)['"]/);
    if (m) return { action: 'AssertEnabled', selector: 'mx:' + m[1] };

    m = stmt.match(/mx\.assertWidgetDisabled\s*\(\s*page\s*,\s*['"]([^'"]+)['"]/);
    if (m) return { action: 'AssertDisabled', selector: 'mx:' + m[1] };

    m = stmt.match(/mx\.assertWidgetVisible\s*\(\s*page\s*,\s*['"]([^'"]+)['"]/);
    if (m) return { action: 'AssertVisible', selector: 'mx:' + m[1] };

    // ── Navigation ──
    m = stmt.match(/page\.goto\s*\(\s*['"]([^'"]+)['"]/);
    if (m) return { action: 'Navigate', value: m[1] };

    // ── page.locator(...).action(...) ──
    m = stmt.match(/page\.locator\s*\(\s*['"]([^'"]+)['"]\s*\)[^;]*\.click\s*\(/);
    if (m) return { action: 'Click', selector: selectorToMx(m[1]) };

    m = stmt.match(/page\.locator\s*\(\s*['"]([^'"]+)['"]\s*\)[^;]*\.fill\s*\(\s*['"]([^'"]*)['"]/);
    if (m) return { action: 'Fill', selector: selectorToMx(m[1]), value: m[2] };

    m = stmt.match(/page\.locator\s*\(\s*['"]([^'"]+)['"]\s*\)[^;]*\.selectOption\s*\(\s*['"]([^'"]*)['"]/);
    if (m) return { action: 'SelectDropdown', selector: selectorToMx(m[1]), value: m[2] };

    // ── getByRole(...).click/fill ──
    m = stmt.match(/page\.getByRole\s*\(\s*['"]([^'"]+)['"]\s*,\s*\{\s*name:\s*['"]([^'"]+)['"][^}]*\}\s*\)[^;]*\.click\s*\(/);
    if (m) return { action: 'Click', selector: m[1] + ':' + m[2] };

    m = stmt.match(/page\.getByRole\s*\(\s*['"]([^'"]+)['"]\s*,\s*\{\s*name:\s*['"]([^'"]+)['"][^}]*\}\s*\)[^;]*\.fill\s*\(\s*['"]([^'"]*)['"]/);
    if (m) return { action: 'Fill', selector: m[1] + ':' + m[2], value: m[3] };

    m = stmt.match(/page\.getByRole\s*\(\s*['"]([^'"]+)['"]\s*,\s*\{\s*name:\s*['"]([^'"]+)['"][^}]*\}\s*\)[^;]*\.selectOption\s*\(\s*['"]([^'"]*)['"]/);
    if (m) return { action: 'SelectDropdown', selector: m[1] + ':' + m[2], value: m[3] };

    // ── getByRole without name ──
    m = stmt.match(/page\.getByRole\s*\(\s*['"]([^'"]+)['"]\s*\)[^;]*\.click\s*\(/);
    if (m) return { action: 'Click', selector: m[1] };

    m = stmt.match(/page\.getByRole\s*\(\s*['"]([^'"]+)['"]\s*\)[^;]*\.fill\s*\(\s*['"]([^'"]*)['"]/);
    if (m) return { action: 'Fill', selector: m[1], value: m[2] };

    // ── getByText(...).click/fill/selectOption ──
    m = stmt.match(/page\.getByText\s*\(\s*['"]([^'"]+)['"]\s*\)[^;]*\.click\s*\(/);
    if (m) return { action: 'Click', selector: 'text:' + m[1] };

    m = stmt.match(/page\.getByText\s*\(\s*['"]([^'"]+)['"]\s*\)[^;]*\.fill\s*\(\s*['"]([^'"]*)['"]/);
    if (m) return { action: 'Fill', selector: 'text:' + m[1], value: m[2] };

    m = stmt.match(/page\.getByText\s*\(\s*['"]([^'"]+)['"]\s*\)[^;]*\.selectOption\s*\(\s*['"]([^'"]*)['"]/);
    if (m) return { action: 'SelectDropdown', selector: 'text:' + m[1], value: m[2] };

    // ── getByLabel(...).fill/click/selectOption ──
    m = stmt.match(/page\.getByLabel\s*\(\s*['"]([^'"]+)['"]\s*\)(?:\s*\.nth\s*\(\s*\d+\s*\))?\s*\.fill\s*\(\s*['"]([^'"]*)['"]/);
    if (m) return { action: 'Fill', selector: 'label:' + m[1], value: m[2] };

    m = stmt.match(/page\.getByLabel\s*\(\s*['"]([^'"]+)['"]\s*\)(?:\s*\.nth\s*\(\s*\d+\s*\))?\s*\.selectOption\s*\(\s*['"]([^'"]*)['"]/);
    if (m) return { action: 'SelectDropdown', selector: 'label:' + m[1], value: m[2] };

    m = stmt.match(/page\.getByLabel\s*\(\s*['"]([^'"]+)['"]\s*\)(?:\s*\.nth\s*\(\s*\d+\s*\))?\s*\.click\s*\(/);
    if (m) return { action: 'Click', selector: 'label:' + m[1] };

    // ── getByPlaceholder(...).fill/click ──
    m = stmt.match(/page\.getByPlaceholder\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.fill\s*\(\s*['"]([^'"]*)['"]/);
    if (m) return { action: 'Fill', selector: 'placeholder:' + m[1], value: m[2] };

    m = stmt.match(/page\.getByPlaceholder\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.click\s*\(/);
    if (m) return { action: 'Click', selector: 'placeholder:' + m[1] };

    // ── Assertions: expect / expect.soft ──
    m = stmt.match(/expect(?:\.soft)?\s*\(\s*page\.locator\s*\(\s*['"]([^'"]+)['"]\s*\).*?\)\s*\.toContainText\s*\(\s*['"]([^'"]*)['"]/);
    if (m) return { action: 'AssertText', selector: selectorToMx(m[1]), value: m[2] };
    m = stmt.match(/expect(?:\.soft)?\s*\(\s*page\.locator\s*\(\s*['"]([^'"]+)['"]\s*\).*?\)\s*\.toHaveText\s*\(\s*['"]([^'"]*)['"]/);
    if (m) return { action: 'AssertText', selector: selectorToMx(m[1]), value: m[2] };

    m = stmt.match(/expect(?:\.soft)?\s*\(\s*page\.locator\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (m && /\.toBeVisible\s*\(/.test(stmt)) return { action: 'AssertVisible', selector: selectorToMx(m[1]) };
    if (m && /\.toBeEnabled\s*\(/.test(stmt)) return { action: 'AssertEnabled', selector: selectorToMx(m[1]) };
    if (m && /\.toBeDisabled\s*\(/.test(stmt)) return { action: 'AssertDisabled', selector: selectorToMx(m[1]) };

    m = stmt.match(/expect(?:\.soft)?\s*\(\s*page\.getByRole\s*\(\s*['"]([^'"]+)['"]\s*,\s*\{\s*name:\s*['"]([^'"]+)['"][^}]*\}\s*\)[^)]*\).*?\.to(?:Contain|Have)Text\s*\(\s*['"]([^'"]*)['"]/);
    if (m) return { action: 'AssertText', selector: m[1] + ':' + m[2], value: m[3] };

    m = stmt.match(/expect(?:\.soft)?\s*\(\s*page\.getByRole\s*\(\s*['"]([^'"]+)['"]\s*,\s*\{\s*name:\s*['"]([^'"]+)['"][^}]*\}\s*\)/);
    if (m && /\.toBeVisible\s*\(/.test(stmt)) return { action: 'AssertVisible', selector: m[1] + ':' + m[2] };
    if (m && /\.toBeEnabled\s*\(/.test(stmt)) return { action: 'AssertEnabled', selector: m[1] + ':' + m[2] };
    if (m && /\.toBeDisabled\s*\(/.test(stmt)) return { action: 'AssertDisabled', selector: m[1] + ':' + m[2] };

    m = stmt.match(/expect(?:\.soft)?\s*\(\s*page\.getByText\s*\(\s*['"]([^'"]+)['"]/);
    if (m && /\.toBeVisible\s*\(/.test(stmt)) return { action: 'AssertVisible', selector: 'text:' + m[1] };
    if (m && /\.toContainText\s*\(/.test(stmt)) {
      const vm = stmt.match(/\.toContainText\s*\(\s*['"]([^'"]*)['"]/);
      return { action: 'AssertText', selector: 'text:' + m[1], value: vm ? vm[1] : '' };
    }

    m = stmt.match(/expect(?:\.soft)?\s*\(\s*page\.getByLabel\s*\(\s*['"]([^'"]+)['"]/);
    if (m && /\.toBeVisible\s*\(/.test(stmt)) return { action: 'AssertVisible', selector: 'label:' + m[1] };

    // ── Waits ──
    m = stmt.match(/page\.waitForTimeout\s*\(\s*(\d+)/);
    if (m) return { action: 'Wait', value: m[1] };

    if (/page\.waitForLoadState\s*\(/.test(stmt) || /page\.waitForURL\s*\(/.test(stmt))
      return { action: 'WaitForMendix' };

    // ── Screenshot ──
    m = stmt.match(/page\.screenshot\s*\(\s*\{[^}]*path:\s*['"](?:results\/)?([^'"]+?)(?:\.png)?['"]/);
    if (m) return { action: 'Screenshot', value: m[1] };

    // ── Keyboard press ──
    m = stmt.match(/page\.keyboard\.press\s*\(\s*['"]([^'"]+)['"]/);
    if (m) return { action: 'Click', selector: 'keyboard:' + m[1] };

    // ── Old Playwright API ──
    m = stmt.match(/page\.fill\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]/);
    if (m) return { action: 'Fill', selector: selectorToMx(m[1]), value: m[2] };

    m = stmt.match(/page\.type\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]/);
    if (m) return { action: 'Fill', selector: selectorToMx(m[1]), value: m[2] };

    m = stmt.match(/page\.(?:check|uncheck|dblclick|click)\s*\(\s*['"]([^'"]+)['"]/);
    if (m) return { action: 'Click', selector: selectorToMx(m[1]) };

    return null;
  }

  /**
   * Parse a full script into steps with source tracking.
   * Each step has: { action, selector, value, order, sourceText, startLine, endLine }
   * sourceText is the trimmed original statement for replacement in the script.
   */
  function parseScriptToSteps(script) {
    if (!script) return [];
    const body = extractTestBody(script);
    if (!body) return [];
    const statements = splitIntoStatements(body);
    const steps = [];
    const visitedOrigins = new Set();
    for (const stmt of statements) {
      // Skip Playwright Codegen browser/context/page lifecycle boilerplate.
      // These are generated by Codegen's IIFE wrapper but are redundant when
      // the script runs via Playwright's test runner (which provides `page`).
      if (/const\s+browser\s*=\s*await\s+\S+\.launch\s*\(/.test(stmt.text)) continue;
      if (/const\s+context\s*=\s*await\s+browser\.newContext\s*\(/.test(stmt.text)) continue;
      if (/const\s+page\s*=\s*await\s+context\.newPage\s*\(/.test(stmt.text)) continue;
      if (/await\s+page\.close\s*\(\s*\)/.test(stmt.text)) continue;
      if (/await\s+context\.close\s*\(\s*\)/.test(stmt.text)) continue;
      if (/await\s+browser\.close\s*\(\s*\)/.test(stmt.text)) continue;

      const step = parseStatement(stmt.text) ?? { action: 'Raw', value: stmt.text };
      // Skip redundant Navigate steps
      if (step.action === 'Navigate' && step.value) {
        try {
          const url = new URL(step.value);
          const origin = url.origin;
          const isRootish = url.pathname === '/' || url.pathname === '';
          if (isRootish && visitedOrigins.has(origin)) continue;
          visitedOrigins.add(origin);
        } catch { /* not a valid URL, keep it */ }
      }
      step.order = steps.length;
      step.selector = step.selector || '';
      step.value = step.value || '';
      step.sourceText = stmt.text;
      step.startLine = stmt.startLine;
      step.endLine = stmt.endLine;
      steps.push(step);
    }
    return steps;
  }

  /**
   * Replace a statement in a script by finding the sourceText and substituting new code.
   * Handles indentation: finds the original indented line(s) and replaces with new code.
   * Returns the updated script, or the original if sourceText wasn't found.
   */
  function replaceInScript(script, sourceText, newCode, occurrence) {
    // The sourceText is trimmed (from splitIntoStatements). We need to find it
    // within the script body, accounting for indentation.
    // Strategy: split sourceText into its lines, find each line (trimmed) in the script,
    // then replace the full original indented block with the new code.
    // occurrence (0-indexed) controls which match to replace when sourceText appears
    // multiple times (e.g., duplicate `await mx.waitForMendix(page);` lines).
    const targetOccurrence = occurrence || 0;
    const sourceLines = sourceText.split('\n').map(l => l.trim());
    const scriptLines = script.split('\n');

    // Find the Nth occurrence of the source text in the script
    let matchStart = -1;
    let found = 0;
    for (let i = 0; i < scriptLines.length; i++) {
      if (scriptLines[i].trim() === sourceLines[0]) {
        // Check if all subsequent source lines match
        let allMatch = true;
        for (let j = 1; j < sourceLines.length; j++) {
          if (i + j >= scriptLines.length || scriptLines[i + j].trim() !== sourceLines[j]) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) {
          if (found === targetOccurrence) {
            matchStart = i;
            break;
          }
          found++;
        }
      }
    }

    if (matchStart === -1) return script; // Not found, return unchanged

    // Detect the indentation of the original first line
    const indentMatch = scriptLines[matchStart].match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '  ';

    // Build replacement: apply the same indentation to the new code
    const newLines = newCode.split('\n').map(l => {
      const trimmed = l.trimStart();
      return trimmed ? indent + trimmed : l;
    });

    // Splice the script lines
    scriptLines.splice(matchStart, sourceLines.length, ...newLines);
    return scriptLines.join('\n');
  }

  /**
   * Describe a statement for progress marker display.
   * Returns a short human-readable description.
   */
  function describeStatement(stmtText) {
    const step = parseStatement(stmtText);
    if (!step) return stmtText.slice(0, 60).replace(/'/g, "\\'");
    const desc = step.action === 'Login'
      ? 'Login'
      : `${step.action}${step.selector ? ' ' + step.selector : ''}${step.value ? ' = ' + step.value : ''}`;
    return escapeJsString(desc);
  }

  /**
   * Remove a statement from the script by its source text.
   * Uses the same occurrence logic as replaceInScript to handle duplicates.
   */
  function removeFromScript(script, sourceText, occurrence) {
    const targetOccurrence = occurrence || 0;
    const sourceLines = sourceText.split('\n').map(l => l.trim());
    const scriptLines = script.split('\n');

    let matchStart = -1;
    let found = 0;
    for (let i = 0; i < scriptLines.length; i++) {
      if (scriptLines[i].trim() === sourceLines[0]) {
        let allMatch = true;
        for (let j = 1; j < sourceLines.length; j++) {
          if (i + j >= scriptLines.length || scriptLines[i + j].trim() !== sourceLines[j]) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) {
          if (found === targetOccurrence) {
            matchStart = i;
            break;
          }
          found++;
        }
      }
    }

    if (matchStart === -1) return script;

    // Remove the matched lines and any trailing blank line
    let removeCount = sourceLines.length;
    if (matchStart + removeCount < scriptLines.length && scriptLines[matchStart + removeCount].trim() === '') {
      removeCount++;
    }
    scriptLines.splice(matchStart, removeCount);
    return scriptLines.join('\n');
  }

  // ── Exports ────────────────────────────────────────────

  exports.STEP_ACTION_CONFIG = STEP_ACTION_CONFIG;
  exports.ARIA_ROLES = ARIA_ROLES;
  exports.escapeJsString = escapeJsString;
  exports.resolveLocator = resolveLocator;
  exports.selectorToMx = selectorToMx;
  exports.generateStepCode = generateStepCode;
  exports.extractTestBody = extractTestBody;
  exports.splitIntoStatements = splitIntoStatements;
  exports.parseStatement = parseStatement;
  exports.parseScriptToSteps = parseScriptToSteps;
  exports.replaceInScript = replaceInScript;
  exports.removeFromScript = removeFromScript;
  exports.describeStatement = describeStatement;

})(typeof module !== 'undefined' && module.exports ? module.exports : (window.ScriptUtils = {}));
