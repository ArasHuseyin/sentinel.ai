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

const MIN_CONFIDENCE = 0.5;

/**
 * Vision-based element grounding using any vision-capable LLMProvider.
 * Used as a fallback when the AOM (Accessibility Tree) cannot find an element.
 *
 * Supported out of the box: GeminiProvider, OpenAIProvider, ClaudeProvider,
 * OllamaProvider (with a vision model such as llava or bakllava).
 */
export class VisionGrounding {
  constructor(private provider: LLMProvider, private verbose: number = 1) {
    if (!provider.analyzeImage && this.verbose >= 1) {
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
   * Asks the vision-capable LLM to find an element matching the instruction and return its bounding box
   * in CSS pixels (ready to hand to `page.mouse.click`). Handles HiDPI/deviceScaleFactor by reading the
   * screenshot's native dimensions from the PNG header and rescaling the model's answer.
   *
   * Returns null if the element cannot be found, the provider lacks vision, the response is incomplete,
   * confidence is below threshold, or the computed bbox falls outside the viewport.
   */
  async findElement(
    instruction: string,
    screenshot: Buffer,
    viewportWidth: number,
    viewportHeight: number
  ): Promise<BoundingBox | null> {
    if (!this.provider.analyzeImage) return null;

    const imageSize = readPngDimensions(screenshot);
    const imgW = imageSize?.width ?? viewportWidth;
    const imgH = imageSize?.height ?? viewportHeight;
    const scaleX = imgW / viewportWidth;
    const scaleY = imgH / viewportHeight;

    const base64 = screenshot.toString('base64');

    const prompt = `
You are a browser automation assistant analyzing a screenshot.

Task: Find the UI element that matches this instruction: "${instruction}"

The image is ${imgW}x${imgH} pixels. Use the image's absolute pixel coordinate system with origin (0,0) at the TOP-LEFT corner and the positive Y axis pointing DOWN. All coordinates must be absolute image pixels — NOT normalized, NOT percentages, NOT thousandths.

Return ONLY a JSON object with these fields (no markdown, no explanation):
{
  "found": true or false,
  "x": left edge in image pixels,
  "y": top edge in image pixels,
  "width": element width in image pixels,
  "height": element height in image pixels,
  "confidence": number between 0.0 and 1.0,
  "reasoning": "brief explanation"
}

If you cannot confidently locate the element, set found to false and omit the coordinate fields.
    `.trim();

    try {
      const raw = await this.provider.analyzeImage(prompt, base64, 'image/png');
      const parsed = extractJSON(raw);

      if (!parsed?.found) {
        this.warnMsg(1, `[Vision] Element not found: "${instruction}" — ${parsed?.reasoning ?? 'no reason given'}`);
        return null;
      }

      if (
        !Number.isFinite(parsed.x) ||
        !Number.isFinite(parsed.y) ||
        !Number.isFinite(parsed.width) ||
        !Number.isFinite(parsed.height) ||
        parsed.width <= 0 ||
        parsed.height <= 0
      ) {
        this.warnMsg(1, `[Vision] Incomplete bbox for "${instruction}" — missing or invalid coordinates`);
        return null;
      }

      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 1;
      if (confidence < MIN_CONFIDENCE) {
        this.warnMsg(1, `[Vision] Low confidence (${confidence.toFixed(2)}) for "${instruction}" — rejecting`);
        return null;
      }

      const cssX = parsed.x / scaleX;
      const cssY = parsed.y / scaleY;
      const cssW = parsed.width / scaleX;
      const cssH = parsed.height / scaleY;

      const cx = cssX + cssW / 2;
      const cy = cssY + cssH / 2;
      if (cx < 0 || cy < 0 || cx > viewportWidth || cy > viewportHeight) {
        this.warnMsg(
          1,
          `[Vision] Out-of-bounds bbox for "${instruction}": center (${cx.toFixed(0)},${cy.toFixed(0)}) outside viewport ${viewportWidth}x${viewportHeight}`
        );
        return null;
      }

      this.log(2, `[Vision] Found element: "${instruction}" at (${cssX.toFixed(0)}, ${cssY.toFixed(0)}) conf=${confidence.toFixed(2)} — ${parsed.reasoning}`);
      return { x: cssX, y: cssY, width: cssW, height: cssH };
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

  private log(level: number, msg: string): void {
    if (this.verbose >= level) console.log(msg);
  }

  private warnMsg(level: number, msg: string): void {
    if (this.verbose >= level) console.warn(msg);
  }
}

/**
 * Reads width/height from a PNG buffer's IHDR chunk.
 * Returns null if the buffer is not a valid PNG (e.g. in tests with fake buffers).
 */
function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) return null;
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
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
