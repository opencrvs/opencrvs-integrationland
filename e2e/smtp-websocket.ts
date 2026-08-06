const WS_URL = 'wss://smtp.collab.mosip.net:443/mocksmtp/websocket'

/*
 * The mock SMTP server broadcasts every message it receives to all connected
 * clients, so the listener has to be connected *before* the OTP is requested.
 * Resolves once the socket is open, which is why this is async.
 */
export async function openOTPListener(): Promise<
  (timeoutMs?: number) => Promise<string>
> {
  let resolveOTP: (otp: string) => void
  const otpPromise = new Promise<string>((resolve) => {
    resolveOTP = resolve
  })

  const ws = new WebSocket(WS_URL)

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Could not connect to ${WS_URL} within 15s`)),
      15_000
    )
    ws.onopen = () => {
      clearTimeout(timeout)
      console.log('OTP listener: WebSocket connected')
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(timeout)
      reject(new Error(`WebSocket error connecting to ${WS_URL}`))
    }
  })

  ws.onerror = () => {
    console.error('OTP listener: WebSocket error')
  }

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data as string)
      if (message.type !== 'SMS') return

      const body: string = message.subject || message.text || ''
      const otpMatch = body.match(/\b\d{6}\b/)

      if (!otpMatch) {
        // MOSIP collab is shared, so most traffic belongs to other tenants.
        console.log(`OTP listener: ignoring SMS without an OTP: ${body}`)
        return
      }

      console.log(`OTP listener: received OTP ${otpMatch[0]}`)
      ws.close()
      resolveOTP(otpMatch[0])
    } catch (e) {
      console.error('OTP listener: parse error:', e)
    }
  }

  return (timeoutMs = 60_000): Promise<string> => {
    const timeout = new Promise<string>((_, reject) =>
      setTimeout(() => {
        ws.close()
        reject(new Error(`Timeout waiting for OTP after ${timeoutMs}ms`))
      }, timeoutMs)
    )
    return Promise.race([otpPromise, timeout])
  }
}

/*
 * eSignet answers a failed send-otp with HTTP 200 and an `errors` array, so
 * without this the only symptom is the OTP listener timing out a minute later.
 */
export async function requestOTP(
  page: import('@playwright/test').Page
): Promise<void> {
  const sendOtpResponse = page.waitForResponse(
    (response) => response.url().includes('/authorization/send-otp'),
    { timeout: 60_000 }
  )

  await page.getByRole('button', { name: 'Get OTP' }).click()

  const body = await (await sendOtpResponse).json()

  if (body.errors?.length) {
    throw new Error(
      `eSignet refused to send an OTP: ${JSON.stringify(body.errors)}`
    )
  }
}
