/**
 * Example: Autonomous Shopping Agent on Amazon
 * Demonstrates: sentinel.run() – the autonomous multi-step agent loop
 * This is the "AutoGPT Killer" feature of Sentinel.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { Sentinel } from '../src/index.js';

async function run() {
  const sentinel = new Sentinel({
    apiKey: process.env.GEMINI_API_KEY!,
    headless: false,
    verbose: 1,
    humanLike: true, // random delays for more natural behavior
  });

  // Listen to each agent step
  sentinel.on('action', e => {
    console.log(`[Event] 🤖 Action: ${e.instruction}`);
  });

  await sentinel.init();
  await sentinel.goto('https://www.amazon.de');

  // Let the autonomous agent handle everything
  const result = await sentinel.run(
    'Search for "mechanical keyboard" and extract the names and prices of the top 3 results',
    {
      maxSteps: 10,
      onStep: step => {
        console.log(`\n[Step ${step.stepNumber}] ${step.success ? '✅' : '❌'} ${step.instruction}`);
        console.log(`  → ${step.reasoning}`);
      },
    }
  );

  console.log('\n─────────────────────────────────────────');
  console.log(`🎯 Goal achieved: ${result.goalAchieved}`);
  console.log(`📊 Total steps: ${result.totalSteps}`);
  console.log(`💬 ${result.message}`);

  // Token usage summary
  const usage = sentinel.getTokenUsage();
  console.log(`\n💰 Token usage: ${usage.totalTokens} tokens (~$${usage.estimatedCostUsd.toFixed(5)})`);

  await sentinel.close();
}

run().catch(console.error);
