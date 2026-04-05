import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page, CDPSession } from 'playwright';

export interface DriverOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
}

export class SentinelDriver {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private cdpSession: CDPSession | null = null;

  constructor(private options: DriverOptions = { headless: false }) {}

  async initialize() {
    this.browser = await chromium.launch({
      headless: this.options.headless ?? false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    this.context = await this.browser.newContext({
      viewport: this.options.viewport || { width: 1280, height: 720 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'de-AT',
      timezoneId: 'Europe/Vienna',
    });

    this.page = await this.context.newPage();
    this.cdpSession = await this.page.context().newCDPSession(this.page);

    // Enable Accessibility tree access via CDP
    await this.cdpSession.send('Accessibility.enable');
  }

  getPage() {
    if (!this.page) throw new Error('Driver not initialized');
    return this.page;
  }

  getContext() {
    if (!this.context) throw new Error('Driver not initialized');
    return this.context;
  }

  getCDPSession() {
    if (!this.cdpSession) throw new Error('Driver not initialized');
    return this.cdpSession;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }

  async goto(url: string) {
    const page = this.getPage();

    // Use domcontentloaded as primary – faster and sufficient for most pages
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Then wait for network to settle (SPA content), but don't crash if it times out
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
      console.warn(`[Driver] networkidle timeout for ${url} – proceeding anyway`);
    });
  }
}
