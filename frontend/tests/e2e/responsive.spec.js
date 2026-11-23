// M07 — responsive layout
import { expect, test } from '@playwright/test'
import { PASSWORD, login } from './helpers'

test('auth page has no horizontal scroll on phones', async ({ page }) => {
  await page.goto('/login')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(overflow).toBe(false)
})

test('mobile navigation drawer opens and closes', async ({ page, isMobile }) => {
  test.skip(!PASSWORD || !isMobile, 'mobile + credentials only')
  await login(page, 'officer')
  await page.getByRole('button', { name: 'Open menu' }).click()
  await expect(page.getByRole('link', { name: 'Live Risk Map' })).toBeVisible()
  await page.getByRole('link', { name: 'Live Risk Map' }).click()
  await expect(page).toHaveURL(/\/map/)
})
