import { StateParser } from '../core/state-parser.js';
import { GeminiService } from '../utils/gemini.js';
export class Verifier {
    page;
    stateParser;
    gemini;
    constructor(page, stateParser, gemini) {
        this.page = page;
        this.stateParser = stateParser;
        this.gemini = gemini;
    }
    async verifyAction(action, stateBefore, stateAfter) {
        const prompt = `
      I performed an action on a page: "${action}".
      
      State BEFORE action:
      - Title: ${stateBefore.title}
      - URL: ${stateBefore.url}
      - Elements Counts: ${stateBefore.elements.length}
      
      State AFTER action:
      - Title: ${stateAfter.title}
      - URL: ${stateAfter.url}
      - Elements Counts: ${stateAfter.elements.length}
      
      Did the action achieve its goal? Respond with JSON: { "success": boolean, "confidence": number, "explanation": string }
    `;
        const schema = {
            type: "object",
            properties: {
                success: { type: "boolean" },
                confidence: { type: "number" },
                explanation: { type: "string" }
            },
            required: ["success", "confidence", "explanation"]
        };
        const result = await this.gemini.generateStructuredData(prompt, schema);
        return {
            done: true,
            success: result.success,
            message: result.explanation,
            confidence: result.confidence
        };
    }
}
//# sourceMappingURL=verifier.js.map