/**
 * Script transformations for Zoniq Test Runner.
 *
 * Pure functions that transform recorded Playwright scripts before execution:
 *   - Strip codegen boilerplate
 *   - Clean fragile Mendix selectors
 *   - Transform .selectOption() into mx.smartSelect()
 *   - Collapse date picker sequences into mx.pickDate()
 *   - Disambiguate locators with .first()
 *   - Transform ListView/DataGrid row clicks into helper calls
 *   - Inject [ZONIQ_STEP] progress markers
 *
 * Used by both the Electron main process and the standalone server.
 */

const path = require("path");
const ScriptUtils = require("./script-utils");
const { getPaths } = require("./paths");

function getMendixHelpersPath() {
  const { HELPERS_DIR } = getPaths();
  return path.resolve(HELPERS_DIR, "mendix-helpers.js").replace(/\\/g, "/");
}

function wrapScript(script, targetUrl, credentials) {
  let scriptBody = script.trim();

  // Strip Codegen's own imports (both ESM and CommonJS)
  scriptBody = scriptBody
    .replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]*['"];\s*$/gm, '')
    .replace(/^import\s+\*\s+as\s+\w+\s+from\s+['"][^'"]*['"];\s*$/gm, '')
    .replace(/^import\s+\w+\s+from\s+['"][^'"]*['"];\s*$/gm, '')
    .replace(/^const\s+\{[^}]*\}\s*=\s*require\s*\([^)]*\);.*$/gm, '')
    .replace(/^const\s+\w+\s*=\s*require\s*\([^)]*\);.*$/gm, '')
    .replace(/^const\s+TARGET_URL\s*=\s*.*;\s*$/gm, '')
    .replace(/^const\s+CREDENTIALS\s*=\s*\{[\s\S]*?\}\s*;\s*$/gm, '')
    .trim();

  scriptBody = scriptBody
    .replace(/test\.use\s*\(\s*\{[\s\S]*?\}\s*\)\s*;/g, '')
    .trim();

  const iifeMatch = scriptBody.match(/^\(\s*async\s*\(\s*\)\s*=>\s*\{([\s\S]*)\}\s*\)\s*\(\s*\)\s*;?\s*$/);
  if (iifeMatch) {
    scriptBody = iifeMatch[1].trim();
  }

  scriptBody = scriptBody
    .replace(/const\s+browser\s*=\s*await\s+chromium\.launch\s*\(\s*\{[\s\S]*?\}\s*\)\s*;/g, '')
    .replace(/const\s+context\s*=\s*await\s+browser\.newContext\s*\(\s*\{[\s\S]*?\}\s*\)\s*;/g, '')
    .replace(/const\s+context\s*=\s*await\s+browser\.newContext\s*\(\s*\)\s*;/g, '')
    .replace(/const\s+page\s*=\s*await\s+context\.newPage\s*\(\s*\)\s*;/g, '')
    .replace(/await\s+page\.close\s*\(\s*\)\s*;/g, '')
    .replace(/await\s+context\.close\s*\(\s*\)\s*;/g, '')
    .replace(/await\s+browser\.close\s*\(\s*\)\s*;/g, '')
    .replace(/\/\/\s*-{3,}\s*$/gm, '')
    .trim();

  scriptBody = cleanMendixSelectors(scriptBody);
  scriptBody = transformSelectOptionCalls(scriptBody);
  scriptBody = transformDatePickerClicks(scriptBody);
  scriptBody = disambiguateSelectors(scriptBody);
  scriptBody = transformListViewRowClicks(scriptBody);
  scriptBody = transformDataGridRowClicks(scriptBody);

  const hasTestBlock = /\btest\s*\(/.test(scriptBody);

  if (!hasTestBlock) {
    const hasOwnGoto = /await\s+page\.goto\s*\(/.test(scriptBody);
    const preamble = hasOwnGoto
      ? ''
      : '  await page.goto(TARGET_URL);\n  await mx.waitForMendix(page);\n\n  ';
    scriptBody = `
test('Recorded Test', async ({ page }) => {
${preamble}${hasOwnGoto ? '  ' : ''}${scriptBody}
});
`;
  }

  scriptBody = injectStepMarkers(scriptBody);

  const mendixHelpersPath = getMendixHelpersPath();
  return `
const { test, expect, chromium } = require('@playwright/test');
const mx = require('${mendixHelpersPath}');
const TARGET_URL = ${JSON.stringify(targetUrl)};
const CREDENTIALS = ${JSON.stringify(credentials || {})};

${scriptBody}
`;
}

function injectStepMarkers(scriptBody) {
  const body = ScriptUtils.extractTestBody(scriptBody);
  if (!body) return scriptBody;

  const statements = ScriptUtils.splitIntoStatements(body);
  if (!statements.length) return scriptBody;

  const visitedOrigins = new Set();
  let realIdx = 0;

  const wrapped = statements.map((stmt, stmtIdx) => {
    const desc = ScriptUtils.describeStatement(stmt.text);

    let isFiltered = false;
    if (/const\s+browser\s*=\s*await\s+\S+\.launch\s*\(/.test(stmt.text)) isFiltered = true;
    if (/const\s+context\s*=\s*await\s+browser\.newContext\s*\(/.test(stmt.text)) isFiltered = true;
    if (/const\s+page\s*=\s*await\s+context\.newPage\s*\(/.test(stmt.text)) isFiltered = true;
    if (/await\s+page\.close\s*\(\s*\)/.test(stmt.text)) isFiltered = true;
    if (/await\s+context\.close\s*\(\s*\)/.test(stmt.text)) isFiltered = true;
    if (/await\s+browser\.close\s*\(\s*\)/.test(stmt.text)) isFiltered = true;
    if (/await\s+page\.goto\s*\(\s*TARGET_URL\s*\)/.test(stmt.text)) isFiltered = true;
    if (/await\s+mx\.waitForMendix\s*\(/.test(stmt.text)) isFiltered = true;

    if (!isFiltered) {
      const navMatch = stmt.text.match(/await\s+page\.goto\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (navMatch) {
        try {
          const url = new URL(navMatch[1]);
          const isRootish = url.pathname === '/' || url.pathname === '';
          if (isRootish && visitedOrigins.has(url.origin)) isFiltered = true;
          if (isRootish && !isFiltered && stmtIdx > 0) {
            const prevStmt = statements[stmtIdx - 1];
            if (/\.(click|dblclick|press|check|uncheck|selectOption)\s*\(/.test(prevStmt.text) ||
                /mx\.(clickWidget|selectDropdown|smartSelect)\s*\(/.test(prevStmt.text)) {
              isFiltered = true;
            }
          }
          visitedOrigins.add(url.origin);
        } catch { /* not a valid URL, keep it */ }
      }
    }

    if (isFiltered) return null;

    const idx = realIdx++;
    const wantsScreenshot = /\/\/\s*@zoniq:screenshot/.test(stmt.text);
    const cleanStmt = wantsScreenshot ? stmt.text.replace(/\s*\/\/\s*@zoniq:screenshot\s*$/, '') : stmt.text;
    const screenshotBlock = wantsScreenshot && idx >= 0
      ? `\n    await page.waitForLoadState('load');\n` +
        `    await page.screenshot({ path: require('path').join(process.env.ZONIQ_RUN_RESULTS_DIR || 'results', 'step-${idx}-proof.png'), fullPage: true });`
      : '';
    const isRaw = /^(?:const|let|var)\s/.test(cleanStmt);
    if (isRaw) {
      return `  console.log('[ZONIQ_STEP:START:${idx}:${desc}]');\n` +
        `  ${cleanStmt}${screenshotBlock}\n` +
        `  console.log('[ZONIQ_STEP:DONE:${idx}]');`;
    }
    const errVar = `_stepErr_${stmtIdx}`;
    return `  console.log('[ZONIQ_STEP:START:${idx}:${desc}]');\n` +
      `  try {\n    ${cleanStmt}${screenshotBlock}\n` +
      `    console.log('[ZONIQ_STEP:DONE:${idx}]');\n` +
      `  } catch (${errVar}) {\n` +
      `    console.log('[ZONIQ_STEP:FAIL:${idx}:' + ${errVar}.message.replace(/\\n/g, ' ') + ']');\n` +
      `    throw ${errVar};\n` +
      `  }`;
  });

  const testBodyMatch = scriptBody.match(
    /(\btest\s*\(\s*['"][^'"]*['"]\s*,\s*async\s*\(\s*\{\s*page\s*\}\s*\)\s*=>\s*\{)([\s\S]*)(\}\s*\)\s*;?\s*$)/
  );
  if (testBodyMatch) {
    return testBodyMatch[1] + '\n' + wrapped.filter(Boolean).join('\n\n') + '\n' + testBodyMatch[3];
  }
  return scriptBody;
}

function cleanMendixSelectors(script) {
  let cleaned = script;

  cleaned = cleaned.replace(
    /await page\.locator\(['"]#mxui_widget_Underlay_\d+['"]\)\.click\(\);/g,
    'await page.locator(".mx-underlay").click();'
  );

  cleaned = cleaned.replace(
    /(['"])#mxui_widget_(\w+?)_\d+\1/g,
    (match, quote, widgetType) => {
      const classMap = {
        'TextBox': { css: '.mx-textbox', alt: 'page.getByRole("textbox")' },
        'TextArea': { css: '.mx-textarea', alt: 'page.getByRole("textbox")' },
        'Button': { css: '.mx-button', alt: 'page.getByRole("button", { name: "..." })' },
        'DataGrid': { css: '.mx-datagrid', alt: null },
        'DropDown': { css: '.mx-dropdown', alt: null },
        'CheckBox': { css: '.mx-checkbox', alt: 'page.getByRole("checkbox")' },
        'RadioButton': { css: '.mx-radiobutton', alt: 'page.getByRole("radio")' },
        'DatePicker': { css: '.mx-datepicker', alt: null },
        'ReferenceSelector': { css: '.mx-referenceselector', alt: 'page.getByLabel("Label text")' },
      };
      if (classMap[widgetType]) {
        const comment = classMap[widgetType].alt
          ? ` /* Consider: ${classMap[widgetType].alt} */`
          : '';
        return `${quote}${classMap[widgetType].css}${quote}${comment}`;
      }
      return match;
    }
  );

  cleaned = cleaned.replace(
    /page\.locator\(['"](\[id="p\.[^"]+""])['"]\)/g,
    (match, selector) => {
      return `page.locator('${selector}') /* FRAGILE: Mendix page-composition ID — consider using getByRole or getByText */`;
    }
  );

  return cleaned;
}

function transformSelectOptionCalls(script) {
  return script.replace(
    /await\s+(page\.(?:getByLabel|getByRole|getByText|getByPlaceholder|locator)\s*\([^)]*\)(?:\s*\.(?:first|last|nth)\s*\([^)]*\))*)\s*\.selectOption\s*\(([^)]+)\)\s*;/g,
    (match, locatorExpr, valueExpr) => {
      return `await mx.smartSelect(page, ${locatorExpr}, ${valueExpr});`;
    }
  );
}

function transformDatePickerClicks(script) {
  const lines = script.split('\n');
  const result = [];

  const triggerRe = /^(\s*)await\s+(page\.getByRole\s*\(\s*['"]button['"]\s*,\s*\{[^}]*['"]Show date picker['"][^}]*\}\s*\)(?:\.\w+\s*\([^)]*\))*)\s*\.click\s*\([^)]*\)\s*;/;
  const yearNavRe = /^\s*await\s+page\.getByText\s*\(\s*['"](\d{4})['"]\s*(?:,\s*\{[^}]*\})?\s*\)[^;]*\.click\s*\([^)]*\)\s*;/;
  const gridcellRe = /^\s*await\s+page\.getByRole\s*\(\s*['"]gridcell['"]\s*,\s*\{\s*name:\s*['"](\d{1,2})\/(\d{1,2})\/(\d{0,4})['"]\s*\}\s*\)[^;]*\.click\s*\([^)]*\)\s*;/;

  let i = 0;
  while (i < lines.length) {
    const triggerMatch = lines[i].match(triggerRe);
    if (!triggerMatch) {
      result.push(lines[i]);
      i++;
      continue;
    }

    const indent = triggerMatch[1];
    const triggerExpr = triggerMatch[2];
    let year = null;
    let consumed = 1;

    if (i + consumed < lines.length) {
      const yearMatch = lines[i + consumed].match(yearNavRe);
      if (yearMatch) {
        year = yearMatch[1];
        consumed++;
      }
    }

    if (i + consumed < lines.length) {
      const gridcellMatch = lines[i + consumed].match(gridcellRe);
      if (gridcellMatch) {
        const day = parseInt(gridcellMatch[1], 10);
        const month = parseInt(gridcellMatch[2], 10);
        const gridcellYear = gridcellMatch[3] ? parseInt(gridcellMatch[3], 10) : null;
        const finalYear = year || gridcellYear;
        consumed++;

        const yearArg = finalYear ? `, ${finalYear}` : '';
        result.push(`${indent}await mx.pickDate(page, ${triggerExpr}, ${day}, ${month}${yearArg});`);
        i += consumed;
        continue;
      }
    }

    result.push(lines[i]);
    i++;
  }

  return result.join('\n');
}

function disambiguateSelectors(script) {
  const actions = 'click|fill|press|dblclick|check|uncheck|hover|focus|clear|type|selectOption|setInputFiles|tap';
  const chainingIndicators = /\.(?:first|last|nth|filter|getByRole|getByText|getByLabel|getByPlaceholder|locator)\s*\(/;

  const re = new RegExp(
    `(await\\s+)(page\\.(?:getByRole|getByText|getByLabel|getByPlaceholder|locator)\\s*\\([^)]*\\))(\\s*\\.\\s*(?:${actions})\\s*\\()`,
    'g'
  );

  return script.replace(re, (match, prefix, locatorExpr, actionPart) => {
    if (chainingIndicators.test(locatorExpr.slice(locatorExpr.indexOf(')')))) {
      return match;
    }
    return `${prefix}${locatorExpr}.first()${actionPart}`;
  });
}

function transformListViewRowClicks(script) {
  let result = script.replace(
    /await\s+page\.locator\s*\(\s*['"]li\[role=["']?button["']?\]['"]\s*\)\s*\.filter\s*\(\s*\{\s*hasText:\s*['"]([^'"]+)['"]\s*\}\s*\)(?:\s*\.first\s*\(\s*\))?\s*\.click\s*\(\s*\)\s*;/g,
    (match, rowText) => {
      return `await mx.clickListViewRow(page, '${rowText.replace(/'/g, "\\'")}');`;
    }
  );

  result = result.replace(
    /await\s+page\.getByRole\s*\(\s*['"]button['"]\s*,\s*\{\s*name:\s*['"]([^'"]+)['"]\s*\}\s*\)(?:\s*\.first\s*\(\s*\))?\s*\.click\s*\(\s*\)\s*;/g,
    (match, name) => {
      if (!/\s{3,}/.test(name)) return match;
      const primaryText = name.split(/\s{2,}/)[0].trim();
      if (!primaryText) return match;
      return `await mx.clickListViewRow(page, '${primaryText.replace(/'/g, "\\'")}');`;
    }
  );

  return result;
}

function transformDataGridRowClicks(script) {
  let result = script.replace(
    /await\s+page\.getByRole\s*\(\s*['"]gridcell['"]\s*,\s*\{\s*name:\s*['"]([^'"]+)['"]\s*\}\s*\)(?:\s*\.first\s*\(\s*\))?\s*\.click\s*\(\s*\)\s*;/g,
    `await mx.clickDataGridFirstRow(page);`
  );
  result = result.replace(
    /await\s+page\.getByRole\s*\(\s*['"]gridcell['"]\s*\)(?:\s*\.first\s*\(\s*\))?\s*\.click\s*\(\s*\)\s*;/g,
    `await mx.clickDataGridFirstRow(page);`
  );
  result = result.replace(
    /await\s+page\.getByRole\s*\(\s*['"]row['"]\s*,\s*\{\s*name:\s*['"]([^'"]+)['"]\s*\}\s*\)(?:\s*\.first\s*\(\s*\))?\s*\.click\s*\(\s*\)\s*;/g,
    `await mx.clickDataGridFirstRow(page);`
  );
  result = result.replace(
    /await\s+page\.getByText\s*\(\s*['"]([^'"]+)['"]\s*\)(?:\s*\.first\s*\(\s*\))?\s*\.click\s*\(\s*\)\s*;/g,
    (match, textValue) => {
      if (ScriptUtils.looksLikeDynamicId(textValue)) {
        return `await mx.clickDataGridFirstRow(page);`;
      }
      return match;
    }
  );
  return result;
}

function extractSpecs(suites) {
  const specs = [];
  for (const suite of suites) {
    if (suite.specs) specs.push(...suite.specs);
    if (suite.suites) specs.push(...extractSpecs(suite.suites));
  }
  return specs;
}

function extractStepsFromReport(report) {
  if (!report?.suites) return null;
  const specs = extractSpecs(report.suites);
  const stepList = [];
  const stepResults = {};
  let index = 0;

  for (const spec of specs) {
    for (const test of spec.tests || []) {
      for (const result of test.results || []) {
        for (const step of result.steps || []) {
          stepList.push({
            index,
            action: step.title,
            description: step.title,
          });
          const failed = step.error != null;
          stepResults[String(index)] = {
            status: failed ? "failed" : "done",
            error: failed ? (step.error.message || step.error.snippet || "") : undefined,
            durationMs: step.duration || 0,
          };
          index++;
        }
      }
    }
  }

  return stepList.length > 0 ? { stepList, stepResults } : null;
}

module.exports = {
  wrapScript,
  injectStepMarkers,
  cleanMendixSelectors,
  transformSelectOptionCalls,
  transformDatePickerClicks,
  disambiguateSelectors,
  transformListViewRowClicks,
  transformDataGridRowClicks,
  extractSpecs,
  extractStepsFromReport,
  getMendixHelpersPath,
};
