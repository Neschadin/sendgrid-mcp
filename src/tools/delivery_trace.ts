import {
  isSendGridApiError,
  type EmailLogMessage,
  type SendGridClient,
  type SendGridMessageActivity,
} from '../client';

export function activityQueryForXMessageId(xMessageId: string): string {
  const id = xMessageId.trim();
  if (id.length === 0) {
    throw new Error('xMessageId is empty');
  }
  if (id.includes("'") || id.includes('"') || /\s/u.test(id)) {
    throw new Error(
      'xMessageId contains quotes or whitespace and cannot be placed in an Email Activity query',
    );
  }
  return `msg_id LIKE '${id}%'`;
}

export function compileActivitySearch(input: {
  query?: string;
  xMessageId?: string;
}): string {
  const like = input.xMessageId
    ? activityQueryForXMessageId(input.xMessageId)
    : undefined;
  const query = input.query?.trim();
  if (like && query) return `(${query}) AND ${like}`;
  if (like) return like;
  if (query) return query;
  throw new Error('Provide query or xMessageId');
}

export function rejectActivityOffset(offset: number | undefined): void {
  if (offset !== undefined && offset > 0) {
    throw new Error(
      'GET /v3/messages has no offset. Remove offset and narrow the query with to_email, last_event_time, or msg_id LIKE.',
    );
  }
}

export function activityListMeta(count: number, limit: number): {
  total_count: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset: null;
  note?: string;
} {
  const hasMore = count >= limit && count > 0;
  return {
    total_count: count,
    count,
    offset: 0,
    has_more: hasMore,
    next_offset: null,
    ...(hasMore
      ? {
          note: 'Email Activity does not page with offset. Narrow the query (to_email, last_event_time, status) to see other messages.',
        }
      : {}),
  };
}

export function logsEqualityQuery(
  field: 'to_email' | 'sg_message_id',
  value: string,
): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes("'") || trimmed.includes('"')) {
    throw new Error(`${field} cannot be quoted into an Email Logs query`);
  }
  return `${field}='${trimmed}'`;
}

export function summarizeActivityMessage(
  message: SendGridMessageActivity,
): string {
  const lines = [
    `msg_id=${message.msg_id}`,
    `status=${message.status ?? 'n/a'}`,
    `from=${message.from_email ?? 'n/a'}`,
    `to=${message.to_email ?? 'n/a'}`,
    `subject=${message.subject ?? 'n/a'}`,
    `last_event_time=${message.last_event_time ?? 'n/a'}`,
  ];
  const asmGroupId = message['asm_group_id'];
  if (typeof asmGroupId === 'number' || typeof asmGroupId === 'string') {
    lines.push(`asm_group_id=${asmGroupId}`);
  }
  const outboundIp = message['outbound_ip'];
  if (typeof outboundIp === 'string') {
    lines.push(
      `outbound_ip=${outboundIp} type=${String(message['outbound_ip_type'] ?? 'n/a')}`,
    );
  }
  const reason = message['reason'];
  if (typeof reason === 'string' && reason.length > 0) {
    lines.push(`reason=${reason}`);
  }
  const events = message['events'];
  if (Array.isArray(events) && events.length > 0) {
    const last = events[events.length - 1];
    if (last && typeof last === 'object') {
      const event = last as Record<string, unknown>;
      lines.push(
        `last_event=${String(event['event_name'] ?? 'n/a')} reason=${String(event['reason'] ?? 'n/a')} bounce_type=${String(event['bounce_type'] ?? 'n/a')} mx=${String(event['mx_server'] ?? 'n/a')}`,
      );
    }
    lines.push(`events=${events.length}`);
  }
  return lines.join(', ');
}

function mapLogMessage(row: EmailLogMessage): SendGridMessageActivity | undefined {
  if (!row.sg_message_id) return undefined;
  return {
    msg_id: row.sg_message_id,
    from_email: row.from_email,
    to_email: row.to_email,
    subject: row.subject,
    status: row.status,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.sg_message_id_created_at
      ? { last_event_time: row.sg_message_id_created_at }
      : {}),
  };
}

async function logsMessages(
  client: SendGridClient,
  query: string,
  limit: number,
): Promise<SendGridMessageActivity[]> {
  const logs = await client.searchEmailLogs({ query, limit });
  return (logs.messages ?? []).flatMap((row) => {
    const mapped = mapLogMessage(row);
    return mapped ? [mapped] : [];
  });
}

export async function searchActivityOrLogs(
  client: SendGridClient,
  query: string,
  limit: number,
): Promise<{
  messages: SendGridMessageActivity[];
  source: 'activity' | 'logs';
  note?: string;
}> {
  try {
    const response = await client.filterMessages(query, limit);
    const messages = response.messages ?? [];
    if (messages.length === 0 && client.preferEmailLogs) {
      try {
        const fromLogs = await logsMessages(client, query, limit);
        if (fromLogs.length > 0) {
          return {
            messages: fromLogs,
            source: 'logs',
            note: 'Email Activity returned no rows. SENDGRID_REGION=eu often has no Activity detail, so these rows are from POST /v3/logs.',
          };
        }
      } catch (logsError) {
        const logsText =
          logsError instanceof Error ? logsError.message : String(logsError);
        return {
          messages: [],
          source: 'activity',
          note: `Email Activity returned no rows. Email Logs fallback failed: ${logsText}`,
        };
      }
    }
    return { messages, source: 'activity' };
  } catch (error) {
    if (
      !isSendGridApiError(error) ||
      (error.status !== 403 && error.status !== 404)
    ) {
      throw error;
    }
    try {
      const fromLogs = await logsMessages(client, query, limit);
      return {
        messages: fromLogs,
        source: 'logs',
        note: `Email Activity returned ${error.status}. Rows are from POST /v3/logs. Logs only accepts equality/IN on sg_message_id, subject, to_email, status, reason, categories, and sg_message_id_created_at.`,
      };
    } catch (logsError) {
      const logsText =
        logsError instanceof Error ? logsError.message : String(logsError);
      throw new Error(
        `Email Activity failed (${error.status}). Email Logs fallback also failed.\n${logsText}`,
      );
    }
  }
}

export async function traceMessage(
  client: SendGridClient,
  msgId: string,
): Promise<{ message: SendGridMessageActivity; note?: string }> {
  try {
    return { message: await client.getMessageById(msgId) };
  } catch (error) {
    if (
      !isSendGridApiError(error) ||
      (error.status !== 404 && error.status !== 403)
    ) {
      throw error;
    }

    const isXMessageId = !msgId.includes('.');
    if (isXMessageId && error.status === 404) {
      const found = await client.filterMessages(
        activityQueryForXMessageId(msgId),
        10,
      );
      const rows = found.messages ?? [];
      const only = rows[0];
      if (rows.length === 1 && only?.msg_id) {
        return {
          message: await client.getMessageById(only.msg_id),
          note: `Resolved x-message-id ${msgId} to msg_id ${only.msg_id} via msg_id LIKE.`,
        };
      }
      if (rows.length > 1) {
        throw new Error(
          `x-message-id ${msgId} matches ${rows.length} messages. Call get_message_activity with one full msg_id:\n${rows.map((row) => row.msg_id).join('\n')}`,
        );
      }
      throw new Error(
        `No Email Activity row for x-message-id ${msgId}. It may not be indexed yet, or this account has no Activity detail. Try search_email_logs with to_email equality.`,
      );
    }

    if (msgId.includes('.')) {
      try {
        const fromLogs = await logsMessages(
          client,
          logsEqualityQuery('sg_message_id', msgId),
          5,
        );
        const message = fromLogs[0];
        if (message) {
          return {
            message,
            note: `Email Activity returned ${error.status}. Loaded from POST /v3/logs, which has status and reason but no event chain.`,
          };
        }
      } catch {
        // Keep the original Activity error below.
      }
    }

    throw error;
  }
}
