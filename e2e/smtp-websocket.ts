const WS_URL = 'wss://smtp.collab.mosip.net:443/mocksmtp/websocket'

export function openOTPListener(): () => Promise<string> {
  let resolveOTP: (otp: string) => void
  const otpPromise = new Promise<string>((resolve) => {
    resolveOTP = resolve
  })

  const ws = new WebSocket(WS_URL)

  ws.onopen = () => {
    console.log('OTP listener: WebSocket connected')
  }

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data as string)
      console.log('OTP listener: message type:', message.type)
      if (message.type !== 'SMS') return

      const body: string = message.subject || message.text || ''
      const otpMatch = body.match(/\b\d{6}\b/)

      if (otpMatch) {
        console.log(`OTP listener: received OTP ${otpMatch[0]}`)
        ws.close()
        resolveOTP(otpMatch[0])
      }
    } catch (e) {
      console.error('OTP listener: parse error:', e)
    }
  }

  ws.onerror = () => {
    console.error('OTP listener: WebSocket error')
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
