import { Sentinel, z } from './index.js';
import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.GEMINI_API_KEY || "YOUR_API_KEY";

async function whatsappTest() {
  const sentinel = new Sentinel({ apiKey: API_KEY, headless: false });

  try {
    await sentinel.init();
    const page = sentinel.page;

    console.log("1. Navigating to WhatsApp Web...");
    await sentinel.goto("https://web.whatsapp.com");

    console.log("PLEASE SCAN THE QR CODE MANUALLY.");
    console.log("Waiting for WhatsApp to fully load...");

    await page.waitForSelector('#pane-side', { timeout: 180000 });
    await page.waitForFunction(
      () => ((document.querySelector('#pane-side') as HTMLElement | null)?.innerText?.trim().length ?? 0) > 50,
      { timeout: 30000 }
    );

    console.log("2. Logged in. Extracting top 2 chats...");

    // Define schema once – z.infer<> gives full TypeScript type inference
    const chatListSchema = z.object({
      chats: z.array(z.object({ name: z.string() })).min(1).max(2)
    });
    type ChatList = z.infer<typeof chatListSchema>;

    const { chats } = await sentinel.extract<ChatList>(
      `Look at the LEFT SIDEBAR. List the names of the first 2 conversations.
       Only contact/group names. Skip labels like "Archiviert", dates, message previews.`,
      chatListSchema
    );

    console.log(`Found chats: ${chats.map((c: { name: string }) => `"${c.name}"`).join(', ')}`);

    for (const chat of chats) {
      console.log(`\n--- Opening chat: "${chat.name}" ---`);

      // act() handles it – listitem role is now in StateParser
      const opened = await sentinel.act(
        `Click the chat entry in the left sidebar with the name "${chat.name}".`
      );

      if (!opened.success) {
        console.warn(`[Skip] ${opened.message}`);
        continue;
      }

      await page.waitForFunction(
        () => ((document.querySelector('#main') as HTMLElement | null)?.innerText?.trim().length ?? 0) > 20,
        { timeout: 8000 }
      ).catch(() => console.warn(`[Warn] Message area slow for "${chat.name}"`));

      // Define message schema
      const msgSchema = z.object({
        msgs: z.array(z.object({
          text: z.string(),
          sender: z.enum(["me", "other"])
        }))
      });
      type MsgResult = z.infer<typeof msgSchema>;

      const { msgs } = await sentinel.extract<MsgResult>(
        `Extract the last 5 messages from the RIGHT SIDE conversation panel.
         For each: text content and sender ('me' = outgoing right, 'other' = incoming left).
         Skip system messages like encryption notices or date separators.`,
        msgSchema
      );

      console.log(`Last ${msgs.length} messages:`);
      msgs.forEach(m => console.log(`  [${m.sender}] ${m.text}`));
    }

  } catch (error) {
    console.error("WhatsApp Test Error:", error);
  } finally {
    console.log("\nTest finished. Closing browser...");
    await sentinel.close();
  }
}

whatsappTest();
