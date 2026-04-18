import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ConsoleLogger,
  JsonLogger,
  createLogger,
  createFileSink,
  type Logger,
  type LogEvent,
} from '../../utils/logger.js';

describe('ConsoleLogger', () => {
  let logSpy: jest.SpiedFunction<typeof console.log>;
  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it('respects verbose gating for info/notice/debug', () => {
    const l = new ConsoleLogger(1);
    l.info('a');
    l.notice('b');
    l.debug('c');
    expect(logSpy).toHaveBeenCalledTimes(1); // only info passes at verbose=1
    expect(logSpy).toHaveBeenCalledWith('a');
  });

  it('emits all levels at verbose=3', () => {
    const l = new ConsoleLogger(3);
    l.info('i');
    l.notice('n');
    l.debug('d');
    expect(logSpy).toHaveBeenCalledTimes(3);
  });

  it('warn bypasses verbose filter', () => {
    const l = new ConsoleLogger(0);
    l.warn('problem');
    expect(warnSpy).toHaveBeenCalledWith('problem');
  });

  it('child() prefixes scope in output', () => {
    const l = new ConsoleLogger(1).child('Agent');
    l.info('step 1');
    expect(logSpy).toHaveBeenCalledWith('[Agent] step 1');
  });

  it('child().child() chains scopes', () => {
    const l = new ConsoleLogger(1).child('Agent').child('Planner');
    l.info('deciding');
    expect(logSpy).toHaveBeenCalledWith('[Agent/Planner] deciding');
  });
});

describe('JsonLogger', () => {
  it('emits one JSON object per event', () => {
    const lines: string[] = [];
    const l = new JsonLogger(1, line => lines.push(line));
    l.info('hello', { k: 1 });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as LogEvent;
    expect(parsed.levelName).toBe('info');
    expect(parsed.message).toBe('hello');
    expect(parsed.fields).toEqual({ k: 1 });
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('respects verbose gating', () => {
    const lines: string[] = [];
    const l = new JsonLogger(1, line => lines.push(line));
    l.info('a');
    l.debug('b');
    expect(lines).toHaveLength(1); // debug filtered
  });

  it('warn bypasses the verbose filter', () => {
    const lines: string[] = [];
    const l = new JsonLogger(0, line => lines.push(line));
    l.warn('bad');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as LogEvent;
    expect(parsed.message).toMatch(/\[WARN\] bad/);
  });

  it('child() attaches scope to structured output', () => {
    const lines: string[] = [];
    const l = new JsonLogger(1, line => lines.push(line)).child('Act');
    l.info('clicked');
    const parsed = JSON.parse(lines[0]!) as LogEvent;
    expect(parsed.scope).toBe('Act');
  });

  it('broken sink never throws to the caller', () => {
    const broken: Logger = new JsonLogger(1, () => { throw new Error('sink dead'); });
    expect(() => broken.info('x')).not.toThrow();
    expect(() => broken.warn('y')).not.toThrow();
  });
});

describe('createLogger factory', () => {
  let logSpy: jest.SpiedFunction<typeof console.log>;
  beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { jest.restoreAllMocks(); });

  it('defaults to ConsoleLogger when logFormat is false/undefined', () => {
    const l = createLogger(false, 1);
    expect(l).toBeInstanceOf(ConsoleLogger);
  });

  it('returns JsonLogger for logFormat=true', () => {
    const l = createLogger(true, 1);
    expect(l).toBeInstanceOf(JsonLogger);
  });

  it('returns JsonLogger with file sink for string logFormat', () => {
    const tmp = path.join(os.tmpdir(), `sentinel-log-${Date.now()}.jsonl`);
    try {
      const l = createLogger(tmp, 1);
      l.info('persisted');
      const content = fs.readFileSync(tmp, 'utf-8');
      const parsed = JSON.parse(content.trim()) as LogEvent;
      expect(parsed.message).toBe('persisted');
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ok */ }
    }
  });

  it('injected logger short-circuits the factory', () => {
    const custom: Logger = {
      info: jest.fn(), notice: jest.fn(), debug: jest.fn(), warn: jest.fn(),
      child: jest.fn(() => custom),
    };
    const l = createLogger(true, 1, custom);
    expect(l).toBe(custom);
  });
});

describe('createFileSink', () => {
  it('appends one line per call and creates parent dirs', () => {
    const dir = path.join(os.tmpdir(), `sentinel-sink-${Date.now()}`, 'nested');
    const file = path.join(dir, 'log.jsonl');
    try {
      const sink = createFileSink(file);
      sink('{"a":1}');
      sink('{"b":2}');
      const content = fs.readFileSync(file, 'utf-8');
      expect(content.trim().split('\n')).toEqual(['{"a":1}', '{"b":2}']);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });
});
