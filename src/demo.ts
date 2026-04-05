import { Sentinel, z } from './index.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const sentinel = new Sentinel({
    apiKey: process.env.GEMINI_API_KEY || 'YOUR_API_KEY',
    headless: false,
    verbose: 1,
    enableCaching: true,
    domSettleTimeoutMs: 3000,
  });

  try {
    await sentinel.init();

    // Direct Playwright page access (like Stagehand)
    console.log('Current URL:', sentinel.page.url());

    await sentinel.goto('https://www.google.com');

    // act() with variables support
    await sentinel.act("Click 'Alle akzeptieren' or 'I agree' to cookies if present", { retries: 1 });

    // act() with %variable% interpolation
    const searchTerm = 'Stagehand AI';
    await sentinel.act('Type %term% into the search bar and press enter', {
      variables: { term: searchTerm },
    });

    // extract() with Zod schema
    const results = await sentinel.extract(
      'Extract the first 5 search result titles',
      z.object({
        titles: z.array(z.string()),
      })
    );
    console.log('Search results:', results);

    // observe() with optional instruction
    const actions = await sentinel.observe('Find navigation or search elements');
    console.log('Observable actions:', actions);

  } catch (error) {
    console.error('Sentinel Error:', error);
  } finally {
    await sentinel.close();
  }
}

main();
