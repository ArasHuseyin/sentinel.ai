import type { CDPSession, Page } from 'playwright';
export type PageRegion = 'header' | 'nav' | 'sidebar' | 'main' | 'footer' | 'modal' | 'popup';
export interface UIElement {
    id: number;
    role: string;
    name: string;
    description?: string;
    region?: PageRegion;
    boundingClientRect: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    attributes?: Record<string, string>;
    state?: {
        disabled?: boolean;
        hidden?: boolean;
        focused?: boolean;
        checked?: boolean | 'mixed';
    };
}
export interface SimplifiedState {
    url: string;
    title: string;
    elements: UIElement[];
}
export declare class StateParser {
    private page;
    private cdp;
    private elementCounter;
    constructor(page: Page, cdp: CDPSession);
    parse(): Promise<SimplifiedState>;
    private isInteractive;
    private nodeToUIElement;
}
//# sourceMappingURL=state-parser.d.ts.map