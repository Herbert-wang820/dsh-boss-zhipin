import * as m from '../lib/cdp.js';
import { resolveConfig } from '../lib/config.js';

const { config } = resolveConfig({});
const ids = process.argv.slice(2);
const tab = await m.openTab(config.port, 'https://www.zhipin.com/');
const out = {};
for (const id of ids) {
  await tab.navigate(`https://www.zhipin.com/job_detail/${id}.html`);
  await new Promise((r) => setTimeout(r, 4000));
  const sid = await tab.evaluate(`(function(){
    const html = document.documentElement.innerHTML;
    const mm = html.match(/securityId[\\"':=\\s]{1,6}([A-Za-z0-9_~\\-]{25,})/);
    return mm ? mm[1] : null;
  })()`);
  out[id] = sid;
}
console.log(JSON.stringify(out, null, 1));
await tab.close();
process.exit(0);
