import { test, expect, type Page } from '@playwright/test'

const ADMIN = 'browser-test-admin-key'

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('管理密钥', { exact: true }).fill(ADMIN)
  await page.getByRole('button', { name: '进入控制台', exact: true }).click()
  await expect(page.locator('.app-shell')).toBeVisible()
}

test('key login opens the three separate overview cards', async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole('heading', { name: /运行概览/ })).toBeVisible()
  await expect(page.getByTestId('system-count')).toHaveText('2/3')
  for (const system of ['cnb', 'codebuddy', 'zcode']) {
    await expect(page.getByTestId(`overview-card-${system}`)).toBeVisible()
  }
})

test('each overview card keeps its own unit and a failing system only affects itself', async ({
  page,
}) => {
  await signIn(page)
  const cnb = page.getByTestId('overview-card-cnb')
  const codebuddy = page.getByTestId('overview-card-codebuddy')
  const zcode = page.getByTestId('overview-card-zcode')
  // Independent figures, in the unit each system reports.
  await expect(cnb.getByTestId('overview-quota')).toContainText('1,500')
  await expect(cnb.getByTestId('overview-quota')).toContainText('credits')
  await expect(codebuddy.getByTestId('overview-quota')).toContainText('600')
  await expect(codebuddy.getByTestId('overview-quota')).toContainText('积分')
  await expect(cnb.getByTestId('overview-quota')).not.toContainText('积分')
  // Isolation: the third system errors without touching the other two.
  await expect(zcode.getByTestId('overview-error-zcode')).toContainText('zcode2api 暂时不可达')
  await expect(zcode.getByTestId('overview-quota')).toHaveCount(0)
  await expect(cnb.getByTestId('overview-quota')).toBeVisible()
})

test('one unified account list carries a system badge, filter and tag editing', async ({
  page,
}) => {
  await signIn(page)
  await page.getByTestId('nav-accounts').click()
  const table = page.getByTestId('accounts-table')
  await expect(table).toBeVisible()
  await expect(page.getByTestId('account-cnb:cnb-a1')).toBeVisible()
  await expect(page.getByTestId('account-codebuddy:cb-b1')).toBeVisible()
  await expect(page.getByTestId('account-zcode:zc-team:1')).toBeVisible()
  // System badges are automatic.
  for (const system of ['cnb', 'codebuddy', 'zcode'])
    await expect(
      page.locator(`[data-testid=accounts-table] .system-badge.system-${system}`).first(),
    ).toBeVisible()

  // System filter narrows the same list.
  await page.getByTestId('filter-zcode').click()
  await expect(page.getByTestId('account-zcode:zc-team:1')).toBeVisible()
  await expect(page.getByTestId('account-cnb:cnb-a1')).toHaveCount(0)
  await page.getByTestId('filter-cnb').click()
  await expect(page.getByTestId('account-cnb:cnb-a1')).toBeVisible()

  // Tag filter: the automatic system tag is a real tag, so it filters too.
  await page.getByTestId('filter-all').click()
  await page.getByTestId('tag-filter').selectOption('cnb')
  await expect(page.getByTestId('account-cnb:cnb-a1')).toBeVisible()
  await expect(page.getByTestId('account-codebuddy:cb-b1')).toHaveCount(0)
  await page.getByTestId('tag-filter').selectOption('')

  // Tag editing persists through the panel tag store.
  const row = page.getByTestId('account-codebuddy:cb-b1')
  await row.getByRole('button', { name: /编辑标签/ }).click()
  await expect(page.getByTestId('system-tag-codebuddy')).toBeVisible()
  await page.getByTestId('tag-input').fill('付费')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  const patched = page.waitForRequest(
    (request) => request.method() === 'PATCH' && request.url().includes('/tags'),
  )
  const tagSave = page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && response.url().includes('/tags'),
  )
  await page.getByTestId('tag-save').click()
  expect((await patched).postDataJSON()).toEqual({ tags: ['付费'] })
  expect((await tagSave).status()).toBe(200)
  await expect(row.getByTestId('tag-chip')).toContainText('付费')
})

for (const system of ['cnb', 'codebuddy', 'zcode'] as const) {
  test(`${system} authorization runs entirely inside the panel`, async ({ page }) => {
    await signIn(page)
    await page.getByTestId('nav-accounts').click()
    const started = page.waitForResponse((response) =>
      response.url().includes(`/api/accounts/auth/${system}/start`),
    )
    await page.getByTestId(`authorize-${system}`).click()
    const dialog = page.getByRole('dialog')
    await expect(page.getByTestId(`auth-dialog-${system}`)).toBeVisible()
    expect((await started).status()).toBe(200)
    if (system === 'zcode') {
      // Adapter-driven input step: the shell never hardcodes provider fields.
      await expect(page.getByTestId('auth-input-code')).toBeVisible()
      await page.getByTestId('auth-input-code').fill('123456')
      await page.getByRole('button', { name: '提交并继续', exact: true }).click()
    }
    // The shell polls until the adapter reports success, then offers to close out.
    await expect(dialog.getByRole('button', { name: '完成', exact: true })).toBeVisible({
      timeout: 15000,
    })
    await dialog.getByRole('button', { name: '完成', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })
}

test('settings page reports each service address and token state', async ({ page }) => {
  await signIn(page)
  await page.getByTestId('nav-settings').click()
  for (const system of ['cnb', 'codebuddy', 'zcode'])
    await expect(page.getByTestId(`setting-${system}`)).toBeVisible()
  await expect(page.getByTestId('setting-cnb')).toContainText('http://cnb:9002')
  await expect(page.getByTestId('setting-codebuddy')).toContainText('已配置')
  await expect(page.getByTestId('setting-zcode')).toContainText('未配置')
})

test('the shell reserves a route slot for every not-yet-wired system page', async ({ page }) => {
  await signIn(page)
  await page.goto('/#cnb/reserved-slot-probe')
  await expect(page.getByRole('heading', { name: 'Reserved Slot Probe' })).toBeVisible()
  await expect(page.getByText('#cnb/reserved-slot-probe', { exact: false })).toBeVisible()
  // Sidebar keeps one section per system.
  await expect(page.locator('.nav-caption.system-caption')).toHaveCount(3)
})

test('signing out returns to the login form', async ({ page }) => {
  await signIn(page)
  await page.getByRole('button', { name: '用户菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
  await expect(page.getByLabel('管理密钥', { exact: true })).toBeVisible()
})
