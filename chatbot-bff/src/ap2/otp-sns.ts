import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'
import { createLogger } from 'ap2-core/log'

const sns = new SNSClient({ region: process.env.AWS_REGION ?? 'us-east-1' })
const log = createLogger({ service: 'bff' })

/**
 * Sends the one-time code to the user's phone.
 *
 * Delivery failure is non-fatal on purpose. The code is already minted and sealed server-side, and
 * a sandbox account can only reach verified numbers — so treating an SMS failure as a checkout
 * failure would make the flow untestable for anyone without a verified phone, while gaining nothing:
 * a user who never receives the code simply cannot confirm, which is already the correct outcome.
 *
 * The code never travels through the agent. It goes out of band here and comes back in directly from
 * the browser, so the model never sees it in any turn.
 *
 * The logger masks `otp` by default; it surfaces only under `LOG_OTP_INSECURE`, which exists for
 * SMS-less sandbox testing and nowhere else.
 */
export async function sendOtpSms(
  phone: string | undefined,
  otp: string,
  summary: string,
): Promise<void> {
  log.info('one-time code generated', { otp, summary })

  if (!phone) {
    log.warn('one-time code not sent', { reason: 'no phone number on the caller identity' })
    return
  }

  try {
    const res = await sns.send(
      new PublishCommand({
        Message: `Your checkout authorization code is ${otp}. ${summary}`,
        PhoneNumber: phone,
      }),
    )
    log.info('one-time code sent', {
      // Enough to correlate a delivery complaint, not enough to reconstruct the number.
      phone: phone.slice(0, 3) + '****' + phone.slice(-2),
      messageId: res.MessageId,
    })
  } catch (err) {
    log.error('one-time code delivery failed', { err })
  }
}
