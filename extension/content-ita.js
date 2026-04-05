/**
 * Flight MCP Bridge — ITA Matrix Content Script
 *
 * Handles:
 *   action: "search"  — fill & submit ITA Matrix search form
 *   action: "scrape"  — scrape current results
 *   action: "ping"    — liveness check
 *
 * ITA Matrix is a GWT SPA — URLs don't encode search params.
 * All interaction must go through DOM manipulation with simulated keyboard events.
 */

(function () {
  'use strict';

  if (window.__flightMcpItaListener) {
    chrome.runtime.onMessage.removeListener(window.__flightMcpItaListener);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function qs(sel, root = document) { return root.querySelector(sel); }
  function qsAll(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

  /**
   * Find an input by its associated label text (case-insensitive substring).
   */
  function findInputByLabel(labelText) {
    const labels = qsAll('label');
    for (const label of labels) {
      if (label.textContent.toLowerCase().includes(labelText.toLowerCase())) {
        if (label.htmlFor) {
          const el = document.getElementById(label.htmlFor);
          if (el) return el;
        }
        const inp = label.querySelector('input');
        if (inp) return inp;
      }
    }
    // aria-label fallback
    const inputs = qsAll('input[aria-label]');
    for (const inp of inputs) {
      if (inp.getAttribute('aria-label').toLowerCase().includes(labelText.toLowerCase())) return inp;
    }
    return null;
  }

  const nativeInputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

  /**
   * Type into an Angular Material input char-by-char.
   * Uses the native value setter + input + keyup events.
   * Angular Material's MatAutocompleteTrigger listens to both.
   */
  async function typeInto(el, text) {
    el.focus();
    await sleep(200);

    // Clear
    nativeInputSetter?.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(80);

    for (const char of text) {
      const newVal = el.value + char;
      nativeInputSetter?.call(el, newVal);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: char }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      await sleep(80);
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Wait for an autocomplete suggestion dropdown and click the first item.
   */
  async function selectFirstSuggestion(timeoutMs = 5000) {
    const start = Date.now();
    const DROPDOWN_SELECTORS = [
      '.mat-option',                        // Angular Material
      '[role="listbox"] [role="option"]',
      '[role="option"]',
      '.mat-autocomplete-panel .mat-option',
      '.gwt-SuggestBoxPopup .item',
      '.gwt-MenuItem',
      '[class*="suggest"] li',
    ];

    while (Date.now() - start < timeoutMs) {
      for (const sel of DROPDOWN_SELECTORS) {
        const items = qsAll(sel);
        if (items.length > 0) {
          items[0].click();
          await sleep(200);
          return true;
        }
      }
      await sleep(150);
    }
    return false;
  }

  /**
   * Wait until results appear (price rows visible).
   */
  async function waitForResults(timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (hasResults()) return true;
      await sleep(500);
    }
    return false;
  }

  function hasResults() {
    const RESULT_SELECTORS = [
      '[role="grid"] tr',
      'table[class*="results"] tr',
      'table tr td[class*="price"]',
      '[class*="itinerary"]',
    ];
    for (const s of RESULT_SELECTORS) {
      if (qsAll(s).length >= 2) return true;
    }
    const pricePattern = /(?:USD|TWD|JPY|NT\$|¥|\$)\s*[\d,]{2,}/;
    return pricePattern.test(document.body.innerText);
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  /**
   * Select cabin class in ITA Matrix form.
   * ITA uses a mat-select dropdown near the top of the form.
   * Returns { ok, via, attempted, selectedText } for debugging.
   */
  async function selectCabin(cabin) {
    if (!cabin || cabin === 'economy') return { skipped: true };

    const cabinLabels = {
      business: ['Business', 'Business Class'],
      first:    ['First', 'First Class'],
      premium:  ['Premium Economy', 'Premium'],
    };
    const targets = cabinLabels[cabin.toLowerCase()] || [cabin];

    // Try up to 2 times (first attempt may race with Angular rendering)
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(800);

      // Strategy 1: mat-select dropdown
      const selects = qsAll('mat-select');
      for (const sel of selects) {
        const label = (sel.getAttribute('aria-label') || '').toLowerCase();
        const value = (sel.querySelector('.mat-select-value-text, .mat-mdc-select-value-text, .mat-select-min-line')?.textContent || '').toLowerCase();
        if (/cabin|class|economy|business|first|coach|cheapest/i.test(label + ' ' + value)) {
          sel.click();
          await sleep(800); // wait for dropdown animation
          const options = qsAll('mat-option');
          const target = options.find(o =>
            targets.some(t => o.textContent.trim().toLowerCase().includes(t.toLowerCase()))
          );
          if (target) {
            const selectedText = target.textContent.trim();
            target.click();
            await sleep(500);
            return { ok: true, via: 'mat-select', attempt, selectedText };
          }
          // Close dropdown and try next strategy
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await sleep(300);
        }
      }

      // Strategy 2: mat-button-toggle-group
      const toggleGroups = qsAll('mat-button-toggle-group');
      for (const group of toggleGroups) {
        const btns = qsAll('mat-button-toggle', group);
        const target = btns.find(b =>
          targets.some(t => b.textContent.trim().toLowerCase().includes(t.toLowerCase()))
        );
        if (target) {
          target.click();
          await sleep(400);
          return { ok: true, via: 'toggle', attempt, selectedText: target.textContent.trim() };
        }
      }
    }

    // Debug info on failure
    const selectDebug = qsAll('mat-select').map(sel => ({
      ariaLabel: sel.getAttribute('aria-label'),
      value: sel.querySelector('.mat-select-value-text, .mat-mdc-select-value-text, .mat-select-min-line')?.textContent?.trim(),
    }));
    const toggleDebug = qsAll('mat-button-toggle-group').map(g => ({
      buttons: qsAll('mat-button-toggle', g).map(b => b.textContent.trim())
    }));
    return { ok: false, attempted: cabin, selectDebug, toggleDebug };
  }

  /**
   * Convert YYYY-MM-DD to MM/DD/YYYY (ITA Matrix date format)
   */
  function toITADate(isoDate) {
    const [y, m, d] = isoDate.split('-');
    return `${m}/${d}/${y}`;
  }

  /**
   * Find all mat-form-field elements whose label matches "Date".
   * Returns one per leg in document order.
   */
  function findDateFormFields() {
    return qsAll('mat-form-field').filter(f => {
      const label = qs('mat-label, label', f);
      // Match "Date" or "Date*" exactly — NOT "Date options" or other compound labels
      return label && /^date\*?$/i.test(label.textContent.trim());
    });
  }

  /**
   * Click the Date* form field for legIndex and type the date.
   * ITA Matrix date fields open a datepicker on click; we click to focus,
   * then type into whatever input becomes active.
   */
  async function fillDateField(legIndex, isoDate) {
    const fields = findDateFormFields();
    const field = fields[legIndex];
    if (!field) return { ok: false, reason: `no date field at index ${legIndex}, found ${fields.length}` };

    // Try to find the input directly inside the form field
    let inp = qs('input', field);
    if (!inp) {
      // Click the field to reveal the input
      field.click();
      await sleep(400);
      inp = qs('input', field) || document.activeElement;
    }
    if (!inp || inp.tagName !== 'INPUT') {
      // Last resort: click and use activeElement
      field.click();
      await sleep(400);
      inp = document.activeElement;
    }
    if (!inp || inp.tagName !== 'INPUT') {
      return { ok: false, reason: 'no input found inside date field', activeTag: document.activeElement?.tagName };
    }

    inp.focus();
    await sleep(200);
    await typeInto(inp, toITADate(isoDate));
    await sleep(400);
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    await sleep(200);
    return { ok: true, value: inp.value };
  }

  async function searchMultiCity(legs, cabin) {
    const steps = [];

    // Step 1: Click Multi-City tab
    // (background.js always navigates to a fresh ITA URL, so no stale data to clear)
    const tabSpans = Array.from(document.querySelectorAll('.mdc-tab__content span, [role="tab"] span, mat-tab span'));
    const mcTab = tabSpans.find(s => /multi.?city|多城市/i.test(s.textContent.trim()));
    if (mcTab) {
      const btn = mcTab.closest('button, [role="tab"]') || mcTab.parentElement?.parentElement;
      btn?.click();
      await sleep(1000);
      steps.push({ step: 'trip_type', set: true });
    } else {
      steps.push({ step: 'trip_type', set: false });
    }

    // Step 2: Select cabin class
    const cabinOk = await selectCabin(cabin);
    steps.push({ step: 'cabin', cabin, set: cabinOk });

    // Steps 3+: Fill each leg one at a time.
    // After autocomplete, ITA clears the input value and shows a chip.
    // To locate the correct inputs: for leg 0 use indices [0,1];
    // for leg i>0, count inputs BEFORE clicking "Add Flight" and slice the new ones.
    for (let i = 0; i < legs.length; i++) {
      const { origin, destination, date } = legs[i];

      let originInput, destInput;

      if (i === 0) {
        const airports = qsAll('input[placeholder="Add airport"]');
        originInput = airports[0];
        destInput   = airports[1];
        steps.push({ step: 'leg_1_inputs', total: airports.length });
      } else {
        const beforeCount = qsAll('input[placeholder="Add airport"]').length;
        const addBtn = Array.from(document.querySelectorAll('button'))
          .find(b => /^add flight$|add another flight|新增班機/i.test(b.textContent.trim()));
        if (!addBtn) {
          steps.push({ step: `add_leg_${i + 1}`, found: false });
          continue;
        }
        addBtn.click();

        const deadline = Date.now() + 4000;
        let newAirports = [];
        while (Date.now() < deadline) {
          const current = qsAll('input[placeholder="Add airport"]');
          if (current.length >= beforeCount + 2) {
            newAirports = current.slice(beforeCount);
            break;
          }
          await sleep(200);
        }

        originInput = newAirports[0];
        destInput   = newAirports[1];
        steps.push({ step: `add_leg_${i + 1}`, found: true,
          beforeCount, afterCount: qsAll('input[placeholder="Add airport"]').length,
          originFound: !!originInput, destFound: !!destInput });

        // Give Angular time to attach event listeners to newly created inputs
        await sleep(500);
      }

      if (!originInput || !destInput) {
        steps.push({ step: `leg_${i + 1}`, error: 'airport inputs not found' });
        continue;
      }

      // ITA auto-fills the new leg's origin with the previous leg's destination.
      // Check if the chip already shows the correct origin code — if so, skip typing.
      function chipsNear(input) {
        let el = input.parentElement;
        for (let n = 0; n < 6; n++) {
          if (!el) break;
          const chips = Array.from(el.querySelectorAll('mat-chip, [class*="chip"]'));
          if (chips.length) return chips;
          el = el.parentElement;
        }
        return [];
      }
      const existingOriginChips = chipsNear(originInput);
      const originAlreadySet = existingOriginChips.some(
        c => c.textContent.trim().toUpperCase().includes(origin.toUpperCase())
      );

      let originOk;
      if (originAlreadySet) {
        originOk = true; // already correct, no need to type
      } else {
        await typeInto(originInput, origin);
        await sleep(1500);
        originOk = await selectFirstSuggestion(4000);
        await sleep(500);
      }

      await typeInto(destInput, destination);
      await sleep(1500);
      const destOk = await selectFirstSuggestion(4000);
      await sleep(500);

      // Fill date field by clicking the Date* mat-form-field for this leg
      await sleep(500);
      const dateResult = await fillDateField(i, date);
      steps.push({ step: `leg_${i + 1}`, origin, destination, date, originOk, destOk, date: dateResult });
    }

    // Final: Click Search
    await sleep(500);
    let searchBtn = null;
    for (const btn of qsAll('button')) {
      if (/\bSearch\b/.test(btn.textContent.trim()) &&
          btn.getAttribute('aria-label') !== 'toggle light/dark theme') {
        searchBtn = btn; break;
      }
    }
    if (!searchBtn) return { status: 'error', error: 'Search button not found', steps };
    steps.push({ step: 'search_btn', found: true });
    searchBtn.click();

    await sleep(2000);
    const found = await waitForResults(30000);
    steps.push({ step: 'wait_results', found });

    const result = scrape(found);
    result.steps = steps;
    return result;
  }

  async function search(params) {
    const { origin, destination, departure_date, return_date, passengers = 1, cabin } = params;

    // Multi-city path
    if (params.legs && params.legs.length >= 2) {
      return await searchMultiCity(params.legs, cabin);
    }

    const isRoundTrip = !!return_date;
    const steps = [];

    // Step 1: Trip type — MDC Tab component (.mdc-tab__content > span)
    // Do this FIRST so Angular re-renders the correct form inputs before we query them
    let tripTypeSet = false;
    const targetText = isRoundTrip ? 'Round Trip' : 'One Way';
    const tripSpans = Array.from(document.querySelectorAll('.mdc-tab__content span, [role="tab"] span, mat-tab span'));
    for (const span of tripSpans) {
      if (span.textContent.trim() === targetText) {
        const tabBtn = span.closest('button, [role="tab"]') || span.parentElement?.parentElement;
        if (tabBtn) {
          tabBtn.click();
          await sleep(800);
          // Verify via aria-selected on the button
          const isActive = tabBtn.getAttribute('aria-selected') === 'true'
            || tabBtn.classList.contains('mat-mdc-tab-active')
            || tabBtn.classList.contains('mat-tab-label-active');
          tripTypeSet = true;
          steps.push({ step: 'trip_type', set: true, verified: isActive, type: isRoundTrip ? 'round' : 'oneway' });
          break;
        }
      }
    }
    if (!tripTypeSet) {
      steps.push({ step: 'trip_type', set: false, type: isRoundTrip ? 'round' : 'oneway',
                   tabsFound: tripSpans.map(s => s.textContent.trim()) });
    }

    // Select cabin class
    const cabinResult = await selectCabin(cabin);
    steps.push({ step: 'cabin', cabin: cabin || 'economy', result: cabinResult });

    // Wait for Angular to settle after trip type change, then re-query inputs
    await sleep(1000);

    // Step 2: Find form inputs (after trip type change so form is in correct state)
    const allInputs = qsAll('input');
    const airportInputs = Array.from(allInputs).filter(el => el.placeholder === 'Add airport');
    const originInput = airportInputs[0];
    const destInput   = airportInputs[1];

    const textInputs = Array.from(allInputs).filter(el => el.type === 'text');
    const dateInput = Array.from(allInputs).find(el => el.placeholder === 'Start date')
      || textInputs.find(el => el !== originInput && el !== destInput && !el.getAttribute('aria-label'));
    const retInput = Array.from(allInputs).find(el => el.placeholder === 'End date')
      || textInputs.filter(el => el !== originInput && el !== destInput && !el.getAttribute('aria-label'))[1];

    steps.push({ step: 'inputs', originFound: !!originInput, destFound: !!destInput, dateFound: !!dateInput,
                 originPlaceholder: originInput?.placeholder, datePlaceholder: dateInput?.placeholder });

    if (!originInput || !destInput || !dateInput) {
      return { status: 'error', error: 'ITA Matrix form inputs not found', steps };
    }

    // Step 3: Fill origin
    await sleep(500);
    await typeInto(originInput, origin);
    await sleep(1500);
    let originOptCount = document.querySelectorAll('.mat-option, [role="option"]').length;
    let originSuggestion = await selectFirstSuggestion(4000);
    if (!originSuggestion) {
      // Retry once
      await typeInto(originInput, origin);
      await sleep(1500);
      originOptCount = document.querySelectorAll('.mat-option, [role="option"]').length;
      originSuggestion = await selectFirstSuggestion(4000);
    }
    steps.push({ step: 'fill_origin', valueAfter: originInput.value, optionsVisible: originOptCount, suggestion: originSuggestion });

    // Step 4: Fill destination
    await typeInto(destInput, destination);
    await sleep(1500);
    const destOptCount = document.querySelectorAll('.mat-option, [role="option"]').length;
    const destSuggestion = await selectFirstSuggestion(4000);
    steps.push({ step: 'fill_dest', valueAfter: destInput.value, optionsVisible: destOptCount, suggestion: destSuggestion });

    // Step 5: Fill departure date (ITA uses MM/DD/YYYY)
    const itaDate = toITADate(departure_date);
    await typeInto(dateInput, itaDate);
    await sleep(500);
    dateInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    await sleep(300);
    steps.push({ step: 'fill_date', value: itaDate, valueAfter: dateInput.value });

    // Step 6: Return date (round trip only)
    if (isRoundTrip && return_date && retInput) {
      const itaRetDate = toITADate(return_date);
      await typeInto(retInput, itaRetDate);
      await sleep(500);
      retInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      await sleep(200);
      steps.push({ step: 'fill_return_date', value: itaRetDate });
    }

    // Step 7: Click Search — find the Search button and check if it's enabled
    let searchBtn = null;
    for (const btn of qsAll('button')) {
      const txt = btn.textContent.trim();
      if (/\bSearch\b/.test(txt) && btn.getAttribute('aria-label') !== 'toggle light/dark theme') {
        searchBtn = btn;
        break;
      }
    }

    const btnDisabled = searchBtn ? (searchBtn.disabled || searchBtn.getAttribute('aria-disabled') === 'true') : null;
    steps.push({ step: 'search_btn', found: !!searchBtn, disabled: btnDisabled });

    if (!searchBtn) {
      return { status: 'error', error: 'Could not find Search button', steps };
    }

    searchBtn.click();

    // Step 8: Wait for results (budget: ~50s to stay within 82s total)
    await sleep(2000);
    const found = await waitForResults(48000);
    steps.push({ step: 'wait_results', found });

    const result = scrape(found);
    result.steps = steps;
    return result;
  }

  // ─── Scrape ───────────────────────────────────────────────────────────────

  function scrape(hasData = true) {
    if (!hasData && !hasResults()) {
      return { status: 'no_results', fares: [], url: location.href, scraped_at: new Date().toISOString() };
    }

    const fares = [];

    // Strategy 1: Grid/table rows
    const gridRows = qsAll('[role="grid"] tr, [role="row"], table tr');
    for (const row of gridRows) {
      const fare = extractFare(row);
      if (fare && fare.price) fares.push(fare);
    }

    // Strategy 2: Itinerary containers
    if (fares.length === 0) {
      const containers = qsAll('[class*="itinerary"], [class*="result"], [class*="fare"]');
      for (const c of containers) {
        const fare = extractFare(c);
        if (fare && fare.price) fares.push(fare);
      }
    }

    // Strategy 3: Text pattern scan as last resort
    if (fares.length === 0) {
      const pricePattern = /(?:USD|TWD|JPY|NT\$|¥|\$)\s*([\d,]+)/g;
      const bodyText = document.body.innerText;
      let m;
      const prices = [];
      while ((m = pricePattern.exec(bodyText)) !== null) {
        prices.push(m[0].trim());
      }
      if (prices.length > 0) {
        return {
          status: 'ok',
          fares: prices.map((p) => ({ price: p, note: 'text-pattern-scan' })),
          url: location.href,
          scraped_at: new Date().toISOString(),
          _warning: 'Structured scraping failed; prices extracted via text pattern'
        };
      }
    }

    return {
      status: fares.length > 0 ? 'ok' : 'no_results',
      fares,
      count: fares.length,
      url: location.href,
      scraped_at: new Date().toISOString()
    };
  }

  function extractFare(row) {
    const text = row.textContent;
    if (!text.trim()) return null;

    const priceMatch = text.match(/(?:USD|TWD|JPY|NT\$|¥|\$)\s*([\d,]+)/);
    const price = priceMatch ? priceMatch[0].trim() : null;

    const routeMatch = text.match(/([A-Z]{3})\s*[–\-→]\s*([A-Z]{3})/);
    const routing = routeMatch ? routeMatch[0] : null;

    const fareClassMatch = text.match(/\b([A-Z]\d?)\s+(?:class|fare)\b/i);
    const fare_class = fareClassMatch ? fareClassMatch[1] : null;

    const airlineEl = qs('[class*="airline"], [class*="carrier"]', row);
    const airline = airlineEl ? airlineEl.textContent.trim() : null;

    const durationMatch = text.match(/(\d+)h\s*(\d+)?m|(\d+)\s*hr?\s*(\d+)?\s*min?/i);
    const duration = durationMatch ? durationMatch[0].trim() : null;

    const stopsMatch = text.match(/nonstop|(\d+)\s*stop/i);
    let stops = null;
    if (stopsMatch) {
      stops = stopsMatch[0].toLowerCase().includes('nonstop') ? 0 : parseInt(stopsMatch[1], 10);
    }

    const timePattern = /\b\d{1,2}:\d{2}(?:\s*[AP]M)?\b/gi;
    const times = (text.match(timePattern) || []).slice(0, 2);

    return {
      price,
      routing,
      fare_class,
      airline,
      duration,
      stops,
      departure_time: times[0] || null,
      arrival_time: times[1] || null
    };
  }

  // ─── Message Listener ─────────────────────────────────────────────────────

  function messageListener(msg, _sender, sendResponse) {
    const { action, params } = msg;

    if (action === 'ping') {
      sendResponse({ ok: true });
      return true;
    }

    if (action === 'scrape') {
      sendResponse(scrape(hasResults()));
      return true;
    }

    if (action === 'search') {
      search(params)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ status: 'error', error: err.message }));
      return true;
    }

    return false;
  }

  window.__flightMcpItaListener = messageListener;
  chrome.runtime.onMessage.addListener(messageListener);

})();
