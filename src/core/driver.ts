import { chromium, firefox, webkit } from 'playwright';
import type { Browser, BrowserContext, Page, CDPSession } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { isProxyProvider } from '../utils/proxy-provider.js';
import type { IProxyProvider } from '../utils/proxy-provider.js';

export type BrowserType = 'chromium' | 'firefox' | 'webkit';

export interface ProxyOptions {
  server: string;
  username?: string;
  password?: string;
}

export interface DriverOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  browser?: BrowserType;
  sessionPath?: string;
  userDataDir?: string;
  proxy?: ProxyOptions | IProxyProvider;
  stealth?: boolean;
  humanLike?: boolean;
}

export class SentinelDriver {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Page[] = [];
  private activePageIndex = 0;
  private cdpSession: CDPSession | null = null;
  private _activeProxy: ProxyOptions | undefined;
  private _proxyProvider: IProxyProvider | undefined;

  constructor(private options: DriverOptions = { headless: false }) {}

  async initialize() {
    const browserType = this.options.browser ?? 'chromium';
    const launcher = browserType === 'firefox' ? firefox : browserType === 'webkit' ? webkit : chromium;

    const launchArgs = browserType === 'chromium'
      ? ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
      : [];

    // Resolve proxy: plain ProxyOptions or IProxyProvider (fetches dynamically)
    let resolvedProxy: ProxyOptions | undefined;
    if (this.options.proxy) {
      if (isProxyProvider(this.options.proxy)) {
        resolvedProxy = await this.options.proxy.getProxy();
        this._activeProxy = resolvedProxy;
        this._proxyProvider = this.options.proxy;
      } else {
        resolvedProxy = this.options.proxy;
      }
    }

    const contextOptions = {
      viewport: this.options.viewport || { width: 1280, height: 720 },
      userAgent: this.getRandomUserAgent(),
      locale: 'de-AT',
      timezoneId: 'Europe/Vienna',
      ...(resolvedProxy ? { proxy: resolvedProxy } : {}),
    };

    if (this.options.userDataDir) {
      // Persistent context: stores cookies, localStorage, IndexedDB, ServiceWorkers
      // on disk — survives browser restarts without needing saveSession().
      // userDataDir is a path to a directory; Playwright creates it if it doesn't exist.
      if (!fs.existsSync(this.options.userDataDir)) {
        fs.mkdirSync(this.options.userDataDir, { recursive: true });
      }
      this.context = await launcher.launchPersistentContext(this.options.userDataDir, {
        headless: this.options.headless ?? false,
        args: launchArgs,
        ...contextOptions,
      });
      console.log(`[Driver] Persistent context loaded from ${this.options.userDataDir}`);
    } else {
      // Standard context: cookies + localStorage only (via optional storageState file)
      this.browser = await launcher.launch({
        headless: this.options.headless ?? false,
        args: launchArgs,
      });

      const storageState = this.options.sessionPath && fs.existsSync(this.options.sessionPath)
        ? JSON.parse(fs.readFileSync(this.options.sessionPath, 'utf-8'))
        : undefined;

      this.context = await this.browser.newContext({
        ...contextOptions,
        ...(storageState ? { storageState } : {}),
      });

      if (storageState) {
        console.log(`[Driver] Session loaded from ${this.options.sessionPath}`);
      }
    }

    const page = await this.context.newPage();
    this.pages = [page];
    this.activePageIndex = 0;

    // CDP only available for Chromium
    if (browserType === 'chromium') {
      this.cdpSession = await page.context().newCDPSession(page);
      await this.cdpSession.send('Accessibility.enable');
    }
  }

  // ─── Tab Management ───────────────────────────────────────────────────────

  async newTab(url?: string): Promise<number> {
    if (!this.context) throw new Error('Driver not initialized');
    const page = await this.context.newPage();
    this.pages.push(page);
    const index = this.pages.length - 1;
    if (url) {
      await this.gotoPage(page, url);
    }
    console.log(`[Driver] New tab opened (index ${index})`);
    return index;
  }

  async switchTab(index: number): Promise<void> {
    if (!this.pages[index]) throw new Error(`Tab ${index} does not exist`);
    this.activePageIndex = index;
    await this.pages[index]!.bringToFront();

    // Re-attach CDP session for new active page (Chromium only)
    if (this.options.browser !== 'firefox' && this.options.browser !== 'webkit') {
      this.cdpSession = await this.pages[index]!.context().newCDPSession(this.pages[index]!);
      await this.cdpSession.send('Accessibility.enable');
    }
    console.log(`[Driver] Switched to tab ${index}`);
  }

  async closeTab(index: number): Promise<void> {
    if (!this.pages[index]) throw new Error(`Tab ${index} does not exist`);
    await this.pages[index]!.close();
    this.pages.splice(index, 1);
    if (index < this.activePageIndex) {
      this.activePageIndex--;
    } else if (this.activePageIndex >= this.pages.length) {
      this.activePageIndex = Math.max(0, this.pages.length - 1);
    }
    console.log(`[Driver] Tab ${index} closed`);
  }

  get tabCount(): number {
    return this.pages.length;
  }

  // ─── Session Persistence ──────────────────────────────────────────────────

  async saveSession(filePath: string): Promise<void> {
    if (!this.context) throw new Error('Driver not initialized');
    const state = await this.context.storageState();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
    console.log(`[Driver] Session saved to ${filePath}`);
  }

  async hasLoginForm(): Promise<boolean> {
    const page = this.getPage();
    const loginIndicators = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      return inputs.some(
        i => i.type === 'password' ||
          i.name?.toLowerCase().includes('password') ||
          i.id?.toLowerCase().includes('password')
      );
    });
    return loginIndicators;
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  getPage(): Page {
    if (!this.pages[this.activePageIndex]) throw new Error('Driver not initialized');
    return this.pages[this.activePageIndex]!;
  }

  getContext(): BrowserContext {
    if (!this.context) throw new Error('Driver not initialized');
    return this.context;
  }

  getCDPSession(): CDPSession {
    if (!this.cdpSession) throw new Error('CDP session not available (only supported on Chromium)');
    return this.cdpSession;
  }

  async close() {
    if (this.options.userDataDir) {
      // Persistent context has no separate browser object — close the context directly.
      await this.context?.close();
    } else if (this.browser) {
      await this.browser.close();
    }
    // Notify provider that the proxy session is done (e.g. for usage tracking)
    if (this._proxyProvider?.releaseProxy && this._activeProxy) {
      await this._proxyProvider.releaseProxy(this._activeProxy).catch(() => {});
    }
  }

  async goto(url: string) {
    await this.gotoPage(this.getPage(), url);
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private async gotoPage(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
      console.warn(`[Driver] networkidle timeout for ${url} – proceeding anyway`);
    });

    if (this.options.humanLike) {
      await page.waitForTimeout(300 + Math.random() * 700);
    }
  }

  private getRandomUserAgent(): string {
    const agents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    ];
    return agents[Math.floor(Math.random() * agents.length)]!;
  }
}
