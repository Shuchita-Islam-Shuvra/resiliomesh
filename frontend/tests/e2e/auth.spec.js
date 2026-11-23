// M03 / M06 / M07 — authentication, protected routes, validation feedback, keyboard access
import { expect, test } from '@playwright/test'
import { PASSWORD, login } from './helpers'

test('unauthenticated users are redirected to login', async ({ page }) => {
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/login/)
})

test('login form shows inline validation errors', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText('Enter a valid email address')).toBeVisible()
  await expect(page.getByText('Enter your password')).toBeVisible()
})

test('wrong password gives a clear error', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill('citizen@resiliomesh.demo')
  await page.getByLabel('Password').fill('definitely-wrong-1')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText(/incorrect email or password/i)
})

test('login form is fully keyboard operable', async ({ page }) => {
  test.skip(!PASSWORD, 'E2E_PASSWORD not set')
  await page.goto('/login')
  await page.getByLabel('Email').focus()
  await page.keyboard.type('citizen@resiliomesh.demo')
  await page.keyboard.press('Tab')
  await page.keyboard.type(PASSWORD)
  await page.keyboard.press('Enter')
  await page.waitForURL('**/dashboard')
})

test('register enforces password policy', async ({ page }) => {
  await page.goto('/register')
  await page.getByLabel('Full name').fill('Test User')
  await page.getByLabel('Email').fill('x@y.co')
  await page.getByLabel('Password').fill('short')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByText(/at least 8 characters/i).last()).toBeVisible()
})

test('citizen cannot open admin or optimiser pages (role-based access)', async ({ page }) => {
  test.skip(!PASSWORD, 'E2E_PASSWORD not set')
  await login(page, 'citizen')
  await page.goto('/admin')
  await expect(page.getByText('Access restricted')).toBeVisible()
  await page.goto('/resources')
  await expect(page.getByText('Access restricted')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Audit & Admin' })).toHaveCount(0)
})
