import { describe, it, expect } from 'vitest';
import {
  EmailRefSchema,
  emailSourceMeta,
  emailSourceUid,
  emailSourceUrl,
  type EmailRef,
} from '../src/email-provenance.js';

const gmail: EmailRef = {
  provider: 'gmail',
  account: 'Owner@Example.com',
  message_id: 'msg-1',
  thread_id: 'thread-1',
};

describe('emailSourceUid', () => {
  it('names the thread inside the mailbox, lower-casing the address', () => {
    expect(emailSourceUid(gmail)).toBe('gmail:owner@example.com:thread:thread-1');
  });

  it('falls back to the message when no thread id is known', () => {
    expect(emailSourceUid({ ...gmail, thread_id: undefined })).toBe('gmail:owner@example.com:message:msg-1');
  });
});

describe('emailSourceUrl (invoice-zero buildEmailLink formats)', () => {
  it('opens a Gmail message in the right account', () => {
    expect(emailSourceUrl(gmail)).toBe('https://mail.google.com/mail/u/owner@example.com/#all/msg-1');
  });

  it('opens a work/school Outlook message with the outlook.office.com deeplink', () => {
    const ref: EmailRef = { provider: 'outlook', account: 'owner@example.com', message_id: 'msg-1', thread_id: 'conversation-1' };
    expect(emailSourceUrl(ref)).toBe('https://outlook.office.com/mail/deeplink/read/msg-1');
  });

  it('opens a consumer Outlook mailbox on outlook.live.com by thread', () => {
    const ref: EmailRef = { provider: 'outlook', account: 'owner@outlook.com', message_id: 'msg-1', thread_id: 'conversation-1' };
    expect(emailSourceUrl(ref)).toBe('https://outlook.live.com/mail/0/inbox/id/conversation-1');
  });

  it('encodes Graph ids that carry base64 characters', () => {
    const ref: EmailRef = { provider: 'outlook', account: 'owner@example.com', message_id: 'AAMk+a/b==' };
    expect(emailSourceUrl(ref)).toBe('https://outlook.office.com/mail/deeplink/read/AAMk%2Ba%2Fb%3D%3D');
  });
});

describe('emailSourceMeta', () => {
  it('keeps header-level fields only, trimmed', () => {
    const meta = emailSourceMeta({
      ...gmail,
      internet_message_id: '<abc@mail.example.com>',
      subject: '  Invoice for March ',
      from: 'Supplier <billing@example.net>',
      received_at: '2026-10-14T08:30:00Z',
    });
    expect(meta).toEqual({
      provider: 'gmail',
      account: 'owner@example.com',
      message_id: 'msg-1',
      thread_id: 'thread-1',
      internet_message_id: '<abc@mail.example.com>',
      subject: 'Invoice for March',
      from: 'Supplier <billing@example.net>',
      received_at: '2026-10-14T08:30:00Z',
    });
  });
});

describe('EmailRefSchema', () => {
  const valid = { provider: 'gmail', account: 'owner@example.com', message_id: 'msg-1' };

  it('accepts the minimal reference', () => {
    expect(EmailRefSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['an email body', { ...valid, body: 'Dear owner, ...' }],
    ['an access token', { ...valid, access_token: 'ya29.x' }],
    ['a Gmail id with a slash', { ...valid, message_id: 'a/b' }],
    ['a multi-line subject', { ...valid, subject: 'Hi\nBcc: someone@example.com' }],
    ['a mailbox that is not an address', { ...valid, account: 'owner' }],
    ['a received_at that is not ISO 8601', { ...valid, received_at: 'yesterday' }],
    ['an unknown provider', { ...valid, provider: 'yahoo' }],
  ])('rejects %s', (_label, ref) => {
    expect(EmailRefSchema.safeParse(ref).success).toBe(false);
  });
});
