import { describe, expect, it } from 'vitest';
import { DisabledMailer } from '../src/mail/mailer.js';
import { sendTestEmail } from '../src/mail/testEmail.js';
import { FakeMailer, networkError, smtpError } from './helpers.js';

const TO = 'operator@example.com';
const APP = 'https://subcycle.example.org';

describe('sendTestEmail (the operator "send a test email" command)', () => {
  it('sends exactly one clearly labelled message and reports success', async () => {
    const mailer = new FakeMailer();
    expect(await sendTestEmail(mailer, TO, APP)).toEqual({ ok: true });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe(TO);
    expect(mailer.sent[0]!.subject).toBe('SubCycle test email');
    expect(mailer.sent[0]!.text).toContain(APP);
    expect(mailer.sent[0]!.text).not.toMatch(/token|password|http[^s]/i); // no link to click, nothing sensitive
  });

  it('without SMTP settings it says how to configure them and sends nothing', async () => {
    const result = await sendTestEmail(new DisabledMailer(), TO, APP);
    expect(result).toMatchObject({ ok: false, label: 'Email is not configured' });
    expect((result as { hint: string }).hint).toContain('SMTP_HOST');
  });

  it.each([
    ['a rejected login (535)', smtpError(535), 'SMTP 535', /username or password/],
    ['a refused sender or recipient (550)', smtpError(550), 'SMTP 550', /sender or the recipient/],
    ['a temporary failure (451)', smtpError(451), 'SMTP 451', /try again later/],
    ['a server without STARTTLS', Object.assign(new Error('x'), { code: 'ETLS' }), 'SMTP ETLS', /STARTTLS/],
    ['a timeout', networkError('ETIMEDOUT'), 'SMTP ETIMEDOUT', /timed out/],
    ['an unreachable host', networkError('ECONNREFUSED'), 'SMTP ECONNREFUSED', /Could not connect to the server/],
    ['a socket error', networkError('ESOCKET'), 'SMTP ESOCKET', /Could not connect to the server/],
    ['an unknown failure', new Error('something odd'), 'SMTP error', /reported an error/],
  ])('%s gives a short label and a plain next step', async (_name, error, label, hint) => {
    const mailer = new FakeMailer();
    mailer.errors = [error];
    const result = await sendTestEmail(mailer, TO, APP);
    expect(result).toMatchObject({ ok: false, label });
    expect((result as { hint: string }).hint).toMatch(hint);
  });

  it('never repeats the provider\'s own text, the recipient address or credentials', async () => {
    const mailer = new FakeMailer();
    mailer.errors = [smtpError(535)]; // its message contains "secret-provider-text user@example.com"
    const result = await sendTestEmail(mailer, TO, APP);
    const text = JSON.stringify(result);
    expect(text).not.toContain('secret-provider-text');
    expect(text).not.toContain('user@example.com');
    expect(text).not.toContain(TO);
  });
});
