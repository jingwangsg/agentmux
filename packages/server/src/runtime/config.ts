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
    model: 'default',
    reasoningEffort: 'medium',
    mode: 'default',
  },
};

const DEFAULT_REASONING: ConfigCandidate[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
];

const DEFAULT_MODES: ConfigCandidate[] = [
  { value: 'default', label: 'Default', description: 'Normal interactive behavior.' },
  { value: 'plan', label: 'Plan', description: 'Prefer planning before execution.' },
  { value: 'auto-accept', label: 'Auto Accept', description: 'Favor low-friction execution.' },
];

const DEFAULT_MODELS: Record<BackendType, ConfigCandidate[]> = {
  codex: [
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { value: 'gpt-5.2', label: 'GPT-5.2' },
    { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
  ],
  claude: [
    { value: 'default', label: 'Default' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus' },
  ],
};

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
    path.join(home, '.claude', 'config.json'),
    path.join(home, '.config', 'claude', 'config.json'),
  ];

  for (const file of files) {
    if (!fs.existsSync(file)) {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      return {
        model: typeof parsed.model === 'string' ? parsed.model : undefined,
        reasoningEffort:
          typeof parsed.reasoningEffort === 'string'
            ? parsed.reasoningEffort
            : typeof parsed.reasoning_effort === 'string'
              ? parsed.reasoning_effort
              : undefined,
        mode: typeof parsed.mode === 'string' ? parsed.mode : undefined,
      };
    } catch {
      return {};
    }
  }

  return {};
}

function uniqueCandidates(base: ConfigCandidate[], current?: string): ConfigCandidate[] {
  const seen = new Set<string>();
  const merged = [...base];
  if (current && !base.some((candidate) => candidate.value === current)) {
    merged.unshift({ value: current, label: current });
  }
  return merged.filter((candidate) => {
    if (seen.has(candidate.value)) {
      return false;
    }
    seen.add(candidate.value);
    return true;
  });
}

export function resolveBackendDefaults(backend: BackendType): Required<Pick<ConversationConfig, 'model' | 'reasoningEffort' | 'mode'>> {
  const local = backend === 'codex' ? readCodexConfig() : readClaudeConfig();
  const fallback = DEFAULTS[backend];
  return {
    model: normalizeModel(local.model, fallback.model),
    reasoningEffort: normalizeReasoning(local.reasoningEffort, fallback.reasoningEffort),
    mode: normalizeMode(local.mode, fallback.mode),
  };
}

export function normalizeConversationConfig(backend: BackendType, config: Partial<ConversationConfig> | undefined): ConversationConfig {
  const defaults = resolveBackendDefaults(backend);
  return {
    ...config,
    model: normalizeModel(config?.model, defaults.model),
    reasoningEffort: normalizeReasoning(config?.reasoningEffort, defaults.reasoningEffort),
    mode: normalizeMode(config?.mode, defaults.mode),
  };
}

export function getConversationConfigCandidates(backend: BackendType): ConversationConfigCandidates {
  const defaults = resolveBackendDefaults(backend);
  return {
    backend,
    defaults,
    candidates: {
      model: uniqueCandidates(DEFAULT_MODELS[backend], defaults.model),
      reasoningEffort: uniqueCandidates(DEFAULT_REASONING, defaults.reasoningEffort),
      mode: uniqueCandidates(DEFAULT_MODES, defaults.mode),
    },
  };
}
