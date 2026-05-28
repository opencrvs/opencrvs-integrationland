import { Page, expect, test } from '@playwright/test'
import { goToSection, login } from '../../helpers'
import { openBirthDeclaration } from '../birth/helpers'

async function authenticateInformantWithESignet(page: Page) {
  await page.locator('#informant____verify').click()

  await expect(page).toHaveURL(/login/, { timeout: 60_000 })
  await page.locator('#Otp_vid').fill('2186715839')
  await page.getByRole('button', { name: 'Get OTP' }).click()

  const pincodeInputs = page.locator('.pincode-input-text')
  for (let i = 0; i < 6; i++) {
    await pincodeInputs.nth(i).fill('1')
  }

  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page).not.toHaveURL(/login/, { timeout: 60_000 })
}

test.describe
  .serial('E-Signet LINK_BUTTON inserts and locks informant data @nightly', () => {
  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
  })

  test.afterAll(async () => {
    await page.close()
  })

  test('Login', async () => {
    await login(page)
  })

  test('Name and DOB are inserted+disabled, National ID is unavailable', async () => {
    await openBirthDeclaration(page)
    await goToSection(page, 'informant')

    await page.locator('#informant____relation').click()
    await page.getByText('Brother', { exact: true }).click()

    await authenticateInformantWithESignet(page)

    await expect(page.getByText('ID Authenticated')).toBeVisible({
      timeout: 60_000
    })

    await expect(page.locator('#firstname')).toHaveValue('Rachik')
    await expect(page.locator('#surname')).toHaveValue('Sharma')
    await expect(page.locator('#firstname')).toBeDisabled()
    await expect(page.locator('#surname')).toBeDisabled()

    await expect(page.locator('#informant____dob-dd')).toHaveValue('06')
    await expect(page.locator('#informant____dob-mm')).toHaveValue('06')
    await expect(page.locator('#informant____dob-yyyy')).toHaveValue('2000')

    await expect(page.locator('#informant____dob-dd')).toBeDisabled()
    await expect(page.locator('#informant____dob-mm')).toBeDisabled()
    await expect(page.locator('#informant____dob-yyyy')).toBeDisabled()

    await expect(page.locator('#informant____nid')).toBeDisabled()
    await expect(page.locator('#informant____nid')).toHaveValue('2186715839')
  })

  test.skip('Handle surnames with spaces', async () => {})
})
