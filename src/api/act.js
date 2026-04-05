import { StateParser } from '../core/state-parser.js';
import { GeminiService } from '../utils/gemini.js';
export class ActionEngine {
    page;
    stateParser;
    gemini;
    constructor(page, stateParser, gemini) {
        this.page = page;
        this.stateParser = stateParser;
        this.gemini = gemini;
    }
    async act(instruction) {
        const state = await this.stateParser.parse();
        const prompt = `
      Current Page URL: ${state.url}
      Page Title: ${state.title}
      Instruction: "${instruction}"
      
      Elements on page:
      ${JSON.stringify(state.elements.map(e => ({ id: e.id, role: e.role, name: e.name })), null, 2)}
      
      Select the ID of the element to interact with and the action to perform (click, fill, hover).
      If the action is "fill", provide the value to fill.
    `;
        const schema = {
            type: "object",
            properties: {
                elementId: { type: "number" },
                action: { type: "string", enum: ["click", "fill", "hover"] },
                value: { type: "string" },
                reasoning: { type: "string" }
            },
            required: ["elementId", "action", "reasoning"]
        };
        const decision = await this.gemini.generateStructuredData(prompt, schema);
        const target = state.elements.find(e => e.id === decision.elementId);
        if (!target) {
            return { success: false, message: `Could not find element with ID ${decision.elementId}` };
        }
        console.log(`Action: ${decision.action} on "${target.name}" (${target.role}) - ${decision.reasoning}`);
        try {
            if (decision.action === 'click') {
                // Use coordinates for reliability to avoid overlapping elements blocking the click if possible
                const { x, y, width, height } = target.boundingClientRect;
                await this.page.mouse.click(x + width / 2, y + height / 2);
            }
            else if (decision.action === 'fill') {
                const { x, y, width, height } = target.boundingClientRect;
                await this.page.mouse.click(x + width / 2, y + height / 2);
                await this.page.keyboard.type(decision.value || '');
            }
            else if (decision.action === 'hover') {
                const { x, y, width, height } = target.boundingClientRect;
                await this.page.mouse.move(x + width / 2, y + height / 2);
            }
            // Basic Post-Action verification: Wait for something to change
            await this.page.waitForTimeout(1000); // Wait for animations
            return { success: true, message: `Successfully performed ${decision.action} on ${target.name}` };
        }
        catch (e) {
            return { success: false, message: `Action failed: ${e.message}` };
        }
    }
}
//# sourceMappingURL=act.js.map