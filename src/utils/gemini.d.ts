export declare class GeminiService {
    private genAI;
    private model;
    constructor(apiKey: string);
    generateStructuredData<T>(prompt: string, schema: any): Promise<T>;
    generateText(prompt: string, systemInstruction?: string): Promise<string>;
}
//# sourceMappingURL=gemini.d.ts.map