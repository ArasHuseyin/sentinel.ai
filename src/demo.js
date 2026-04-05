import { Sentinel } from './index.js';
import dotenv from 'dotenv';
dotenv.config();
const API_KEY = process.env.GEMINI_API_KEY || "YOUR_API_KEY";
async function main() {
    const sentinel = new Sentinel(API_KEY, { headless: false });
    try {
        await sentinel.init();
        console.log("Navigating to google.com...");
        await sentinel.goto("https://www.google.com");
        // Accept cookies if present
        await sentinel.act("Click 'Alle akzeptieren' or 'I agree' to cookies if necessary");
        console.log("Searching for 'Stagehand AI'...");
        await sentinel.act("Type 'Stagehand AI' into the search bar and press enter");
        console.log("Extracting search results...");
        const results = await sentinel.extract("Extract the first 5 search results titles", {
            type: "object",
            properties: {
                titles: { type: "array", items: { type: "string" } }
            },
            required: ["titles"]
        });
        console.log("Results:", results);
    }
    catch (error) {
        console.error("Sentinel Error:", error);
    }
    finally {
        await sentinel.close();
    }
}
main();
//# sourceMappingURL=demo.js.map