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

  /**
   * Detect whether a value looks like a Mendix internal GUID rather than
   * human-readable label text.  Mendix GUIDs are typically:
   *  - Long numeric IDs (e.g. "12345678901234")
   *  - UUIDs (e.g. "a1b2c3d4-e5f6-7890-abcd-ef1234567890")
   *  - Hex strings (e.g. "5a3f9c1b2d4e")
   */
  function looksLikeGuid(value) {
    if (!value || typeof value !== 'string') return false;
    const v = value.trim();
    // Pure numeric ID (10+ digits — short numbers like "1" or "42" could be legit values)
    if (/^\d{10,}$/.test(v)) return true;
    // UUID pattern
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true;
    // Long hex string (12+ hex chars, no spaces or readable text)
    if (/^[0-9a-f]{12,}$/i.test(v)) return true;
    return false;
  }

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
    const screenshotSuffix = step.screenshot ? ' // @zoniq:screenshot' : '';

    const SELECTOR_REQUIRED = ['Click', 'Fill', 'SelectDropdown', 'AssertText', 'AssertVisible', 'AssertEnabled', 'AssertDisabled'];
    if (SELECTOR_REQUIRED.includes(step.action) && !step.selector?.trim()) {
      throw new Error(`Step ${(step.order ?? 0) + 1} ("${step.action}") is missing a selector. Please provide a CSS selector or mx:widgetName.`);
    }

    let code;
    switch (step.action) {
      case "Navigate":
        code = `  await page.goto('${val}');`; break;
      case "Login": {
        if (step.username && step.password) {
          const u = escapeJsString(step.username);
          const p = escapeJsString(step.password);
          code = `  await mx.login(page, TARGET_URL, '${u}', '${p}');`;
        } else {
          code = `  await mx.login(page, TARGET_URL, CREDENTIALS.username, CREDENTIALS.password);`;
        }
        break;
      }
      case "Click":
        if (step.selector?.startsWith("mx:"))
          code = `  await mx.clickWidget(page, '${widgetName(step.selector)}');`;
        else if (step.selector?.startsWith("keyboard:"))
          code = `  await page.keyboard.press('${escapeJsString(step.selector.replace(/^keyboard:/, ''))}');`;
        else
          code = `  await ${resolveLocator(step.selector)}.click();`;
        break;
      case "Fill":
        if (step.selector?.startsWith("mx:"))
          code = `  await mx.fillWidget(page, '${widgetName(step.selector)}', '${val}');`;
        else
          code = `  await ${resolveLocator(step.selector)}.fill('${val}');`;
        break;
      case "SelectDropdown":
        if (step.selector?.startsWith("mx:"))
          code = `  await mx.selectDropdown(page, '${widgetName(step.selector)}', '${val}');`;
        else
          code = `  await mx.smartSelect(page, ${resolveLocator(step.selector)}, '${val}');`;
        break;
      case "AssertText":
        if (step.selector?.startsWith("mx:"))
          code = `  await mx.assertWidgetText(page, '${widgetName(step.selector)}', '${val}', { soft: true });`;
        else
          code = `  await expect.soft(${resolveLocator(step.selector)}, 'Step ${step.order}: "${sel}" should contain "${val}"').toContainText('${val}');`;
        break;
      case "AssertVisible":
        if (step.selector?.startsWith("mx:"))
          code = `  await expect.soft(page.locator('.mx-name-${widgetName(step.selector)}').first(), 'Step ${step.order}: "${widgetName(step.selector)}" should be visible').toBeVisible();`;
        else
          code = `  await expect.soft(${resolveLocator(step.selector)}, 'Step ${step.order}: "${sel}" should be visible').toBeVisible();`;
        break;
      case "AssertEnabled":
        if (step.selector?.startsWith("mx:"))
          code = `  await mx.assertWidgetEnabled(page, '${widgetName(step.selector)}');`;
        else
          code = `  await expect.soft(${resolveLocator(step.selector)}, 'Step ${step.order}: "${sel}" should be enabled').toBeEnabled();`;
        break;
      case "AssertDisabled":
        if (step.selector?.startsWith("mx:"))
          code = `  await mx.assertWidgetDisabled(page, '${widgetName(step.selector)}');`;
        else
          code = `  await expect.soft(${resolveLocator(step.selector)}, 'Step ${step.order}: "${sel}" should be disabled').toBeDisabled();`;
        break;
      case "Wait":
        code = `  await page.waitForTimeout(${parseInt(step.value, 10) || 1000}); // WARNING: Hard wait — prefer mx.waitForMendix() or a specific condition`; break;
      case "WaitForMendix":
        code = `  await mx.waitForMendix(page);`; break;
      case "WaitForPopup":
        code = `  await mx.waitForPopup(page);`; break;
      case "ClosePopup":
        code = `  await mx.closePopup(page);`; break;
      case "WaitForMicroflow":
        code = `  await mx.waitForMicroflow(page);`; break;
      case "Logout":
        code = `  await page.goto(TARGET_URL + '/logout');`; break;
      case "Screenshot":
        code = `  await page.screenshot({ path: 'results/${val || "screenshot"}.png', fullPage: true });`; break;
      case "Raw":
        code = `  ${step.value}`; break;
      default:
        code = `  // Unknown action: ${escapeJsString(step.action)}`;
    }

    // Append screenshot marker if the step has the screenshot flag enabled
    if (screenshotSuffix) {
      const lines = code.split('\n');
      lines[lines.length - 1] += screenshotSuffix;
      code = lines.join('\n');
    }
    return code;
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

      // Strip trailing inline comments before checking statement termination.
      // Blank out string literals (preserving length) so // inside URLs aren't mistaken for comments.
      const _noStrings = trimmed.replace(/'[^']*'|"[^"]*"/g, m => ' '.repeat(m.length));
      const _commentIdx = _noStrings.search(/\s*\/\//);
      const codeOnly = _commentIdx >= 0 ? trimmed.substring(0, _commentIdx).trimEnd() : trimmed;

      if (braceDepth <= 0 && parenDepth <= 0 && (codeOnly.endsWith(';') || codeOnly.endsWith(')'))) {
        // Don't finalize if the next non-empty line starts with '.' (method chaining)
        let isChained = false;
        if (!codeOnly.endsWith(';')) {
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
    if (/mx\.login\s*\(/.test(stmt)) {
      const mLogin = stmt.match(/mx\.login\s*\(\s*page\s*,\s*\S+\s*,\s*'([^']*)'/);
      return mLogin ? { action: 'Login', username: mLogin[1] } : { action: 'Login' };
    }
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
    let prevParsed = null;
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

      // Detect and strip screenshot marker before parsing
      const hasScreenshot = /\/\/\s*@zoniq:screenshot\s*$/.test(stmt.text);
      const cleanedText = hasScreenshot ? stmt.text.replace(/\s*\/\/\s*@zoniq:screenshot\s*$/, '') : stmt.text;
      const step = parseStatement(cleanedText) ?? { action: 'Raw', value: cleanedText };
      // Skip redundant Navigate steps
      if (step.action === 'Navigate' && step.value) {
        try {
          const url = new URL(step.value);
          const origin = url.origin;
          const isRootish = url.pathname === '/' || url.pathname === '';
          if (isRootish && visitedOrigins.has(origin)) continue;
          // Click → goto(root) pattern: Mendix client-side navigation causes
          // codegen to emit spurious root-URL gotos after button clicks
          if (isRootish && prevParsed &&
              ['Click', 'SelectDropdown'].includes(prevParsed.action)) continue;
          visitedOrigins.add(origin);
        } catch { /* not a valid URL, keep it */ }
      }
      prevParsed = step;
      step.order = steps.length;
      step.selector = step.selector || '';
      step.value = step.value || '';
      // Strip GUID values from SelectDropdown steps — users should see
      // human-readable label text, not internal Mendix IDs.  The script
      // (source of truth) still contains the GUID; smartSelect resolves
      // it to the visible option label at runtime.
      if (step.action === 'SelectDropdown' && looksLikeGuid(step.value)) {
        step.value = '';
      }
      if (hasScreenshot) step.screenshot = true;
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
    // Strip screenshot marker before describing
    const cleaned = stmtText.replace(/\s*\/\/\s*@zoniq:screenshot\s*$/, '');
    const step = parseStatement(cleaned);
    if (!step) return cleaned.slice(0, 60).replace(/'/g, "\\'");
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

  // ── Script Cleanup ───────────────────────────────────────

  /**
   * Actions where consecutive duplicates on the same selector should collapse
   * (keep last). These are truly idempotent — doing them twice is always
   * redundant. Click is intentionally excluded: two consecutive clicks on the
   * same selector often target different DOM elements (e.g. Save in a popup
   * then Save on the underlying page). Rule 7 still handles the most common
   * redundant-click case (click before fill on the same element).
   */
  const DEDUP_ACTIONS = new Set([
    'WaitForMendix', 'WaitForPopup', 'WaitForMicroflow', 'ClosePopup',
  ]);

  /**
   * Actions where the user likely corrected a value — keep last occurrence.
   */
  const SUPERSEDE_ACTIONS = new Set(['Fill', 'SelectDropdown']);

  /**
   * Canonical key for comparing whether two parsed steps target the same element.
   */
  function _stepKey(parsed) {
    if (!parsed) return null;
    return parsed.action + '::' + (parsed.selector || '') ;
  }

  /**
   * Clean up a recorded script by removing common recording mistakes:
   * duplicate clicks, fill corrections, redundant navigation, etc.
   *
   * Returns { cleanedScript, changes: [{ original, reason }], removedCount }.
   * Does NOT modify the original — returns a new script string.
   */
  function cleanupScript(script) {
    const noChange = { cleanedScript: script, changes: [], removedCount: 0 };
    if (!script) return noChange;

    const body = extractTestBody(script);
    if (!body) return noChange;

    const statements = splitIntoStatements(body);
    if (statements.length < 2) return noChange;

    // Build entries with parsed info
    const entries = statements.map(stmt => ({
      stmt,
      parsed: parseStatement(stmt.text),
      removed: false,
      reason: null,
    }));

    // ── Rule passes (mark earlier/redundant entries for removal) ──

    for (let i = 0; i < entries.length - 1; i++) {
      if (entries[i].removed) continue;
      const cur = entries[i];
      const nxt = entries[i + 1];
      if (!cur.parsed || !nxt.parsed) continue;

      const curKey = _stepKey(cur.parsed);
      const nxtKey = _stepKey(nxt.parsed);

      // Rule 1: Consecutive duplicate idempotent actions (same action + selector)
      if (DEDUP_ACTIONS.has(cur.parsed.action) && curKey === nxtKey) {
        cur.removed = true;
        cur.reason = `Removed duplicate ${cur.parsed.action}` +
          (cur.parsed.selector ? ` on ${cur.parsed.selector}` : '');
        continue;
      }

      // Rule 2: Fill/Select correction — same selector, keep last value
      if (SUPERSEDE_ACTIONS.has(cur.parsed.action) && curKey === nxtKey) {
        cur.removed = true;
        cur.reason = `Removed superseded ${cur.parsed.action}` +
          (cur.parsed.selector ? ` on ${cur.parsed.selector}` : '') +
          (nxt.parsed.value ? ` (kept: '${nxt.parsed.value}')` : '');
        continue;
      }

      // Rule 3: Consecutive identical waits (parameterless)
      if (cur.parsed.action === nxt.parsed.action &&
          ['WaitForMendix', 'WaitForPopup', 'WaitForMicroflow'].includes(cur.parsed.action)) {
        cur.removed = true;
        cur.reason = `Removed consecutive duplicate ${cur.parsed.action}`;
        continue;
      }

      // Rule 4: Redundant consecutive Navigate to same URL
      if (cur.parsed.action === 'Navigate' && nxt.parsed.action === 'Navigate' &&
          cur.parsed.value === nxt.parsed.value) {
        nxt.removed = true;
        nxt.reason = `Removed duplicate navigation to ${nxt.parsed.value}`;
        continue;
      }
    }

    // Rule 5: Navigate detour — goto(A) → goto(B) → goto(A) with no real actions between
    for (let i = 0; i < entries.length - 2; i++) {
      if (entries[i].removed) continue;
      const a = entries[i];
      if (!a.parsed || a.parsed.action !== 'Navigate') continue;

      // Look ahead for pattern: Navigate(B) → Navigate(A) with only Navigate steps between
      let j = i + 1;
      let allNavigates = true;
      while (j < entries.length) {
        if (entries[j].removed) { j++; continue; }
        if (!entries[j].parsed || entries[j].parsed.action !== 'Navigate') {
          allNavigates = false;
          break;
        }
        // Found return to same URL?
        if (entries[j].parsed.value === a.parsed.value && j > i + 1) {
          // Remove everything between i+1 and j (inclusive) — the detour
          for (let k = i + 1; k <= j; k++) {
            if (!entries[k].removed && entries[k].parsed?.action === 'Navigate') {
              entries[k].removed = true;
              entries[k].reason = k === j
                ? `Removed redundant return navigation to ${a.parsed.value}`
                : `Removed navigation detour to ${entries[k].parsed.value}`;
            }
          }
          break;
        }
        j++;
      }
    }

    // Rule 6: Click → goto(root) — Mendix client-side navigation artifact
    // Codegen records a spurious page.goto(root) when a button click triggers
    // Mendix client-side navigation
    for (let i = 0; i < entries.length - 1; i++) {
      if (entries[i].removed) continue;
      const cur = entries[i];
      const nxt = entries.slice(i + 1).find(e => !e.removed);
      if (!nxt) break;
      if (!cur.parsed || !['Click', 'SelectDropdown'].includes(cur.parsed.action)) continue;
      if (!nxt.parsed || nxt.parsed.action !== 'Navigate' || !nxt.parsed.value) continue;
      try {
        const url = new URL(nxt.parsed.value);
        const isRootish = url.pathname === '/' || url.pathname === '';
        if (isRootish) {
          nxt.removed = true;
          nxt.reason = `Removed spurious root navigation after ${cur.parsed.action}` +
            (cur.parsed.selector ? ` on ${cur.parsed.selector}` : '');
        }
      } catch { /* not a valid URL, skip */ }
    }

    // Rule 7: Click immediately before Fill on the same selector — the fill
    // already focuses the element, so the click is redundant.
    for (let i = 0; i < entries.length - 1; i++) {
      if (entries[i].removed) continue;
      const cur = entries[i];
      // Find the next non-removed entry
      let j = i + 1;
      while (j < entries.length && entries[j].removed) j++;
      if (j >= entries.length) break;
      const nxt = entries[j];
      if (!cur.parsed || !nxt.parsed) continue;

      if (cur.parsed.action === 'Click' && nxt.parsed.action === 'Fill' &&
          cur.parsed.selector && cur.parsed.selector === nxt.parsed.selector) {
        cur.removed = true;
        cur.reason = `Removed redundant Click before Fill on ${cur.parsed.selector}`;
      }
    }

    // ── Reconstruct the cleaned script ──

    const changes = entries
      .filter(e => e.removed)
      .map(e => ({ original: e.stmt.text, reason: e.reason }));

    if (changes.length === 0) return noChange;

    // Remove statements from script in reverse order to preserve line positions.
    // Track occurrence counts for duplicate source texts.
    let cleanedScript = script;
    const occurrenceCounts = new Map(); // sourceText → count of prior occurrences

    // First, count all occurrences of each sourceText in the full entries list
    // so we can compute the correct occurrence index for removeFromScript.
    const seenCounts = new Map();
    const entryOccurrences = entries.map(e => {
      const key = e.stmt.text;
      const idx = seenCounts.get(key) || 0;
      seenCounts.set(key, idx + 1);
      return idx;
    });

    // Process removals in reverse to keep indices stable
    for (let i = entries.length - 1; i >= 0; i--) {
      if (!entries[i].removed) continue;
      // Recount occurrence in the current (partially modified) script
      // since earlier removals (processed later in reverse) haven't happened yet.
      // We stored the original occurrence index — use it directly.
      cleanedScript = removeFromScript(cleanedScript, entries[i].stmt.text, entryOccurrences[i]);
    }

    return { cleanedScript, changes, removedCount: changes.length };
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
  exports.looksLikeGuid = looksLikeGuid;
  exports.cleanupScript = cleanupScript;

})(typeof module !== 'undefined' && module.exports ? module.exports : (window.ScriptUtils = {}));
