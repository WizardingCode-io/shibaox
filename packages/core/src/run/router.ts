import type { Models, Role } from '@wizardingcode/shibaox-schemas';

export type ModelResolution =
  | { kind: 'direct'; ref: string; provider: string; model: string }
  | { kind: 'runtime'; runtime: string; model?: string; ref?: string };
export interface RouterProvider {
  id: string;
  via_runtime?: string;
  configured: boolean;
}

function splitRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf('/');
  if (i <= 0 || i === ref.length - 1)
    throw new Error(`model ref "${ref}" must look like <provider>/<model>`);
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

export function resolveModel(args: {
  role: Role;
  models: Models;
  providers: RouterProvider[];
  runtimes: string[];
  defaultAdapter?: string;
}): { resolution: ModelResolution; warnings: string[] } {
  const warnings: string[] = [];
  const override = args.models.roles[args.role.role];
  if (args.defaultAdapter && args.defaultAdapter !== 'direct')
    return {
      resolution: {
        kind: 'runtime',
        runtime: args.defaultAdapter,
        model: override?.model ? splitRef(override.model).model : undefined,
        ref: override?.model,
      },
      warnings,
    };
  const ref = override?.model ?? args.models.tiers[args.role.model_tier];
  if (!ref)
    throw new Error(
      `no model configured for tier "${args.role.model_tier}" (set models.yaml tiers.${args.role.model_tier})`,
    );
  const { provider, model } = splitRef(ref);
  const p = args.providers.find((x) => x.id === provider);
  if (!p) throw new Error(`unknown provider "${provider}" in model ref "${ref}"`);
  if (p.via_runtime) {
    if (args.defaultAdapter === 'direct')
      throw new Error(
        `provider "${provider}" is only reachable via runtime "${p.via_runtime}"; it cannot run directly`,
      );
    return { resolution: { kind: 'runtime', runtime: p.via_runtime, model, ref }, warnings };
  }
  if (!p.configured)
    throw new Error(
      `provider "${provider}" is not configured (run: shibaox providers test ${provider})`,
    );
  const preferred = override?.runtime ?? args.role.runtime;
  if (
    args.defaultAdapter !== 'direct' &&
    preferred === 'claude-code' &&
    provider === 'anthropic' &&
    args.runtimes.includes('claude-code')
  ) {
    return { resolution: { kind: 'runtime', runtime: 'claude-code', model, ref }, warnings };
  }
  if (
    args.defaultAdapter !== 'direct' &&
    preferred !== 'direct' &&
    args.runtimes.includes(preferred)
  ) {
    warnings.push(
      `role "${args.role.role}" prefers runtime "${preferred}" but model "${ref}" is a direct provider; using direct`,
    );
  }
  return { resolution: { kind: 'direct', ref, provider, model }, warnings };
}
