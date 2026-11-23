// A04 — field worker updates a task while offline; sync on reconnect
import { expect, test } from '@playwright/test'
import { PASSWORD, login } from './helpers'

test.skip(!PASSWORD, 'E2E_PASSWORD not set')

test('offline task update is queued and synced when back online', async ({ page, context }) => {
  await login(page, 'field')
  await page.goto('/field')
  const card = page.locator('section').filter({ has: page.getByRole('button', { name: /accept|start work|mark completed/i }) }).first()
  test.skip(await card.count() === 0, 'no active task assigned to field1 — approve a plan first')

  await context.setOffline(true)
  await expect(page.getByText('Offline mode')).toBeVisible()
  await card.getByRole('button', { name: /accept|start work/i }).first().click()
  await expect(page.getByText(/waiting to sync/)).toBeVisible()
  await expect(page.getByText('pending sync').first()).toBeVisible()

  await context.setOffline(false)
  await expect(page.getByText(/All changes synced/)).toBeVisible({ timeout: 20_000 })
})
