const SENDGRID_BASE = 'https://api.sendgrid.com/v3';

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

export interface SendEmailParams {
  to: string;
  templateId: string;
  dynamicTemplateData: Record<string, unknown>;
  fromEmail: string;
  fromName: string;
}

export interface SuppressionEntry {
  email: string;
  created: number;
  reason?: string;
}

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

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${SENDGRID_BASE}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SendGrid ${method} ${path} → ${res.status}: ${text}`);
    }

    if (res.status === 204 || res.headers.get('content-length') === '0') {
      return {} as T;
    }

    return res.json() as Promise<T>;
  }

  // ─── Templates ──────────────────────────────────────────────────────────────

  listTemplates(pageSize = 50): Promise<TemplateListResponse> {
    return this.request<TemplateListResponse>('GET', '/templates', undefined, {
      generations: 'dynamic',
      page_size: String(pageSize),
    });
  }

  getTemplate(templateId: string): Promise<Template> {
    return this.request<Template>('GET', `/templates/${templateId}`);
  }

  updateTemplate(templateId: string, params: UpdateTemplateParams): Promise<Template> {
    const body: Record<string, unknown> = {};
    if (params.name !== undefined) body['name'] = params.name;
    return this.request<Template>('PATCH', `/templates/${templateId}`, body);
  }

  getTemplateVersion(templateId: string, versionId: string): Promise<TemplateVersion> {
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
    params: { name: string; subject: string; htmlContent: string; active?: 0 | 1 },
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
    params: Partial<{ name: string; subject: string; htmlContent: string; active: 0 | 1; testData: string }>,
  ): Promise<TemplateVersion> {
    const body: Record<string, unknown> = {};
    if (params.name !== undefined) body['name'] = params.name;
    if (params.subject !== undefined) body['subject'] = params.subject;
    if (params.htmlContent !== undefined) body['html_content'] = params.htmlContent;
    if (params.active !== undefined) body['active'] = params.active;
    if (params.testData !== undefined) body['test_data'] = params.testData;

    return this.request<TemplateVersion>(
      'PATCH',
      `/templates/${templateId}/versions/${versionId}`,
      body,
    );
  }

  activateTemplateVersion(templateId: string, versionId: string): Promise<TemplateVersion> {
    return this.request<TemplateVersion>(
      'POST',
      `/templates/${templateId}/versions/${versionId}/activate`,
    );
  }

  deleteTemplate(templateId: string): Promise<void> {
    return this.request<void>('DELETE', `/templates/${templateId}`);
  }

  // ─── Email ───────────────────────────────────────────────────────────────────

  async sendEmail(params: SendEmailParams): Promise<{ messageId: string }> {
    const res = await fetch(`${SENDGRID_BASE}/mail/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [
          {
            to: [{ email: params.to }],
            dynamic_template_data: params.dynamicTemplateData,
          },
        ],
        from: { email: params.fromEmail, name: params.fromName },
        template_id: params.templateId,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SendGrid mail/send → ${res.status}: ${text}`);
    }

    return { messageId: res.headers.get('x-message-id') ?? '' };
  }

  // ─── Diagnostics ─────────────────────────────────────────────────────────────

  async checkSuppression(email: string): Promise<{
    bounced: boolean;
    blocked: boolean;
    unsubscribed: boolean;
    spamReported: boolean;
    details: Record<string, unknown>;
  }> {
    const encoded = encodeURIComponent(email);
    const [bounces, blocks, unsubscribes, spam] = await Promise.allSettled([
      this.request<SuppressionEntry[]>('GET', `/suppression/bounces/${encoded}`),
      this.request<SuppressionEntry[]>('GET', `/suppression/blocks/${encoded}`),
      this.request<SuppressionEntry[]>('GET', `/suppression/unsubscribes/${encoded}`),
      this.request<SuppressionEntry[]>('GET', `/suppression/spam_reports/${encoded}`),
    ]);

    const get = (r: PromiseSettledResult<SuppressionEntry[]>) =>
      r.status === 'fulfilled' ? r.value : [];

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
    const params: Record<string, string> = { start_date: startDate, aggregated_by: 'day' };
    if (endDate) params['end_date'] = endDate;
    return this.request<GlobalStats[]>('GET', '/stats', undefined, params);
  }
}
