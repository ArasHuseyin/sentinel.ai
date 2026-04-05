/**
 * Example: Extract top stories from Hacker News
 * Demonstrates: sentinel.extract(), sentinel.observe(), sentinel.act()
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { Sentinel, z } from '../src/index.js';

const storySchema = z.object({
  stories: z.array(
    z.object({
      rank: z.number(),
      title: z.string(),
      points: z.number(),
      commentCount: z.number(),
    })
  ),
});

async function run() {
  const sentinel = new Sentinel({
    apiKey: process.env.GEMINI_API_KEY!,
    headless: false,
    verbose: 1,
  });

  // Listen to events
  sentinel.on('action', e => console.log('[Event] action:', e.instruction));
  sentinel.on('navigate', e => console.log('[Event] navigate:', e.url));

  await sentinel.init();
  await sentinel.goto('https://news.ycombinator.com');

  // Extract top 5 stories with structured data
  const data = await sentinel.extract(
    'Extract the top 5 stories with their rank, title, points and comment count',
    storySchema
  );

  console.log('\n📰 Top 5 Hacker News Stories:');
  data.stories.forEach(s => {
    console.log(`  ${s.rank}. ${s.title} (${s.points} pts, ${s.commentCount} comments)`);
  });

  // Navigate to "new" section
  await sentinel.act('Click on the "new" link in the navigation');

  // Observe what's available
  const elements = await sentinel.observe('Find navigation links');
  console.log('\n🔍 Navigation elements found:', elements.length);

  await sentinel.close();
}

run().catch(console.error);
