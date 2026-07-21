import { describe, expect, test } from 'bun:test';
import { classifySendGridError } from '../src/tools/classify_error';
import { formatToolError } from '../src/tools/tool_utils';
import { SendGridApiError } from '../src/client';
import { runSendPreflight } from '../src/tools/preflight';
import type { SendGridClient } from '../src/client';

describe('formatToolError', () => {
  test('adds 401 hint for unauthorized SendGrid errors', () => {
    const error = new SendGridApiError({
      status: 401,
      method: 'GET',
      path: '/user/profile',
      errors: [{ message: 'authorization required' }],
      rawBody: '{"errors":[{"message":"authorization required"}]}',
    });

    const text = formatToolError(error);
    expect(text).toContain('401');
    expect(text).toContain('SENDGRID_API_KEY');
  });
});

describe('classifySendGridError', () => {
  test('classifies sender identity errors', () => {
    const result = classifySendGridError(
      400,
      'from address does not match a verified sender identity',
    );
    expect(result.category).toBe('sender_identity');
  });

  test('requires at least one input field at tool schema level', () => {
    const result = classifySendGridError(undefined, '');
    expect(result.category).toBe('unknown');
  });
});

describe('runSendPreflight', () => {
  test('blocks too many categories', async () => {
    const client = {
      listAuthenticatedDomains: async () => [],
      listVerifiedSenders: async () => [],
      listBrandedLinks: async () => [],
      checkSuppression: async () => ({
        bounced: false,
        blocked: false,
        unsubscribed: false,
        spamReported: false,
        invalidEmail: false,
        details: {},
      }),
    } as unknown as SendGridClient;

    const report = await runSendPreflight(
      client,
      {
        personalizations: [{ to: [{ email: 'user@example.com' }] }],
        from: { email: 'sender@example.com' },
        subject: 'Hello',
        content: [{ type: 'text/plain', value: 'Hi' }],
        categories: Array.from({ length: 11 }, (_, index) => `cat-${index}`),
      },
      { checkSenderIdentity: false },
    );

    expect(report.ok).toBe(false);
    expect(report.blockers.some((issue) => issue.code === 'TOO_MANY_CATEGORIES')).toBe(
      true,
    );
  });
});
