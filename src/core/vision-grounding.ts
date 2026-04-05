import type { Page } from 'playwright';
import { GoogleGenerativeAI } from '@google/generative-ai';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisionElement {
  description: string;
  boundingBox: BoundingBox;
  confidence: number;
}

/**
 * Vision-based element grounding using Gemini's multimodal capabilities.
 * Used as a fallback when the AOM (Accessibility Tree) cannot find an element.
 */
export class VisionGrounding {
  private genAI: GoogleGenerativeAI;
  private model: any;

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    const modelName = process.env.GEMINI_VERSION;
    if (!modelName) throw new Error('GEMINI_VERSION must be set in .env');
    this.model = this.genAI.getGenerativeModel({ model: modelName });
  }

  /**
   * Takes a screenshot of the current page and returns it as a base64 PNG buffer.
   */
  async takeScreenshot(page: Page): Promise<Buffer> {
    return await page.screenshot({ type: 'png', fullPage: false });
  }

  /**
   * Asks Gemini Vision to find an element matching the instruction and return its bounding box.
   * Returns null if the element cannot be found.
   */
  async findElement(
    instruction: string,
    screenshot: Buffer,
    viewportWidth: number,
    viewportHeight: number
  ): Promise<BoundingBox | null> {
    const base64 = screenshot.toString('base64');

    const prompt = `
You are a browser automation assistant analyzing a screenshot.

Task: Find the UI element that matches this instruction: "${instruction}"

The screenshot is ${viewportWidth}x${viewportHeight} pixels.

Return the bounding box of the element as JSON with these fields:
- x: left edge in pixels
- y: top edge in pixels  
- width: element width in pixels
- height: element height in pixels
- found: true if element was found, false if not visible

Be precise. If the element is not visible in the screenshot, set found to false.
    `;

    const schema = {
      type: 'object',
      properties: {
        found: { type: 'boolean' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        reasoning: { type: 'string' },
      },
      required: ['found', 'reasoning'],
    };

    try {
      const result = await this.model.generateContent({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              { inlineData: { mimeType: 'image/png', data: base64 } },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
      });

      const parsed = JSON.parse(result.response.text());

      if (!parsed.found) {
        console.warn(`[Vision] Element not found: "${instruction}" — ${parsed.reasoning}`);
        return null;
      }

      console.log(`[Vision] Found element: "${instruction}" at (${parsed.x}, ${parsed.y}) — ${parsed.reasoning}`);
      return {
        x: parsed.x ?? 0,
        y: parsed.y ?? 0,
        width: parsed.width ?? 50,
        height: parsed.height ?? 30,
      };
    } catch (err: any) {
      console.error(`[Vision] findElement failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Describes the current page visually using Gemini Vision.
   * Useful for debugging and agent context building.
   */
  async describeScreen(screenshot: Buffer): Promise<string> {
    const base64 = screenshot.toString('base64');

    try {
      const result = await this.model.generateContent({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: 'Describe this webpage screenshot briefly: what page is it, what are the main UI elements visible, and what actions are possible?',
              },
              { inlineData: { mimeType: 'image/png', data: base64 } },
            ],
          },
        ],
      });
      return result.response.text();
    } catch (err: any) {
      console.error(`[Vision] describeScreen failed: ${err.message}`);
      return 'Could not describe screen.';
    }
  }
}
