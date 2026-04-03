const SENDGRID_BASE = 'https://api.sendgrid.com/v3';

type QueryParamValue = string | number | boolean | undefined;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function coerceArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!isObject(value)) return [];

  const directResult = value['result'];
  if (Array.isArray(directResult)) return directResult as T[];

  const directResults = value['results'];
  if (Array.isArray(directResults)) return directResults as T[];

  return [];
}

export interface SendGridErrorDetail {
  message: string;
  field?: string | null;
  help?: unknown;
}

function toErrorDetail(value: unknown): SendGridErrorDetail | undefined {
  if (!isObject(value) || typeof value['message'] !== 'string')
    return undefined;

  const fieldValue = value['field'];
  const field =
    typeof fieldValue === 'string' || fieldValue === null
      ? fieldValue
      : undefined;

  return {
    message: value['message'],
    field,
    help: value['help'],
  };
}

function parseSendGridErrorDetails(rawBody: string): SendGridErrorDetail[] {
  const trimmed = rawBody.trim();
  if (trimmed.length === 0) return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isObject(parsed)) return [{ message: trimmed }];

    const errors = parsed['errors'];
    if (Array.isArray(errors)) {
      const mapped = errors
        .map(toErrorDetail)
        .filter((item): item is SendGridErrorDetail => item !== undefined);
      if (mapped.length > 0) return mapped;
    }

    const single = toErrorDetail(parsed);
    if (single) return [single];
  } catch {
    return [{ message: trimmed }];
  }

  return [{ message: trimmed }];
}

export class SendGridApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly errors: SendGridErrorDetail[];
  readonly rawBody: string;

  constructor(params: {
    status: number;
    method: string;
    path: string;
    errors: SendGridErrorDetail[];
    rawBody: string;
  }) {
    const lead = params.errors[0]?.message;
    super(
      lead
        ? `SendGrid ${params.method} ${params.path} -> ${params.status}: ${lead}`
        : `SendGrid ${params.method} ${params.path} -> ${params.status}`,
    );
    this.name = 'SendGridApiError';
    this.status = params.status;
    this.method = params.method;
    this.path = params.path;
    this.errors = params.errors;
    this.rawBody = params.rawBody;
  }
}

export function isSendGridApiError(error: unknown): error is SendGridApiError {
  return error instanceof SendGridApiError;
}

export interface TemplateVersion {
  id: string;
  template_id: string;
  active: 0 | 1;
  name: string;
  subject: string;
  html_content: string;
  plain_content: string;
  generate_plain_content: boolean;
  updated_at: string;
  thumbnail_url?: string;
  test_data?: string;
  editor?: 'code' | 'design';
}

export interface Template {
  id: string;
  name: string;
  generation: 'legacy' | 'dynamic';
  updated_at: string;
  versions: TemplateVersion[];
}

export interface TemplateListResponse {
  result: Template[];
  _metadata: { self: string; count: number; next?: string };
}

export interface UpdateTemplateParams {
  name?: string;
}

export interface SendGridEmailAddress {
  email: string;
  name?: string;
}

export interface SendGridMailContent {
  type: string;
  value: string;
}

export interface SendGridMailAttachment {
  content: string;
  filename: string;
  type?: string;
  disposition?: 'attachment' | 'inline';
  content_id?: string;
}

export interface SendGridMailPersonalization {
  to: SendGridEmailAddress[];
  cc?: SendGridEmailAddress[];
  bcc?: SendGridEmailAddress[];
  subject?: string;
  dynamic_template_data?: Record<string, unknown>;
  custom_args?: Record<string, string>;
  headers?: Record<string, string>;
  send_at?: number;
}

export interface SendGridMailSendPayload {
  personalizations: SendGridMailPersonalization[];
  from: SendGridEmailAddress;
  reply_to?: SendGridEmailAddress;
  subject?: string;
  content?: SendGridMailContent[];
  attachments?: SendGridMailAttachment[];
  template_id?: string;
  categories?: string[];
  custom_args?: Record<string, string>;
  headers?: Record<string, string>;
  send_at?: number;
  batch_id?: string;
  asm?: {
    group_id: number;
    groups_to_display?: number[];
  };
  ip_pool_name?: string;
  mail_settings?: Record<string, unknown>;
  tracking_settings?: Record<string, unknown>;
}

export interface SendEmailParams {
  to: string;
  templateId: string;
  dynamicTemplateData: Record<string, unknown>;
  fromEmail: string;
  fromName: string;
}

export type ScheduledSendStatus = 'pause' | 'cancel';

export interface ScheduledSendState {
  batch_id: string;
  status: ScheduledSendStatus;
}

export interface VerifiedSender {
  id: number;
  nickname?: string;
  from_email?: string;
  from_name?: string;
  reply_to?: string;
  verified?: boolean;
  locked?: boolean;
}

export interface AuthenticatedDomain {
  id: number;
  user_id?: number;
  subdomain: string;
  domain: string;
  username?: string;
  default?: boolean;
  valid?: boolean;
  legacy?: boolean;
  custom_spf?: boolean;
  automatic_security?: boolean;
  dns?: Record<string, unknown>;
}

export interface BrandedLink {
  id: number;
  domain: string;
  subdomain: string;
  default?: boolean;
  valid?: boolean;
  legacy?: boolean;
  dns?: Record<string, unknown>;
}

export interface SendGridMessageActivity {
  msg_id: string;
  from_email?: string;
  to_email?: string;
  subject?: string;
  status?: string;
  opens_count?: number;
  clicks_count?: number;
  last_event_time?: string;
  last_timestamp?: number;
  [key: string]: unknown;
}

export interface SendGridMessageActivityListResponse {
  messages: SendGridMessageActivity[];
}

export interface EventWebhookSettings {
  id: string;
  enabled?: boolean;
  url?: string;
  account_status_change?: boolean;
  group_resubscribe?: boolean;
  delivered?: boolean;
  group_unsubscribe?: boolean;
  spam_report?: boolean;
  bounce?: boolean;
  deferred?: boolean;
  unsubscribe?: boolean;
  processed?: boolean;
  open?: boolean;
  click?: boolean;
  dropped?: boolean;
  friendly_name?: string | null;
  oauth_client_id?: string | null;
  oauth_client_secret?: string | null;
  oauth_token_url?: string | null;
  public_key?: string;
  created_date?: string | null;
  updated_date?: string;
}

export interface EventWebhookSettingsListResponse {
  max_allowed: number;
  webhooks: EventWebhookSettings[];
}

export interface UpdateEventWebhookPayload {
  enabled?: boolean;
  url?: string;
  account_status_change?: boolean;
  group_resubscribe?: boolean;
  delivered?: boolean;
  group_unsubscribe?: boolean;
  spam_report?: boolean;
  bounce?: boolean;
  deferred?: boolean;
  unsubscribe?: boolean;
  processed?: boolean;
  open?: boolean;
  click?: boolean;
  dropped?: boolean;
  friendly_name?: string | null;
  oauth_client_id?: string | null;
  oauth_client_secret?: string | null;
  oauth_token_url?: string | null;
}

export interface SuppressionEntry {
  email: string;
  created: number;
  reason?: string;
  status?: string;
}

export type SuppressionListType =
  | 'bounces'
  | 'blocks'
  | 'unsubscribes'
  | 'spam_reports'
  | 'invalid_emails'
  | 'global_unsubscribes';

export interface GlobalStats {
  date: string;
  stats: Array<{
    metrics: {
      requests: number;
      delivered: number;
      bounces: number;
      clicks: number;
      opens: number;
      spam_reports: number;
      unsubscribes: number;
    };
  }>;
}

export class SendGridClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private buildUrl(
    path: string,
    params?: Record<string, QueryParamValue>,
  ): URL {
    const url = new URL(`${SENDGRID_BASE}${path}`);
    if (!params) return url;

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    return url;
  }

  private async requestRaw(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, QueryParamValue>,
  ): Promise<Response> {
    const url = this.buildUrl(path, params);
    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.ok) return res;

    const rawBody = await res.text();
    throw new SendGridApiError({
      status: res.status,
      method,
      path,
      errors: parseSendGridErrorDetails(rawBody),
      rawBody,
    });
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, QueryParamValue>,
  ): Promise<T> {
    const res = await this.requestRaw(method, path, body, params);

    if (res.status === 204) return {} as T;

    const rawBody = await res.text();
    if (rawBody.trim().length === 0) return {} as T;

    try {
      return JSON.parse(rawBody) as T;
    } catch {
      throw new SendGridApiError({
        status: res.status,
        method,
        path,
        errors: [
          { message: 'Expected JSON response but received plain text.' },
        ],
        rawBody,
      });
    }
  }

  // ─── Templates ──────────────────────────────────────────────────────────────

  listTemplates(pageSize = 50): Promise<TemplateListResponse> {
    return this.request<TemplateListResponse>('GET', '/templates', undefined, {
      generations: 'dynamic',
      page_size: pageSize,
    });
  }

  getTemplate(templateId: string): Promise<Template> {
    return this.request<Template>('GET', `/templates/${templateId}`);
  }

  updateTemplate(
    templateId: string,
    params: UpdateTemplateParams,
  ): Promise<Template> {
    const body: Record<string, unknown> = {};
    if (params.name !== undefined) body['name'] = params.name;
    return this.request<Template>('PATCH', `/templates/${templateId}`, body);
  }

  getTemplateVersion(
    templateId: string,
    versionId: string,
  ): Promise<TemplateVersion> {
    return this.request<TemplateVersion>(
      'GET',
      `/templates/${templateId}/versions/${versionId}`,
    );
  }

  createTemplate(name: string): Promise<Template> {
    return this.request<Template>('POST', '/templates', {
      name,
      generation: 'dynamic',
    });
  }

  createTemplateVersion(
    templateId: string,
    params: {
      name: string;
      subject: string;
      htmlContent: string;
      active?: 0 | 1;
    },
  ): Promise<TemplateVersion> {
    return this.request<TemplateVersion>(
      'POST',
      `/templates/${templateId}/versions`,
      {
        name: params.name,
        subject: params.subject,
        html_content: params.htmlContent,
        generate_plain_content: true,
        active: params.active ?? 1,
        editor: 'code',
      },
    );
  }

  updateTemplateVersion(
    templateId: string,
    versionId: string,
    params: Partial<{
      name: string;
      subject: string;
      htmlContent: string;
      active: 0 | 1;
      testData: string;
    }>,
  ): Promise<TemplateVersion> {
    const body: Record<string, unknown> = {};
    if (params.name !== undefined) body['name'] = params.name;
    if (params.subject !== undefined) body['subject'] = params.subject;
    if (params.htmlContent !== undefined)
      body['html_content'] = params.htmlContent;
    if (params.active !== undefined) body['active'] = params.active;
    if (params.testData !== undefined) body['test_data'] = params.testData;

    return this.request<TemplateVersion>(
      'PATCH',
      `/templates/${templateId}/versions/${versionId}`,
      body,
    );
  }

  activateTemplateVersion(
    templateId: string,
    versionId: string,
  ): Promise<TemplateVersion> {
    return this.request<TemplateVersion>(
      'POST',
      `/templates/${templateId}/versions/${versionId}/activate`,
    );
  }

  deleteTemplate(templateId: string): Promise<void> {
    return this.request<void>('DELETE', `/templates/${templateId}`);
  }

  // ─── Sending & Scheduling ───────────────────────────────────────────────────

  async sendMail(
    payload: SendGridMailSendPayload,
  ): Promise<{ messageId: string; statusCode: number }> {
    const res = await this.requestRaw('POST', '/mail/send', payload);
    return {
      statusCode: res.status,
      messageId: res.headers.get('x-message-id') ?? '',
    };
  }

  async sendEmail(params: SendEmailParams): Promise<{ messageId: string }> {
    const result = await this.sendMail({
      personalizations: [
        {
          to: [{ email: params.to }],
          dynamic_template_data: params.dynamicTemplateData,
        },
      ],
      from: { email: params.fromEmail, name: params.fromName },
      template_id: params.templateId,
    });
    return { messageId: result.messageId };
  }

  createBatchId(): Promise<{ batch_id: string }> {
    return this.request<{ batch_id: string }>('POST', '/mail/batch');
  }

  upsertScheduledSend(
    batchId: string,
    status: ScheduledSendStatus,
  ): Promise<ScheduledSendState> {
    return this.request<ScheduledSendState>('POST', '/user/scheduled_sends', {
      batch_id: batchId,
      status,
    });
  }

  getScheduledSend(batchId: string): Promise<ScheduledSendState> {
    return this.request<ScheduledSendState>(
      'GET',
      `/user/scheduled_sends/${encodeURIComponent(batchId)}`,
    );
  }

  async resumeScheduledSend(batchId: string): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/user/scheduled_sends/${encodeURIComponent(batchId)}`,
    );
  }

  // ─── Sender / Account Auth Surfaces ─────────────────────────────────────────

  async listVerifiedSenders(params?: {
    limit?: number;
    lastSeenID?: number;
    id?: number;
  }): Promise<VerifiedSender[]> {
    const payload = await this.request<unknown>(
      'GET',
      '/verified_senders',
      undefined,
      {
        limit: params?.limit,
        lastSeenID: params?.lastSeenID,
        id: params?.id,
      },
    );
    return coerceArray<VerifiedSender>(payload);
  }

  async listAuthenticatedDomains(): Promise<AuthenticatedDomain[]> {
    const payload = await this.request<unknown>('GET', '/whitelabel/domains');
    return coerceArray<AuthenticatedDomain>(payload);
  }

  async listBrandedLinks(): Promise<BrandedLink[]> {
    const payload = await this.request<unknown>('GET', '/whitelabel/links');
    return coerceArray<BrandedLink>(payload);
  }

  // ─── Email Activity & Event Webhooks ────────────────────────────────────────

  filterMessages(
    query: string,
    limit = 25,
  ): Promise<SendGridMessageActivityListResponse> {
    return this.request<SendGridMessageActivityListResponse>(
      'GET',
      '/messages',
      undefined,
      {
        query,
        limit,
      },
    );
  }

  getMessageById(msgId: string): Promise<SendGridMessageActivity> {
    return this.request<SendGridMessageActivity>(
      'GET',
      `/messages/${encodeURIComponent(msgId)}`,
    );
  }

  getAllEventWebhooks(
    includeAccountStatusChange = false,
  ): Promise<EventWebhookSettingsListResponse> {
    return this.request<EventWebhookSettingsListResponse>(
      'GET',
      '/user/webhooks/event/settings/all',
      undefined,
      {
        include: includeAccountStatusChange
          ? 'account_status_change'
          : undefined,
      },
    );
  }

  getEventWebhook(
    id: string,
    includeAccountStatusChange = false,
  ): Promise<EventWebhookSettings> {
    return this.request<EventWebhookSettings>(
      'GET',
      `/user/webhooks/event/settings/${encodeURIComponent(id)}`,
      undefined,
      {
        include: includeAccountStatusChange
          ? 'account_status_change'
          : undefined,
      },
    );
  }

  updateEventWebhook(
    id: string,
    payload: UpdateEventWebhookPayload,
    includeAccountStatusChange = false,
  ): Promise<EventWebhookSettings> {
    return this.request<EventWebhookSettings>(
      'PATCH',
      `/user/webhooks/event/settings/${encodeURIComponent(id)}`,
      payload,
      {
        include: includeAccountStatusChange
          ? 'account_status_change'
          : undefined,
      },
    );
  }

  toggleEventWebhookSignatureVerification(
    id: string,
    enabled: boolean,
  ): Promise<{ id: string; public_key: string }> {
    return this.request<{ id: string; public_key: string }>(
      'PATCH',
      `/user/webhooks/event/settings/signed/${encodeURIComponent(id)}`,
      { enabled },
    );
  }

  getPartnerAccountState(accountId: string): Promise<{ state: string }> {
    return this.request<{ state: string }>(
      'GET',
      `/partners/accounts/${encodeURIComponent(accountId)}/state`,
    );
  }

  // ─── Suppressions & Delivery Diagnostics ────────────────────────────────────

  private suppressionPath(type: SuppressionListType): string {
    if (type === 'global_unsubscribes') return '/asm/suppressions/global';
    return `/suppression/${type}`;
  }

  listSuppressions(
    type: SuppressionListType,
    params?: {
      limit?: number;
      offset?: number;
      startTime?: number;
      endTime?: number;
      email?: string;
    },
  ): Promise<SuppressionEntry[]> {
    return this.request<SuppressionEntry[]>(
      'GET',
      this.suppressionPath(type),
      undefined,
      {
        limit: params?.limit,
        offset: params?.offset,
        start_time: params?.startTime,
        end_time: params?.endTime,
        email: params?.email,
      },
    );
  }

  async checkSuppression(email: string): Promise<{
    bounced: boolean;
    blocked: boolean;
    unsubscribed: boolean;
    spamReported: boolean;
    details: Record<string, unknown>;
  }> {
    const encoded = encodeURIComponent(email);
    const [bounces, blocks, unsubscribes, spam] = await Promise.allSettled([
      this.request<SuppressionEntry[]>(
        'GET',
        `/suppression/bounces/${encoded}`,
      ),
      this.request<SuppressionEntry[]>('GET', `/suppression/blocks/${encoded}`),
      this.request<SuppressionEntry[]>(
        'GET',
        `/suppression/unsubscribes/${encoded}`,
      ),
      this.request<SuppressionEntry[]>(
        'GET',
        `/suppression/spam_reports/${encoded}`,
      ),
    ]);

    const get = (result: PromiseSettledResult<SuppressionEntry[]>) =>
      result.status === 'fulfilled' ? result.value : [];

    return {
      bounced: get(bounces).length > 0,
      blocked: get(blocks).length > 0,
      unsubscribed: get(unsubscribes).length > 0,
      spamReported: get(spam).length > 0,
      details: {
        bounces: get(bounces),
        blocks: get(blocks),
        unsubscribes: get(unsubscribes),
        spamReports: get(spam),
      },
    };
  }

  getStats(startDate: string, endDate?: string): Promise<GlobalStats[]> {
    return this.request<GlobalStats[]>('GET', '/stats', undefined, {
      start_date: startDate,
      aggregated_by: 'day',
      end_date: endDate,
    });
  }
}
