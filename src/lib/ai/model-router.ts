export type AiProvider = 'anthropic' | 'gemini' | 'mistral' | 'xai';

export type ModelByProvider = Record<AiProvider, string>;

type ActionConfig = {
  provider: AiProvider;
  models: ModelByProvider;
  creditCost: number;
  useCache: boolean;
};

type ProviderPricing = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
};

type ModelPricingByProvider = Record<string, ProviderPricing>;

export const ACTION_CONFIG = {
  mandate_generation: {
    provider: 'anthropic',
    models: {
      anthropic: 'MODEL_ID_HERE',
      gemini: 'MODEL_ID_HERE',
      mistral: 'MODEL_ID_HERE',
      xai: 'MODEL_ID_HERE',
    },
    creditCost: 5,
    useCache: true,
  },
  etat_des_lieux: {
    provider: 'anthropic',
    models: {
      anthropic: 'MODEL_ID_HERE',
      gemini: 'MODEL_ID_HERE',
      mistral: 'MODEL_ID_HERE',
      xai: 'MODEL_ID_HERE',
    },
    creditCost: 5,
    useCache: true,
  },
  listing_description: {
    provider: 'gemini',
    models: {
      anthropic: 'MODEL_ID_HERE',
      gemini: 'gemini-2.0-flash',
      mistral: 'MODEL_ID_HERE',
      xai: 'MODEL_ID_HERE',
    },
    creditCost: 5,
    useCache: false,
  },
  email_triage: {
    provider: 'gemini',
    models: {
      anthropic: 'MODEL_ID_HERE',
      gemini: 'gemini-2.5-flash-lite',
      mistral: 'MODEL_ID_HERE',
      xai: 'MODEL_ID_HERE',
    },
    creditCost: 0.1,
    useCache: false,
  },
  email_summary: {
    provider: 'gemini',
    models: {
      anthropic: 'MODEL_ID_HERE',
      gemini: 'gemini-2.5-flash-lite',
      mistral: 'MODEL_ID_HERE',
      xai: 'MODEL_ID_HERE',
    },
    creditCost: 0.1,
    useCache: false,
  },
  valuation_deck: {
    provider: 'anthropic',
    models: {
      anthropic: 'MODEL_ID_HERE',
      gemini: 'MODEL_ID_HERE',
      mistral: 'MODEL_ID_HERE',
      xai: 'MODEL_ID_HERE',
    },
    creditCost: 8,
    useCache: true,
  },
  lead_reply: {
    provider: 'anthropic',
    models: {
      anthropic: 'MODEL_ID_HERE',
      gemini: 'MODEL_ID_HERE',
      mistral: 'MODEL_ID_HERE',
      xai: 'MODEL_ID_HERE',
    },
    creditCost: 1,
    useCache: false,
  },
  photo_enhancement_prompt: {
    provider: 'anthropic',
    models: {
      anthropic: 'MODEL_ID_HERE',
      gemini: 'MODEL_ID_HERE',
      mistral: 'MODEL_ID_HERE',
      xai: 'MODEL_ID_HERE',
    },
    creditCost: 2,
    useCache: false,
  },
  daily_briefing: {
    provider: 'gemini',
    models: {
      anthropic: 'MODEL_ID_HERE',
      gemini: 'gemini-2.5-flash',
      mistral: 'MODEL_ID_HERE',
      xai: 'MODEL_ID_HERE',
    },
    creditCost: 1,
    useCache: false,
  },
  document_generation: {
    provider: 'gemini',
    models: {
      anthropic: 'claude-sonnet-4-20250514',
      gemini: 'gemini-2.5-flash',
      mistral: 'mistral-large-latest',
      xai: 'grok-4-fast-reasoning',
    },
    creditCost: 0,
    useCache: false,
  },
  document_special_clause: {
    provider: 'mistral',
    models: {
      anthropic: 'claude-sonnet-4-20250514',
      gemini: 'gemini-2.5-flash',
      mistral: 'mistral-large-latest',
      xai: 'grok-4-fast-reasoning',
    },
    creditCost: 0.5,
    useCache: false,
  },
  chat_assistant: {
    provider: 'gemini',
    models: {
      anthropic: 'claude-sonnet-4-20250514',
      gemini: 'gemini-2.5-flash-lite',
      mistral: 'mistral-small-latest',
      xai: 'grok-4-fast-reasoning',
    },
    creditCost: 0.1,
    useCache: false,
  },
} as const satisfies Record<string, ActionConfig>;

export type ActionType = keyof typeof ACTION_CONFIG;

type ModelTier = 'flagship' | 'sonnet' | 'haiku';

// Placeholder pricing constants. Fill these in with the live provider rates you want to log against.
// The keys here should match the exact model identifiers you assign per provider.
export const MODEL_PRICING: Record<AiProvider, ModelPricingByProvider> = {
  anthropic: {
    MODEL_ID_HERE: {
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
    },
    'claude-sonnet-4-20250514': {
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
    },
  },
  gemini: {
    'gemini-2.0-flash': {
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
    },
    'gemini-2.5-flash': {
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
    },
  },
  mistral: {
    MODEL_ID_HERE: {
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
    },
    'mistral-large-latest': {
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
    },
  },
  xai: {
    MODEL_ID_HERE: {
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
    },
    'grok-4-fast-reasoning': {
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
    },
  },
} as const;

export type ActionConfigResult = (typeof ACTION_CONFIG)[ActionType];

export function getActionConfig(actionType: ActionType) {
  const actionConfig = ACTION_CONFIG[actionType];

  return {
    ...actionConfig,
    model: actionConfig.models[actionConfig.provider],
  };
}

export function getActionModel(actionType: ActionType, provider?: AiProvider) {
  const actionConfig = ACTION_CONFIG[actionType];
  const resolvedProvider = provider ?? actionConfig.provider;

  return actionConfig.models[resolvedProvider];
}

export function estimateCost(
  actionType: ActionType,
  inputTokens: number,
  outputTokens: number,
) {
  const { provider, model } = getActionConfig(actionType);
  const pricing = MODEL_PRICING[provider][model];

  if (!pricing) {
    return 0;
  }

  return (
    (inputTokens / 1_000_000) * pricing.inputUsdPerMillionTokens +
    (outputTokens / 1_000_000) * pricing.outputUsdPerMillionTokens
  );
}