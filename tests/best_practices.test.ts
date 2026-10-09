import { describe, expect, test } from 'bun:test';
import { classifySendGridError } from '../src/tools/classify_error';
import {
  formatToolError,
  isReadOnlyBlocked,
  isReadOnlyMode,
} from '../src/tools/tool_utils';
import { SendGridApiError } from '../src/client';
import {
  activityQueryForXMessageId,
  compileActivitySearch,
  rejectActivityOffset,
} from '../src/tools/delivery_trace';
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

  test('blocks a recipient unsubscribed from the send ASM group', async () => {
    const client = {
      listAuthenticatedDomains: async () => [
        { id: 1, domain: 'example.com', valid: true },
      ],
      listVerifiedSenders: async () => [],
      listBrandedLinks: async () => [
        { id: 1, domain: 'example.com', subdomain: 'links', default: true },
      ],
      checkSuppression: async () => ({
        bounced: false,
        blocked: false,
        unsubscribed: false,
        spamReported: false,
        invalidEmail: false,
        groupUnsubscribed: true,
        groupSuppressions: [
          { id: 12, name: 'News', suppressed: true },
        ],
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
        asm: { groupId: 12 },
      },
      { checkSenderIdentity: true },
    );

    expect(
      report.blockers.some((issue) => issue.code === 'RECIPIENT_GROUP_UNSUBSCRIBE'),
    ).toBe(true);
  });
});

describe('activity query', () => {
  test('compiles an x-message-id into a LIKE query', () => {
    expect(activityQueryForXMessageId('Ua9z9lSTSaqYBWJe_Xfc-Q')).toBe(
      "msg_id LIKE 'Ua9z9lSTSaqYBWJe_Xfc-Q%'",
    );
    expect(
      compileActivitySearch({
        query: 'to_email="user@example.com"',
        xMessageId: 'abc',
      }),
    ).toBe('(to_email="user@example.com") AND msg_id LIKE \'abc%\'');
  });

  test('rejects Email Activity offset', () => {
    expect(() => rejectActivityOffset(0)).not.toThrow();
    expect(() => rejectActivityOffset(undefined)).not.toThrow();
    expect(() => rejectActivityOffset(25)).toThrow(/no offset/);
  });
});

describe('READ_ONLY', () => {
  test('blocks send tools and allows list tools', () => {
    const previous = Bun.env['READ_ONLY'];
    Bun.env['READ_ONLY'] = 'true';
    try {
      expect(isReadOnlyMode()).toBe(true);
      expect(isReadOnlyBlocked('sendgrid_send_email_advanced')).toBe(true);
      expect(isReadOnlyBlocked('sendgrid_delete_suppression')).toBe(true);
      expect(isReadOnlyBlocked('sendgrid_list_templates')).toBe(false);
      expect(isReadOnlyBlocked('sendgrid_validate_send_request')).toBe(false);
    } finally {
      if (previous === undefined) delete Bun.env['READ_ONLY'];
      else Bun.env['READ_ONLY'] = previous;
    }
  });
});
