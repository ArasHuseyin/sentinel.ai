/**
 * Example: Google Search with Record & Replay
 * Demonstrates: sentinel.act(), sentinel.extract(), startRecording(), stopRecording(), exportWorkflowAsCode()
 */
import * as dotenv from 'dotenv';
import * as fs from 'fs';
dotenv.config();

import { Sentinel, z } from '../src/index.js';

const searchResultSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      snippet: z.string(),
    })
  ),
});

async function run() {
  const sentinel = new Sentinel({
    apiKey: process.env.GEMINI_API_KEY!,
    headless: false,
    verbose: 1,
  });

  await sentinel.init();

  // Start recording
  sentinel.startRecording('google-typescript-search');

  await sentinel.goto('https://www.google.com');

  // Search for TypeScript
  await sentinel.act('Fill "TypeScript tutorial" into the search input field');
  await sentinel.act('Press Enter to submit the search');

  // Extract top 3 results
  const data = await sentinel.extract(
    'Extract the top 3 search results with title, URL and snippet',
    searchResultSchema
  );

  console.log('\n🔍 Top 3 Google Results for "TypeScript tutorial":');
  data.results.forEach((r, i) => {
    console.log(`\n  ${i + 1}. ${r.title}`);
    console.log(`     ${r.url}`);
    console.log(`     ${r.snippet}`);
  });

  // Stop recording and export
  const workflow = sentinel.stopRecording();
  const code = sentinel.exportWorkflowAsCode(workflow);
  const json = sentinel.exportWorkflowAsJSON(workflow);

  fs.writeFileSync('examples/google-search-workflow.ts', code, 'utf-8');
  fs.writeFileSync('examples/google-search-workflow.json', json, 'utf-8');
  console.log('\n💾 Workflow exported as TypeScript and JSON');

  // Show token usage
  const usage = sentinel.getTokenUsage();
  console.log(`\n💰 Token usage: ${usage.totalTokens} tokens (~$${usage.estimatedCostUsd.toFixed(5)})`);

  await sentinel.close();
}

run().catch(console.error);
