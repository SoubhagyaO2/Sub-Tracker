import { emailSchema } from '@subcycle/shared';
import { loadConfig } from '../config.js';
import { createMailer } from '../mail/mailer.js';
import { sendTestEmail } from '../mail/testEmail.js';

/**
 * Operator tool: sends ONE test message through the configured SMTP provider and says whether the server accepted it.
 * Uses the same SMTP_* settings as the API, so it proves exactly what the API will do. Sends nothing else, touches no
 * database and prints no credentials.
 *   npm run admin:test-email -- you@example.com
 */
const parsed = emailSchema.safeParse(process.argv[2] ?? '');
if (!parsed.success) {
  console.error('Usage: npm run admin:test-email -- <an address you can read>');
  process.exit(2);
}
const to = parsed.data;

const config = loadConfig();
const mailer = createMailer(config.smtp);
if (config.smtp) console.log(`Sending a test message to ${to} through ${config.smtp.host}:${config.smtp.port} (${config.smtp.secure ? 'TLS from the start' : 'STARTTLS required'}) ...`);

const result = await sendTestEmail(mailer, to, config.appUrl);
if (result.ok) {
  console.log('The SMTP server accepted the message. That is not the same as delivered: now check the inbox (and the spam folder) of that address.');
} else {
  console.error(`Failed: ${result.label}`);
  console.error(result.hint);
  process.exitCode = 1;
}
