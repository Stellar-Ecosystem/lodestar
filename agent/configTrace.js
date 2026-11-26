/**
 * Agent configuration validation, redaction, and run-traceability helpers
 * (LDS-2026-194).
 */

const SOROBAN_CONTRACT_RE = /^C[A-Z2-7]{55}$/;
const STELLAR_CLASSIC_ASSET_RE = /^[A-Za-z0-9]{1,12}:G[A-Z2-7]{55}$/;

/**
 * Redact a URL so credentials, query parameters, and fragments are never logged.
 * Falls back to a safe redacted token when the input is not a valid URL.
 *
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function redactUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    }
    return `${parsed.protocol}//[redacted]`;
  } catch {
    const withoutQuery = trimmed.split(/[?#]/)[0];
    const withoutCreds = withoutQuery.includes('@')
      ? withoutQuery.slice(withoutQuery.lastIndexOf('@') + 1)
      : withoutQuery;
    if (withoutCreds.length <= 12) return '***';
    return `${withoutCreds.slice(0, 6)}...${withoutCreds.slice(-4)}`;
  }
}

/**
 * Redact a service or payment reference (URL, tx hash, token, or identifier)
 * so logs remain correlatable without exposing secrets or sensitive query data.
 *
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function redactReference(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '(no hash)') return null;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return redactUrl(trimmed);
  }

  if (trimmed.length <= 8) return '***';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

/**
 * Check whether a configured USDC token identifier is a valid Soroban contract
 * address (`C...`, 56 chars) or Stellar classic asset (`CODE:G...`).
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isValidUsdcToken(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return SOROBAN_CONTRACT_RE.test(trimmed) || STELLAR_CLASSIC_ASSET_RE.test(trimmed);
}

/**
 * Check whether a URL is a valid http(s) URL with a non-empty hostname.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isValidHttpUrl(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Validate optional and active agent configuration values and produce a
 * redacted summary suitable for structured logging and run summaries.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ valid: boolean, issues: Array<{ field: string, envVar: string, reason: string, value: string | null }>, summary: object }}
 */
export function validateAgentConfig(env = process.env) {
  const issues = [];

  const usdcTokenRaw = env.AGENT_USDC_TOKEN ?? env.USDC_TOKEN_ADDRESS ?? null;
  const usdcEnvVar = env.AGENT_USDC_TOKEN !== undefined ? 'AGENT_USDC_TOKEN' : 'USDC_TOKEN_ADDRESS';
  if (typeof usdcTokenRaw === 'string' && usdcTokenRaw.trim() !== '') {
    if (!isValidUsdcToken(usdcTokenRaw)) {
      issues.push({
        field: 'usdcToken',
        envVar: usdcEnvVar,
        reason: 'invalid_usdc_token',
        value: redactReference(usdcTokenRaw),
      });
    }
  }

  const facilitatorRaw = env.FACILITATOR_URL ?? env.X402_FACILITATOR_URL ?? null;
  const facilitatorEnvVar = env.FACILITATOR_URL !== undefined ? 'FACILITATOR_URL' : 'X402_FACILITATOR_URL';
  if (typeof facilitatorRaw === 'string' && facilitatorRaw.trim() !== '') {
    if (!isValidHttpUrl(facilitatorRaw)) {
      issues.push({
        field: 'facilitatorUrl',
        envVar: facilitatorEnvVar,
        reason: 'invalid_facilitator_url',
        value: redactUrl(facilitatorRaw),
      });
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    summary: {
      rpcUrl: redactUrl(env.STELLAR_RPC_URL),
      apiUrl: redactUrl(env.LODESTAR_API_URL),
      usdcToken: typeof usdcTokenRaw === 'string' && usdcTokenRaw.trim() !== ''
        ? redactReference(usdcTokenRaw)
        : null,
      facilitatorUrl: typeof facilitatorRaw === 'string' && facilitatorRaw.trim() !== ''
        ? redactUrl(facilitatorRaw)
        : null,
    },
  };
}

/**
 * Emit structured configuration outcome logs for a run.
 *
 * @param {object} logger
 * @param {{ valid: boolean, issues: Array<object>, summary: object }} validation
 * @param {{ runId?: string | null, agentAddress?: string | null, events: { CONFIG_VALIDATED: string, CONFIG_INVALID: string } }} ctx
 */
export function logConfigOutcome(logger, validation, { runId = null, agentAddress = null, events }) {
  for (const issue of validation.issues) {
    logger?.warn?.(
      {
        event: events.CONFIG_INVALID,
        runId,
        agentAddress,
        field: issue.field,
        envVar: issue.envVar,
        reason: issue.reason,
        value: issue.value,
      },
      'Invalid agent configuration value',
    );
  }

  logger?.info?.(
    {
      event: events.CONFIG_VALIDATED,
      runId,
      agentAddress,
      valid: validation.valid,
      issueCount: validation.issues.length,
      config: validation.summary,
    },
    validation.valid ? 'Agent configuration validated' : 'Agent configuration validated with issues',
  );
}
