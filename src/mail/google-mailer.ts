/**
 * Shared Google mail helper — replaces the `gog gmail send`/`gog gmail
 * messages search` CLI calls (which depend on an OAuth token that expires
 * ~weekly). Uses a Gmail **App Password** over SMTP (send) and IMAP (read),
 * so there is no OAuth token to expire.
 *
 * Credentials (no OAuth):
 *   - Account:  $GMAIL_ACCOUNT  (default govna.assistant@gmail.com)
 *   - Password: $GMAIL_APP_PASSWORD, else the file at
 *               $GMAIL_APP_PASSWORD_FILE (default
 *               ~/.openclaw/secrets/gmail_app_password). Whitespace is
 *               stripped, so a value saved with Google's display spaces
 *               ("abcd efgh ijkl mnop") works as-is.
 *
 * Requires 2-Step Verification on the account + IMAP enabled in Gmail
 * settings (for the read side).
 */
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_ACCOUNT = 'govna.assistant@gmail.com';

export function gmailAccount(): string {
  return process.env.GMAIL_ACCOUNT || DEFAULT_ACCOUNT;
}

function appPassword(): string {
  const raw = process.env.GMAIL_APP_PASSWORD
    ?? readFileSync(
      process.env.GMAIL_APP_PASSWORD_FILE || path.join(homedir(), '.openclaw', 'secrets', 'gmail_app_password'),
      'utf8',
    );
  const pw = String(raw).replace(/\s+/g, ''); // Google shows it with spaces; the real value has none
  if (!pw) throw new Error('Gmail app password is empty (set GMAIL_APP_PASSWORD or the secrets file)');
  return pw;
}

// ───────────────────────── SMTP (send) ─────────────────────────

export type MailAttachment = {
  filename: string;
  path?: string;
  content?: Buffer | string;
  contentType?: string;
};

export type SendMailArgs = {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  /** Defaults to the authenticated account. Gmail only honors the account
   *  itself or a verified "Send mail as" alias. */
  from?: string;
  replyTo?: string;
  cc?: string | string[];
  bcc?: string | string[];
  attachments?: MailAttachment[];
};

let cachedTransport: Transporter | null = null;
function transport(): Transporter {
  if (cachedTransport) return cachedTransport;
  cachedTransport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: gmailAccount(), pass: appPassword() },
  });
  return cachedTransport;
}

/** Send an email via Gmail SMTP. Throws on failure. */
export async function sendGmail(args: SendMailArgs): Promise<{ messageId: string }> {
  const info = await transport().sendMail({
    from: args.from || gmailAccount(),
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    replyTo: args.replyTo,
    subject: args.subject,
    text: args.text,
    html: args.html,
    attachments: args.attachments,
  });
  return { messageId: String(info.messageId || '') };
}

/** Verify SMTP auth without sending (handshake + login). */
export async function verifySmtp(): Promise<boolean> {
  await transport().verify();
  return true;
}

// ───────────────────────── IMAP (read) ─────────────────────────

/**
 * Open an IMAP session, run `fn` with the connected client (mailbox locked),
 * then cleanly log out. Use for search+fetch in a single connection.
 */
export async function withImap<T>(
  fn: (client: ImapFlow) => Promise<T>,
  opts: { mailbox?: string } = {},
): Promise<T> {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: gmailAccount(), pass: appPassword() },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock(opts.mailbox || 'INBOX');
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/**
 * Search the mailbox with a Gmail search expression (same syntax as the
 * Gmail UI / the old `gog gmail messages search`), via IMAP's X-GM-RAW
 * extension. Returns matching UIDs, most-recent last; pass `max` to cap.
 */
export async function gmailRawSearch(
  query: string,
  opts: { max?: number; mailbox?: string } = {},
): Promise<number[]> {
  return withImap(async (client) => {
    // `gmailRaw` is a Gmail-specific IMAP search key (X-GM-RAW). It works at
    // runtime but isn't in imapflow's published SearchObject type, hence the cast.
    const uids = (await client.search({ gmailRaw: query } as Record<string, unknown>, { uid: true })) || [];
    return opts.max ? uids.slice(-opts.max) : uids;
  }, { mailbox: opts.mailbox });
}
