export interface ProviderDefinition {
  name: string;
  displayName: string;
  envKey?: string;
  defaultBaseUrl?: string;
  requiresApiKey: boolean;
}

/**
 * Provider metadata is deliberately separate from provider implementations.
 * Adding a provider means registering its definition here and adding an
 * LLMProvider implementation to ProviderService.
 */
const providerDefinitions = new Map<string, ProviderDefinition>([
  [
    'mock',
    {
      name: 'mock',
      displayName: 'Mock',
      requiresApiKey: false,
    },
  ],
  [
    'openai',
    {
      name: 'openai',
      displayName: 'OpenAI',
      envKey: 'OPENAI_API_KEY',
      defaultBaseUrl: 'https://api.openai.com',
      requiresApiKey: true,
    },
  ],
  [
    'anthropic',
    {
      name: 'anthropic',
      displayName: 'Anthropic',
      envKey: 'ANTHROPIC_API_KEY',
      defaultBaseUrl: 'https://api.anthropic.com',
      requiresApiKey: true,
    },
  ],
]);

export function getProviderDefinition(
  name: string,
): ProviderDefinition | undefined {
  return providerDefinitions.get(name.trim().toLowerCase());
}

export function listProviderDefinitions(): ProviderDefinition[] {
  return [...providerDefinitions.values()];
}
