// M03 / M06 / M07 — authentication, protected routes, validation feedback, keyboard access
import { expect, test } from '@playwright/test'
import { PASSWORD, login } from './helpers'

test('unauthenticated users are redirected to login', async ({ page }) => {
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/login/)
})

test('login form shows inline validation errors', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByText('Enter a valid email address')).toBeVisible()
  await expect(page.getByText('Enter your password')).toBeVisible()
})

test('wrong password gives a clear error', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill('citizen@resiliomesh.demo')
  await page.getByLabel('Password', { exact: true }).fill('definitely-wrong-1')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
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
  await page.getByLabel('Password', { exact: true }).fill('short')
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

test('signing in on the wrong role tab is refused with a switch option', async ({ page }) => {
  test.skip(!PASSWORD, 'E2E_PASSWORD not set')
  await page.goto('/login?role=city_officer')
  await page.getByLabel('Email').fill('citizen@resiliomesh.demo')
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('Employee ID').fill('DSCC-OFF-01')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByText(/This is a Citizen account/)).toBeVisible()
  await page.getByRole('button', { name: 'Sign in as Citizen' }).click()
  await expect(page.getByRole('tab', { name: 'Citizen' })).toHaveAttribute('aria-selected', 'true')
})

test('role capsule switches the registration form', async ({ page }) => {
  await page.goto('/register')
  await page.getByRole('tab', { name: 'Field Worker' }).click()
  await expect(page).toHaveURL(/role=field_worker/)
  await page.getByRole('button', { name: 'Submit access request' }).click()
  await expect(page.getByText('Choose your team')).toBeVisible()
  await expect(page.getByText('Mobile number is required for staff accounts')).toBeVisible()
  await page.getByRole('tab', { name: 'Admin' }).click()
  await expect(page.getByText('Admin accounts cannot be self-registered')).toBeVisible()
})

test('staff sign-in asks for the role-specific ID', async ({ page }) => {
  await page.goto('/login?role=field_worker')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByText('Enter your Staff ID')).toBeVisible()
  await page.getByRole('tab', { name: 'NGO Coordinator' }).click()
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByText('Choose your NGO')).toBeVisible()
})

test('city officer sign-up refuses a non-official e-mail domain', async ({ page }) => {
  await page.goto('/register?role=city_officer')
  await page.getByLabel('City authority').selectOption({ index: 1 })
  await page.getByLabel('Official work email').fill('someone@gmail.com')
  await page.getByRole('button', { name: 'Submit access request' }).click()
  await expect(page.getByText(/Use your official @d[ns]cc\.gov\.bd e-mail address/)).toBeVisible()
})

test('registration accepts Bangladeshi mobile numbers only', async ({ page }) => {
  await page.goto('/register')
  await page.getByLabel('Mobile (Bangladesh)').fill('+14155550100')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByText(/Bangladeshi mobile number/)).toBeVisible()
})
