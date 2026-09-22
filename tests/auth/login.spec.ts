import { test, expect } from '@playwright/test';
import { LoginPage } from '../../pages/LoginPage';
import users from '../../test-data/users.json';

/**
 * These are the one set of tests that must not share a session: the second
 * starts from signed out, which the first has just stopped being. So they use
 * Playwright's own per-test context rather than the shared tab the other specs
 * run in (see fixtures/test.ts).
 */
test.describe('Login', () => {
  test('logs in with valid credentials', async ({ page, context }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(users.admin.username, users.admin.password);

    await loginPage.expectLoggedIn();

    const cookies = await context.cookies();
    expect(cookies.map((c) => c.name)).toContain('.AspNetCore.Identity.Application');
  });

  test('shows an error for an invalid password', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(users.invalid.username, users.invalid.password);

    await loginPage.expectLoginFailed();
  });
});
