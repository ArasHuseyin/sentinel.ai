import type { Page } from 'playwright';
import type { LLMProvider } from '../utils/llm-provider.js';

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
 * Vision-based element grounding using any vision-capable LLMProvider.
 * Used as a fallback when the AOM (Accessibility Tree) cannot find an element.
 *
 * Supported out of the box: GeminiProvider, OpenAIProvider, ClaudeProvider,
 * OllamaProvider (with a vision model such as llava or bakllava).
 */
export class VisionGrounding {
  constructor(private provider: LLMProvider) {
    if (!provider.analyzeImage) {
      console.warn(
        '[VisionGrounding] The configured LLM provider does not implement analyzeImage. ' +
        'Vision fallback will be disabled. Use a vision-capable model (Gemini, GPT-4o, Claude 3, llava).'
      );
    }
  }

  /**
   * Takes a screenshot of the current page and returns it as a base64 PNG buffer.
   */
  async takeScreenshot(page: Page): Promise<Buffer> {
    return await page.screenshot({ type: 'png', fullPage: false });
  }

  /**
   * Asks the vision-capable LLM to find an element matching the instruction and return its bounding box.
   * Returns null if the element cannot be found or the provider does not support vision.
   */
  async findElement(
    instruction: string,
    screenshot: Buffer,
    viewportWidth: number,
    viewportHeight: number
  ): Promise<BoundingBox | null> {
    if (!this.provider.analyzeImage) return null;

    const base64 = screenshot.toString('base64');

    const prompt = `
You are a browser automation assistant analyzing a screenshot.

Task: Find the UI element that matches this instruction: "${instruction}"

The screenshot is ${viewportWidth}x${viewportHeight} pixels.

Return ONLY a JSON object with these fields (no markdown, no explanation):
{
  "found": true or false,
  "x": left edge in pixels,
  "y": top edge in pixels,
  "width": element width in pixels,
  "height": element height in pixels,
  "reasoning": "brief explanation"
}

If the element is not visible, set found to false and omit x/y/width/height.
    `.trim();

    try {
      const raw = await this.provider.analyzeImage(prompt, base64, 'image/png');
      const parsed = extractJSON(raw);

      if (!parsed?.found) {
        console.warn(`[Vision] Element not found: "${instruction}" — ${parsed?.reasoning ?? 'no reason given'}`);
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
   * Describes the current page visually.
   * Useful for debugging and agent context building.
   */
  async describeScreen(screenshot: Buffer): Promise<string> {
    if (!this.provider.analyzeImage) return 'Vision not available — provider does not support analyzeImage.';

    const base64 = screenshot.toString('base64');
    try {
      return await this.provider.analyzeImage(
        'Describe this webpage screenshot briefly: what page is it, what are the main UI elements visible, and what actions are possible?',
        base64,
        'image/png'
      );
    } catch (err: any) {
      console.error(`[Vision] describeScreen failed: ${err.message}`);
      return 'Could not describe screen.';
    }
  }
}

/**
 * Extracts the first JSON object from a string, handling markdown code fences.
 */
function extractJSON(text: string): any {
  try {
    return JSON.parse(text.trim());
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
    if (match) {
      try { return JSON.parse(match[1]!.trim()); } catch { /* fall through */ }
    }
    return null;
  }
}
