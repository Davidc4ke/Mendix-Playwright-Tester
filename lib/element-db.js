/**
 * element-db.js — Local Element Database operations.
 * UMD module used by both the Electron main process and the renderer.
 *
 * Manages a per-app database of discovered UI elements that can be used
 * for AI script generation, healing, and element browsing.
 */
(function (exports) {
  'use strict';

  // ── App helpers ──────────────────────────────────────────

  /**
   * Normalize a full URL to a base app URL (protocol + host).
   * e.g. "https://myapp.mendixcloud.com/p/dashboard?foo=1" → "https://myapp.mendixcloud.com"
   */
  function normalizeAppUrl(targetUrl) {
    if (!targetUrl) return '';
    try {
      const url = new URL(targetUrl.startsWith('http') ? targetUrl : 'https://' + targetUrl);
      return `${url.protocol}//${url.host}`;
    } catch {
      return targetUrl.trim();
    }
  }

  /**
   * Derive a human-readable app name from a URL.
   * e.g. "https://my-cool-app.mendixcloud.com" → "my-cool-app"
   */
  function deriveAppName(baseUrl) {
    try {
      const url = new URL(baseUrl);
      const host = url.hostname;
      // Strip common suffixes
      const name = host
        .replace(/\.mendixcloud\.com$/i, '')
        .replace(/\.mxapps\.io$/i, '')
        .replace(/\.mendix\.com$/i, '')
        .replace(/\.(com|org|net|io|app)$/i, '')
        .replace(/^www\./i, '');
      // Humanize: replace dots/hyphens with spaces, title case
      return name
        .replace(/[.\-_]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim() || host;
    } catch {
      return baseUrl || 'Unknown App';
    }
  }

  // ── Element type inference ───────────────────────────────

  /**
   * Infer the widget type from DOM properties.
   * @param {object} raw — { tagName, classes[], hasInput, inputType, hasTextarea, hasSelect, hasCheckbox, hasRadio, hasDateInput, hasLink, hasImage }
   * @returns {string}
   */
  function inferWidgetType(raw) {
    if (!raw) return 'unknown';
    const c = (raw.classes || []).join(' ');
    if (/button|btn/i.test(c) || raw.tagName === 'BUTTON') return 'button';
    if (raw.hasTextarea) return 'textarea';
    if (raw.hasSelect) return 'dropdown';
    if (raw.hasCheckbox) return 'checkbox';
    if (raw.hasRadio) return 'radio';
    if (raw.hasDateInput) return 'datepicker';
    if (/datagrid/i.test(c)) return 'datagrid';
    if (/listview/i.test(c)) return 'listview';
    if (raw.hasInput) return 'textbox';
    if (raw.hasLink || raw.tagName === 'A') return 'link';
    if (raw.hasImage) return 'image';
    if (/tab/i.test(c)) return 'tab';
    if (/groupbox/i.test(c)) return 'groupbox';
    return 'container';
  }

  /**
   * Infer widget type from a parsed step and its selector type.
   */
  function inferTypeFromStep(step, selectorType) {
    if (step.action === 'Fill') return 'textbox';
    if (step.action === 'SelectDropdown') return 'dropdown';
    if (step.action === 'Click' && selectorType === 'role') {
      const role = step.selector.split(':')[0].toLowerCase();
      if (role === 'button') return 'button';
      if (role === 'link') return 'link';
      if (role === 'checkbox') return 'checkbox';
      if (role === 'radio') return 'radio';
      if (role === 'tab') return 'tab';
      if (role === 'textbox') return 'textbox';
      if (role === 'combobox') return 'dropdown';
    }
    return 'unknown';
  }

  // ── Element DB merge logic ───────────────────────────────

  /**
   * Merge newly discovered elements into an existing element database.
   * Updates existing entries (lastSeen, seenCount, merges selectors/interactions).
   * Adds new entries for unknown elements.
   *
   * @param {object} existingDB — { elements: { [widgetName]: ElementRecord } }
   * @param {Array}  discovered — Array of discovered element objects
   * @param {object} context — { pageUrl, pageTitle, parentDialog }
   * @returns {object} — Updated element DB
   */
  function mergeElements(existingDB, discovered, context) {
    const db = existingDB || { elements: {} };
    if (!db.elements) db.elements = {};
    const now = new Date().toISOString();

    for (const el of discovered) {
      if (!el.name) continue;

      const existing = db.elements[el.name];
      if (existing) {
        // Update existing record
        existing.lastSeen = now;
        existing.seenCount = (existing.seenCount || 1) + 1;
        // Merge type if we got a better one
        if (el.type && el.type !== 'unknown' && el.type !== 'container') {
          existing.type = el.type;
        }
        // Merge selectors
        if (el.selectors) {
          existing.selectors = { ...existing.selectors, ...el.selectors };
        }
        // Merge interactions
        if (el.interactions) {
          const set = new Set(existing.interactions || []);
          el.interactions.forEach(i => set.add(i));
          existing.interactions = Array.from(set);
        }
        // Update context if this is a new page
        if (context?.pageUrl && existing.context?.pageUrl !== context.pageUrl) {
          if (!existing.pages) existing.pages = [];
          const pageEntry = { url: context.pageUrl, title: context.pageTitle || '' };
          if (!existing.pages.some(p => p.url === pageEntry.url)) {
            existing.pages.push(pageEntry);
          }
        }
        // Merge text/value hints
        if (el.text && (!existing.text || existing.text.length < el.text.length)) {
          existing.text = el.text;
        }
        if (el.value !== undefined && el.value !== null) {
          existing.lastValue = el.value;
        }
      } else {
        // New element
        db.elements[el.name] = {
          widgetName: el.name,
          type: el.type || 'unknown',
          selectors: el.selectors || { mx: `mx:${el.name}` },
          context: context ? {
            pageUrl: context.pageUrl || '',
            pageTitle: context.pageTitle || '',
            parentDialog: context.parentDialog || null,
          } : {},
          pages: context?.pageUrl ? [{ url: context.pageUrl, title: context.pageTitle || '' }] : [],
          interactions: el.interactions || [],
          text: el.text || '',
          lastValue: el.value || null,
          lastSeen: now,
          seenCount: 1,
          description: '',
        };
      }
    }

    db.updatedAt = now;
    return db;
  }

  /**
   * Format the element database as a compact text summary for LLM consumption.
   * Groups elements by type for readability.
   *
   * @param {object} elementDB — { elements: { [name]: ElementRecord } }
   * @returns {string}
   */
  function formatElementDBForLLM(elementDB) {
    if (!elementDB?.elements) return 'No elements discovered yet.';

    const elements = Object.values(elementDB.elements);
    if (!elements.length) return 'No elements discovered yet.';

    // Group by type
    const byType = {};
    for (const el of elements) {
      const t = el.type || 'unknown';
      if (!byType[t]) byType[t] = [];
      byType[t].push(el);
    }

    const lines = [`## Known Application Elements (${elements.length} total)\n`];

    // Order types by relevance
    const typeOrder = ['button', 'textbox', 'textarea', 'dropdown', 'checkbox', 'radio',
                       'datepicker', 'link', 'datagrid', 'listview', 'tab', 'groupbox', 'container', 'image', 'unknown'];

    for (const type of typeOrder) {
      const group = byType[type];
      if (!group?.length) continue;

      lines.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)}s (${group.length})`);
      for (const el of group) {
        let desc = `- **${el.widgetName}**`;
        if (el.text && el.type !== 'container') desc += ` "${el.text.substring(0, 60)}"`;
        if (el.interactions?.length) desc += ` [${el.interactions.join(', ')}]`;

        // Show best selector
        const sel = el.selectors || {};
        const bestSel = sel.label || sel.text || sel.role || sel.testId || sel.mx || '';
        if (bestSel) desc += ` — selector: \`${bestSel}\``;

        // Show pages
        if (el.pages?.length) {
          desc += ` — pages: ${el.pages.map(p => p.url || p.title).join(', ')}`;
        }

        lines.push(desc);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Extract interaction type from a parsed step action.
   * @param {string} action — Step action name (Click, Fill, SelectDropdown, etc.)
   * @returns {string} — Interaction type for element DB
   */
  function actionToInteraction(action) {
    const map = {
      Click: 'click',
      Fill: 'fill',
      SelectDropdown: 'select',
      AssertText: 'assert',
      AssertVisible: 'assert',
      AssertEnabled: 'assert',
      AssertDisabled: 'assert',
      Screenshot: 'screenshot',
    };
    return map[action] || null;
  }

  /**
   * Enrich element DB from parsed script steps.
   * Cross-references selectors and interaction types found in scripts.
   *
   * @param {object} elementDB — Existing element DB
   * @param {Array} steps — Parsed steps from parseScriptToSteps()
   * @returns {object} — Updated element DB
   */
  function enrichFromSteps(elementDB, steps) {
    const db = elementDB || { elements: {} };
    if (!db.elements) db.elements = {};

    for (const step of steps) {
      if (!step.selector) continue;

      // Determine element key and selector type
      let elementKey = null;
      let widgetName = null;
      let selectorType = null;

      const mxMatch = step.selector.match(/^mx:(.+)$/);
      if (mxMatch) {
        widgetName = mxMatch[1];
        elementKey = widgetName;
        selectorType = 'mx';
      } else if (step.selector.match(/^\.mx-name-(\S+)/)) {
        widgetName = step.selector.match(/^\.mx-name-(\S+)/)[1];
        elementKey = widgetName;
        selectorType = 'mx';
      } else if (step.selector.startsWith('label:')) {
        elementKey = step.selector;
        selectorType = 'label';
      } else if (step.selector.startsWith('text:')) {
        elementKey = step.selector;
        selectorType = 'text';
      } else if (step.selector.startsWith('placeholder:')) {
        elementKey = step.selector;
        selectorType = 'placeholder';
      } else if (step.selector.includes(':')) {
        elementKey = step.selector;
        selectorType = 'role';
      } else if (step.selector.trim()) {
        elementKey = step.selector;
        selectorType = 'css';
      }

      if (!elementKey) continue;

      const existing = db.elements[elementKey];
      const interaction = actionToInteraction(step.action);

      if (existing) {
        // Merge interaction
        if (interaction) {
          const set = new Set(existing.interactions || []);
          set.add(interaction);
          existing.interactions = Array.from(set);
        }
        // Merge selector under appropriate key
        existing.selectors = existing.selectors || {};
        if (selectorType === 'label') existing.selectors.label = step.selector;
        else if (selectorType === 'text') existing.selectors.text = step.selector;
        else if (selectorType === 'role') existing.selectors.role = step.selector;
        else if (selectorType === 'placeholder') existing.selectors.placeholder = step.selector;
        else if (selectorType === 'mx') existing.selectors.mx = 'mx:' + widgetName;
        // Update lastValue if present
        if (step.value) existing.lastValue = step.value;
      } else {
        // New element
        const displayName = widgetName || step.selector;
        const selectors = {};
        if (selectorType === 'mx') selectors.mx = 'mx:' + widgetName;
        else if (selectorType === 'label') selectors.label = step.selector;
        else if (selectorType === 'text') selectors.text = step.selector;
        else if (selectorType === 'role') selectors.role = step.selector;
        else if (selectorType === 'placeholder') selectors.placeholder = step.selector;
        else selectors.css = step.selector;

        db.elements[elementKey] = {
          widgetName: displayName,
          type: inferTypeFromStep(step, selectorType),
          selectors,
          context: {},
          pages: [],
          interactions: interaction ? [interaction] : [],
          text: '',
          lastValue: step.value || null,
          lastSeen: new Date().toISOString(),
          seenCount: 1,
          description: '',
        };
      }
    }

    return db;
  }

  // ── Exports ────────────────────────────────────────────

  exports.normalizeAppUrl = normalizeAppUrl;
  exports.deriveAppName = deriveAppName;
  exports.inferWidgetType = inferWidgetType;
  exports.mergeElements = mergeElements;
  exports.formatElementDBForLLM = formatElementDBForLLM;
  exports.actionToInteraction = actionToInteraction;
  exports.enrichFromSteps = enrichFromSteps;

})(typeof module !== 'undefined' && module.exports ? module.exports : (window.ElementDB = {}));
