// M01 end-to-end: citizen report -> officer verify -> AI assess -> optimise -> approve -> workflow
// A01: two officers edit the same incident concurrently -> conflict detected
import { expect, test } from '@playwright/test'
import { PASSWORD, login } from './helpers'

test.skip(!PASSWORD, 'E2E_PASSWORD not set (seed demo users first)')

test('full incident lifecycle across three roles', async ({ browser }) => {
  const title = `E2E knee-deep water ${Date.now()}`
  // 1. citizen reports
  const citizen = await (await browser.newContext()).newPage()
  await login(citizen, 'citizen')
  await citizen.goto('/incidents/new')
  await citizen.getByLabel('Title').fill(title)
  await citizen.getByLabel('Description').fill('Water entering shops near the bazar, rickshaws stuck.')
  await citizen.getByLabel('Water depth (cm)').fill('55')
  await citizen.getByLabel('People affected (approx.)').fill('300')
  await citizen.locator('.leaflet-container').click({ position: { x: 220, y: 160 } })
  await citizen.getByRole('button', { name: /submit report/i }).click()
  await citizen.waitForURL(/\/incidents\/[0-9a-f-]{36}/)
  const url = citizen.url()

  // 2. officer verifies + runs AI
  const officer = await (await browser.newContext()).newPage()
  await login(officer, 'officer')
  await officer.goto(url.replace(/^https?:\/\/[^/]+/, ''))
  await officer.getByRole('button', { name: 'Verify' }).click()
  await expect(officer.getByText('Verified').first()).toBeVisible()
  await officer.getByRole('button', { name: /run ai risk assessment/i }).click()
  await expect(officer.getByText(/why this risk score/i)).toBeVisible({ timeout: 30_000 })

  // citizen sees the status change live (realtime)
  await expect(citizen.getByText('Assessed').first()).toBeVisible({ timeout: 15_000 })

  // 3. optimise and approve
  await officer.getByRole('link', { name: 'Plan resources' }).click()
  await officer.getByRole('button', { name: /run optimiser/i }).click()
  await expect(officer.getByText('Optimiser result')).toBeVisible({ timeout: 30_000 })
  await officer.getByRole('button', { name: 'Approve' }).first().click()
  await expect(officer.getByText(/dispatch workflow queued|already approved/i)).toBeVisible()
  await officer.goto('/workflows')
  await expect(officer.getByText('Succeeded').first()).toBeVisible({ timeout: 30_000 })
})

test('A01: concurrent edits by two officers are detected, not silently overwritten', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage()
  const b = await (await browser.newContext()).newPage()
  await login(a, 'officer')
  await login(b, 'officer2')
  await a.goto('/incidents?tab=assets')
  await b.goto('/incidents?tab=assets')
  // both open the same asset editor
  await a.getByRole('button', { name: /^Edit DR-MRP-002/ }).click()
  await b.getByRole('button', { name: /^Edit DR-MRP-002/ }).click()
  await a.getByLabel('Condition (0–100)').fill('41')
  await a.getByRole('button', { name: 'Save' }).click()
  await expect(a.getByText(/updated/)).toBeVisible()
  await b.getByLabel('Condition (0–100)').fill('77')
  await b.getByRole('button', { name: 'Save' }).click()
  await expect(b.getByRole('dialog', { name: /someone else changed this record/i })).toBeVisible()
})
