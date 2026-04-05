import { SentinelDriver } from './core/driver.js';
import { StateParser } from './core/state-parser.js';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

async function debugAOM() {
  const driver = new SentinelDriver({ headless: false });
  await driver.initialize();
  const page = driver.getPage()!;
  
  await page.goto("https://web.whatsapp.com");
  console.log("WAITING FOR MANUAL LOGIN...");
  await page.waitForSelector('#pane-side', { timeout: 120000 });
  
  console.log("Logged in. Capturing AOM...");
  const cdp = driver.getCDPSession()!;
  const parser = new StateParser(page, cdp);
  const state = await parser.parse();
  
  fs.writeFileSync('whatsapp-aom-debug.json', JSON.stringify(state, null, 2));
  console.log("AOM saved to whatsapp-aom-debug.json");
  
  await driver.close();
}

debugAOM();
