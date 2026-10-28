import { classifySendError } from '../services/reminders.js';
import type { Mailer } from './mailer.js';

export type TestEmailResult = { ok: true } | { ok: false; label: string; hint: string };

/** Plain-language next step for the failures operators actually meet. Never includes provider text, addresses or credentials. */
function hintFor(err: unknown): string {
  const e = err as { responseCode?: unknown; code?: unknown };
  const reply = typeof e.responseCode === 'number' ? e.responseCode : null;
  const code = typeof e.code === 'string' ? e.code : null;
  if (reply === 535 || reply === 534 || reply === 530 || code === 'EAUTH') {
    return 'The server rejected the username or password (SMTP_USER / SMTP_PASS). Many providers need an app password or an API key instead of your account password.';
  }
  if (reply !== null && [550, 551, 553, 554].includes(reply)) {
    return 'The server refused the sender or the recipient. Check that SMTP_FROM is an address or domain you have verified with the provider, and that the recipient address is correct.';
  }
  if (reply !== null && reply >= 400 && reply < 500) {
    return 'The server asked us to try again later (temporary failure, often rate limiting or greylisting). Wait a few minutes and run the command again.';
  }
  if (code === 'ETLS') {
    return 'The server did not offer an encrypted connection (STARTTLS), which SubCycle requires. Use port 587 (STARTTLS), or port 465 with SMTP_SECURE=true.';
  }
  if (code === 'ETIMEDOUT') {
    return "The connection timed out. Many hosts block outbound SMTP ports; try the provider's alternative port, or check the firewall.";
  }
  if (code === 'ESOCKET' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNECTION' || code === 'EDNS') {
    return 'Could not connect to the server, or the connection was cut. Check SMTP_HOST and SMTP_PORT (587 with STARTTLS, or 465 with SMTP_SECURE=true), and that this machine may make outbound SMTP connections (many hosts block them).';
  }
  return 'The email server reported an error. Look the code up in your provider\'s documentation.';
}

/**
 * Sends one clearly-labelled test message and reports the outcome in words an operator can act on. "Ok" means the SMTP
 * server ACCEPTED the message; it does not prove delivery: the recipient still has to find it (inbox or spam).
 */
export async function sendTestEmail(mailer: Mailer, to: string, appUrl: string): Promise<TestEmailResult> {
  if (!mailer.configured) {
    return { ok: false, label: 'Email is not configured', hint: 'Set SMTP_HOST, SMTP_PORT and SMTP_FROM (and usually SMTP_USER and SMTP_PASS), then run this again. See docs/EMAIL.md.' };
  }
  try {
    await mailer.send({
      to,
      subject: 'SubCycle test email',
      text: `This is a test message from your SubCycle server (${appUrl}).\n\nIf you can read it, the SMTP settings work. Nothing in your account was changed.\n`,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, label: classifySendError(err).label, hint: hintFor(err) };
  }
}
