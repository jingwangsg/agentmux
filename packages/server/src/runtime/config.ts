import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  BackendType,
  ConfigCandidate,
  ConversationConfig,
  ConversationConfigCandidates,
  ConversationMode,
  ReasoningEffort,
} from '../types.js';

const DEFAULTS: Record<BackendType, Required<Pick<ConversationConfig, 'model' | 'reasoningEffort' | 'mode'>>> = {
  codex: {
    model: 'gpt-5.4',
    reasoningEffort: 'medium',
    mode: 'default',
  },
  claude: {
    model: 'sonnet',
    reasoningEffort: 'medium',
    mode: 'default',
  },
};

const MINIMAL_MODEL_FALLBACKS: Record<BackendType, ConfigCandidate[]> = {
  codex: [
    { value: 'gpt-5.4', label: 'GPT-5.4', description: 'Latest flagship Codex-capable model.' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', description: 'Faster, lighter-weight GPT-5.4 variant.' },
    { value: 'gpt-5.2', label: 'GPT-5.2', description: 'Stable general-purpose GPT-5 generation.' },
    { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', description: 'Codex-tuned GPT-5.2 model.' },
  ],
  claude: [
    { value: 'default', label: 'Default' },
    { value: 'opus', label: 'Opus', description: 'Most capable for ambitious work.' },
    { value: 'opus[1m]', label: 'Opus [1M]' },
    { value: 'sonnet', label: 'Sonnet', description: 'Most efficient for everyday tasks.' },
    { value: 'sonnet[1m]', label: 'Sonnet [1M]' },
    { value: 'haiku', label: 'Haiku', description: 'Fastest for quick answers.' },
  ],
};

const MINIMAL_REASONING_FALLBACKS: ConfigCandidate[] = [
  { value: 'low', label: 'Low', description: 'Lower latency for quick tasks.' },
  { value: 'medium', label: 'Medium', description: 'Balanced default effort.' },
  { value: 'high', label: 'High', description: 'Longer reasoning for harder tasks.' },
  { value: 'xhigh', label: 'Extra High', description: 'Deepest reasoning for the hardest tasks.' },
];

const CLAUDE_REASONING_CANDIDATES: ConfigCandidate[] = [
  { value: 'low', label: 'Low', description: 'Lower latency for quick tasks.' },
  { value: 'medium', label: 'Medium', description: 'Balanced default effort.' },
  { value: 'high', label: 'High', description: 'Longer reasoning for harder tasks.' },
];

const EMPTY_CANDIDATES: ConfigCandidate[] = [];

const CODEX_MODE_CANDIDATES: ConfigCandidate[] = [
  { value: 'default', label: 'Default', description: 'Normal interactive behavior.' },
  { value: 'plan', label: 'Plan', description: 'Prefer planning before execution.' },
  { value: 'auto-accept', label: 'Auto Accept', description: 'Favor low-friction execution.' },
];

const CLAUDE_MODE_CANDIDATES: ConfigCandidate[] = [
  { value: 'default', label: 'Default', description: 'Normal interactive behavior.' },
  { value: 'plan', label: 'Plan', description: 'Prefer planning before execution.' },
  { value: 'acceptEdits', label: 'Accept Edits', description: 'Apply edits with reduced approval friction.' },
  { value: 'bypassPermissions', label: 'Bypass Permissions', description: 'Bypass permission prompts in trusted environments.' },
];

function normalizeReasoning(value: unknown, fallback: ReasoningEffort | string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeMode(value: unknown, fallback: ConversationMode | string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeModel(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function parseSimpleConfigFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const pairs: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('[')) {
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!match) {
      continue;
    }
    let [, key, value] = match;
    value = value.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    pairs[key] = value;
  }

  return pairs;
}

function readJsonIfExists(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractJsonArrayIfExists(filePath: string, key: string): unknown[] {
  const parsed = readJsonIfExists(filePath);
  const value = parsed?.[key];
  return Array.isArray(value) ? value : [];
}

function titleizeModel(value: string): string {
  // Strip provider prefix (e.g. "openai/openai/gpt-5.4" → "gpt-5.4")
  const bare = value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value;
  return bare
    .replace(/^claude-/, '')
    .replace(/^gpt-/, 'GPT-')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function dedupeCandidates(candidates: ConfigCandidate[], preferredValues: Array<string | undefined>): ConfigCandidate[] {
  const merged = [...candidates];
  for (const value of preferredValues) {
    if (!value || merged.some((candidate) => candidate.value === value)) {
      continue;
    }
    merged.unshift({ value, label: titleizeModel(value) });
  }

  const seen = new Set<string>();
  return merged.filter((candidate) => {
    if (!candidate.value || seen.has(candidate.value)) {
      return false;
    }
    seen.add(candidate.value);
    return true;
  });
}

function dedupeModeCandidates(candidates: ConfigCandidate[], preferredValues: Array<string | undefined>): ConfigCandidate[] {
  const merged = [...candidates];
  for (const value of preferredValues) {
    if (!value || merged.some((candidate) => candidate.value === value)) {
      continue;
    }
    merged.unshift({ value, label: value, description: 'Currently selected mode from local or conversation config.' });
  }

  const seen = new Set<string>();
  return merged.filter((candidate) => {
    if (!candidate.value || seen.has(candidate.value)) {
      return false;
    }
    seen.add(candidate.value);
    return true;
  });
}

function toReasoningCandidate(value: string): ConfigCandidate {
  const normalized = value.trim();
  return {
    value: normalized,
    label: normalized.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
    description: normalized === 'high' || normalized === 'xhigh' || normalized === 'max'
      ? 'Longer reasoning for harder tasks.'
      : normalized === 'low'
        ? 'Lower latency for quick tasks.'
        : 'Balanced reasoning for everyday tasks.',
  };
}

function readCodexConfig(): ConversationConfig {
  const home = os.homedir();
  const files = [
    path.join(home, '.codex', 'config.toml'),
    path.join(home, '.config', 'codex', 'config.toml'),
  ];

  for (const file of files) {
    const parsed = parseSimpleConfigFile(file);
    if (Object.keys(parsed).length === 0) {
      continue;
    }
    return {
      model: parsed.model,
      reasoningEffort: parsed.reasoning_effort ?? parsed.reasoningEffort,
      mode: parsed.mode,
    };
  }

  return {};
}

function readClaudeConfig(): ConversationConfig {
  const home = os.homedir();
  const files = [
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.config', 'claude', 'settings.json'),
  ];

  for (const file of files) {
    const parsed = readJsonIfExists(file);
    if (!parsed) {
      continue;
    }
    return {
      model:
        typeof parsed.selectedModel === 'string'
          ? parsed.selectedModel
          : typeof parsed.model === 'string'
            ? parsed.model
            : undefined,
      reasoningEffort:
        typeof parsed.reasoningEffort === 'string'
          ? parsed.reasoningEffort
          : typeof parsed.reasoning_effort === 'string'
            ? parsed.reasoning_effort
            : typeof parsed.effortLevel === 'string'
              ? parsed.effortLevel
              : parsed.alwaysThinkingEnabled === true
                ? 'high'
                : undefined,
      mode:
        typeof parsed.initialPermissionMode === 'string'
          ? parsed.initialPermissionMode
          : typeof parsed.mode === 'string'
            ? parsed.mode
            : undefined,
    };
  }

  return {};
}

function extractReasoningCandidatesFromUnknown(input: unknown): ConfigCandidate[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .map(toReasoningCandidate);
}

function readClaudeExtensionState(): { model: ConfigCandidate[]; reasoningEffort: ConfigCandidate[] } {
  const home = os.homedir();
  const files = [
    path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'anthropic.claude-code', 'state.json'),
    path.join(home, '.config', 'Code', 'User', 'globalStorage', 'anthropic.claude-code', 'state.json'),
  ];

  for (const file of files) {
    const parsed = readJsonIfExists(file);
    if (!parsed) {
      continue;
    }

    const modelCandidates = dedupeCandidates(
      [
        ...extractJsonArrayIfExists(file, 'models').map((value) => ({ value: String(value), label: titleizeModel(String(value)) })),
      ],
      [typeof parsed.selectedModel === 'string' ? parsed.selectedModel : undefined],
    );

    const reasoningCandidates = dedupeCandidates(
      extractReasoningCandidatesFromUnknown(parsed.reasoningEfforts),
      [
        typeof parsed.reasoningEffort === 'string'
          ? parsed.reasoningEffort
          : typeof parsed.reasoning_effort === 'string'
            ? parsed.reasoning_effort
            : undefined,
      ],
    );

    return { model: modelCandidates, reasoningEffort: reasoningCandidates };
  }

  return { model: [], reasoningEffort: [] };
}

function readClaudeDynamicCandidates(config: ConversationConfig): { model: ConfigCandidate[]; reasoningEffort: ConfigCandidate[] } {
  const fromState = readClaudeExtensionState();
  return {
    model: dedupeCandidates(fromState.model, [typeof config.model === 'string' ? config.model : undefined]),
    reasoningEffort: dedupeCandidates(
      fromState.reasoningEffort,
      [typeof config.reasoningEffort === 'string' ? config.reasoningEffort : undefined],
    ),
  };
}

function readCodexDynamicCandidates(config: ConversationConfig): { model: ConfigCandidate[]; reasoningEffort: ConfigCandidate[] } {
  const home = os.homedir();
  const files = [
    path.join(home, '.codex', 'config.toml'),
    path.join(home, '.config', 'codex', 'config.toml'),
  ];

  const modelValues = new Set<string>();
  const reasoningValues = new Set<string>();

  for (const file of files) {
    const parsed = parseSimpleConfigFile(file);
    for (const key of ['model', 'model_name', 'modelName']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) {
        modelValues.add(value.trim());
      }
    }
    for (const key of ['reasoning_effort', 'reasoningEffort', 'effort']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) {
        reasoningValues.add(value.trim());
      }
    }
  }

  const modelCandidates = dedupeCandidates(
    Array.from(modelValues).map((value) => ({ value, label: titleizeModel(value) })),
    [typeof config.model === 'string' ? config.model : undefined],
  );
  const reasoningCandidates = dedupeCandidates(
    Array.from(reasoningValues).map(toReasoningCandidate),
    [typeof config.reasoningEffort === 'string' ? config.reasoningEffort : undefined],
  );

  return { model: modelCandidates, reasoningEffort: reasoningCandidates };
}

function readCodexFallbackCandidates(config: ConversationConfig): { model: ConfigCandidate[]; reasoningEffort: ConfigCandidate[] } {
  return {
    model: dedupeCandidates(MINIMAL_MODEL_FALLBACKS.codex, [typeof config.model === 'string' ? config.model : undefined]),
    reasoningEffort: dedupeCandidates(MINIMAL_REASONING_FALLBACKS, [typeof config.reasoningEffort === 'string' ? config.reasoningEffort : undefined]),
  };
}

export function resolveBackendDefaults(backend: BackendType): Required<Pick<ConversationConfig, 'model' | 'reasoningEffort' | 'mode'>> {
  const fallback = DEFAULTS[backend];
  const local = backend === 'codex' ? readCodexConfig() : readClaudeConfig();
  return {
    model: normalizeModel(local.model, fallback.model),
    reasoningEffort: normalizeReasoning(local.reasoningEffort, fallback.reasoningEffort),
    mode: normalizeMode(local.mode, fallback.mode),
  };
}

export function resolveConversationConfig(
  backend: BackendType,
  config?: ConversationConfig,
): Required<Pick<ConversationConfig, 'model' | 'reasoningEffort' | 'mode'>> {
  const defaults = resolveBackendDefaults(backend);
  return {
    model: normalizeModel(config?.model, defaults.model),
    reasoningEffort: normalizeReasoning(config?.reasoningEffort, defaults.reasoningEffort),
    mode: normalizeMode(config?.mode, defaults.mode),
  };
}

export function resolveConfigCandidates(
  backend: BackendType,
  config: ConversationConfig = {},
): ConversationConfigCandidates {
  const defaults = resolveBackendDefaults(backend);
  const localConfig = backend === 'codex' ? readCodexConfig() : readClaudeConfig();

  if (backend === 'claude') {
    const dynamic = readClaudeDynamicCandidates(config);
    return {
      backend,
      defaults,
      candidates: {
        model: dedupeCandidates(
          dynamic.model.length ? dynamic.model : MINIMAL_MODEL_FALLBACKS.claude,
          [defaults.model, typeof localConfig.model === 'string' ? localConfig.model : undefined],
        ),
        reasoningEffort: dedupeCandidates(
          dynamic.reasoningEffort.length ? dynamic.reasoningEffort : CLAUDE_REASONING_CANDIDATES,
          [defaults.reasoningEffort, typeof localConfig.reasoningEffort === 'string' ? localConfig.reasoningEffort : undefined],
        ),
        mode: dedupeModeCandidates(CLAUDE_MODE_CANDIDATES, [defaults.mode, typeof localConfig.mode === 'string' ? localConfig.mode : undefined, typeof config.mode === 'string' ? config.mode : undefined]),
      },
    };
  }

  const discovered = readCodexDynamicCandidates(config);
  const fallback = readCodexFallbackCandidates(config);
  const modelCandidates = dedupeCandidates(
    discovered.model.length ? discovered.model : fallback.model,
    [defaults.model, typeof localConfig.model === 'string' ? localConfig.model : undefined],
  );
  const reasoningCandidates = dedupeCandidates(
    discovered.reasoningEffort.length ? discovered.reasoningEffort : MINIMAL_REASONING_FALLBACKS,
    [defaults.reasoningEffort, typeof localConfig.reasoningEffort === 'string' ? localConfig.reasoningEffort : undefined],
  );

  return {
    backend,
    defaults,
    candidates: {
      model: modelCandidates.length ? modelCandidates : EMPTY_CANDIDATES,
      reasoningEffort: reasoningCandidates.length ? reasoningCandidates : EMPTY_CANDIDATES,
      mode: dedupeModeCandidates(CODEX_MODE_CANDIDATES, [defaults.mode, typeof localConfig.mode === 'string' ? localConfig.mode : undefined, typeof config.mode === 'string' ? config.mode : undefined]),
    },
  };
}


export function normalizeConversationConfig(backend: BackendType, config: ConversationConfig = {}): ConversationConfig {
  return resolveConversationConfig(backend, config);
}

export function getConversationConfigCandidates(backend: BackendType, config: ConversationConfig = {}): ConversationConfigCandidates {
  return resolveConfigCandidates(backend, config);
}
