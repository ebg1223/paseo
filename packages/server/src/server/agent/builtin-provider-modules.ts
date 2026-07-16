import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";

import type { ProviderModule } from "./provider-module.js";
import { claudeProviderModule } from "./providers/claude/module.js";
import { codexProviderModule } from "./providers/codex-module.js";
import { copilotProviderModule } from "./providers/copilot-module.js";
import { mockProviderModule } from "./providers/mock-module.js";
import { mockSlowProviderModule } from "./providers/mock-slow-module.js";
import { ompProviderModule } from "./providers/omp/module.js";
import { opencodeProviderModule } from "./providers/opencode-module.js";
import { piProviderModule } from "./providers/pi/module.js";

// Order: today's AGENT_PROVIDER_DEFINITIONS order, then dev definitions.
// NOTE: cursor is intentionally NOT here — it has no builtin definition and is
// only instantiated through user `extends: "acp"` overrides (see
// provider-registry.ts addDerivedProviders cursor special case).
export const BUILTIN_PROVIDER_MODULES: ProviderModule[] = [
  claudeProviderModule,
  codexProviderModule,
  copilotProviderModule,
  opencodeProviderModule,
  piProviderModule,
  ompProviderModule,
  mockProviderModule,
  mockSlowProviderModule,
];

export function getBuiltinDefinition(id: string): AgentProviderDefinition | undefined {
  return BUILTIN_PROVIDER_MODULES.find((module) => module.definition.id === id)?.definition;
}

// Production builtin ids (matches the pre-refactor BUILTIN_PROVIDER_IDS surface:
// dev-only modules like mock/mock-slow are excluded).
export const BUILTIN_PROVIDER_IDS = BUILTIN_PROVIDER_MODULES.filter(
  (module) => !module.devOnly,
).map((module) => module.definition.id);
