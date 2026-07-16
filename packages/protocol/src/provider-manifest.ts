import { z } from "zod";
import type { AgentMode } from "./agent-types.js";

export type AgentModeColorTier = "safe" | "moderate" | "dangerous" | "planning" | `#${string}`;
// Open string by design: the client looks icons up in a registry and falls back
// to a default for unknown values. Daemon downgrades unknown icons for clients
// that pre-date the open-string contract (see CLIENT_CAPS.customModeIcons).
export type AgentModeIcon = string;

export interface AgentModeVisuals {
  icon: AgentModeIcon;
  colorTier: AgentModeColorTier;
}

export type AgentProviderModeDefinition = Omit<AgentMode, "icon" | "colorTier"> &
  AgentModeVisuals & {
    // Marks the provider's most-permissioned no-prompt mode. Selecting it means tools run without approval; the runtime mechanism is provider-specific.
    isUnattended?: boolean;
  };

// TODO: `modes` should not be static. Providers (especially ACP) report their
// own modes at runtime via session/new. We should fetch modes from the provider
// as source of truth and enrich with UI metadata (icons, colorTier) on top.
export interface AgentProviderDefinition {
  id: string;
  label: string;
  description: string;
  enabledByDefault?: boolean;
  defaultModeId: string | null;
  modes: AgentProviderModeDefinition[];
  voice?: {
    enabled: boolean;
    defaultModeId: string;
    defaultModel?: string;
  };
}

// Ids + labels of the providers bundled with the daemon, in historical order.
// Used for offline CLI listings and reserved-id checks; full definitions live
// in each provider's module (packages/server .../providers/*/module.ts).
export const BUILTIN_PROVIDER_ID_LABELS: ReadonlyArray<{
  id: string;
  label: string;
  enabledByDefault?: boolean;
}> = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "copilot", label: "Copilot" },
  { id: "opencode", label: "OpenCode" },
  { id: "pi", label: "Pi" },
  { id: "omp", label: "Oh My Pi", enabledByDefault: false },
];

export const AgentProviderSchema = z.string();

export function isValidAgentProvider(
  value: string,
  validIds: Iterable<string> = BUILTIN_PROVIDER_ID_LABELS.map((entry) => entry.id),
): boolean {
  return Array.isArray(validIds) ? validIds.includes(value) : new Set(validIds).has(value);
}

export function getModeVisuals(
  provider: string,
  modeId: string,
  definitions: AgentProviderDefinition[],
): AgentModeVisuals | undefined {
  const definition = definitions.find((entry) => entry.id === provider);
  const mode = definition?.modes.find((m) => m.id === modeId);
  if (!mode) return undefined;
  return { icon: mode.icon, colorTier: mode.colorTier };
}
