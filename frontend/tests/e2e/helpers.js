export const PASSWORD = process.env.E2E_PASSWORD
export const USERS = {
  admin: 'admin@resiliomesh.demo',
  officer: 'officer@resiliomesh.demo',
  officer2: 'officer2@resiliomesh.demo',
  ngo: 'ngo@resiliomesh.demo',
  ngo2: 'ngo2@resiliomesh.demo',
  field: 'field1@resiliomesh.demo',
  citizen: 'citizen@resiliomesh.demo',
}

export async function login(page, who) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(USERS[who])
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}
