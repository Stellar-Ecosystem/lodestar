/**
 * Secure secrets management using AWS Secrets Manager with fallback to environment variables.
 *
 * This module provides a unified interface for retrieving sensitive configuration values
 * like Stellar secret keys. It prioritizes:
 * 1. AWS Secrets Manager (if configured)
 * 2. Environment variables (fallback for local development)
 *
 * AWS Secrets Manager configuration:
 * - AWS_REGION: AWS region for Secrets Manager
 * - AWS_SECRET_ID: Secret ID in AWS Secrets Manager (optional, defaults to 'lodestar/production')
 * - USE_AWS_SECRETS: Set to 'true' to enable AWS Secrets Manager
 *
 * The secret in AWS Secrets Manager should be a JSON object with keys matching the
 * environment variable names (e.g., SERVER_STELLAR_SECRET, DEMO_VOTER_SECRETS).
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

let secretsCache = null;
let secretsClient = null;

/**
 * Initialize the AWS Secrets Manager client if AWS credentials are configured.
 */
function initSecretsClient() {
  if (secretsClient) return secretsClient;

  const useAwsSecrets = process.env.USE_AWS_SECRETS === 'true';
  if (!useAwsSecrets) return null;

  try {
    secretsClient = new SecretsManagerClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
    return secretsClient;
  } catch (err) {
    console.warn('[secrets] Failed to initialize AWS Secrets Manager client:', err.message);
    return null;
  }
}

/**
 * Fetch secrets from AWS Secrets Manager and cache them.
 */
async function fetchSecretsFromAws() {
  const client = initSecretsClient();
  if (!client) return null;

  try {
    const secretId = process.env.AWS_SECRET_ID || 'lodestar/production';
    const command = new GetSecretValueCommand({ SecretId: secretId });
    const response = await client.send(command);

    if (response.SecretString) {
      secretsCache = JSON.parse(response.SecretString);
      return secretsCache;
    }

    if (response.SecretBinary) {
      secretsCache = JSON.parse(Buffer.from(response.SecretBinary, 'base64').toString('utf-8'));
      return secretsCache;
    }

    return null;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      console.warn(`[secrets] Secret not found: ${process.env.AWS_SECRET_ID || 'lodestar/production'}`);
    } else {
      console.warn('[secrets] Failed to fetch from AWS Secrets Manager:', err.message);
    }
    return null;
  }
}

/**
 * Get a secret value by key.
 * Priority: AWS Secrets Manager > Environment variable > defaultValue.
 *
 * @param {string} key - The secret key (e.g., 'SERVER_STELLAR_SECRET')
 * @param {string} defaultValue - Fallback value if secret not found
 * @returns {Promise<string>}
 */
export async function getSecret(key, defaultValue = null) {
  // Try AWS Secrets Manager first
  if (!secretsCache) {
    await fetchSecretsFromAws();
  }

  if (secretsCache && secretsCache[key] !== undefined) {
    return secretsCache[key];
  }

  // Fallback to environment variable
  if (process.env[key] !== undefined) {
    return process.env[key];
  }

  // Return default value if provided
  return defaultValue;
}

/**
 * Clear the secrets cache (useful for testing or forced refresh).
 */
export function clearCache() {
  secretsCache = null;
}

/**
 * Check if AWS Secrets Manager is being used.
 */
export function isUsingAwsSecrets() {
  return process.env.USE_AWS_SECRETS === 'true' && initSecretsClient() !== null;
}

/**
 * Populate process.env from AWS Secrets Manager.
 * This should be called at application startup before config is loaded.
 * Secrets from AWS will override existing environment variables.
 *
 * @returns {Promise<void>}
 */
export async function loadSecretsToEnv() {
  const secrets = await fetchSecretsFromAws();
  if (!secrets) return;

  for (const [key, value] of Object.entries(secrets)) {
    if (value !== undefined && value !== null) {
      process.env[key] = String(value);
    }
  }

  console.log('[secrets] Loaded secrets from AWS Secrets Manager');
}
