import { test as setup, expect } from '@playwright/test';
import { LoginPage } from '../../pages/LoginPage';
import users from '../../test-data/users.json';
import { ADMIN_STORAGE_STATE } from '../../utils/constants';

/**
 * Hands the browser back from the pathologist to the administrator.
 *
 * The counterpart of `pathologist.setup.ts`, and the last thing a full run
 * does: once the pathologist has finalized the report there is nothing further
 * for that account to do, and leaving the machine signed in as a clinician is
 * not how a shift ends.
 *
 * It also repairs something the switch out broke. Signing the administrator out
 * ended that session on the server, so `playwright/.auth/admin.json` was left
 * holding a cookie that no longer worked; signing back in here rewrites it, and
 * a `--no-deps` run of any chain stage works again without a separate
 * `--project=setup` first.
 */
setup('switch from the pathologist back to the administrator', async ({ page, context }) => {
  setup.setTimeout(180_000);

  const login = new LoginPage(page);
  const { from, to } = await login.switchTo(users.admin.username, users.admin.password);

  console.log(`signed out: ${from || '(nobody — the session had already lapsed)'}`);
  console.log(`now signed in as: ${to}`);
  expect(to, `the header should name the ${users.admin.role}`).toMatch(
    new RegExp(users.admin.role, 'i'),
  );

  const cookies = await context.cookies();
  expect(cookies.map((c) => c.name)).toContain('.AspNetCore.Identity.Application');

  await context.storageState({ path: ADMIN_STORAGE_STATE });
  console.log(`saved the administrator session back to ${ADMIN_STORAGE_STATE}`);
});
