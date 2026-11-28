// The owner's slot is held by a board from an earlier walk: the pane's own "Stop sharing …" frees it,
// then Invite user again. Real clicks.   node owner-free-invite.mjs <port> <invitee>
import { pane, shot, tab } from './lib.mjs';
const [port, invitee] = process.argv.slice(2);
const o = await pane(Number(port));
await tab(o, 'sharing');
if (await o.getByTestId('settings-sharing-limit-free').isVisible()) {
  console.log('limit button:', await o.getByTestId('settings-sharing-limit-free').innerText());
  await o.getByTestId('settings-sharing-limit-free').click();
  for (let i = 0; i < 40 && await o.getByTestId('settings-sharing-limit').isVisible(); i++) await o.waitForTimeout(500);
  await o.waitForTimeout(3000);
  await shot(o, 'c06b-owner-slot-freed');
}
await o.getByTestId('settings-sharing-invite-open').click();
await o.getByTestId('settings-sharing-email').fill(invitee);
await o.getByTestId('settings-sharing-send').click();
await o.waitForTimeout(6000);
await shot(o, 'c06c-owner-invited');
process.exit(0);
