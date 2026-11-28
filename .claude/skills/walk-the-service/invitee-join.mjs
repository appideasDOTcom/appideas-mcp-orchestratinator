// the invitee: a fresh app, the code pasted as a person copies it from an email (with spaces around), Join.
import { pane, shot, tab } from './lib.mjs';
const [port, code] = process.argv.slice(2);
const p = await pane(Number(port));
await tab(p, 'sharing');
await p.getByTestId('settings-service-code').waitFor({ timeout: 60000 });
await shot(p, 'c12-invitee-fresh');
await p.getByTestId('settings-service-code').fill(`   ${code}\n`);
await shot(p, 'c13-invitee-code-pasted');
await p.getByTestId('settings-service-code-use').click();
for (let i = 0; i < 30 && !/You.re in/.test(await p.locator('body').innerText()); i++) await p.waitForTimeout(1000);
await shot(p, 'c14-invitee-joined');
process.exit(0);
