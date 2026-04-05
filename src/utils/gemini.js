import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
export class GeminiService {
    genAI;
    model;
    constructor(apiKey) {
        this.genAI = new GoogleGenerativeAI(apiKey);
        const modelName = process.env.GEMINI_VERSION || "gemini-1.5-flash";
        this.model = this.genAI.getGenerativeModel({
            model: modelName,
        });
    }
    async generateStructuredData(prompt, schema) {
        const modelName = process.env.GEMINI_VERSION || "gemini-1.5-flash";
        const model = this.genAI.getGenerativeModel({
            model: modelName,
        });
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: schema,
            },
        });
        const text = result.response.text();
        return JSON.parse(text);
    }
    async generateText(prompt, systemInstruction) {
        const modelName = process.env.GEMINI_VERSION || "gemini-1.5-flash";
        const params = {
            model: modelName,
        };
        if (systemInstruction) {
            params.systemInstruction = { role: "system", parts: [{ text: systemInstruction }] };
        }
        const model = this.genAI.getGenerativeModel(params);
        const result = await model.generateContent(prompt);
        return result.response.text();
    }
}
//# sourceMappingURL=gemini.js.map