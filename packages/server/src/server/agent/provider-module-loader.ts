import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentProviderDefinitionSchema } from "@getpaseo/protocol/provider-manifest";
import { PROVIDER_SDK_VERSION, type ProviderModule } from "@getpaseo/provider-sdk";
import type { ProviderOverride } from "@getpaseo/protocol/provider-config";
import type { Logger } from "pino";

export interface ProviderLoadFailure {
  id: string;
  error: string;
}

export async function loadProviderModules(
  overrides: Record<string, ProviderOverride>,
  paseoHome: string,
  logger: Logger,
): Promise<{ modules: ProviderModule[]; failures: ProviderLoadFailure[] }> {
  const modules: ProviderModule[] = [];
  const failures: ProviderLoadFailure[] = [];

  for (const [id, override] of Object.entries(overrides)) {
    if (!override.module) continue;

    const specifier = override.module;
    try {
      const resolvedPath = isAbsolute(specifier)
        ? specifier
        : createRequire(join(paseoHome, "providers", "package.json")).resolve(specifier);
      // Provider specifiers are chosen at runtime from user configuration.
      const loaded = await import(pathToFileURL(resolvedPath).href);
      const candidate = loaded.default;

      if (!candidate || typeof candidate !== "object") {
        throw new Error("default export must be a provider module object");
      }

      const definition = AgentProviderDefinitionSchema.parse(candidate.definition);
      if (definition.id !== id) {
        throw new Error(`definition id "${definition.id}" does not match configured id "${id}"`);
      }
      if (typeof candidate.createClient !== "function") {
        throw new Error("default export createClient must be a function");
      }
      if (
        typeof candidate.sdkVersion === "string" &&
        candidate.sdkVersion.split(".", 1)[0] !== PROVIDER_SDK_VERSION.split(".", 1)[0]
      ) {
        throw new Error(
          `sdkVersion "${candidate.sdkVersion}" is incompatible with provider SDK ${PROVIDER_SDK_VERSION}`,
        );
      }

      modules.push({ ...candidate, definition } as ProviderModule);
    } catch (cause) {
      // A hostile module can throw a value whose toString itself throws;
      // detail extraction must never let that escape the loader boundary.
      let detail: string;
      try {
        detail = cause instanceof Error ? cause.message : String(cause);
      } catch {
        detail = "threw a value that could not be stringified";
      }
      const error = `Failed to load provider module "${specifier}": ${detail}`;
      failures.push({ id, error });
      try {
        logger.warn({ err: cause, providerId: id, specifier }, error);
      } catch {
        // Logging must not let a provider loading failure escape this boundary.
      }
    }
  }

  return { modules, failures };
}
