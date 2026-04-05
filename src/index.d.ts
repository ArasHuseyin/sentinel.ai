import type { DriverOptions } from './core/driver.js';
export declare class Sentinel {
    private driver;
    private stateParser;
    private actionEngine;
    private extractionEngine;
    private observationEngine;
    private verifier;
    private gemini;
    constructor(apiKey: string, driverOptions?: DriverOptions);
    init(): Promise<void>;
    goto(url: string): Promise<void>;
    act(instruction: string, retries?: number): Promise<{
        success: boolean;
        message: string;
    }>;
    extract<T>(instruction: string, schema: any): Promise<T>;
    observe(): Promise<string[]>;
    close(): Promise<void>;
}
//# sourceMappingURL=index.d.ts.map