import type { ConnectorTemplate, McpAddRequest, RoleRow } from '@wizardingcode/shibaox-daemon';
import type { McpServerInput } from '@wizardingcode/shibaox-schemas';
import { useState } from 'react';
import { ds } from '../../../ds.js';
import { useAppState, useStore } from '../../../store/hooks.js';
import { headerLines, ID_RE, words } from '../filter.js';
import { KEY_NAME_RE } from '../needed-keys.js';
import { RoleChecks } from '../parts.js';
import type { McpRow } from '../types.js';

// biome-ignore lint/suspicious/noTemplateCurlyInString: the catalog's own ${KEY} placeholder, expanded by the daemon
const HEADER_EXAMPLE = 'Authorization: Bearer ${ACME_API_KEY}';
// biome-ignore lint/suspicious/noTemplateCurlyInString: the catalog's own ${KEY} placeholder, expanded by the daemon
const HEADER_HINT = 'One per line, Name: value; ${KEY} becomes that vault key (it joins Keys)';

const defaultRoles = (roles: RoleRow[]) =>
  roles.some((r) => r.id === 'assistant') ? ['assistant'] : [];

/** A key a connector needs: set (a badge), or a password field with Save and where to get one. */
function KeyField(props: {
  name: string;
  description?: string;
  signupUrl?: string;
  /** The server works without it. */
  optional?: boolean;
}): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  const row = state.customize?.keys.find((k) => k.name === props.name);
  const [value, setValue] = useState('');
  return (
    <div className="stack">
      <div className="row">
        <span className="mono">{props.name}</span>
        {props.optional ? <S.Badge>optional</S.Badge> : null}
        {props.description ? <span className="muted">{props.description}</span> : null}
        <span className="grow" />
        {row?.set ? (
          <S.Badge tone="matcha" icon="check">
            {`set${row.source === 'env' ? ' · env' : ''}`}
          </S.Badge>
        ) : null}
      </div>
      {row?.set ? null : (
        <div className="key-set">
          <S.Input
            type="password"
            aria-label={props.name}
            placeholder="Paste the key"
            value={value}
            onChange={(e) => setValue((e.target as HTMLInputElement).value)}
          />
          <S.Button
            size="sm"
            disabled={!value.trim()}
            onClick={() => {
              void store.setKey(props.name, value.trim());
              setValue('');
            }}
          >
            Save key
          </S.Button>
          {props.signupUrl ? (
            <a
              className="sx-btn sx-btn--quiet sx-btn--sm"
              href={props.signupUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Get a key
            </a>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** "Add <name>" for a registry connector: its keys (set inline) and the roles to attach. */
export function TemplateDialog(props: {
  template: ConnectorTemplate;
  roles: RoleRow[];
  onClose: () => void;
}): JSX.Element {
  const S = ds();
  const store = useStore();
  const t = props.template;
  const [roles, setRoles] = useState<string[]>(defaultRoles(props.roles));
  const [saving, setSaving] = useState(false);
  return (
    <S.Dialog
      open
      title={`Add ${t.name}`}
      description={t.description}
      icon="plug"
      width={520}
      onClose={props.onClose}
      footer={
        <>
          <S.Button variant="quiet" onClick={props.onClose}>
            Cancel
          </S.Button>
          <S.Button
            variant="primary"
            loading={saving}
            onClick={() => {
              setSaving(true);
              void store
                .addMcp({
                  id: t.id,
                  description: t.description,
                  tags: [t.category],
                  server: t.server,
                  roles,
                })
                .then((ok) => {
                  setSaving(false);
                  if (ok) props.onClose();
                });
            }}
          >
            Add
          </S.Button>
        </>
      }
    >
      <div className="form">
        <p className="muted">
          {`by ${t.vendor} · ${t.server.transport === 'http' ? t.server.url : [t.server.command, ...(t.server.args ?? [])].join(' ')}`}
        </p>
        {t.keys.length && t.note ? <p className="muted">{t.note}</p> : null}
        {t.keys.length ? (
          t.keys.map((k) => (
            <KeyField
              key={k.name}
              name={k.name}
              description={k.description}
              signupUrl={k.signupUrl}
              optional={k.optional}
            />
          ))
        ) : (
          <p className="muted">{t.note ?? 'It needs no key.'}</p>
        )}
        <RoleChecks roles={props.roles} value={roles} onChange={setRoles} />
      </div>
    </S.Dialog>
  );
}

export interface CustomForm {
  id: string;
  description: string;
  transport: 'http' | 'stdio';
  url: string;
  /** stdio: the executable alone. */
  command: string;
  /** stdio: one argument per line (spaces inside an argument are kept). */
  args: string;
  /** stdio: `NAME=value` lines (fixed environment, never secrets). */
  env: string;
  keys: string;
  headers: string;
  bearer: string;
  tools: string;
  timeoutS: string;
  roles: string[];
  /** Edit: the bearer command as written (kept when the field is not changed). */
  bearerArgv?: string[];
}

export const emptyCustom = (roles: RoleRow[]): CustomForm => ({
  id: '',
  description: '',
  transport: 'http',
  url: '',
  command: '',
  args: '',
  env: '',
  keys: '',
  headers: '',
  bearer: '',
  tools: '',
  timeoutS: '',
  roles: defaultRoles(roles),
});

/** The Edit… form of a catalog server: the raw server the daemon read (else what the row says). */
export function formOf(row: McpRow, roles: RoleRow[]): CustomForm {
  const s = row.server;
  const base = {
    ...emptyCustom(roles),
    id: row.id,
    description: row.description,
    roles: row.roles,
  };
  if (!s)
    return {
      ...base,
      transport: row.transport,
      url: row.transport === 'http' ? row.target : '',
      command: row.transport === 'stdio' ? row.target : '',
      keys: row.keys.map((k) => k.name).join(', '),
      tools: (row.tools ?? []).join(', '),
    };
  return {
    ...base,
    transport: s.transport,
    url: s.url ?? '',
    command: s.command ?? '',
    args: (s.args ?? []).join('\n'),
    env: Object.entries(s.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    keys: (s.env_keys ?? []).join(', '),
    headers: Object.entries(s.headers ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
    bearer: (s.bearer_command ?? []).join(' '),
    ...(s.bearer_command ? { bearerArgv: s.bearer_command } : {}),
    tools: (s.tools ?? []).join(', '),
    timeoutS: s.timeout_ms && s.timeout_ms !== 30_000 ? String(s.timeout_ms / 1000) : '',
  };
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** `NAME=value` lines into an object (lines without `=` are skipped). */
function envLines(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines(s)) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}

/** The request a custom connector form makes: only the fields that were filled. */
export function customRequest(f: CustomForm, replace: boolean): McpAddRequest {
  const keys = words(f.keys);
  const tools = words(f.tools);
  const timeout = Number.parseFloat(f.timeoutS);
  const common = {
    ...(keys.length ? { env_keys: keys } : {}),
    ...(tools.length ? { tools } : {}),
    ...(timeout > 0 ? { timeout_ms: Math.round(timeout * 1000) } : {}),
  };
  const { env_keys, ...rest } = common;
  let server: McpServerInput;
  if (f.transport === 'http') {
    const headers = headerLines(f.headers);
    const bearer =
      f.bearerArgv && f.bearer === f.bearerArgv.join(' ')
        ? f.bearerArgv
        : f.bearer.trim().split(/\s+/).filter(Boolean);
    server = {
      transport: 'http',
      url: f.url.trim(),
      ...(env_keys ? { env_keys } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(bearer.length ? { bearer_command: bearer } : {}),
      ...rest,
    };
  } else {
    const args = lines(f.args);
    const env = envLines(f.env);
    server = {
      transport: 'stdio',
      command: f.command.trim(),
      ...(args.length ? { args } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(env_keys ? { env_keys } : {}),
      ...rest,
    };
  }
  return {
    id: f.id.trim(),
    description: f.description.trim() || f.id.trim(),
    server,
    roles: f.roles,
    ...(replace ? { replace: true } : {}),
  };
}

/**
 * Why the daemon would refuse this id for an MCP server (the schemas' `Id` plus core's
 * `mcpIdProblem`), or undefined.
 */
export function mcpIdError(id: string): string | undefined {
  if (!ID_RE.test(id)) return 'Letters, digits, - and _';
  if (id === 'shibaox' || id === 'graphify') return `"${id}" is reserved for a built-in server`;
  if (id.includes(':') || id.includes('__')) return 'No ":" or "__" (it becomes a tool name)';
  return undefined;
}

/** "Add a custom connector" (and Edit…): any MCP server by URL or command. */
export function CustomConnectorDialog(props: {
  roles: RoleRow[];
  initial?: CustomForm;
  /** Edit: the id is fixed, the file is replaced and the roles become exactly the ones ticked. */
  editing?: boolean;
  onClose: () => void;
}): JSX.Element {
  const S = ds();
  const store = useStore();
  const [f, setF] = useState<CustomForm>(props.initial ?? emptyCustom(props.roles));
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<CustomForm>) => setF((x) => ({ ...x, ...patch }));
  const field = (k: keyof CustomForm) => (e: { target: EventTarget | null }) =>
    set({ [k]: (e.target as HTMLInputElement).value } as Partial<CustomForm>);
  const idError = mcpIdError(f.id.trim());
  const commandSpaced = /\s/.test(f.command.trim());
  const keysError = words(f.keys).some((k) => !KEY_NAME_RE.test(k))
    ? 'Keys are the UPPER_CASE names of vault entries (ACME_KEY), never a value: paste the value in Keys and write its name here'
    : undefined;
  const target =
    f.transport === 'http'
      ? /^https?:\/\/\S+$/.test(f.url.trim())
      : !!f.command.trim() && !commandSpaced;
  return (
    <S.Dialog
      open
      title={props.editing ? `Edit ${f.id}` : 'Add a custom connector'}
      description="Any MCP server: a URL (Streamable HTTP) or a command on the daemon's machine (stdio)."
      icon="plug"
      width={560}
      onClose={props.onClose}
      footer={
        <>
          <S.Button variant="quiet" onClick={props.onClose}>
            Cancel
          </S.Button>
          <S.Button
            variant="primary"
            loading={saving}
            disabled={!!idError || !!keysError || !target}
            onClick={() => {
              setSaving(true);
              void store.addMcp(customRequest(f, props.editing === true)).then((ok) => {
                setSaving(false);
                if (ok) props.onClose();
              });
            }}
          >
            {props.editing ? 'Save' : 'Add'}
          </S.Button>
        </>
      }
    >
      <div className="form">
        <S.Input
          label="Id"
          placeholder="acme"
          value={f.id}
          disabled={props.editing}
          error={f.id && idError ? idError : undefined}
          onChange={field('id')}
        />
        <S.Input
          label="Description"
          placeholder="What it gives the agent"
          value={f.description}
          onChange={field('description')}
        />
        <div className="stack">
          <span className="sx-field__label">Transport</span>
          <S.Segmented
            label="Transport"
            items={[
              { id: 'http', label: 'http' },
              { id: 'stdio', label: 'stdio' },
            ]}
            value={f.transport}
            onChange={(id) => set({ transport: id as 'http' | 'stdio' })}
          />
        </div>
        {f.transport === 'http' ? (
          <S.Input
            label="URL"
            placeholder="https://mcp.example.com/mcp"
            value={f.url}
            onChange={field('url')}
          />
        ) : (
          <>
            <S.Input
              label="Command"
              placeholder="npx"
              hint="The executable alone, found on the daemon's PATH"
              error={commandSpaced ? 'One word: the arguments go below' : undefined}
              value={f.command}
              onChange={field('command')}
            />
            <S.Textarea
              label="Arguments"
              placeholder={'-y\n@scope/server\n--flag'}
              hint="One per line (spaces inside an argument are kept)"
              rows={3}
              className="mono"
              value={f.args}
              onChange={field('args')}
            />
            <S.Textarea
              label="Environment"
              placeholder="DEBUG=1"
              hint="NAME=value, one per line; never secrets (those are Keys)"
              rows={2}
              className="mono"
              value={f.env}
              onChange={field('env')}
            />
          </>
        )}
        <S.Input
          label="Keys"
          placeholder="ACME_API_KEY"
          hint="Vault keys it needs, comma separated (set them in Keys)"
          value={f.keys}
          onChange={field('keys')}
          error={keysError}
        />
        {f.transport === 'http' ? (
          <>
            <S.Textarea
              label="Headers"
              placeholder={HEADER_EXAMPLE}
              hint={HEADER_HINT}
              rows={2}
              value={f.headers}
              onChange={field('headers')}
            />
            <S.Input
              label="Bearer command"
              placeholder="acme auth token"
              hint="Its output is the token (a CLI's login instead of a key)"
              value={f.bearer}
              onChange={field('bearer')}
            />
          </>
        ) : null}
        <S.Input
          label="Tools"
          placeholder="All of them"
          hint="Only these tools, comma separated"
          value={f.tools}
          onChange={field('tools')}
        />
        <S.Input
          label="Timeout (seconds)"
          placeholder="30"
          inputMode="decimal"
          value={f.timeoutS}
          onChange={field('timeoutS')}
        />
        <RoleChecks roles={props.roles} value={f.roles} onChange={(roles) => set({ roles })} />
      </div>
    </S.Dialog>
  );
}
