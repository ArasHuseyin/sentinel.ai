import { jest, describe, it, expect } from '@jest/globals';
import { StateParser } from '../core/state-parser.js';
import type { SimplifiedState } from '../core/state-parser.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(role: string, name: string, backendDOMNodeId = 1, ignored = false) {
  return {
    role: { value: role },
    name: { value: name },
    description: { value: '' },
    backendDOMNodeId,
    ignored,
    properties: [],
  };
}

function makeBoxModel(x = 10, y = 20, width = 100, height = 30) {
  return {
    model: {
      // CDP box model: [x0,y0, x1,y0, x1,y1, x0,y1] (8 values)
      content: [x, y, x + width, y, x + width, y + height, x, y + height],
    },
  };
}

function makeMockCDP(nodes: any[], boxModels: any[]) {
  return {
    send: jest.fn(async (method: string, params?: any) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes };
      if (method === 'DOM.getBoxModel') {
        const idx = nodes.findIndex(
          (n) => n.backendDOMNodeId === params?.backendNodeId
        );
        return boxModels[idx] ?? makeBoxModel();
      }
      return {};
    }),
  };
}

function makeMockPage(url = 'https://example.com', title = 'Example') {
  return {
    url: () => url,
    title: jest.fn(async () => title),
    evaluate: jest.fn(async () => []),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('StateParser', () => {
  it('returns url and title from page', async () => {
    const nodes = [makeNode('button', 'Submit', 1)];
    const cdp = makeMockCDP(nodes, [makeBoxModel()]);
    const page = makeMockPage('https://test.com', 'Test Page');

    const parser = new StateParser(page as any, cdp as any);
    const state: SimplifiedState = await parser.parse();

    expect(state.url).toBe('https://test.com');
    expect(state.title).toBe('Test Page');
  });

  it('parses interactive button element correctly', async () => {
    const nodes = [makeNode('button', 'Login', 42)];
    const cdp = makeMockCDP(nodes, [makeBoxModel(5, 10, 80, 25)]);
    const page = makeMockPage();

    const parser = new StateParser(page as any, cdp as any);
    const state = await parser.parse();

    expect(state.elements).toHaveLength(1);
    const el = state.elements[0]!;
    expect(el.role).toBe('button');
    expect(el.name).toBe('Login');
    expect(el.boundingClientRect.x).toBe(5);
    expect(el.boundingClientRect.y).toBe(10);
    expect(el.boundingClientRect.width).toBe(80);
    expect(el.boundingClientRect.height).toBe(25);
  });

  it('filters out non-interactive roles', async () => {
    const nodes = [
      makeNode('generic', 'Some div', 1),
      makeNode('heading', 'Title', 2),
      makeNode('link', 'Click me', 3),
    ];
    const cdp = makeMockCDP(nodes, [makeBoxModel(), makeBoxModel(), makeBoxModel()]);
    const page = makeMockPage();

    const parser = new StateParser(page as any, cdp as any);
    const state = await parser.parse();

    // Only 'link' is interactive
    expect(state.elements).toHaveLength(1);
    expect(state.elements[0]!.role).toBe('link');
  });

  it('filters out ignored nodes', async () => {
    const nodes = [
      makeNode('button', 'Hidden', 1, true), // ignored = true
      makeNode('button', 'Visible', 2, false),
    ];
    const cdp = makeMockCDP(nodes, [makeBoxModel(), makeBoxModel()]);
    const page = makeMockPage();

    const parser = new StateParser(page as any, cdp as any);
    const state = await parser.parse();

    expect(state.elements).toHaveLength(1);
    expect(state.elements[0]!.name).toBe('Visible');
  });

  it('filters out nameless non-textbox elements', async () => {
    const nodes = [
      makeNode('button', '', 1),   // no name → filtered
      makeNode('textbox', '', 2),  // textbox without name → kept
    ];
    const cdp = makeMockCDP(nodes, [makeBoxModel(), makeBoxModel()]);
    const page = makeMockPage();

    const parser = new StateParser(page as any, cdp as any);
    const state = await parser.parse();

    expect(state.elements).toHaveLength(1);
    expect(state.elements[0]!.role).toBe('textbox');
  });

  it('uses description as fallback name', async () => {
    const node = {
      role: { value: 'button' },
      name: { value: '' },
      description: { value: 'Close dialog' },
      backendDOMNodeId: 1,
      ignored: false,
      properties: [],
    };
    const cdp = makeMockCDP([node], [makeBoxModel()]);
    const page = makeMockPage();

    const parser = new StateParser(page as any, cdp as any);
    const state = await parser.parse();

    expect(state.elements[0]!.name).toBe('Close dialog');
  });

  it('caches state within TTL', async () => {
    const nodes = [makeNode('button', 'OK', 1)];
    const cdp = makeMockCDP(nodes, [makeBoxModel()]);
    const page = makeMockPage();

    const parser = new StateParser(page as any, cdp as any);
    await parser.parse();
    await parser.parse(); // second call – should use cache

    // CDP.send for getFullAXTree should only be called once
    const axCalls = (cdp.send as jest.Mock).mock.calls.filter(
      (c: any[]) => c[0] === 'Accessibility.getFullAXTree'
    );
    expect(axCalls).toHaveLength(1);
  });

  it('invalidateCache forces fresh parse', async () => {
    const nodes = [makeNode('button', 'OK', 1)];
    const cdp = makeMockCDP(nodes, [makeBoxModel()]);
    const page = makeMockPage();

    const parser = new StateParser(page as any, cdp as any);
    await parser.parse();
    parser.invalidateCache();
    await parser.parse();

    const axCalls = (cdp.send as jest.Mock).mock.calls.filter(
      (c: any[]) => c[0] === 'Accessibility.getFullAXTree'
    );
    expect(axCalls).toHaveLength(2);
  });

  it('assigns incrementing ids to elements', async () => {
    const nodes = [
      makeNode('button', 'A', 1),
      makeNode('link', 'B', 2),
      makeNode('textbox', 'C', 3),
    ];
    const cdp = makeMockCDP(nodes, [makeBoxModel(), makeBoxModel(), makeBoxModel()]);
    const page = makeMockPage();

    const parser = new StateParser(page as any, cdp as any);
    const state = await parser.parse();

    expect(state.elements.map((e) => e.id)).toEqual([0, 1, 2]);
  });

  it('skips elements where box model is rejected', async () => {
    const nodes = [makeNode('button', 'Broken', 1), makeNode('link', 'Good', 2)];
    const cdp = {
      send: jest.fn(async (method: string, params?: any) => {
        if (method === 'Accessibility.getFullAXTree') return { nodes };
        if (method === 'DOM.getBoxModel') {
          if (params?.backendNodeId === 1) throw new Error('not found');
          return makeBoxModel();
        }
        return {};
      }),
    };
    const page = makeMockPage();

    const parser = new StateParser(page as any, cdp as any);
    const state = await parser.parse();

    expect(state.elements).toHaveLength(1);
    expect(state.elements[0]!.name).toBe('Good');
  });
});
