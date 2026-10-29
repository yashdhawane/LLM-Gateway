import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderError } from './base.provider';
import { getProviderDefinition } from './provider.registry';

export interface ProviderCredential {
  apiKey?: string;
  baseUrl?: string;
  source: 'environment' | 'none';
}

/**
 * Central credential resolution for upstream providers.
 *
 * Credentials never live in the database or in request logs. The current
 * implementation resolves provider keys from validated environment
 * configuration; a database-backed store can be added behind this service
 * without changing callers.
 */
@Injectable()
export class CredentialManager {
  constructor(private readonly config: ConfigService) {}

  resolve(providerName: string, modelBaseUrl?: string): ProviderCredential {
    const provider = getProviderDefinition(providerName);
    if (!provider) {
      throw new ProviderError(
        'PROVIDER_NOT_CONFIGURED',
        `Provider '${providerName}' is not supported.`,
      );
    }

    const configured = provider.envKey
      ? this.config.get<string>(provider.envKey)
      : undefined;
    const apiKey = configured?.trim() || undefined;

    if (provider.requiresApiKey && !apiKey) {
      throw new ProviderError(
        'PROVIDER_NOT_CONFIGURED',
        `Provider '${provider.name}' is not configured.`,
      );
    }

    return {
      apiKey,
      baseUrl: modelBaseUrl?.trim() || provider.defaultBaseUrl,
      source: apiKey ? 'environment' : 'none',
    };
  }
}
