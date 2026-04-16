/**
 * E2E Test — Upload, Drag-and-Drop, and Shadow-DOM widget detection.
 *
 * All three features are exercised against hermetic data-URL fixtures so
 * the test does not depend on external sites.
 *
 *   Upload      — writes a temp file, uploads it to an <input type="file">,
 *                 verifies the file reaches the element.
 *   Drag        — moves a list item into a drop zone and verifies the
 *                 drop handler recorded the event.
 *   Shadow DOM  — renders a select widget inside a shadow root and verifies
 *                 the state parser still discovers it.
 *
 * Run:  GEMINI_API_KEY=... npx jest src/__tests__/e2e/upload-drag-shadow.test.ts --no-coverage
 */
import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Sentinel } from '../../index.js';

if (!process.env.GEMINI_VERSION) {
  process.env.GEMINI_VERSION = 'gemini-3-flash-preview';
}

const API_KEY = process.env.GEMINI_API_KEY ?? '';
const RUN_E2E = API_KEY.length > 0;
const describeE2E = RUN_E2E ? describe : describe.skip;

const UPLOAD_HTML = `
<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Upload</title>
<style>body{font-family:sans-serif;padding:40px;}label{display:block;margin-bottom:8px;}input{padding:8px;}</style>
</head><body>
<h1>Upload your CV</h1>
<label for="cv">Curriculum Vitae</label>
<input id="cv" name="cv" type="file" aria-label="Curriculum Vitae">
<div id="result">no file</div>
<script>
  document.getElementById('cv').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    document.getElementById('result').textContent = file ? ('picked:' + file.name + ':' + file.size) : 'no file';
  });
</script>
</body></html>`;

const DRAG_HTML = `
<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Drag</title>
<style>
  body{font-family:sans-serif;padding:40px;display:flex;gap:40px;}
  .col{width:220px;min-height:220px;border:2px dashed #888;padding:10px;}
  .col h2{margin-top:0;font-size:16px;}
  .card{background:#fafafa;border:1px solid #bbb;border-radius:4px;padding:10px;margin:8px 0;cursor:grab;user-select:none;}
</style>
</head><body>
<div class="col" id="todo-col"><h2>Todo</h2>
  <div class="card" id="card1" draggable="true" role="listitem" aria-label="Card A">Card A</div>
</div>
<div class="col" id="done-col" role="list" aria-label="Done"><h2>Done</h2></div>
<div id="result">idle</div>
<script>
  const card = document.getElementById('card1');
  const done = document.getElementById('done-col');
  card.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', card.id));
  done.addEventListener('dragover', e => e.preventDefault());
  done.addEventListener('drop', e => {
    e.preventDefault();
    done.appendChild(card);
    document.getElementById('result').textContent = 'dropped:' + card.id;
  });
</script>
</body></html>`;

const SHADOW_HTML = `
<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Shadow</title>
<style>body{font-family:sans-serif;padding:40px;}</style>
</head><body>
<h1>Shadow-DOM form</h1>
<my-form></my-form>
<div id="result">idle</div>
<script>
  class MyForm extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = \`
        <style>input{padding:8px;font-size:14px;width:240px;}button{padding:8px;margin-top:8px;}</style>
        <label for="email">Email address</label><br>
        <input id="email" type="email" aria-label="Email address" placeholder="you@example.com"><br>
        <button id="save" type="button" aria-label="Save profile">Save profile</button>
      \`;
      root.getElementById('save').addEventListener('click', () => {
        const v = root.getElementById('email').value;
        document.getElementById('result').textContent = 'saved:' + v;
      });
    }
  }
  customElements.define('my-form', MyForm);
</script>
</body></html>`;

const toDataUrl = (html: string) =>
  'data:text/html;charset=utf-8,' + encodeURIComponent(html);

describeE2E('E2E: Upload + Drag + Shadow DOM', () => {
  let sentinel: Sentinel;
  let tempFile: string;

  beforeAll(async () => {
    tempFile = path.join(os.tmpdir(), `sentinel-upload-test-${Date.now()}.txt`);
    fs.writeFileSync(tempFile, 'dummy cv content for sentinel upload test');

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
    try { fs.unlinkSync(tempFile); } catch { /* best effort */ }
  }, 15_000);

  it('uploads a file via the upload action', async () => {
    await sentinel.goto(toDataUrl(UPLOAD_HTML));
    await sentinel.act(`Upload the file at ${tempFile} to the Curriculum Vitae field`);

    const status = await sentinel.page.locator('#result').textContent();
    expect(status).toMatch(/^picked:/);
  }, 60_000);

  it('drags a card from Todo into Done via the drag action', async () => {
    await sentinel.goto(toDataUrl(DRAG_HTML));
    await sentinel.act('Drag "Card A" onto the Done column');

    const status = await sentinel.page.locator('#result').textContent();
    expect(status).toBe('dropped:card1');
    // Card should now live inside the Done column
    const inDone = await sentinel.page.locator('#done-col #card1').count();
    expect(inDone).toBe(1);
  }, 90_000);

  it('detects and fills a form inside a shadow DOM', async () => {
    await sentinel.goto(toDataUrl(SHADOW_HTML));
    await sentinel.act('Fill the Email address field with test@shadow.dev');
    await sentinel.act('Click the Save profile button');

    const status = await sentinel.page.locator('#result').textContent();
    expect(status).toBe('saved:test@shadow.dev');
  }, 90_000);
});
