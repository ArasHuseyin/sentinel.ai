/**
 * Onix Connect – Automatisierungstest
 *
 * Flow:
 *   Login → Tarifrechner ausfüllen → Kelag-Tarif auswählen → Kundendaten eingeben
 *
 * Auführen (nach npm run build):
 *   npx ts-node --esm src/onix-test.ts
 *
 * Oder kompiliert:
 *   node dist/onix-test.js
 */

import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

dotenv.config();

// Gemini-Modell – kann per .env überschrieben werden
process.env.GEMINI_VERSION ??= 'gemini-3-flash-preview';

import { Sentinel, z } from './index.js';

// ─── Pfade ────────────────────────────────────────────────────────────────────

const SESSION_PATH    = path.join(process.cwd(), 'sessions', 'onix-session.json');
const SCREENSHOTS_DIR = path.join(process.cwd(), 'screenshots');

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(msg: string)  { console.log(`[${ts()}] ${msg}`); }
function err(msg: string)  { console.error(`[${ts()}] ❌  ${msg}`); }
function ts()              { return new Date().toISOString().slice(11, 19); }

// ─── Hauptfunktion ────────────────────────────────────────────────────────────

async function runOnixAutomation() {
  log('========================================');
  log('   SENTINEL – ONIX AUTOMATION TEST');
  log('========================================');

  const sessionExists = fs.existsSync(SESSION_PATH);
  log(`Sitzungsdatei: ${sessionExists ? SESSION_PATH : '(keine – Erstanmeldung)'}`);

  const sentinel = new Sentinel({
    apiKey:            process.env.GEMINI_API_KEY!,
    headless:          false,
    verbose:           1,
    visionFallback:    true,   // Onix ist eine komplexe SPA – Vision Grounding aktiviert
    humanLike:         true,
    domSettleTimeoutMs: 4000,
    viewport:          { width: 1920, height: 1080 },
    ...(sessionExists ? { sessionPath: SESSION_PATH } : {}),
  });

  await sentinel.init();
  log('Sentinel initialisiert.');

  try {

    // ── 1. Navigation & Login ───────────────────────────────────────────────
    log('(1) Navigiere zu Onix Connect...');
    await sentinel.goto('https://vp.onix-connect.com/');

    log('(2) Login...');
    await sentinel.act('Gib die E-Mail "samil.andak@hotmail.com" in das E-Mail-Feld ein',   { retries: 0 });
    await sentinel.act('Gib das Passwort "odkPLlGAwz" in das Passwort-Feld ein',             { retries: 0 });
    await sentinel.act('Klicke auf den Anmelden-Button',                                     { retries: 0 });

    log('Warte auf Dashboard...');
    await delay(3500);

    // ── 2. Navigation zum Tarifrechner ──────────────────────────────────────
    log('(3) Prüfe ob Tarifrechner / Auftragsanlage sichtbar...');
    const dashboardCheck = await sentinel.extract<{ visible: boolean }>(
      'Ist der Tarifrechner oder die Auftragsanlage direkt sichtbar auf dieser Seite?',
      z.object({ visible: z.boolean() })
    );

    if (!dashboardCheck.visible) {
      log('Tarifrechner nicht direkt sichtbar – navigiere über Menü...');
      await sentinel.act('Klicke im linken Menü auf "Auftragsverwaltung" oder den Tarifrechner-Button');
      await delay(3000);
    }

    // ── 3. Tarifrechner ausfüllen ───────────────────────────────────────────
    log('(4) Fülle den Tarifrechner aus...');
    await sentinel.act('Wähle den Radiobutton "Strom"',                                      { retries: 1 });
    await sentinel.act('Wähle den Radiobutton "Privatkunde"',                                { retries: 1 });
    await sentinel.act('Trage die Postleitzahl "1110" ein',                                  { retries: 0 });
    await sentinel.act('Trage als Stadt "Wien" ein',                                         { retries: 0 });
    await sentinel.act('Trage als Straße "Simmeringer Hauptstraße" ein',                     { retries: 0 });
    await sentinel.act('Trage als Hausnummer "190-192" ein',                                 { retries: 0 });
    await sentinel.act('Trage "1222" in das Feld für den Gesamtverbrauch (kWh) ein',         { retries: 0 });
    await sentinel.act('Drücke Enter um das Formular abzusenden',                            { retries: 1 });

    log('Warte auf Tarif-Ergebnisse...');
    await delay(2500);

    // ── 4. Kelag-Tarif auswählen ────────────────────────────────────────────
    log('(5) Suche und wähle Kelag-Tarif...');

    // Etwas nach unten scrollen damit alle Angebote sichtbar sind
    await sentinel.page.evaluate(() => window.scrollBy(0, 400));
    await delay(1500);

    await sentinel.act(
      'Suche in der Anbieterliste nach dem Anbieter "Kelag" (achte auf den Namen oder das Logo). ' +
      'Klicke beim Kelag-Angebot auf den Button "Tarif auswählen". ' +
      'Falls mehrere Kelag-Angebote vorhanden sind, nimm das oberste.',
      { retries: 3 }
    );

    log('Warte auf Kundendaten-Formular...');
    await delay(6000);

    // ── 5. Kundendaten ──────────────────────────────────────────────────────
    log('(6) Kundendaten eingeben... [SICHERHEITSSTOP aktiv – kein Absenden]');
    await sentinel.act('Gib als Vorname "Samil" ein',                                        { retries: 0 });
    await sentinel.act('Gib als Nachname "Andak" ein',                                       { retries: 0 });
    await sentinel.act('Gib als Geburtsdatum "30.06.2000" ein',                              { retries: 0 });
    await sentinel.act('Gib als E-Mail "andak-test@example.com" ein',                        { retries: 0 });
    await sentinel.act('Gib als Telefonnummer "06601234567" ein',                            { retries: 0 });
    await sentinel.act('Gib bei IBAN die Kontonummer "AT331200000000123456" ein',            { retries: 0 });
    log('(Sicherheitsstop erreicht – Auftrag wird NICHT abgesendet)');

    // ── 6. Screenshot & Session speichern ───────────────────────────────────
    log('(7) Erstelle Abschluss-Screenshot...');
    ensureDir(SCREENSHOTS_DIR);
    const screenshotPath = path.join(SCREENSHOTS_DIR, 'onix_check_final.png');
    await sentinel.page.screenshot({ path: screenshotPath, fullPage: true });

    // Session für Folgeläufe speichern
    ensureDir(path.dirname(SESSION_PATH));
    await sentinel.saveSession(SESSION_PATH);

    // Token-Verbrauch
    const usage = sentinel.getTokenUsage();
    log(`Token-Verbrauch: ${usage.totalTokens} Tokens | ~$${usage.estimatedCostUsd.toFixed(5)}`);
    log(`ERFOLG ✅  Screenshot: ${screenshotPath}`);

  } catch (error: any) {
    err(error.message ?? String(error));

    // Fehler-Screenshot
    try {
      ensureDir(SCREENSHOTS_DIR);
      const errPath = path.join(SCREENSHOTS_DIR, 'onix_error.png');
      await sentinel.page.screenshot({ path: errPath, fullPage: true });
      log(`Fehler-Screenshot gespeichert: ${errPath}`);
    } catch { /* Screenshot selbst fehlgeschlagen – ignorieren */ }

  } finally {
    log('Schließe Browser in 10 Sekunden...');
    await delay(20000);
    await sentinel.close();
  }
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Start ────────────────────────────────────────────────────────────────────

runOnixAutomation().catch(console.error);
