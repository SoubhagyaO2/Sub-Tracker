import nodemailer, { type Transporter } from 'nodemailer';
import type { SmtpConfig } from '../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /** false => no provider is configured; callers must report email as unavailable, never as sent. */
  readonly configured: boolean;
  /** Resolves only after the SMTP server accepted the message; rejects otherwise. */
  send(message: MailMessage): Promise<void>;
}

export class DisabledMailer implements Mailer {
  readonly configured = false;
  async send(): Promise<void> {
    throw new Error('Email is not configured');
  }
}

export class SmtpMailer implements Mailer {
  readonly configured = true;
  private readonly transport: Transporter;
  constructor(private readonly smtp: SmtpConfig) {
    this.transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass ?? '' } : undefined,
      // Bounded well below the scheduler's claim lease, so a hung server can't outlive the lease and cause a double send.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
  }
  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.smtp.from, ...message });
  }
}

export function createMailer(smtp: SmtpConfig | null): Mailer {
  return smtp ? new SmtpMailer(smtp) : new DisabledMailer();
}
