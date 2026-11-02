import { expect, test } from "@playwright/test";
import { createTestUser, deleteTestUser, signInLink } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";

const admin = localSupabaseAdmin();
const PORT = process.env.PORT ?? "3000";
const created: string[] = [];

test.afterAll(async () => {
  for (const id of created) await deleteTestUser(admin, id);
});

async function userExists(email: string): Promise<boolean> {
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    if (data.users.some((user) => user.email === email)) return true;
    if (data.users.length < 1000) return false;
  }
}

test("an unknown address gets the neutral answer and no account", async ({ page }) => {
  const email = `unknown-${crypto.randomUUID()}@example.test`;
  await page.goto("/studio");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(
    page.getByText("If this address has an account, a sign-in link is on its way."),
  ).toBeVisible();
  expect(await userExists(email)).toBe(false);
});

test("a malformed address gets a field error", async ({ page }) => {
  await page.goto("/studio");
  await page.getByLabel("Email").fill("not-an-address");
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByText("Enter a valid email address.")).toBeVisible();
});

test("a sign-in link signs in on the landing address, and logout signs out", async ({
  page,
  baseURL,
}) => {
  const user = await createTestUser(admin, "login");
  created.push(user.id);
  const link = await signInLink(admin, user.email, baseURL!);

  await page.goto(link);
  const landed = new URL(page.url());
  expect(landed.port).toBe(PORT);
  expect(landed.pathname).toBe("/studio");
  await expect(page.getByRole("heading", { name: "Your reels" })).toBeVisible();
  await expect(page.getByLabel("Reels")).toBeVisible();
  await expect(page.getByText(user.email)).toBeVisible();

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByLabel("Email")).toBeVisible();
  expect(new URL(page.url()).port).toBe(PORT);

  // The same link a second time: already used.
  await page.goto(link);
  await expect(page.getByText("That sign-in link has expired or was already used.")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
});

test("a link without a token shows the expired-link message", async ({ page }) => {
  await page.goto("/studio/auth/confirm?type=email");
  await expect(page.getByText("That sign-in link has expired or was already used.")).toBeVisible();
});
