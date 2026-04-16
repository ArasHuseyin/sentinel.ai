/**
 * E2E Test — Datepicker three-strategy cascade (Strategy 1 + 2 + 3).
 *
 * Uses inline HTML fixtures served via `data:` URLs so the test is hermetic
 * (no external sites, no flakiness). Each fixture represents one of the
 * widget families the universal cascade targets:
 *
 *   Strategy 1 — native <input type="date"> (Chrome/Firefox built-in)
 *   Strategy 2 — writable wrapped <input> (MUI / Ant Design / react-datepicker)
 *   Strategy 3 — popup-only calendar with readonly trigger (flatpickr-like),
 *                exercised through month navigation + day-cell click.
 *
 * Run:  GEMINI_API_KEY=... npx jest src/__tests__/e2e/datepicker.test.ts --no-coverage
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Sentinel } from '../../index.js';

if (!process.env.GEMINI_VERSION) {
  process.env.GEMINI_VERSION = 'gemini-3-flash-preview';
}

const API_KEY = process.env.GEMINI_API_KEY ?? '';
const RUN_E2E = API_KEY.length > 0;
const describeE2E = RUN_E2E ? describe : describe.skip;

// ─── HTML fixtures ──────────────────────────────────────────────────────────

const NATIVE_DATE_FIXTURE = `
<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>Native Date</title>
<style>body{font-family:sans-serif;padding:40px;}label{display:block;margin-bottom:8px;}input{padding:8px;font-size:16px;width:240px;}</style>
</head><body>
<h1>Native Datepicker</h1>
<label for="dob">Geburtsdatum</label>
<input id="dob" name="dob" type="date">
<div id="result"></div>
<script>
  document.getElementById('dob').addEventListener('change', e => {
    document.getElementById('result').textContent = 'value=' + e.target.value;
  });
</script>
</body></html>`;

const WRAPPED_INPUT_FIXTURE = `
<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Wrapped Date</title>
<style>
  body{font-family:sans-serif;padding:40px;}
  .MuiDatePicker-root{display:inline-flex;border:1px solid #ccc;border-radius:4px;padding:6px;width:260px;}
  .MuiDatePicker-root input{border:0;outline:0;font-size:16px;flex:1;}
  label{display:block;margin-bottom:8px;}
</style>
</head><body>
<h1>Wrapped Datepicker (MUI-style)</h1>
<label for="appt-input">Appointment date</label>
<div class="MuiDatePicker-root"><input id="appt-input" placeholder="MM/DD/YYYY"></div>
<div id="result"></div>
<script>
  document.getElementById('appt-input').addEventListener('blur', e => {
    document.getElementById('result').textContent = 'value=' + e.target.value;
  });
</script>
</body></html>`;

/**
 * Minimal popup-only datepicker that demonstrates the core cascade contract:
 *  - readonly trigger input → not fillable directly
 *  - click opens a role=dialog with role=grid of role=gridcell buttons
 *  - header with role=heading shows the current month name (locale-aware via Intl)
 *  - prev / next buttons have aria-labels that match the multi-lingual patterns
 */
const POPUP_ONLY_FIXTURE = `
<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Popup Date</title>
<style>
  body{font-family:sans-serif;padding:40px;}
  .trigger{padding:8px;font-size:16px;width:240px;border:1px solid #ccc;cursor:pointer;}
  .popup{position:absolute;background:#fff;border:1px solid #888;padding:12px;margin-top:4px;display:none;}
  .popup.open{display:block;}
  .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
  .header h3{margin:0;flex:1;text-align:center;font-size:14px;}
  .header button{background:#eee;border:0;width:32px;height:32px;cursor:pointer;}
  .grid{display:grid;grid-template-columns:repeat(7,36px);gap:2px;}
  .grid button{width:36px;height:36px;border:0;background:#f5f5f5;cursor:pointer;}
  .grid button:hover{background:#ddd;}
  .grid button.outside{color:#ccc;}
</style>
</head><body>
<h1>Popup-only Datepicker</h1>
<label for="event-date">Event date</label><br>
<input id="event-date" class="trigger" type="text" readonly placeholder="Click to pick">
<div id="popup" class="popup" role="dialog" aria-label="Choose date">
  <div class="header">
    <button type="button" aria-label="Previous month" id="prev">&lt;</button>
    <h3 role="heading" id="label"></h3>
    <button type="button" aria-label="Next month" id="next">&gt;</button>
  </div>
  <div class="grid" role="grid" id="grid"></div>
</div>
<div id="result"></div>
<script>
  const trigger = document.getElementById('event-date');
  const popup = document.getElementById('popup');
  const grid = document.getElementById('grid');
  const label = document.getElementById('label');
  let current = new Date(2026, 8, 1); // Start on September 2026 to force navigation
  function render(){
    label.textContent = new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric'}).format(current);
    grid.innerHTML = '';
    const y = current.getFullYear(), m = current.getMonth();
    const firstDay = new Date(y, m, 1).getDay(); // 0=Sun
    const daysInMonth = new Date(y, m+1, 0).getDate();
    for (let i=0;i<firstDay;i++){const b=document.createElement('button');b.textContent='';b.className='outside';b.disabled=true;grid.appendChild(b);}
    for (let d=1;d<=daysInMonth;d++){
      const b=document.createElement('button');
      b.type='button';
      b.setAttribute('role','gridcell');
      const dt = new Date(y,m,d);
      b.setAttribute('aria-label', new Intl.DateTimeFormat('en-US',{year:'numeric',month:'long',day:'numeric'}).format(dt));
      b.textContent = String(d);
      b.onclick = () => {
        trigger.value = y + '-' + String(m+1).padStart(2,'0') + '-' + String(d).padStart(2,'0');
        popup.classList.remove('open');
        document.getElementById('result').textContent = 'value=' + trigger.value;
      };
      grid.appendChild(b);
    }
  }
  trigger.addEventListener('click', () => { popup.classList.add('open'); render(); });
  document.getElementById('prev').onclick = () => { current = new Date(current.getFullYear(), current.getMonth()-1, 1); render(); };
  document.getElementById('next').onclick = () => { current = new Date(current.getFullYear(), current.getMonth()+1, 1); render(); };
</script>
</body></html>`;

const toDataUrl = (html: string) => 'data:text/html;charset=utf-8,' + encodeURIComponent(html);

// ─── Tests ──────────────────────────────────────────────────────────────────

describeE2E('E2E: Datepicker three-strategy cascade', () => {
  let sentinel: Sentinel;

  beforeAll(async () => {
    sentinel = new Sentinel({
      apiKey: API_KEY,
      headless: false,
      verbose: 2,
      viewport: { width: 1280, height: 720 },
      domSettleTimeoutMs: 3000,
    });
    await sentinel.init();
  }, 30_000);

  afterAll(async () => {
    await sentinel.close();
  }, 15_000);

  it('Strategy 1: fills native <input type="date"> with ISO value', async () => {
    await sentinel.goto(toDataUrl(NATIVE_DATE_FIXTURE));
    await sentinel.act('Fill the Geburtsdatum field with 2026-10-15');

    const value = await sentinel.page.locator('#dob').inputValue();
    expect(value).toBe('2026-10-15');
  }, 60_000);

  it('Strategy 1: parses European DD.MM.YYYY for native <input type="date">', async () => {
    await sentinel.goto(toDataUrl(NATIVE_DATE_FIXTURE));
    await sentinel.act('Fill the Geburtsdatum field with 15.10.2026');

    const value = await sentinel.page.locator('#dob').inputValue();
    expect(value).toBe('2026-10-15');
  }, 60_000);

  it('Strategy 2: types into writable wrapped input (MUI-style)', async () => {
    await sentinel.goto(toDataUrl(WRAPPED_INPUT_FIXTURE));
    await sentinel.act('Fill the Appointment date with 10/15/2026');

    // Wrapped inputs keep the raw typed string; the app is responsible for parsing.
    const value = await sentinel.page.locator('#appt-input').inputValue();
    expect(value.length).toBeGreaterThan(0);
    // Must contain the day, month, and year fragments the user typed
    expect(value).toMatch(/10/);
    expect(value).toMatch(/15/);
    expect(value).toMatch(/2026/);
  }, 60_000);

  it('Strategy 3: navigates popup calendar and clicks target day', async () => {
    // Fixture opens on September 2026 — picking October forces a forward navigation.
    await sentinel.goto(toDataUrl(POPUP_ONLY_FIXTURE));
    await sentinel.act('Fill the Event date with 2026-10-15');

    const value = await sentinel.page.locator('#event-date').inputValue();
    expect(value).toBe('2026-10-15');
  }, 90_000);
});
