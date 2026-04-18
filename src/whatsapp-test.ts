import { Sentinel, z } from './index.js';
import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.GEMINI_API_KEY || 'YOUR_API_KEY';
const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH || './whatsapp-session.json';

async function whatsappTest() {
  const sentinel = new Sentinel({
    apiKey: API_KEY,
    headless: false,
    humanLike: true,           // v2: human-like delays between actions
    sessionPath: SESSION_PATH, // v2: persist session – scan QR code only once
    verbose: 1,
    visionFallback: true,      // WhatsApp Web has no clean AOM – vision as fallback
  });

  // v2: events for observability
  sentinel.on('action', (event) => {
    console.log(`[Event] action: "${event.instruction}" → ${event.result.success ? '✅' : '❌'} ${event.result.message}`);
  });

  sentinel.on('navigate', (event) => {
    console.log(`[Event] navigate: ${event.url}`);
  });

  try {
    await sentinel.init();
    const page = sentinel.page;

    console.log('1. Navigating to WhatsApp Web...');
    await sentinel.goto('https://web.whatsapp.com');

    console.log('PLEASE SCAN THE QR CODE MANUALLY (only needed on first run – session will be saved).');
    console.log('Waiting for WhatsApp to fully load...');

    // Wait until Sentinel detects chat entries in the sidebar (no selector needed).
    // Require at least 3 chat entries to prevent false-positives when only
    // QR-code elements are visible.
    let sidebarReady = false;
    const deadline = Date.now() + 180000;
    while (!sidebarReady && Date.now() < deadline) {
      const elements = await sentinel.observe('Find actual chat conversation entries (contact names, group names) in the left sidebar – NOT the QR code, NOT login buttons');
      if (elements.length >= 3) {
        sidebarReady = true;
        // Short pause so WhatsApp fully renders the chat list
        await new Promise(r => setTimeout(r, 2000));
      } else {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    if (!sidebarReady) throw new Error('WhatsApp sidebar did not load in time');

    // v2: persist session after successful login
    await sentinel.saveSession(SESSION_PATH);
    console.log(`✅ Session saved to ${SESSION_PATH}`);

    console.log('2. Logged in. Extracting top 2 chats...');

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

    // v2: use observe() to probe available actions
    const observedElements = await sentinel.observe('Find chat entries in the left sidebar');
    console.log(`\n[v2 observe] Found ${observedElements.length} interactive elements in sidebar`);

    for (const chat of chats) {
      console.log(`\n--- Opening chat: "${chat.name}" ---`);

      const opened = await sentinel.act(
        `Click the chat entry in the left sidebar with the name "${chat.name}". ` +
        `Do NOT click any "Archiviert" (archived) button or label. ` +
        `Click only the actual conversation row.`
      );

      if (!opened.success) {
        console.warn(`[Skip] ${opened.message}`);
        continue;
      }

      // Sentinel detects on its own whether the chat loaded – no selector needed
      const chatElements = await sentinel.observe(`Find messages and conversation content in the currently open chat "${chat.name}" on the right side`);
      console.log(`[Observe] ${chatElements.length} elements found in chat area`);

      const msgSchema = z.object({
        msgs: z.array(z.object({
          text: z.string(),
          sender: z.enum(['me', 'other'])
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

    // v2: report token usage
    const usage = sentinel.getTokenUsage();
    console.log(`\n📊 Token usage: ${usage.totalTokens} tokens (~$${usage.estimatedCostUsd.toFixed(4)})`);

  } catch (error) {
    console.error('WhatsApp Test Error:', error);
  } finally {
    console.log('\nTest finished. Closing browser...');
    await sentinel.close();
  }
}

whatsappTest();