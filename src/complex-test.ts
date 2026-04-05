import { Sentinel } from './index.js';
import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.GEMINI_API_KEY || "YOUR_API_KEY";

async function complexTest() {
  const sentinel = new Sentinel({ apiKey: API_KEY, headless: false });
  
  try {
    await sentinel.init();
    
    console.log("1. Navigating to Hacker News...");
    await sentinel.goto("https://news.ycombinator.com");
    
    console.log("2. Extracting top headlines...");
    const headlines = await sentinel.extract<{ items: { title: string, rank: number }[] }>(
      "Extract the titles and ranks of the first 10 news items on the front page",
      {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                rank: { type: "number" }
              },
              required: ["title", "rank"]
            }
          }
        },
        required: ["items"]
      }
    );
    
    console.log("Top Headlines:", headlines.items.map(h => `${h.rank}. ${h.title}`));

    // Find the first headline that contains 'AI' or 'model' or 'LLM'
    const aiHeadline = headlines.items.find(h => 
      /AI|model|LLM|GPT|intelligence/i.test(h.title)
    ) || headlines.items[0];

    if (aiHeadline) {
      console.log(`3. Navigating to article: "${aiHeadline.title}"`);
      await sentinel.act(`Click on the link with the text "${aiHeadline.title}"`);
      
      console.log("4. Observing current page...");
      const observation = await sentinel.observe();
      console.log("Observation:", observation);
      
      console.log("5. Extracting first paragraph from the article...");
      const summary = await sentinel.extract<{ paragraph: string }>(
        "Extract the first meaningful paragraph or summary of this article",
        {
          type: "object",
          properties: {
            paragraph: { type: "string" }
          },
          required: ["paragraph"]
        }
      );
      
      console.log("Article Summary:", summary.paragraph);
    }
    
  } catch (error) {
    console.error("Complex Test Error:", error);
  } finally {
    console.log("Test finished. Closing browser...");
    await sentinel.close();
  }
}

complexTest();
