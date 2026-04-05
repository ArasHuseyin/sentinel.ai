import { chromium, Browser, BrowserContext, Page, CDPSession } from 'playwright';
export class SentinelDriver {
    options;
    browser = null;
    context = null;
    page = null;
    cdpSession = null;
    constructor(options = { headless: false }) {
        this.options = options;
    }
    async initialize() {
        this.browser = await chromium.launch({
            headless: this.options.headless,
            args: ['--disable-blink-features=AutomationControlled'], // Hide automation
        });
        this.context = await this.browser.newContext({
            viewport: this.options.viewport || { width: 1280, height: 720 },
        });
        this.page = await this.context.newPage();
        this.cdpSession = await this.page.context().newCDPSession(this.page);
        // Enable Accessibility tree access via CDP
        await this.cdpSession.send('Accessibility.enable');
    }
    getPage() {
        if (!this.page)
            throw new Error('Driver not initialized');
        return this.page;
    }
    getCDPSession() {
        if (!this.cdpSession)
            throw new Error('Driver not initialized');
        return this.cdpSession;
    }
    async close() {
        if (this.browser) {
            await this.browser.close();
        }
    }
    async goto(url) {
        const page = this.getPage();
        await page.goto(url, { waitUntil: 'load' });
    }
}
//# sourceMappingURL=driver.js.map