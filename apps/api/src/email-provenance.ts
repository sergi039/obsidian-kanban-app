/**
 * Email provenance for captured cards (issue #2, EMAIL-1).
 *
 * An agent that captures a task from an email passes the provider's own ids
 * (Gmail API message/thread id, Microsoft Graph message/conversation id).
 * The server derives everything else, so every capture of the same email
 * converges on the same values:
 *
 * - `source_uid`: one per thread (per message when no thread id is known),
 *   scoped to the mailbox. It keys `inbox_captures`, so capturing the same
 *   thread again returns the card that already exists.
 * - `source_url`: a link that opens the email, in the formats invoice-zero
 *   uses (`src/lib/email/gmail.ts` and `microsoft.ts`, `buildEmailLink`).
 * - `source_meta.email`: a fixed set of header-level fields. No body, no
 *   tokens: anything else stays out of the card.
 */
import { z } from 'zod';

export const EMAIL_PROVIDERS = ['gmail', 'outlook'] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

/** Gmail API ids are hex strings; Graph ids are base64 (may carry + / =). */
const GMAIL_ID_RE = /^[A-Za-z0-9_-]+$/;
const OUTLOOK_ID_RE = /^[A-Za-z0-9+/=_-]+$/;
const MAX_ID_LENGTH = 512;
/** RFC 5322 caps a header line at 998 characters. */
const MAX_INTERNET_MESSAGE_ID_LENGTH = 998;
const INTERNET_MESSAGE_ID_RE = /^<?[^\s<>]+>?$/;
const MAX_SUBJECT_LENGTH = 500;
const MAX_FROM_LENGTH = 320;
/** Consumer Microsoft mailboxes open on outlook.live.com; work/school ones on outlook.office.com. */
const CONSUMER_OUTLOOK_DOMAIN_RE = /^(outlook|hotmail|live|msn)\.[a-z.]+$/;

const providerId = z.string().min(1).max(MAX_ID_LENGTH);

export const EmailRefSchema = z
  .object({
    provider: z.enum(EMAIL_PROVIDERS),
    /** Address of the mailbox the email sits in (selects the account in the link). */
    account: z.string().email().max(254),
    /** Provider message id: Gmail API `id`, Graph message `id`. */
    message_id: providerId,
    /** Provider thread id: Gmail `threadId`, Graph `conversationId`. */
    thread_id: providerId.optional(),
    /** RFC 5322 Message-ID header. */
    internet_message_id: z.string().max(MAX_INTERNET_MESSAGE_ID_LENGTH).regex(INTERNET_MESSAGE_ID_RE).optional(),
    subject: z.string().max(MAX_SUBJECT_LENGTH).optional(),
    from: z.string().max(MAX_FROM_LENGTH).optional(),
    received_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((ref, ctx) => {
    const idRe = ref.provider === 'gmail' ? GMAIL_ID_RE : OUTLOOK_ID_RE;
    for (const key of ['message_id', 'thread_id'] as const) {
      const value = ref[key];
      if (value !== undefined && !idRe.test(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `Not a ${ref.provider} id` });
      }
    }
    for (const key of ['subject', 'from'] as const) {
      if (ref[key] !== undefined && /[\x00-\x1f\x7f]/.test(ref[key]!)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Must be a single line' });
      }
    }
  });

export type EmailRef = z.infer<typeof EmailRefSchema>;

/** Whether `id` has the shape of this provider's message/thread id; `.` and `..` never do. */
export function isProviderId(provider: EmailProvider, id: string): boolean {
  return id.length <= MAX_ID_LENGTH && (provider === 'gmail' ? GMAIL_ID_RE : OUTLOOK_ID_RE).test(id);
}

function mailbox(ref: EmailRef): string {
  return ref.account.toLowerCase();
}

/** Stable capture identity: the thread when known, else the message, inside one mailbox. */
export function emailSourceUid(ref: EmailRef): string {
  const scope = ref.thread_id ? `thread:${ref.thread_id}` : `message:${ref.message_id}`;
  return `${ref.provider}:${mailbox(ref)}:${scope}`;
}

/** Link that opens the email, in invoice-zero's `buildEmailLink` formats. */
export function emailSourceUrl(ref: EmailRef): string {
  if (ref.provider === 'gmail') {
    return `https://mail.google.com/mail/u/${mailbox(ref)}/#all/${ref.message_id}`;
  }
  const domain = mailbox(ref).split('@')[1] ?? '';
  if (CONSUMER_OUTLOOK_DOMAIN_RE.test(domain)) {
    return `https://outlook.live.com/mail/0/inbox/id/${encodeURIComponent(ref.thread_id || ref.message_id)}`;
  }
  return `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(ref.message_id)}`;
}

/** Header-level fields kept on the card; the validated schema admits nothing else. */
export function emailSourceMeta(ref: EmailRef): Record<string, string> {
  const meta: Record<string, string> = {
    provider: ref.provider,
    account: mailbox(ref),
    message_id: ref.message_id,
  };
  for (const key of ['thread_id', 'internet_message_id', 'subject', 'from', 'received_at'] as const) {
    const value = ref[key];
    if (value !== undefined) meta[key] = value.trim();
  }
  return meta;
}
