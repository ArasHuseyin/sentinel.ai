import { StateParser } from '../core/state-parser.js';
import { GeminiService } from '../utils/gemini.js';
export class ExtractionEngine {
    page;
    stateParser;
    gemini;
    constructor(page, stateParser, gemini) {
        this.page = page;
        this.stateParser = stateParser;
        this.gemini = gemini;
    }
    async extract(instruction, schema) {
        const fullState = await this.stateParser.parse(); // Using AOM for context
        // For extraction, we might need more than just interactive elements. 
        // But starting with AOM nodes is usually very efficient for structured data.
        const prompt = `
      Extract structured data from the following page according to the instruction: "${instruction}".
      
      URL: ${fullState.url}
      Title: ${fullState.title}
      
      Relevant Elements (AOM):
      ${JSON.stringify(fullState.elements, null, 2)}
      
      Return the data in the requested JSON format.
    `;
        return await this.gemini.generateStructuredData(prompt, schema);
    }
}
//# sourceMappingURL=extract.js.map