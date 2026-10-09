import { describe, expect, test } from 'bun:test';
import { classifySendGridError } from '../src/tools/classify_error';
import {
  formatToolError,
  isReadOnlyBlocked,
  isReadOnlyMode,
} from '../src/tools/tool_utils';
import { SendGridApiError } from '../src/client';
import { loadConfig } from '../src/config';
import { redactSensitiveFields, redactSecretsInText } from '../src/redact';
import {
  currentToolAbortSignal,
  resolveOnBehalfOfHeader,
  runWithToolAbortSignal,
} from '../src/tool_signal';
import {
  activityQueryCanFallbackToLogs,
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

  test('warns when SendGrid lists the from domain as a DMARC hard fail', async () => {
    const client = {
      listDomainWarnList: async () => ({
        hardFailures: ['gmail.com'],
        softFailures: [],
      }),
    } as unknown as SendGridClient;

    const report = await runSendPreflight(
      client,
      {
        personalizations: [{ to: [{ email: 'user@example.com' }] }],
        from: { email: 'me@gmail.com' },
        subject: 'Hello',
        content: [{ type: 'text/plain', value: 'Hi' }],
      },
      { checkSenderIdentity: false },
    );

    expect(report.warnings.some((issue) => issue.code === 'DMARC_HARD_FAIL')).toBe(
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

  test('does not forward Activity-only queries to Email Logs', () => {
    expect(activityQueryCanFallbackToLogs("to_email='a@b.co'")).toBe(true);
    expect(activityQueryCanFallbackToLogs("msg_id LIKE 'abc%'")).toBe(false);
    expect(
      activityQueryCanFallbackToLogs('from_email="a@b.co" AND to_email="c@d.co"'),
    ).toBe(false);
  });

  test('rejects Email Activity offset', () => {
    expect(() => rejectActivityOffset(0)).not.toThrow();
    expect(() => rejectActivityOffset(undefined)).not.toThrow();
    expect(() => rejectActivityOffset(25)).toThrow(/does not document offset/);
  });
});

describe('config', () => {
  test('treats SENDGRID_REGION=EU as the EU host', () => {
    const config = loadConfig({
      SENDGRID_API_KEY: 'SG.test',
      SENDGRID_FROM_EMAIL: 'ops@example.com',
      SENDGRID_REGION: 'EU',
    });
    expect(config.region).toBe('eu');
    expect(config.apiBaseUrl).toBe('https://api.eu.sendgrid.com/v3');
    expect(config.preferEmailLogs).toBe(true);
  });

  test('rejects a from address that is not an email', () => {
    expect(() =>
      loadConfig({
        SENDGRID_API_KEY: 'SG.test',
        SENDGRID_FROM_EMAIL: 'not-an-email',
      }),
    ).toThrow(/fromEmail|email/i);
  });
});

describe('redact', () => {
  test('hides oauth client secrets in objects and JSON text', () => {
    expect(
      redactSensitiveFields({ oauth_client_secret: 'supersecret', url: 'https://example.com' }),
    ).toEqual({
      oauth_client_secret: '<redacted len=11>',
      url: 'https://example.com',
    });
    const text = redactSecretsInText(
      JSON.stringify({ oauth_client_secret: 'supersecret' }),
    );
    expect(text).toContain('<redacted len=11>');
    expect(text).not.toContain('supersecret');
  });
});

describe('tool abort signal', () => {
  test('is visible to SendGrid fetches started inside the tool call', async () => {
    const signal = AbortSignal.abort();
    await runWithToolAbortSignal(signal, async () => {
      expect(currentToolAbortSignal()?.aborted).toBe(true);
    });
  });
});

describe('on-behalf-of', () => {
  test('parent clears the configured subuser header', () => {
    expect(resolveOnBehalfOfHeader('parent', 'news')).toBeUndefined();
    expect(resolveOnBehalfOfHeader('billing', 'news')).toBe('billing');
    expect(resolveOnBehalfOfHeader(undefined, 'news')).toBe('news');
  });
});

describe('http config', () => {
  test('rejects public HTTP without a bearer token', () => {
    expect(() =>
      loadConfig({
        SENDGRID_API_KEY: 'SG.test',
        SENDGRID_FROM_EMAIL: 'ops@example.com',
        MCP_TRANSPORT: 'http',
        MCP_HTTP_HOST: '0.0.0.0',
      }),
    ).toThrow(/MCP_AUTH_TOKEN/);
  });

  test('allows loopback HTTP with MCP_AUTH_MODE=none', () => {
    const config = loadConfig({
      SENDGRID_API_KEY: 'SG.test',
      SENDGRID_FROM_EMAIL: 'ops@example.com',
      MCP_TRANSPORT: 'http',
      MCP_AUTH_MODE: 'none',
    });
    expect(config.transport).toBe('http');
    expect(config.http?.authMode).toBe('none');
    expect(config.http?.host).toBe('127.0.0.1');
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
