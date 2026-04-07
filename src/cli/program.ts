import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { Sentinel } from '../index.js';
import type { SentinelOptions } from '../index.js';

// ─── Injected factory type ────────────────────────────────────────────────────
//
// Tests pass a mock factory; the default creates a real Sentinel.

export type SentinelFactory = (opts: { apiKey: string; headless: boolean }) => Promise<Sentinel>;

const defaultFactory: SentinelFactory = async ({ apiKey, headless }) => {
  const sentinel = new Sentinel({ apiKey, headless, verbose: 0 } as SentinelOptions);
  await sentinel.init();
  return sentinel;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function addSharedOptions(cmd: Command) {
  return cmd
    .requiredOption('--url <url>', 'Page URL to navigate to')
    .option('--api-key <key>', 'Gemini API key (default: GEMINI_API_KEY env var)')
    .option('--headless', 'Run browser in headless mode', false)
    .option('--model <model>', 'Gemini model name (default: GEMINI_VERSION env var)');
}

async function resolveSentinel(
  opts: { apiKey?: string; headless?: boolean; model?: string },
  factory: SentinelFactory
): Promise<Sentinel> {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) {
    console.error('Error: Gemini API key required. Set GEMINI_API_KEY or pass --api-key');
    process.exitCode = 1;
    throw new Error('Missing API key');
  }
  if (opts.model) process.env.GEMINI_VERSION = opts.model;
  return factory({ apiKey, headless: opts.headless ?? false });
}

export function writeOutput(data: unknown, outputPath?: string) {
  const json = JSON.stringify(data, null, 2);
  if (outputPath) {
    fs.writeFileSync(path.resolve(outputPath), json, 'utf-8');
    console.log(`Output written to ${outputPath}`);
  } else {
    console.log(json);
  }
}

// ─── Program factory ──────────────────────────────────────────────────────────

export function buildProgram(factory: SentinelFactory = defaultFactory): Command {
  const program = new Command();

  program
    .name('sentinel')
    .description('AI-powered browser automation — Sentinel CLI')
    .version('3.1.1')
    .exitOverride(); // throw instead of process.exit so tests can catch errors

  // ── run ────────────────────────────────────────────────────────────────────

  addSharedOptions(
    program
      .command('run <goal>')
      .description('Run an autonomous agent to achieve a goal')
      .option('--max-steps <n>', 'Maximum number of steps', '15')
      .option('--output <file>', 'Write result JSON to file')
  ).action(async (goal: string, opts: any) => {
    const sentinel = await resolveSentinel(opts, factory);
    try {
      await sentinel.goto(opts.url);
      const result = await sentinel.run(goal, { maxSteps: parseInt(opts.maxSteps, 10) });
      writeOutput({
        goalAchieved: result.goalAchieved,
        success: result.success,
        totalSteps: result.totalSteps,
        message: result.message,
        data: result.data ?? null,
        tokens: sentinel.getTokenUsage(),
      }, opts.output);
      process.exitCode = result.goalAchieved ? 0 : 1;
    } finally {
      await sentinel.close();
    }
  });

  // ── act ────────────────────────────────────────────────────────────────────

  addSharedOptions(
    program
      .command('act <instruction>')
      .description('Perform a natural language action on a page')
  ).action(async (instruction: string, opts: any) => {
    const sentinel = await resolveSentinel(opts, factory);
    try {
      await sentinel.goto(opts.url);
      const result = await sentinel.act(instruction);
      writeOutput({ success: result.success, message: result.message, action: result.action });
      process.exitCode = result.success ? 0 : 1;
    } finally {
      await sentinel.close();
    }
  });

  // ── extract ────────────────────────────────────────────────────────────────

  addSharedOptions(
    program
      .command('extract <instruction>')
      .description('Extract structured data from a page')
      .option('--schema <json>', 'JSON Schema for the expected output')
      .option('--output <file>', 'Write result JSON to file')
  ).action(async (instruction: string, opts: any) => {
    const sentinel = await resolveSentinel(opts, factory);
    try {
      await sentinel.goto(opts.url);
      const schema = opts.schema ? JSON.parse(opts.schema) : { type: 'object' };
      const result = await sentinel.extract(instruction, schema);
      writeOutput(result, opts.output);
    } finally {
      await sentinel.close();
    }
  });

  // ── screenshot ─────────────────────────────────────────────────────────────

  addSharedOptions(
    program
      .command('screenshot')
      .description('Take a screenshot of a page')
      .option('--output <file>', 'Write PNG to file (default: screenshot.png)')
  ).action(async (opts: any) => {
    const sentinel = await resolveSentinel(opts, factory);
    try {
      await sentinel.goto(opts.url);
      const buf = await sentinel.screenshot();
      const outFile = opts.output ?? 'screenshot.png';
      fs.writeFileSync(path.resolve(outFile), buf);
      console.log(`Screenshot saved to ${outFile}`);
    } finally {
      await sentinel.close();
    }
  });

  return program;
}
