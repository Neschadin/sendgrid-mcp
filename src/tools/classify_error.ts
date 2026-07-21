export interface ClassifiedError {
  category: string;
  probableCauses: string[];
  actions: string[];
}

export function classifySendGridError(
  statusCode: number | undefined,
  text: string,
): ClassifiedError {
  const normalized = text.trim().toLowerCase();
  const details: ClassifiedError = {
    category: 'unknown',
    probableCauses: ['Insufficient context to classify exactly.'],
    actions: ['Check full API error body and endpoint payload.'],
  };

  if (
    normalized.includes('from address does not match a verified sender identity') ||
    normalized.includes('verified sender identity')
  ) {
    return {
      category: 'sender_identity',
      probableCauses: [
        'From address/domain is not verified for API sending.',
        'Domain authentication not configured for sender domain.',
      ],
      actions: [
        'Authenticate sender domain and use matching From domain.',
        'Run sender preflight checks before retrying.',
      ],
    };
  }

  if (
    normalized.includes('invalid template') ||
    normalized.includes('template') ||
    normalized.includes('dropped')
  ) {
    return {
      category: 'template_validation',
      probableCauses: [
        'Template ID is invalid or inaccessible.',
        'Template has no active version.',
        'Template render data does not match expected handlebars variables.',
      ],
      actions: [
        'Verify template ID exists and has active version.',
        'Validate dynamic template data against template variables.',
      ],
    };
  }

  if (normalized.includes('attachment content must be base64')) {
    return {
      category: 'attachment_encoding',
      probableCauses: ['Attachment payload is not base64-encoded correctly.'],
      actions: [
        'Base64-encode attachment content before send.',
        'Validate attachment payload in preflight.',
      ],
    };
  }

  if (statusCode === 429 || normalized.includes('rate limit')) {
    return {
      category: 'rate_limit',
      probableCauses: ['Endpoint rate limit exceeded.'],
      actions: [
        'Back off and retry after reset.',
        'Queue requests and apply per-endpoint pacing.',
      ],
    };
  }

  if (statusCode === 413 || normalized.includes('payload too large')) {
    return {
      category: 'payload_too_large',
      probableCauses: [
        'Email payload or attachment set exceeds API/provider limits.',
      ],
      actions: [
        'Reduce attachment sizes and payload footprint.',
        'Move large files to hosted links instead of attachments.',
      ],
    };
  }

  if (statusCode === 401) {
    return {
      category: 'auth_or_account_state',
      probableCauses: [
        'Invalid/revoked API key or missing scopes.',
        'Account in disabled/frozen/credit-exceeded state.',
      ],
      actions: [
        'Verify API key validity and scopes.',
        'Check account/billing state before retrying sends.',
      ],
    };
  }

  if (statusCode === 403) {
    return {
      category: 'permissions_or_policy',
      probableCauses: [
        'API key lacks required permissions.',
        'Endpoint forbidden for this account/plan state.',
      ],
      actions: [
        'Use key with required scopes.',
        'Validate account feature availability for the endpoint.',
      ],
    };
  }

  if (statusCode === 400) {
    return {
      category: 'payload_validation',
      probableCauses: [
        'Malformed JSON or invalid request schema.',
        'Duplicate recipients across to/cc/bcc in a personalization block.',
        'Missing required fields (subject/content/from/personalizations).',
      ],
      actions: [
        'Validate payload schema and required fields.',
        'Ensure recipient uniqueness per personalization block.',
      ],
    };
  }

  return details;
}
