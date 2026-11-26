import { resolveConfig } from '../lib/config.js';
import { Store } from '../lib/store.js';
import { buildTools } from '../lib/tools.js';

const { config } = resolveConfig({});
const store = new Store(config.dataDir);
const tools = buildTools(config, store);
const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

const mode = process.argv[2] || 'scan';

if (mode === 'scan') {
  const out = await byName.boss_rescue_scan.execute({ limit: 3 });
  console.log(JSON.stringify(out, null, 1).slice(0, 2500));
}

if (mode === 'send') {
  const jobId = process.argv[3];
  const bossId = process.argv[4];
  const securityId = process.argv[5];
  const out = await byName.boss_rescue_send.execute({
    items: [{ job_id: jobId, boss_id: bossId, security_id: securityId }],
    dry_run: true,
  });
  console.log(JSON.stringify(out, null, 1).slice(0, 2500));
}

process.exit(0);
