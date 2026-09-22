import { Locator, Page, expect } from '@playwright/test';

/**
 * Login page for the HIS ERP app (Blazor Server).
 *
 * Hitting "/" while signed out redirects to
 * /Account/Login?returnUrl=... , which is where the form lives.
 */
export class LoginPage {
  readonly page: Page;
  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly rememberMeCheckbox: Locator;
  readonly loginButton: Locator;
  readonly errorMessage: Locator;
  readonly userMenuButton: Locator;
  readonly signOutItem: Locator;

  constructor(page: Page) {
    this.page = page;
    this.usernameInput = page.locator('input[name="Input.Email"]');
    this.passwordInput = page.locator('input[name="Input.Password"]');
    this.rememberMeCheckbox = page.locator('.omrs-remember input[type="checkbox"]');
    this.loginButton = page.locator('button.omrs-submit[type="submit"]');
    this.errorMessage = page.getByText(/invalid login attempt/i);

    // Signing out is behind the avatar menu in the header, alongside
    // "Change Password".
    this.userMenuButton = page.getByRole('button', { name: /open user menu/i });
    this.signOutItem = page.getByText(/^\s*sign\s*out\s*$/i);
  }

  async goto() {
    await this.page.goto('/');
    await expect(this.page).toHaveURL(/\/Account\/Login/);
    await expect(this.usernameInput).toBeVisible();
  }

  async login(username: string, password: string, rememberMe = false) {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    if (rememberMe) {
      await this.rememberMeCheckbox.check();
    }
    await this.loginButton.click();
  }

  /** Waits until the post-login module selector has rendered. */
  async expectLoggedIn() {
    await expect(this.page).not.toHaveURL(/\/Account\/Login/);
    await expect(this.page.getByText(/select a module to get started/i)).toBeVisible({
      timeout: 60_000,
    });
  }

  async expectLoginFailed() {
    await expect(this.errorMessage).toBeVisible();
    await expect(this.page).toHaveURL(/\/Account\/Login/);
  }

  /**
   * Whoever the header is showing — name and role, e.g.
   * "Dr. Sazia Afreen Pathologist".
   *
   * Useful after switching accounts: the app lets a stale session look signed
   * in, so reading the header back is what proves the switch actually took.
   */
  async currentUser(): Promise<string> {
    const header = this.page.locator('header, .mud-appbar').first();
    if (!(await header.count())) return '';
    return (await header.innerText()).replace(/\s+/g, ' ').trim();
  }

  /**
   * Signs the current user out, and does nothing if nobody is signed in.
   *
   * A session that has already lapsed lands on the login form by itself, and
   * there is no menu to open in that case — so this checks where it is before
   * reaching for one, which is what lets it run as the opening step of a
   * credentials switch without caring how the previous run left things.
   */
  async signOut() {
    await this.page.goto('/');
    await this.page.waitForTimeout(3_000);

    if (/\/Account\/Login/.test(this.page.url())) return;

    await this.userMenuButton.first().click();
    await expect(this.signOutItem.first()).toBeVisible({ timeout: 30_000 });
    await this.signOutItem.first().click();

    await this.expectSignedOut();
  }

  async expectSignedOut() {
    await expect(this.page).toHaveURL(/\/Account\/Login/, { timeout: 60_000 });
    await expect(this.usernameInput).toBeVisible({ timeout: 30_000 });
  }

  /**
   * Hands the browser from one account to another, and reports both.
   *
   * The switch a person makes at the machine: open the app, sign out through
   * the header menu, sign the next account in. Signing in over the top without
   * signing out would leave the first session alive on the server, so the two
   * halves belong together.
   *
   * The app is opened first so the header can be read — a context that has only
   * been handed a cookie is still on a blank page, with no header on it.
   */
  async switchTo(username: string, password: string): Promise<{ from: string; to: string }> {
    await this.page.goto('/');
    await this.page.waitForTimeout(5_000);
    const from = await this.currentUser();

    await this.signOut();
    await this.login(username, password);
    await this.expectLoggedIn();

    return { from, to: await this.currentUser() };
  }
}
