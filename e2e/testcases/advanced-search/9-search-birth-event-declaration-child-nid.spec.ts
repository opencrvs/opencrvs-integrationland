import { expect, test, type Page } from '@playwright/test'
import { createClient } from '@opencrvs/toolkit/api'
import { aggregateActionDeclarations } from '@opencrvs/toolkit/events'
import { omit } from 'lodash'
import { getToken, login } from '../../helpers'
import {
  getDeclaration,
  createDeclaration,
  type Declaration
} from '../test-data/birth-declaration'
import { CREDENTIALS, GATEWAY_HOST } from '../../constants'
import { assertTexts, ensureAssignedToUser, type } from '../../utils'
import { formatV2ChildName } from '../birth/helpers'

// Accounts for MOSIP delays
test.setTimeout(400_000)

/*
 * Female identity from mock-identities.json (Sahara Wendy Moyo, NID: 1234567899).
 * mother.nid and mother.idType are intentionally omitted from the declaration
 * because eSignet authentication hides those fields — the backend rejects
 * hidden fields receiving values. Setting mother.verified = 'authenticated'
 * causes MOSIP to forward the birth registration and assign a child.nid.
 */
const MOTHER_IDENTITY = {
  firstName: 'Sahara',
  familyName: 'Moyo',
  birthDate: '1994-10-02'
} as const

test.describe
  .serial('Advanced Search - Birth Event Declaration - Child NID @nightly', () => {
  let page: Page
  let childNid: string
  let declaration: Declaration
  let eventId: string

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    const token = await getToken(CREDENTIALS.REGISTRAR)

    const declData = await getDeclaration({
      token,
      partialDeclaration: {
        'mother.verified': 'authenticated',
        'mother.name': {
          firstname: MOTHER_IDENTITY.firstName,
          surname: MOTHER_IDENTITY.familyName
        },
        'mother.dob': MOTHER_IDENTITY.birthDate
      }
    })

    const res = await createDeclaration(token, declData)
    declaration = res.declaration
    eventId = res.eventId

    const client = createClient(`${GATEWAY_HOST}/events`, `Bearer ${token}`)

    await expect
      .poll(
        async () => {
          const event = await client.event.get.query({
            eventId,
            waitFor: false
          })
          const aggregated = aggregateActionDeclarations(event)
          childNid = aggregated['child.nid'] as string
          return /^\d{10}$/.test(childNid)
        },
        { timeout: 300_000, intervals: [10_000, 30_000] }
      )
      .toBe(true)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test('Navigate to advanced search', async () => {
    await login(page)
    await page.click('#searchType')
    await expect(page).toHaveURL(/.*\/advanced-search/)
    await page.getByText('Birth').click()
  })

  test('Search by child name and NID and verify search results', async () => {
    await page.getByText('Child details').click()

    await type(page, '#firstname', declaration['child.name'].firstname)
    await type(page, '#surname', declaration['child.name'].surname)
    await type(page, '#child____nid', childNid)

    await page.click('#search')
    await expect(page).toHaveURL(/.*\/search-result/)
    expect(page.url()).toContain(`child.nid=${childNid}`)

    const searchResult = await page.locator('#content-name').textContent()
    const searchResultCountNumberInBracketsRegex = /\((\d+)\)$/
    expect(searchResult).toMatch(searchResultCountNumberInBracketsRegex)

    await assertTexts({
      root: page,
      testId: 'search-result',
      texts: [
        'Event: Birth',
        `Child's National ID: ${childNid}`,
        `Child's Name: ${declaration['child.name'].firstname} ${declaration['child.name'].surname}`
      ]
    })
  })

  test('Open record from search results and verify NID is visible in summary', async () => {
    const childName = formatV2ChildName(declaration)
    await page.getByRole('button', { name: childName }).click()

    await ensureAssignedToUser(page, CREDENTIALS.REGISTRAR)

    await expect(page.getByTestId('child.nid-value')).toContainText(childNid)
  })
})
