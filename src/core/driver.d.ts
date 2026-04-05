import { Page, CDPSession } from 'playwright';
export interface DriverOptions {
    headless?: boolean;
    viewport?: {
        width: number;
        height: number;
    };
}
export declare class SentinelDriver {
    private options;
    private browser;
    private context;
    private page;
    private cdpSession;
    constructor(options?: DriverOptions);
    initialize(): Promise<void>;
    getPage(): Page;
    getCDPSession(): CDPSession;
    close(): Promise<void>;
    goto(url: string): Promise<void>;
}
//# sourceMappingURL=driver.d.ts.map