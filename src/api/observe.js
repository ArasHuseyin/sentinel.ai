import { StateParser } from '../core/state-parser.js';
import { GeminiService } from '../utils/gemini.js';
export class ObservationEngine {
    page;
    stateParser;
    gemini;
    constructor(page, stateParser, gemini) {
        this.page = page;
        this.stateParser = stateParser;
        this.gemini = gemini;
    }
    async observe() {
        const fullState = await this.stateParser.parse();
        const prompt = `
      List the possible actions a user can take on this page.
      Respond with a brief list of available interactions (buttons, links, inputs).
      URL: ${fullState.url}
      Title: ${fullState.title}
      Interactive Elements: ${JSON.stringify(fullState.elements.map(e => e.name), null, 1)}
    `;
        const systemInstruction = "You are a web observation agent. You identify interactive elements and their purpose.";
        const response = await this.gemini.generateText(prompt, systemInstruction);
        return [response];
    }
}
//# sourceMappingURL=observe.js.map