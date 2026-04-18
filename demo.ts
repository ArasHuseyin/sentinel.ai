import 'dotenv/config';
import { Sentinel } from './dist/index.js';
// @ts-ignore
import process from "process";

async function main() {
    const sentinel = new Sentinel({
        apiKey: process.env.GEMINI_API_KEY,
        headless: false,
        viewport: { width: 1280, height: 720 },
        verbose: 1,
    });

    await sentinel.init();
    await sentinel.goto('https://github.com/trending');

    const start = Date.now();
    const result = await sentinel.run(
        'Extract the top 5 trending repositories. ' +
        'For each: name (owner/repo), description, primary language, and total star count'
    );
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const usage = sentinel.getTokenUsage();

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`✓ Completed in ${result.totalSteps} steps`);
    console.log(`⏱  Time: ${elapsed}s`);
    console.log(`🔢 Tokens: ${usage.totalTokens}`);
    console.log(`💰 Cost: $${usage.estimatedCostUsd.toFixed(4)}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(JSON.stringify(result.data, null, 2));

    await sentinel.close();
}

main().catch(console.error);