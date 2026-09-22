import { test as setup, expect } from '@playwright/test';
import { LoginPage } from '../../pages/LoginPage';
import users from '../../test-data/users.json';
import { ADMIN_STORAGE_STATE } from '../../utils/constants';

/**
 * Signs in once and saves the session so the authenticated projects can
 * reuse it instead of logging in per test.
 */
setup('authenticate as admin', async ({ page, context }) => {
  const loginPage = new LoginPage(page);

  await loginPage.goto();
  await loginPage.login(users.admin.username, users.admin.password);
  await loginPage.expectLoggedIn();

  const cookies = await context.cookies();
  expect(cookies.map((c) => c.name)).toContain('.AspNetCore.Identity.Application');

  await context.storageState({ path: ADMIN_STORAGE_STATE });
});
