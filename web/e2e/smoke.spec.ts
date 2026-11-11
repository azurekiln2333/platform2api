import { test, expect, type Page } from '@playwright/test'
async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('管理密钥', { exact: true }).fill('browser-test-admin-key')
  await page.getByRole('button', { name: '进入控制台', exact: true }).click()
  await expect(page.locator('.app-shell')).toBeVisible()
}
test.beforeEach(async ({ request }) => {
  await request.post('/__reset')
})
test('six flat pages, fourth channel and partial failures', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signIn(page)
  await expect(page.getByRole('navigation', { name: '主导航' }).locator('a')).toHaveCount(6)
  await expect(page.getByTestId('overview-card-fourth')).toBeVisible()
  await expect(page.getByTestId('overview-card-zcode')).toContainText('暂不可达')
  await expect(page.getByTestId('overview-card-cnb')).toContainText('credits')
  await expect(page.getByTestId('overview-card-codebuddy')).toContainText('积分')
  for (const route of ['accounts', 'keys', 'models', 'logs', 'settings']) {
    await page.getByTestId(`nav-${route}`).click()
    await expect(page.locator('main h1')).toHaveCount(1)
  }
  expect(errors).toEqual([])
})
test('incomplete statistics remain explicit without inventing a failure rate', async ({ page }) => {
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.totals.partial = true
    body.errors = [{ system: 'cnb', code: 'usage_partial', message: '今日统计不完整' }]
    body.channels[0].partial = true
    body.channels[0].errorsToday = null
    await route.fulfill({ json: body })
  })
  await signIn(page)
  await expect(page.getByText('统计尚不完整，指标仅汇总当前可用的数据。')).toBeVisible()
  await expect(
    page.locator('.console-metrics article').filter({ hasText: '今日失败率' }).locator('strong'),
  ).toHaveText('—')
  await expect(page.getByRole('alert')).toContainText('CNB：今日统计不完整')
  await expect(page.getByRole('alert')).not.toContainText('暂时不可达')
})
test('legacy routes redirect and filters survive reload/history', async ({ page }) => {
  await signIn(page)
  await page.goto('/#fourth/models?q=shared')
  await expect(page).toHaveURL(/#models\?q=shared&system=fourth/)
  await expect(page.getByTestId('filter-fourth')).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(page.getByLabel('搜索模型')).toHaveValue('shared')
  await page.getByTestId('filter-all').click()
  await page.goBack()
  await expect(page.getByTestId('filter-fourth')).toHaveAttribute('aria-pressed', 'true')
  await page.goto('/#cnb/unknown')
  await expect(page).toHaveURL(/#overview$/)
})
test('accounts card/list persists and tags use PUT', async ({ page }) => {
  await signIn(page)
  await page.getByTestId('nav-accounts').click()
  await expect(page.getByTestId('account-fourth:account-2')).toBeVisible()
  await page.getByRole('button', { name: '列表视图', exact: true }).click()
  await expect(page.getByTestId('accounts-table')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('accounts-table')).toBeVisible()
  const row = page.getByTestId('account-fourth:account-2')
  await row.getByRole('button', { name: /编辑标签/ }).click()
  await page.getByTestId('tag-input').fill('验证')
  const saved = page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes('/tags'))
  await page.getByTestId('tag-save').click()
  expect((await saved).postDataJSON().tags).toContain('验证')
  await expect(row).toContainText('验证')
  await page.getByTestId('filter-fourth').click()
  await expect(page.getByTestId('account-cnb:account-0')).toHaveCount(0)
})
test('unified key has explicit scope, one-time secret and protected result', async ({ page }) => {
  await signIn(page)
  await page.getByTestId('nav-keys').click()
  await expect(page.getByText('还没有可用的统一密钥', { exact: false })).toBeVisible()
  await expect(page.getByText('http://127.0.0.1:19300/v1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '新建密钥', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('指定渠道', { exact: true }).check()
  await dialog.getByLabel('名称', { exact: true }).fill('统一验证密钥')
  await dialog.getByRole('button', { name: '创建密钥', exact: true }).click()
  await expect(dialog).toContainText('请至少选择一个可用渠道')
  await dialog.getByLabel('第四渠道', { exact: true }).check()
  const created = page.waitForRequest(
    (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/keys',
  )
  await dialog.getByRole('button', { name: '创建密钥', exact: true }).click()
  expect((await created).postDataJSON()).toMatchObject({
    via: 'unified',
    channels: ['fourth'],
    name: '统一验证密钥',
  })
  await expect(dialog.getByRole('button', { name: '我已保存' })).toBeVisible()
  await expect(dialog.locator('input[readonly]')).toHaveValue('fixture-secret-1-once-only')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '我已保存' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('fixture-secret-1-once-only')
  await expect(page.getByRole('row').filter({ hasText: '统一验证密钥' })).toContainText('第四渠道')
})
test('direct key fields follow channel capabilities and failed deletion stays open', async ({
  page,
  request,
}) => {
  await signIn(page)
  await page.getByTestId('nav-keys').click()
  await page.getByRole('button', { name: '新建密钥', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('渠道自己的地址', { exact: false }).check()
  await dialog.getByLabel('CodeBuddy', { exact: true }).check()
  await dialog.getByLabel('名称', { exact: true }).fill('直连新密钥')
  await dialog.getByText('限制（可选）', { exact: true }).click()
  await expect(dialog.getByLabel('模型白名单', { exact: false })).toBeVisible()
  await expect(dialog.getByLabel('请求额度', { exact: false })).toHaveCount(0)
  await dialog.getByRole('button', { name: '创建密钥', exact: true }).click()
  await dialog.getByRole('button', { name: '我已保存' }).click()
  await request.post('/__failure', { data: { delete: true } })
  await page.getByRole('button', { name: '删除密钥 直连新密钥', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('直连新密钥')
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('模拟删除失败')
  await request.post('/__failure', { data: { delete: false } })
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
test('unified limits persist, clear explicitly and all-channel keys count once', async ({
  page,
}) => {
  await signIn(page)
  await page.getByTestId('nav-keys').click()
  await page.getByRole('button', { name: '新建密钥', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('名称', { exact: true }).fill('限额验证密钥')
  await dialog.getByText('限制（可选）', { exact: true }).click()
  await dialog.getByLabel('请求额度', { exact: false }).fill('120')
  await dialog.getByLabel('Token 额度', { exact: false }).fill('4500')
  await dialog.getByLabel('到期时间', { exact: true }).fill('2030-12-20T12:30')
  await dialog.getByLabel('模型白名单', { exact: false }).fill('shared-model')
  await dialog.getByLabel('IP 白名单', { exact: false }).fill('127.0.0.1')
  const created = page.waitForRequest(
    (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/keys',
  )
  await dialog.getByRole('button', { name: '创建密钥', exact: true }).click()
  const payload = (await created).postDataJSON()
  expect(payload).toMatchObject({
    via: 'unified',
    channels: '*',
    quota: { requests: 120, tokens: 4500 },
    models: ['shared-model'],
    ipAllow: ['127.0.0.1'],
  })
  expect(payload).not.toHaveProperty('quotaRequests')
  expect(payload.expiresAt).toMatch(/^2030-12-20T/)
  await dialog.getByRole('button', { name: '我已保存' }).click()
  await expect(page.getByTestId('filter-all')).toHaveText('全部 2')
  await page.getByRole('button', { name: '编辑密钥 限额验证密钥', exact: true }).click()
  await expect(dialog.getByLabel('请求额度', { exact: false })).toHaveValue('120')
  await expect(dialog.getByLabel('Token 额度', { exact: false })).toHaveValue('4500')
  await expect(dialog.getByLabel('到期时间', { exact: true })).toHaveValue('2030-12-20T12:30')
  for (const label of ['请求额度', 'Token 额度', '到期时间', '模型白名单', 'IP 白名单'])
    await dialog.getByLabel(label, { exact: false }).fill('')
  const patched = page.waitForRequest(
    (r) => r.method() === 'PATCH' && r.url().includes('/api/keys/'),
  )
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  expect((await patched).postDataJSON()).toMatchObject({
    quota: {},
    expiresAt: null,
    models: [],
    ipAllow: [],
  })
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: '编辑密钥 限额验证密钥', exact: true }).click()
  for (const label of ['请求额度', 'Token 额度', '到期时间', '模型白名单', 'IP 白名单'])
    await expect(dialog.getByLabel(label, { exact: false })).toHaveValue('')
  await dialog.getByLabel('启用密钥', { exact: true }).uncheck()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: /停用密钥「限额验证密钥」/ })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: '停用', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: '新建密钥', exact: true }).first().click()
  await dialog.getByLabel('名称', { exact: true }).fill('再次创建密钥')
  await dialog.getByRole('button', { name: '创建密钥', exact: true }).click()
  await expect(dialog.locator('input[readonly]')).toHaveAttribute('type', 'password')
  await dialog.getByRole('button', { name: '我已保存' }).click()
})
test('models merge duplicate names and fourth channel has server color', async ({ page }) => {
  await signIn(page)
  await page.getByTestId('nav-models').click()
  await expect(page.locator('tbody tr')).toHaveCount(3)
  await page.getByLabel('合并同名模型').check()
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await expect(page.locator('tbody .system-badge')).toHaveCount(6)
  await expect(page.locator('tbody .system-fourth').first()).toHaveCSS('color', 'rgb(221, 87, 38)')
})
test('native model editor preserves rules, encodes slash IDs and confirms disabling', async ({
  page,
}) => {
  await signIn(page)
  await page.getByTestId('nav-models').click()
  await page.getByRole('button', { name: '编辑 shared-model CodeBuddy', exact: true }).click()
  const editor = page.getByRole('dialog', {
    name: '编辑模型「shared-model」（CodeBuddy）',
    exact: true,
  })
  await expect(editor.getByLabel('对外模型 ID', { exact: false })).toHaveValue('shared-model')
  await editor.getByLabel('启用模型', { exact: true }).uncheck()
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  const confirm = page.getByRole('dialog', {
    name: '停用模型「shared-model」（CodeBuddy）',
    exact: true,
  })
  await expect(confirm).toBeVisible()
  const saved = page.waitForRequest(
    (r) => r.method() === 'PUT' && r.url().includes('/api/p/codebuddy/admin/models/'),
  )
  await confirm.getByRole('button', { name: '停用', exact: true }).click()
  const request = await saved
  expect(new URL(request.url()).pathname).toBe('/api/p/codebuddy/admin/models/vendor/shared-model')
  expect(request.postDataJSON()).toMatchObject({
    revision: 7,
    enabled: false,
    routes: ['chat'],
    credits_override: 0,
  })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  for (const [button, action, suffix] of [
    ['扫描目录 CodeBuddy', '扫描目录', 'scan'],
    ['计费探测 CodeBuddy', '计费探测', 'rate-probe'],
  ]) {
    await page.getByRole('button', { name: button, exact: true }).click()
    const started = page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().endsWith(`/admin/models/${suffix}`),
    )
    await page.getByRole('dialog').getByRole('button', { name: action, exact: true }).click()
    await started
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }
  await page.getByRole('button', { name: '新建模型 CodeBuddy', exact: true }).click()
  const create = page.getByRole('dialog', { name: '新建模型（CodeBuddy）', exact: true })
  await create.getByLabel('对外模型 ID', { exact: false }).fill('custom-model')
  await create.getByLabel('上游模型 ID', { exact: false }).fill('vendor/new-model')
  const created = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith('/admin/models'),
  )
  await create.getByRole('button', { name: '保存', exact: true }).click()
  expect((await created).postDataJSON()).toMatchObject({
    revision: 8,
    public_id: 'custom-model',
    upstream_id: 'vendor/new-model',
  })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByTestId('filter-fourth').click()
  await expect(page.locator('.catalog-tools')).toHaveCount(0)
})
test('logs use stable server cursor, via filter and redacted detail', async ({ page }) => {
  await signIn(page)
  await page.getByTestId('nav-logs').click()
  await expect(page.locator('tbody tr')).toHaveCount(50)
  await page.getByRole('button', { name: /加载更多/ }).click()
  await expect(page.locator('tbody tr')).toHaveCount(65)
  await page.getByLabel('入口', { exact: true }).selectOption('unified')
  await expect(page.locator('tbody tr')).toHaveCount(32)
  await expect(page).toHaveURL(/via=unified/)
  await page.locator('tbody tr').first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('原始 JSON', { exact: true })).toBeVisible()
  await dialog.getByText('原始 JSON', { exact: true }).click()
  await expect(dialog).toContainText('[已隐藏]')
  await expect(dialog).not.toContainText('MUST-NOT-APPEAR')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.getByRole('tab', { name: '用量统计' }).click()
  await expect(page.getByText('统一测试密钥', { exact: true })).toBeVisible()
})
test('settings routing persists, service tests, dirty form guards and failures preserve input', async ({
  page,
  request,
}) => {
  await signIn(page)
  await page.getByTestId('nav-settings').click()
  const routing = page
    .locator('section.console-panel')
    .filter({ has: page.getByRole('heading', { name: '统一入口路由', exact: true }) })
  await expect(routing.getByRole('button', { name: '保存路由' })).toBeDisabled()
  await routing.getByRole('button', { name: '上移 第四渠道', exact: true }).click()
  const saved = page.waitForRequest(
    (r) => r.method() === 'PATCH' && r.url().includes('/gateway/routing'),
  )
  await routing.getByRole('button', { name: '保存路由' }).click()
  expect((await saved).postDataJSON().order).toEqual(['cnb', 'codebuddy', 'fourth', 'zcode'])
  await page.getByTestId('setting-fourth').getByRole('button', { name: '测试连接' }).click()
  await expect(page.getByTestId('setting-fourth')).toContainText('连接正常')
  const group = page
    .locator('section.console-panel')
    .filter({ has: page.getByRole('heading', { name: '日志保留', exact: true }) })
  await group.getByLabel('保留天数').fill('12')
  page.once('dialog', (dialog) => dialog.dismiss())
  await page.getByTestId('nav-overview').click()
  await expect(page).toHaveURL(/#settings/)
  await request.post('/__failure', { data: { save: true } })
  await group.getByRole('button', { name: '保存', exact: true }).click()
  await expect(group).toContainText('保留天数无效')
  await expect(group.getByLabel('保留天数')).toHaveValue('12')
  await request.post('/__failure', { data: { save: false } })
  await group.getByRole('button', { name: '保存', exact: true }).click()
  await expect(group.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await group.getByLabel('保留天数').fill('13')
  const resaved = page.waitForRequest(
    (r) => r.method() === 'PATCH' && r.url().includes('/settings/common'),
  )
  await group.getByRole('button', { name: '保存', exact: true }).click()
  expect((await resaved).postDataJSON().values).toMatchObject({ days: 13, revision: 4 })
  await expect(group.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
})
test('mobile drawer, tablet icon rail, keyboard focus and logout', async ({ page }) => {
  await signIn(page)
  await page.setViewportSize({ width: 1000, height: 900 })
  await expect(page.locator('.sidebar')).toHaveCSS('width', '68px')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '展开导航', exact: true }).click()
  await page.getByTestId('nav-keys').click()
  await expect(page.getByRole('button', { name: '展开导航', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await expect(page.locator('.sidebar')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, -220, 0)')
  await expect(page.locator('.mobile-backdrop')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '刷新', exact: true }).first()).not.toHaveCSS(
    'font-size',
    '0px',
  )
  await page.getByRole('button', { name: '新建密钥', exact: true }).first().click()
  await expect(page.getByRole('dialog').locator('input').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: '展开导航', exact: true }).click()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.getByLabel('管理密钥', { exact: true })).toBeVisible()
})
