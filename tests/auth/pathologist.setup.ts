import { test as setup, expect } from '@playwright/test';
import { LoginPage } from '../../pages/LoginPage';
import users from '../../test-data/users.json';
import { PATHOLOGIST_STORAGE_STATE } from '../../utils/constants';

/**
 * Hands the browser over from the administrator to the pathologist.
 *
 * This project starts from the administrator's saved session, signs it out
 * through the header menu, and signs Dr. Sazia Afreen in — the switch a person
 * makes at the machine, rather than a second login in a fresh window. Doing it
 * that way also keeps the sign-out path covered, which nothing else exercises.
 *
 * The new session is saved to its own file, so the administrator's is left
 * intact and specs can ask for whichever account they need. Note that the
 * sign-out ends the administrator's session on the *server*, which leaves that
 * file holding a dead cookie — `administrator.setup.ts` is what signs it back
 * in afterwards.
 */
setup('switch from the administrator to the pathologist', async ({ page, context }) => {
  setup.setTimeout(180_000);

  const login = new LoginPage(page);
  const { from, to } = await login.switchTo(users.pathologist.username, users.pathologist.password);

  console.log(`signed out: ${from || '(nobody — the session had already lapsed)'}`);
  console.log(`now signed in as: ${to}`);
  expect(to, `the header should name the ${users.pathologist.role}`).toMatch(
    new RegExp(users.pathologist.role, 'i'),
  );

  const cookies = await context.cookies();
  expect(cookies.map((c) => c.name)).toContain('.AspNetCore.Identity.Application');

  await context.storageState({ path: PATHOLOGIST_STORAGE_STATE });
  console.log(`saved the pathologist session to ${PATHOLOGIST_STORAGE_STATE}`);
});
