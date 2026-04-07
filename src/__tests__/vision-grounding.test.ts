import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { VisionGrounding } from '../core/vision-grounding.js';
import type { LLMProvider } from '../utils/llm-provider.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProvider(analyzeImageResult?: string | null): LLMProvider & { analyzeImage: jest.Mock } {
  const mock = jest.fn<() => Promise<string>>();
  if (analyzeImageResult !== undefined && analyzeImageResult !== null) {
    mock.mockResolvedValue(analyzeImageResult);
  } else if (analyzeImageResult === null) {
    mock.mockRejectedValue(new Error('vision API error'));
  }
  return {
    generateStructuredData: jest.fn(async () => ({})) as any,
    generateText: jest.fn(async () => ''),
    analyzeImage: mock,
  };
}

function makeProviderWithoutVision(): LLMProvider {
  return {
    generateStructuredData: jest.fn(async () => ({})) as any,
    generateText: jest.fn(async () => ''),
  };
}

const FAKE_PNG = Buffer.from('fakepng');

// ─── VisionGrounding ──────────────────────────────────────────────────────────

describe('VisionGrounding', () => {

  describe('constructor', () => {
    it('logs a warning when provider lacks analyzeImage', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      new VisionGrounding(makeProviderWithoutVision());
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('does not implement analyzeImage'));
      warnSpy.mockRestore();
    });

    it('does not warn when provider has analyzeImage', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      new VisionGrounding(makeProvider('{}'));
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('takeScreenshot', () => {
    it('calls page.screenshot with png and fullPage: false', async () => {
      const provider = makeProvider('{}');
      const vg = new VisionGrounding(provider);

      const mockPage = {
        screenshot: jest.fn(async (_opts?: any) => FAKE_PNG),
      };

      const result = await vg.takeScreenshot(mockPage as any);

      expect(mockPage.screenshot).toHaveBeenCalledWith({ type: 'png', fullPage: false });
      expect(result).toBe(FAKE_PNG);
    });
  });

  describe('findElement', () => {
    it('returns null immediately when provider has no analyzeImage', async () => {
      const vg = new VisionGrounding(makeProviderWithoutVision());
      const result = await vg.findElement('Click submit', FAKE_PNG, 1280, 720);
      expect(result).toBeNull();
    });

    it('returns bounding box when LLM finds element', async () => {
      const response = JSON.stringify({ found: true, x: 100, y: 200, width: 80, height: 30, reasoning: 'Found it' });
      const provider = makeProvider(response);
      const vg = new VisionGrounding(provider);

      const result = await vg.findElement('Click submit', FAKE_PNG, 1280, 720);

      expect(result).toEqual({ x: 100, y: 200, width: 80, height: 30 });
    });

    it('uses fallback values when x/y/width/height are missing', async () => {
      const response = JSON.stringify({ found: true, reasoning: 'Found but no coords' });
      const provider = makeProvider(response);
      const vg = new VisionGrounding(provider);

      const result = await vg.findElement('Click submit', FAKE_PNG, 1280, 720);

      expect(result).toEqual({ x: 0, y: 0, width: 50, height: 30 });
    });

    it('returns null when LLM says found: false', async () => {
      const response = JSON.stringify({ found: false, reasoning: 'Element not visible' });
      const provider = makeProvider(response);
      const vg = new VisionGrounding(provider);

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await vg.findElement('Click invisible button', FAKE_PNG, 1280, 720);
      warnSpy.mockRestore();

      expect(result).toBeNull();
    });

    it('returns null when LLM returns non-JSON text', async () => {
      const provider = makeProvider('I could not find the element.');
      const vg = new VisionGrounding(provider);

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await vg.findElement('Click button', FAKE_PNG, 1280, 720);
      warnSpy.mockRestore();

      expect(result).toBeNull();
    });

    it('parses JSON wrapped in markdown code fences', async () => {
      const response = '```json\n{"found":true,"x":50,"y":80,"width":100,"height":40,"reasoning":"ok"}\n```';
      const provider = makeProvider(response);
      const vg = new VisionGrounding(provider);

      const result = await vg.findElement('Click button', FAKE_PNG, 1280, 720);

      expect(result).toEqual({ x: 50, y: 80, width: 100, height: 40 });
    });

    it('returns null and logs error when analyzeImage throws', async () => {
      const provider = makeProvider(null); // null → throws
      const vg = new VisionGrounding(provider);

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const result = await vg.findElement('Click submit', FAKE_PNG, 1280, 720);
      errorSpy.mockRestore();

      expect(result).toBeNull();
    });

    it('passes base64-encoded screenshot to analyzeImage', async () => {
      const response = JSON.stringify({ found: true, x: 10, y: 20, width: 50, height: 25, reasoning: 'ok' });
      const provider = makeProvider(response);
      const vg = new VisionGrounding(provider);

      await vg.findElement('Click button', FAKE_PNG, 1920, 1080);

      const callArgs = (provider.analyzeImage.mock.calls as any[][])[0]!;
      expect(callArgs[1]).toBe(FAKE_PNG.toString('base64'));
      expect(callArgs[2]).toBe('image/png');
      expect(callArgs[0]).toContain('1920x1080');
    });
  });

  describe('describeScreen', () => {
    it('returns fallback message when provider has no analyzeImage', async () => {
      const vg = new VisionGrounding(makeProviderWithoutVision());
      const result = await vg.describeScreen(FAKE_PNG);
      expect(result).toContain('Vision not available');
    });

    it('returns description from LLM', async () => {
      const provider = makeProvider('A login page with email and password fields.');
      const vg = new VisionGrounding(provider);

      const result = await vg.describeScreen(FAKE_PNG);

      expect(result).toBe('A login page with email and password fields.');
    });

    it('returns fallback string when analyzeImage throws', async () => {
      const provider = makeProvider(null); // throws
      const vg = new VisionGrounding(provider);

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const result = await vg.describeScreen(FAKE_PNG);
      errorSpy.mockRestore();

      expect(result).toBe('Could not describe screen.');
    });

    it('passes base64 screenshot with correct mime type', async () => {
      const provider = makeProvider('A page');
      const vg = new VisionGrounding(provider);

      await vg.describeScreen(FAKE_PNG);

      const callArgs = (provider.analyzeImage.mock.calls as any[][])[0]!;
      expect(callArgs[1]).toBe(FAKE_PNG.toString('base64'));
      expect(callArgs[2]).toBe('image/png');
    });
  });
});
