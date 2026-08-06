import { Page, expect, test } from '@playwright/test'
import { createClient } from '@opencrvs/toolkit/api'
import {
  continueForm,
  drawSignature,
  goToSection,
  login,
  selectDeclarationAction
} from '../../helpers'
import { CREDENTIALS, GATEWAY_HOST } from '../../constants'
import { openBirthDeclaration } from '../birth/helpers'
import { openOTPListener, requestOTP } from '../../smtp-websocket'

async function openBirthDeclarationAndCaptureEventId(page: Page) {
  const createEventResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('event.create') &&
      response.request().method() === 'POST'
  )

  await openBirthDeclaration(page)

  const createEventResponse = await createEventResponsePromise
  const responseText = await createEventResponse.text()
  const eventId = responseText.match(/[0-9a-fA-F-]{36}/)?.[0]

  if (!eventId) {
    throw new Error('Could not capture eventId from event.create response')
  }

  return eventId
}

async function authenticateMotherWithESignet(page: Page) {
  await page.locator('#mother____verify').click()
  await expect(page).toHaveURL(/login/, { timeout: 60_000 })
  await page.locator('#Otp_vid').fill('5614716359')
  const waitForOTP = await openOTPListener()
  await requestOTP(page)
  const otp = await waitForOTP()
  const pincodeInputs = page.locator('.pincode-input-text')
  for (let i = 0; i < 6; i++) {
    await pincodeInputs.nth(i).fill(otp[i])
  }

  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page).not.toHaveURL(/login/, { timeout: 60_000 })
}

async function fillChildDetails(page: Page) {
  await page.locator('#firstname').fill('E2E PSUT Child')
  await page.locator('#surname').fill('Persistence')

  await page.locator('#child____gender').click()
  await page.getByText('Female', { exact: true }).click()

  await page.getByPlaceholder('dd').fill('10')
  await page.getByPlaceholder('mm').fill('10')
  await page.getByPlaceholder('yyyy').fill('2025')

  await page.locator('#child____placeOfBirth').click()
  await page.getByText('Health Institution', { exact: true }).click()
  await page.locator('#child____birthLocation').fill('Klow')
  await page.getByText('Klow Village Hospital', { exact: true }).click()

  await page.locator('#child____attendantAtBirth').click()
  await page.getByText('Physician', { exact: true }).click()

  await page.locator('#child____birthType').click()
  await page.getByText('Single', { exact: true }).click()

  await page.locator('#child____weightAtBirth').fill('2.5')
}

test.describe('E-Signet PSUT persistence @nightly', () => {
  let page: Page
  let token: string

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
  })

  test.afterAll(async () => {
    await page.close()
  })

  test('Declare birth with mother E-Signet and confirm `sub` in backend payload', async () => {
    test.setTimeout(180_000)

    token = await login(page, CREDENTIALS.HOSPITAL_OFFICIAL)

    const eventId = await openBirthDeclarationAndCaptureEventId(page)

    await fillChildDetails(page)
    await continueForm(page)

    await page.locator('#informant____relation').click()
    await page.getByText('Mother', { exact: true }).click()
    await page.locator('#informant____email').fill('psut-mother@example.com')
    await continueForm(page)

    await authenticateMotherWithESignet(page)

    await expect(page.getByText('ID Authenticated')).toBeVisible({
      timeout: 60_000
    })

    if (await page.locator('#mother____addressSameAs_YES').isVisible()) {
      await page.locator('#mother____addressSameAs_YES').check()
    }

    if (await page.locator('#mother____maritalStatus').isVisible()) {
      await page.locator('#mother____maritalStatus').click()
      await page.getByText('Single', { exact: true }).click()
    }

    if (await page.locator('#mother____educationalAttainment').isVisible()) {
      await page.locator('#mother____educationalAttainment').click()
      await page.getByText('No schooling', { exact: true }).click()
    }

    await continueForm(page)

    await page.getByLabel("Father's details are not available").check()
    await page.locator('#father____reason').fill('Father details not available')

    await goToSection(page, 'review')

    await page.locator('#review____comment').fill('PSUT persistence check')
    await page.getByRole('button', { name: 'Sign', exact: true }).click()
    await drawSignature(page, 'review____signature_canvas_element', false)
    await page.getByRole('button', { name: 'Apply' }).click()

    await selectDeclarationAction(page, 'Declare')

    const client = createClient(GATEWAY_HOST + '/events', `Bearer ${token}`)

    await expect
      .poll(
        async () => {
          const eventDocument = await client.event.get.query({
            eventId,
            waitFor: false
          })
          const declareAction = eventDocument.actions.find(
            (action) =>
              action.type === 'DECLARE' && action.status === 'Requested'
          )

          return {
            sub:
              declareAction &&
              'declaration' in declareAction &&
              declareAction.declaration?.['mother.verify-nid-http-fetch']?.data
                ?.sub
          }
        },
        { timeout: 60_000, intervals: [1_000, 2_000, 5_000] }
      )
      .toMatchObject({ sub: expect.stringMatching(/\d+/) })
  })
})
