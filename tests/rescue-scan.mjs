import * as m from '../lib/cdp.js';
import { resolveConfig } from '../lib/config.js';
import { findAutoGreetOnly } from '../lib/rescue.js';

const { config } = resolveConfig({});
const limit = Number(process.argv[2] || 8);

const tab = await m.openTab(config.port, 'https://www.zhipin.com/web/geek/chat');
await new Promise((r) => setTimeout(r, 8000));

const { conversations, candidates, skipped } = await findAutoGreetOnly(tab, {
  limit,
  onProgress: ({ index, total, conversation }) => {
    process.stderr.write(`[${index + 1}/${total}] ${conversation.company} · ${conversation.name}\n`);
  },
});

console.log(JSON.stringify({
  conversations: conversations.length,
  candidates: candidates.map((c) => ({ company: c.company, hr: c.name, jobId: c.jobId, auto: c.autoGreeting, hrSaid: c.friendTexts })),
  skipped: skipped.map((s) => ({ company: s.company, reason: s.reason, custom: s.customTexts })),
}, null, 1).slice(0, 5000));

await tab.close();
process.exit(0);
