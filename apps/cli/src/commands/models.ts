import { resolve } from 'node:path';
import { resolveModel } from '@shibaox/core';
import { loadCatalog, ProviderRegistry } from '@shibaox/providers';
import { loadOrg, type Org } from '@shibaox/schemas';

/** Runtimes that exist in phase 1B-1 (the Claude Code adapter comes in 1B-2). */
export const AVAILABLE_RUNTIMES = ['mock', 'direct'];

/** How each org role resolves to a model; a role that cannot resolve prints `!! <reason>`. */
export function formatModels(org: Org, reg: ProviderRegistry): string[] {
  const providers = reg.list().map((e) => ({
    id: e.id,
    via_runtime: e.via_runtime,
    configured: reg.isConfigured(e.id).ok,
  }));
  const lines: string[] = [];
  for (const role of Object.values(org.roles)) {
    const head = `${role.role.padEnd(22)} ${role.model_tier.padEnd(8)}`;
    try {
      const { resolution: r, warnings } = resolveModel({
        role,
        models: org.models,
        providers,
        runtimes: AVAILABLE_RUNTIMES,
      });
      const target =
        r.kind === 'direct'
          ? `direct ${r.ref}`
          : `runtime ${r.runtime}${r.model ? ` (${r.model})` : ''}`;
      lines.push(`${head} → ${target}${warnings.length ? `  [${warnings.join('; ')}]` : ''}`);
    } catch (err) {
      lines.push(`${head} !! ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return lines;
}

export function modelsCommand(o: { org: string }): void {
  const org = loadOrg(resolve(o.org));
  for (const l of formatModels(org, new ProviderRegistry(loadCatalog()))) console.log(l);
}
