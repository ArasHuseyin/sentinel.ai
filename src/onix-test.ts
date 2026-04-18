/**
 * Onix Connect – automation test
 *
 * Flow:
 *   Login → fill tariff calculator → select Kelag tariff → enter customer data
 *
 * Run (after npm run build):
 *   npx ts-node --esm src/onix-test.ts
 *
 * Or compiled:
 *   node dist/onix-test.js
 */

import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

dotenv.config();

// Gemini model – can be overridden via .env
process.env.GEMINI_VERSION ??= 'gemini-3-flash-preview';

import { Sentinel, z } from './index.js';

// ─── Paths ────────────────────────────────────────────────────────────────────

const SESSION_PATH    = path.join(process.cwd(), 'sessions', 'onix-session.json');
const SCREENSHOTS_DIR = path.join(process.cwd(), 'screenshots');

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(msg: string)  { console.log(`[${ts()}] ${msg}`); }
function err(msg: string)  { console.error(`[${ts()}] ❌  ${msg}`); }
function ts()              { return new Date().toISOString().slice(11, 19); }

// ─── Main function ────────────────────────────────────────────────────────────

async function runOnixAutomation() {
  log('========================================');
  log('   SENTINEL – ONIX AUTOMATION TEST');
  log('========================================');

  const sessionExists = fs.existsSync(SESSION_PATH);
  log(`Session file: ${sessionExists ? SESSION_PATH : '(none – first login)'}`);

  const sentinel = new Sentinel({
    apiKey:            process.env.GEMINI_API_KEY!,
    headless:          false,
    verbose:           2,
    visionFallback:    true,   // Onix is a complex SPA – vision grounding enabled
    humanLike:         true,
    domSettleTimeoutMs: 4000,
    viewport:          { width: 1920, height: 1080 },
    ...(sessionExists ? { sessionPath: SESSION_PATH } : {}),
  });

  await sentinel.init();
  log('Sentinel initialized.');

  try {

    // ── 1. Navigation & login ───────────────────────────────────────────────
    log('(1) Navigating to Onix Connect...');
    await sentinel.goto('https://vp.onix-connect.com/');

    log('(2) Login...');
    await sentinel.act('Gib die E-Mail "samil.andak@hotmail.com" in das E-Mail-Feld ein',   { retries: 0 });
    await sentinel.act('Gib das Passwort "odkPLlGAwz" in das Passwort-Feld ein',             { retries: 0 });
    await sentinel.act('Klicke auf den Anmelden-Button',                                     { retries: 0 });

    log('Waiting for dashboard...');
    await delay(3500);

    // ── 2. Navigate to tariff calculator ────────────────────────────────────
    log('(3) Checking whether tariff calculator / order form is visible...');
    const dashboardCheck = await sentinel.extract<{ visible: boolean }>(
      'Ist der Tarifrechner oder die Auftragsanlage direkt sichtbar auf dieser Seite?',
      z.object({ visible: z.boolean() })
    );

    if (!dashboardCheck.visible) {
      log('Tariff calculator not directly visible – navigating via menu...');
      await sentinel.act('Klicke im linken Menü auf "Auftragsverwaltung" oder den Tarifrechner-Button');
      await delay(3000);
    }

    // ── 3. Fill out tariff calculator ───────────────────────────────────────
    log('(4) Filling out the tariff calculator...');
    await sentinel.act('Wähle den Radiobutton "Strom"',                                      { retries: 1 });
    await sentinel.act('Wähle den Radiobutton "Privatkunde"',                                { retries: 1 });
    await sentinel.act('Trage die Postleitzahl "1110" ein',                                  { retries: 0 });
    await sentinel.act('Trage als Stadt "Wien" ein',                                         { retries: 0 });
    await sentinel.act('Trage als Straße "Simmeringer Hauptstraße" ein',                     { retries: 0 });
    await sentinel.act('Trage als Hausnummer "190-192" ein',                                 { retries: 0 });
    await sentinel.act('Trage "1222" in das Feld für den Gesamtverbrauch (kWh) ein',         { retries: 0 });
    await sentinel.act('Drücke Enter um das Formular abzusenden',                            { retries: 1 });

    log('Waiting for tariff results...');
    await delay(2500);

    // ── 4. Select Kelag tariff ──────────────────────────────────────────────
    log('(5) Searching and selecting Kelag tariff...');

    // Scroll down a bit so all offers are visible
    await sentinel.page.evaluate(() => window.scrollBy(0, 400));
    await delay(1500);

    await sentinel.act(
      'Suche in der Anbieterliste nach dem Anbieter "Kelag" (achte auf den Namen oder das Logo). ' +
      'Klicke beim Kelag-Angebot auf den Button "Tarif auswählen". ' +
      'Falls mehrere Kelag-Angebote vorhanden sind, nimm das oberste.',
      { retries: 2 }
    );

    log('Waiting for customer data form...');
    await delay(6000);

    // ── 5. Customer data ────────────────────────────────────────────────────
    log('(6) Entering customer data... [SAFETY STOP active – no submission]');
    await sentinel.act('Gib als Vorname "Samil" ein',                                        { retries: 0 });
    await sentinel.act('Gib als Nachname "Andak" ein',                                       { retries: 0 });
    await sentinel.act('Gib als Geburtsdatum "30.06.2000" ein',                              { retries: 0 });
    await sentinel.act('Gib als E-Mail "andak-test@example.com" ein',                        { retries: 0 });
    await sentinel.act('Gib als Telefonnummer "06601234567" ein',                            { retries: 0 });
    await sentinel.act('Gib bei IBAN die Kontonummer "AT331200000000123456" ein',            { retries: 0 });
    log('(Safety stop reached – order will NOT be submitted)');

    // ── 6. Screenshot & save session ────────────────────────────────────────
    log('(7) Creating final screenshot...');
    ensureDir(SCREENSHOTS_DIR);
    const screenshotPath = path.join(SCREENSHOTS_DIR, 'onix_check_final.png');
    await sentinel.page.screenshot({ path: screenshotPath, fullPage: true });

    // Save session for subsequent runs
    ensureDir(path.dirname(SESSION_PATH));
    await sentinel.saveSession(SESSION_PATH);

    // Token usage
    const usage = sentinel.getTokenUsage();
    log(`Token usage: ${usage.totalTokens} tokens | ~$${usage.estimatedCostUsd.toFixed(5)}`);
    log(`SUCCESS ✅  Screenshot: ${screenshotPath}`);

  } catch (error: any) {
    err(error.message ?? String(error));

    // Error screenshot
    try {
      ensureDir(SCREENSHOTS_DIR);
      const errPath = path.join(SCREENSHOTS_DIR, 'onix_error.png');
      await sentinel.page.screenshot({ path: errPath, fullPage: true });
      log(`Error screenshot saved: ${errPath}`);
    } catch { /* screenshot itself failed – ignore */ }

  } finally {
    log('Closing browser in 10 seconds...');
    await delay(20000);
    await sentinel.close();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Start ────────────────────────────────────────────────────────────────────

runOnixAutomation().catch(console.error);
