export const PASSWORD = process.env.E2E_PASSWORD
export const USERS = {
  admin: 'admin@resiliomesh.demo',
  admin2: 'admin2@resiliomesh.demo',
  officer: 'officer@resiliomesh.demo',
  officer2: 'officer2@resiliomesh.demo',
  ngo: 'ngo@resiliomesh.demo',
  ngo2: 'ngo2@resiliomesh.demo',
  field: 'field1@resiliomesh.demo',
  citizen: 'citizen@resiliomesh.demo',
}

export const SIGNIN_ID = {
  admin: 'ADM-001', admin2: 'ADM-002', officer: 'DSCC-OFF-01', officer2: 'DNCC-OFF-02', field: 'FW-001',
}

export const ROLE_OF = {
  admin: 'admin', admin2: 'admin', officer: 'city_officer', officer2: 'city_officer', ngo: 'ngo_coordinator',
  ngo2: 'ngo_coordinator', field: 'field_worker', citizen: 'citizen',
}

export async function login(page, who) {
  await page.goto(`/login?role=${ROLE_OF[who]}&view=form`)
  await page.getByLabel('Email').fill(USERS[who])
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  if (SIGNIN_ID[who]) await page.getByLabel(/^(Employee|Staff|Admin) ID/).fill(SIGNIN_ID[who])
  if (who.startsWith('ngo')) await page.getByLabel('NGO', { exact: true }).selectOption({ label: who === 'ngo' ? 'Shobar Jonno Relief Network' : 'Nodi Humanitarian Foundation' })
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL('**/dashboard')
}
