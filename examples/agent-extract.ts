/**
 * Example: Agent with structured data extraction
 *
 * Demonstrates:
 *  - sentinel.run() returning result.data populated by an extract step
 *  - Zod schema passed to the agent goal
 *  - Token cost summary via sentinel.getTokenUsage()
 *
 * Run:
 *   npx tsx examples/agent-extract.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { Sentinel, z } from '../src/index.js';

async function run() {
  const sentinel = new Sentinel({
    apiKey: process.env.GEMINI_API_KEY!,
    headless: false,
    verbose: 1,
  });

  await sentinel.init();
  await sentinel.goto('https://news.ycombinator.com');

  const result = await sentinel.run(
    'Extract the top 5 stories from the front page: title, score, and comment count',
    {
      maxSteps: 5,
      onStep: step => {
        const icon = step.type === 'extract' ? '🔍' : (step.success ? '✅' : '❌');
        console.log(`\n[Step ${step.stepNumber}] ${icon} ${step.instruction}`);
        if (step.reasoning) console.log(`  → ${step.reasoning}`);
        if (step.type === 'extract' && step.data) {
          console.log('  📦 Extracted:', JSON.stringify(step.data, null, 2));
        }
      },
    }
  );

  console.log('\n─────────────────────────────────────────');
  console.log(`🎯 Goal achieved: ${result.goalAchieved}`);
  console.log(`📊 Steps taken:   ${result.totalSteps}`);
  console.log(`💬 ${result.message}`);

  if (result.data) {
    console.log('\n📦 result.data:');
    console.log(JSON.stringify(result.data, null, 2));
  }

  // Direct extract() call to show standalone usage
  console.log('\n─── Direct extract() ─────────────────────');
  const stories = await sentinel.extract(
    'Get the top 5 Hacker News stories',
    z.object({
      stories: z.array(z.object({
        title: z.string(),
        score: z.number().optional(),
        comments: z.number().optional(),
      })),
    })
  );

  console.log('Stories:', JSON.stringify(stories, null, 2));

  // Token cost summary
  const usage = sentinel.getTokenUsage();
  console.log('\n─── Token Usage ──────────────────────────');
  console.log(`Input tokens:  ${usage.totalInputTokens}`);
  console.log(`Output tokens: ${usage.totalOutputTokens}`);
  console.log(`Total tokens:  ${usage.totalTokens}`);
  console.log(`Est. cost:     $${usage.estimatedCostUsd.toFixed(5)}`);

  await sentinel.close();
}

run().catch(console.error);
