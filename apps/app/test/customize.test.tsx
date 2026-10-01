import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { PluginRow } from '@wizardingcode/shibaox-daemon';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadDesignSystem } from '../src/ds.js';
import { client, mount, PLUGINS, server } from './fixtures.js';

beforeAll(() =>
  loadDesignSystem(
    pathToFileURL(join(process.cwd(), 'vendor/design-system/components/bundle.js')).href,
  ),
);

// biome-ignore lint/suspicious/noTemplateCurlyInString: the catalog's own ${KEY} placeholder
const BEARER = 'Bearer ${ACME_KEY}';
const call = (calls: { name: string; args: unknown[] }[], name: string) =>
  calls.find((x) => x.name === name)?.args;
const tab = (name: string) => screen.getByRole('tab', { name });
const radio = (name: string) => screen.getByRole('radio', { name });
const pickCategory = async (label: RegExp, item: string) => {
  fireEvent.click(screen.getByRole('button', { name: label }));
  fireEvent.click(await screen.findByRole('menuitemradio', { name: item }));
};
const openAdd = async (item: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(item) }));
};

describe('Customize: the route', () => {
  it('the sidebar has Customize in place of Skills and Integrations', async () => {
    const { client: c } = client();
    mount(c);
    const side = screen.getByRole('complementary');
    for (const label of ['Chats', 'Scheduled', 'Customize', 'Memory'])
      expect(within(side).getByText(label)).toBeTruthy();
    expect(within(side).queryByText('Skills')).toBeNull();
    expect(within(side).queryByText('Integrations')).toBeNull();
    fireEvent.click(within(side).getByText('Customize'));
    await waitFor(() => expect(window.location.hash).toBe('#/customize'));
  });

  it('opens on Skills with the five tabs; a tab is part of the route', async () => {
    const { client: c } = client();
    mount(c, { hash: '#/customize' });
    expect(await screen.findByRole('heading', { name: 'Customize' })).toBeTruthy();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Skills', 'Connectors', 'Plugins', 'Keys', 'Models']);
    expect(tab('Skills').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(tab('Keys'));
    await waitFor(() => expect(window.location.hash).toBe('#/customize&tab=keys'));
    await waitFor(() => expect(tab('Keys').getAttribute('aria-selected')).toBe('true'));
  });

  it('old links land on the right tab', async () => {
    const { client: c } = client();
    const ui = mount(c, { hash: '#/skills' });
    await waitFor(() => expect(tab('Skills').getAttribute('aria-selected')).toBe('true'));
    expect(window.location.hash).toBe('#/customize&tab=skills');
    ui.unmount();
    mount(c, { hash: '#/integrations' });
    await waitFor(() => expect(tab('Connectors').getAttribute('aria-selected')).toBe('true'));
    expect(window.location.hash).toBe('#/customize&tab=connectors');
  });
});

describe('Customize: Skills', () => {
  it('Yours lists the skills with who uses them, a dot for an unused one, search, and the workflows', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/customize' });
    await screen.findByText('Brand voice');
    expect(screen.getByText('PDF')).toBeTruthy();
    expect(screen.getByText(/Used by: assistant/)).toBeTruthy();
    expect(screen.getByText('Not used by any role')).toBeTruthy();
    expect(radio('Yours (needs attention)').getAttribute('aria-checked')).toBe('true');
    expect(radio('Yours (needs attention)').querySelector('.sx-seg__dot')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search skills' }), {
      target: { value: 'brand' },
    });
    expect(screen.queryByText('PDF')).toBeNull();
    expect(screen.getByText('Brand voice')).toBeTruthy();
    // the search filters the workflows too
    expect(screen.queryByRole('heading', { name: 'Workflows' })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search skills' }), {
      target: { value: '' },
    });
    // the workflows stay here, with Run task
    expect(screen.getByRole('heading', { name: 'Workflows' })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Run task' })[0] as HTMLElement);
    fireEvent.change(screen.getByLabelText('Request'), { target: { value: 'Add a footer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(call(calls, 'submitRun')?.[0]).toMatchObject({
        workflow: 'chat',
        input: 'Add a footer',
      }),
    );
  });

  it('a run task opens its thread', async () => {
    const { client: c } = client();
    mount(c, { hash: '#/customize' });
    fireEvent.click((await screen.findAllByRole('button', { name: 'Run task' }))[0] as HTMLElement);
    fireEvent.change(screen.getByLabelText('Request'), { target: { value: 'Add a footer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(window.location.hash).toBe('#/t/new-1'));
  });

  it('an org that cannot be found says so (never Reading… forever) and retries', async () => {
    const { client: c } = client({ fail: ['defaultOrg'] });
    mount(c, { hash: '#/customize' });
    expect(await screen.findByText(/Could not read the org: defaultOrg failed/)).toBeTruthy();
    expect(screen.queryByText(/Reading/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('one failing route is the toast; the rest of the tab loads', async () => {
    const { client: c, calls } = client({ fail: ['registrySkills'] });
    mount(c, { hash: '#/customize' });
    expect(await screen.findByText('Brand voice')).toBeTruthy();
    expect(await screen.findByText(/registrySkills failed/)).toBeTruthy();
    // the plugins probe Higgsfield already: it is not read twice
    expect(calls.some((x) => x.name === 'higgsfield')).toBe(false);
  });

  it('a repository must be owner/repo or an https URL (a file URL for a local daemon only)', async () => {
    const { client: c } = client();
    mount(c, { hash: '#/customize' });
    await screen.findByText('Brand voice');
    await openAdd('From a repository');
    const dialog = await screen.findByRole('dialog', { name: 'Add skills from a repository' });
    const look = within(dialog).getByRole('button', { name: 'Look' }) as HTMLButtonElement;
    for (const bad of ['git@github.com:acme/tools.git', 'file:///Users/me/skills', 'acme']) {
      fireEvent.change(within(dialog).getByLabelText('Repository'), { target: { value: bad } });
      expect(look.disabled).toBe(true);
    }
    expect(within(dialog).getByText(/owner\/repo or an https/)).toBeTruthy();
    for (const good of ['acme/tools', 'acme/tools/skills', 'https://git.acme.dev/tools.git']) {
      fireEvent.change(within(dialog).getByLabelText('Repository'), { target: { value: good } });
      expect(look.disabled).toBe(false);
    }
  });

  it('an empty org says how to add a skill', async () => {
    const { client: c } = client({ skills: [] });
    mount(c, { hash: '#/customize&tab=skills' });
    expect(
      await screen.findByText('No skills yet. Add one from a repository or write your own.'),
    ).toBeTruthy();
  });

  it('Roles… puts the skill on the roles ticked (PUT of the whole list)', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/customize' });
    await screen.findByText('Brand voice');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Brand voice' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Roles…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Roles for Brand voice' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Assistant/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(call(calls, 'setRoleLinks')).toEqual([
        '/o',
        'assistant',
        { skills: ['pdf', 'brand-voice'] },
      ]),
    );
    expect(calls.filter((x) => x.name === 'setRoleLinks')).toHaveLength(1);
  });

  it('Remove asks first and needs "detach from roles" while a role uses it', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/customize' });
    await screen.findByText('PDF');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for PDF' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove PDF?' });
    const remove = within(dialog).getByRole('button', { name: 'Remove' }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Detach from roles/ }));
    expect(remove.disabled).toBe(false);
    fireEvent.click(remove);
    await waitFor(() => expect(call(calls, 'removeSkill')).toEqual(['/o', 'pdf', true]));
  });

  it('Discover lists the sources by category; + installs and opens the roles', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/customize' });
    await screen.findByText('Brand voice');
    fireEvent.click(radio('Discover'));
    await waitFor(() => expect(window.location.hash).toBe('#/customize&tab=skills&view=discover'));
    expect(await screen.findByText('xlsx')).toBeTruthy();
    expect(screen.getByText('canvas-design')).toBeTruthy();
    expect(screen.getByText('higgsfield')).toBeTruthy();
    // pdf is already yours
    expect(screen.getByLabelText('pdf is added')).toBeTruthy();
    // the source path is not a folder: it is never a category nor a meta line
    expect(screen.queryByText('skills')).toBeNull();
    expect(screen.getByText('recipes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Category/ }));
    const items = (await screen.findAllByRole('menuitemradio')).map((x) => x.textContent);
    expect(items).toEqual(['All', 'Anthropic skills', 'Higgsfield skills', 'recipes']);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'recipes' }));
    expect(screen.queryByText('xlsx')).toBeNull();
    expect(screen.queryByText('higgsfield')).toBeNull();
    expect(screen.getByText('product-shot')).toBeTruthy();
    await pickCategory(/^Category/, 'Anthropic skills');
    expect(screen.queryByText('product-shot')).toBeNull();
    expect(screen.getByText('canvas-design')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add xlsx' }));
    await waitFor(() =>
      expect(call(calls, 'addSkill')).toEqual([
        '/o',
        { source: 'repo', repo: 'anthropics/skills', path: 'skills', ids: ['xlsx'] },
      ]),
    );
    // each source was read once
    expect(calls.filter((x) => x.name === 'discoverSkills').map((x) => x.args)).toEqual([
      ['anthropics/skills', 'skills'],
      ['higgsfield-ai/skills', undefined],
    ]);
    expect(await screen.findByRole('dialog', { name: 'Roles for xlsx' })).toBeTruthy();
  });

  it('Discover: a source that could not be read has Retry', async () => {
    const { client: c, calls } = client({ discoverFails: 2 });
    mount(c, { hash: '#/customize&tab=skills&view=discover' });
    const retries = await screen.findAllByRole('button', { name: 'Retry' });
    expect(retries).toHaveLength(2);
    expect(screen.getAllByText(/git clone timed out/)).toHaveLength(2);
    fireEvent.click(retries[0] as HTMLElement);
    expect(await screen.findByText('xlsx')).toBeTruthy();
    expect(calls.filter((x) => x.name === 'discoverSkills')).toHaveLength(3);
  });

  it('Open shows the SKILL.md, its path and Copy path', async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t: string) => void writes.push(t) },
    });
    const { client: c, calls } = client();
    mount(c, { hash: '#/customize' });
    await screen.findByText('PDF');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for PDF' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open' }));
    expect(await screen.findByRole('heading', { name: 'PDF guide' })).toBeTruthy();
    expect(screen.getByText('first').tagName).toBe('STRONG');
    expect(call(calls, 'skill')).toEqual(['/o', 'pdf']);
    expect(screen.getByText('/o/skills/pdf/SKILL.md')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy path' }));
    await waitFor(() => expect(writes).toEqual(['/o/skills/pdf/SKILL.md']));
  });

  it('Remove: a 409 from the daemon names the roles and offers to detach', async () => {
    const { client: c, calls } = client({ inUse: ['assistant'] });
    mount(c, { hash: '#/customize' });
    await screen.findByText('Brand voice');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Brand voice' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    let dialog = await screen.findByRole('dialog', { name: 'Remove Brand voice?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    dialog = await screen.findByRole('dialog', { name: 'Remove Brand voice?' });
    expect(within(dialog).getByText(/used by assistant — detach\?/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Detach and remove' }));
    await waitFor(() =>
      expect(calls.filter((x) => x.name === 'removeSkill').map((x) => x.args)).toEqual([
        ['/o', 'brand-voice', false],
        ['/o', 'brand-voice', true],
      ]),
    );
  });

  it('nothing added: the dialog stays open and says why for each id', async () => {
    const { client: c } = client({ skip: { invoice: 'exists', pdf: 'symlink' } });
    mount(c, { hash: '#/customize', store: undefined });
    await screen.findByText('Brand voice');
    await openAdd('From a repository');
    const dialog = await screen.findByRole('dialog', { name: 'Add skills from a repository' });
    fireEvent.change(within(dialog).getByLabelText('Repository'), {
      target: { value: 'acme/tools/skills' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Look' }));
    await within(dialog).findByRole('checkbox', { name: /invoice/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install 1' }));
    expect(await within(dialog).findByText(/invoice: already in the org/)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Add skills from a repository' })).toBeTruthy();
  });

  it('some added: the rest and the files left out are a note', async () => {
    const { client: c, calls } = client({
      skip: { pdf: 'too_large' },
      omitted: { xlsx: ['assets/big.bin'] },
    });
    mount(c, { hash: '#/customize&tab=skills&view=discover' });
    fireEvent.click(await screen.findByRole('button', { name: 'Add xlsx' }));
    await waitFor(() => expect(call(calls, 'addSkill')).toBeTruthy());
    expect(await screen.findByText(/assets\/big\.bin/)).toBeTruthy();
  });

  it('From a folder posts the path', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/customize' });
    await screen.findByText('Brand voice');
    await openAdd('From a folder');
    const dialog = await screen.findByRole('dialog', { name: 'Add a skill from a folder' });
    fireEvent.change(within(dialog).getByLabelText('Folder'), {
      target: { value: ' /Users/me/skills/release-notes ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(call(calls, 'addSkill')).toEqual([
        '/o',
        { source: 'folder', path: '/Users/me/skills/release-notes' },
      ]),
    );
    expect(await screen.findByRole('dialog', { name: 'Roles for release-notes' })).toBeTruthy();
  });

  it('From a repository lists what it finds and installs the ones picked', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/customize' });
    await screen.findByText('Brand voice');
    await openAdd('From a repository');
    const dialog = await screen.findByRole('dialog', { name: 'Add skills from a repository' });
    fireEvent.change(within(dialog).getByLabelText('Repository'), {
      target: { value: 'acme/tools/skills' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Look' }));
    await waitFor(() => expect(call(calls, 'discoverSkills')).toEqual(['acme/tools', 'skills']));
    const invoice = (await within(dialog).findByRole('checkbox', {
      name: /invoice/,
    })) as HTMLInputElement;
    expect(invoice.checked).toBe(true);
    const pdf = within(dialog).getByRole('checkbox', { name: /pdf/ }) as HTMLInputElement;
    expect(pdf.disabled).toBe(true);
    expect(within(dialog).getByText('already added')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install 1' }));
    await waitFor(() =>
      expect(call(calls, 'addSkill')).toEqual([
        '/o',
        { source: 'repo', repo: 'acme/tools', path: 'skills', ids: ['invoice'] },
      ]),
    );
  });

  it('a repository that cannot be read says so in the dialog', async () => {
    const { client: c } = client();
    mount(c, { hash: '#/customize' });
    await screen.findByText('Brand voice');
    await openAdd('From a repository');
    const dialog = await screen.findByRole('dialog', { name: 'Add skills from a repository' });
    fireEvent.change(within(dialog).getByLabelText('Repository'), {
      target: { value: 'nope/nope' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Look' }));
    expect(await within(dialog).findByText(/repository not found/)).toBeTruthy();
  });

  it('Write a skill saves SKILL.md inline', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/customize' });
    await screen.findByText('Brand voice');
    await openAdd('Write a skill');
    const dialog = await screen.findByRole('dialog', { name: 'Write a skill' });
    fireEvent.change(within(dialog).getByLabelText('Id'), { target: { value: 'Bad id!' } });
    expect(
      (within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Id'), { target: { value: 'release-notes' } });
    fireEvent.change(within(dialog).getByLabelText('SKILL.md'), {
      target: { value: '---\nname: Release notes\n---\nWrite them.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(call(calls, 'addSkill')).toEqual([
        '/o',
        {
          source: 'inline',
          id: 'release-notes',
          content: '---\nname: Release notes\n---\nWrite them.',
        },
      ]),
    );
  });
});

describe('Customize: Connectors', () => {
  it('Yours: the server, its roles, a missing key that links to Keys, Test inline', async () => {
    const { client: c } = client();
    mount(c, { hash: '#/customize&tab=connectors' });
    await screen.findByText('playwright');
    expect(screen.getByText(/npx -y @playwright\/mcp/)).toBeTruthy();
    expect(screen.getByText(/Roles: browser-qa/)).toBeTruthy();
    expect(radio('Yours (needs attention)').querySelector('.sx-seg__dot')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText(/1 tool: browser_navigate/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'PW_TOKEN missing' }));
    await waitFor(() => expect(window.location.hash).toBe('#/customize&tab=keys&key=PW_TOKEN'));
  });

  it('Discover: the registry by category; + asks for the keys and the roles, then adds', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/customize&tab=connectors&view=discover' });
    await screen.findByText('Firecrawl');
    expect(screen.getByText('GitHub')).toBeTruthy();
    expect(screen.getByLabelText('Playwright is added')).toBeTruthy();
    expect(screen.getAllByText('verified').length).toBe(2);
    expect(screen.getByText(/Signs in on first use/)).toBeTruthy();
    await pickCategory(/^Category/, 'Search');
    expect(screen.queryByText('GitHub')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add Firecrawl' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Firecrawl' });
    expect(
      within(dialog)
        .getByRole('link', { name: /Get a key/ })
        .getAttribute('href'),
    ).toBe('https://firecrawl.dev');
    fireEvent.change(within(dialog).getByLabelText('FIRECRAWL_API_KEY'), {
      target: { value: 'fc-123' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(call(calls, 'setKey')).toEqual(['FIRECRAWL_API_KEY', 'fc-123']));
    expect(
      (within(dialog).getByRole('checkbox', { name: /Assistant/ }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(call(calls, 'addMcp')).toEqual([
        '/o',
        {
          id: 'firecrawl',
          description: 'Scrape and crawl websites',
          tags: ['Search'],
          server: server({
            transport: 'stdio',
            command: 'npx',
            args: ['-y', 'firecrawl-mcp'],
            env_keys: ['FIRECRAWL_API_KEY'],
          }),
          roles: ['assistant'],
        },
      ]),
    );
  });

  it('Yours: a failed Test puts the dot on Yours; the category filter has Custom', async () => {
    const { client: c } = client({
      mcpTestFails: true,
      mcp: [
        {
          id: 'playwright',
          description: 'A browser',
          transport: 'stdio',
          target: 'npx -y @playwright/mcp',
          roles: [],
          keys: [],
        },
        {
          id: 'acme',
          description: 'Acme search',
          transport: 'http',
          target: 'https://mcp.acme.dev/mcp',
          roles: [],
          keys: [],
        },
      ],
    });
    mount(c, { hash: '#/customize&tab=connectors' });
    await screen.findByText('acme');
    expect(radio('Yours').querySelector('.sx-seg__dot')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Test' })[1] as HTMLElement);
    expect(await screen.findByText('spawn npx ENOENT')).toBeTruthy();
    expect(radio('Yours (needs attention)').querySelector('.sx-seg__dot')).toBeTruthy();
    await pickCategory(/^Category/, 'Custom');
    expect(screen.queryByText('playwright')).toBeNull();
    expect(screen.getByText('acme')).toBeTruthy();
    await pickCategory(/^Category/, 'Browser');
    expect(screen.getByText('playwright')).toBeTruthy();
    expect(screen.queryByText('acme')).toBeNull();
  });

  it('a template note is said as written; an optional key says so', async () => {
    const { client: c } = client();
    mount(c, { hash: '#/customize&tab=connectors&view=discover' });
    fireEvent.click(await screen.findByRole('button', { name: 'Add Notion' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Notion' });
    expect(
      within(dialog).getByText('Signs in on first use (OAuth in the browser); no key to set.'),
    ).toBeTruthy();
  });

  it('a connector id follows the daemon rule', async () => {
    const { client: c } = client();
    mount(c, { hash: '#/customize&tab=connectors' });
    await screen.findByText('playwright');
    await openAdd('Custom connector');
    const dialog = await screen.findByRole('dialog', { name: 'Add a custom connector' });
    fireEvent.change(within(dialog).getByLabelText('URL'), {
      target: { value: 'https://mcp.acme.dev/mcp' },
    });
    const add = within(dialog).getByRole('button', { name: 'Add' }) as HTMLButtonElement;
    for (const [id, why] of [
      ['acme:search', /No ":" or "__"/],
      ['acme__x', /No ":" or "__"/],
      ['shibaox', /reserved/],
    ] as const) {
      fireEvent.change(within(dialog).getByLabelText('Id'), { target: { value: id } });
      expect(add.disabled).toBe(true);
      expect(within(dialog).getByText(why)).toBeTruthy();
    }
    fireEvent.change(within(dialog).getByLabelText('Id'), { target: { value: 'acme' } });
    expect(add.disabled).toBe(false);
  });

  it('a custom connector posts exactly what the form says', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/customize&tab=connectors' });
    await screen.findByText('playwright');
    await openAdd('Custom connector');
    const dialog = await screen.findByRole('dialog', { name: 'Add a custom connector' });
    const set = (label: string, value: string) =>
      fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
    set('Id', 'acme');
    set('Description', 'Acme search');
    set('URL', 'https://mcp.acme.dev/mcp');
    set('Keys', 'ACME_KEY');
    set('Headers', `Authorization: ${BEARER}`);
    set('Tools', 'search, fetch');
    set('Timeout (seconds)', '45');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Browser QA/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(call(calls, 'addMcp')).toEqual([
        '/o',
        {
          id: 'acme',
          description: 'Acme search',
          server: {
            transport: 'http',
            url: 'https://mcp.acme.dev/mcp',
            env_keys: ['ACME_KEY'],
            headers: { Authorization: BEARER },
            tools: ['search', 'fetch'],
            timeout_ms: 45000,
          },
          roles: ['assistant', 'browser-qa'],
        },
      ]),
    );
  });

  it('a stdio custom connector sends the command and its arguments', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/customize&tab=connectors' });
    await screen.findByText('playwright');
    await openAdd('Custom connector');
    const dialog = await screen.findByRole('dialog', { name: 'Add a custom connector' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'stdio' }));
    fireEvent.change(within(dialog).getByLabelText('Id'), { target: { value: 'files' } });
    fireEvent.change(within(dialog).getByLabelText('Command'), { target: { value: 'npx' } });
    // one argument per line: a path with a space stays one argument
    fireEvent.change(within(dialog).getByLabelText('Arguments'), {
      target: { value: '-y\n@modelcontextprotocol/server-filesystem\n/tmp/my files\n' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Assistant/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(call(calls, 'addMcp')).toEqual([
        '/o',
        {
          id: 'files',
          description: 'files',
          server: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/my files'],
          },
          roles: [],
        },
      ]),
    );
  });

  it('Edit… starts from the server as written and replaces it, roles as ticked', async () => {
    const { client: c, calls } = client({
      mcp: [
        {
          id: 'playwright',
          description: 'A browser',
          transport: 'stdio',
          target: 'npx -y @playwright/mcp --viewport-size 1280, 720',
          tools: ['browser_navigate'],
          roles: ['browser-qa'],
          keys: [{ name: 'PW_TOKEN', present: false }],
          server: server({
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@playwright/mcp', '--viewport-size', '1280, 720'],
            env: { DEBUG: 'pw' },
            env_keys: ['PW_TOKEN'],
            tools: ['browser_navigate'],
            timeout_ms: 60_000,
          }),
        },
        {
          id: 'acme',
          description: 'Acme search',
          transport: 'http',
          target: 'https://mcp.acme.dev/mcp',
          roles: ['assistant'],
          keys: [{ name: 'ACME_KEY', present: true }],
          server: server({
            transport: 'http',
            url: 'https://mcp.acme.dev/mcp',
            headers: { Authorization: BEARER },
            env_keys: ['ACME_KEY'],
            bearer_command: ['acme', 'auth', 'print token'],
          }),
        },
      ],
    });
    mount(c, { hash: '#/customize&tab=connectors' });
    await screen.findByText('playwright');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for playwright' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit…' }));
    let dialog = await screen.findByRole('dialog', { name: 'Edit playwright' });
    const value = (label: string) =>
      (within(dialog).getByLabelText(label) as HTMLInputElement).value;
    expect(value('Command')).toBe('npx');
    expect(value('Arguments')).toBe('-y\n@playwright/mcp\n--viewport-size\n1280, 720');
    expect(value('Environment')).toBe('DEBUG=pw');
    expect(value('Keys')).toBe('PW_TOKEN');
    expect(value('Tools')).toBe('browser_navigate');
    expect(value('Timeout (seconds)')).toBe('60');
    const qa = within(dialog).getByRole('checkbox', { name: /Browser QA/ }) as HTMLInputElement;
    expect(qa.checked).toBe(true);
    // unticking detaches: the daemon replaces the attachment set
    fireEvent.click(qa);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(call(calls, 'addMcp')).toEqual([
        '/o',
        {
          id: 'playwright',
          description: 'A browser',
          server: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@playwright/mcp', '--viewport-size', '1280, 720'],
            env: { DEBUG: 'pw' },
            env_keys: ['PW_TOKEN'],
            tools: ['browser_navigate'],
            timeout_ms: 60_000,
          },
          roles: [],
          replace: true,
        },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // an http server keeps its headers and its bearer command as they were
    fireEvent.click(screen.getByRole('button', { name: 'Actions for acme' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit…' }));
    dialog = await screen.findByRole('dialog', { name: 'Edit acme' });
    expect(value('Headers')).toBe(`Authorization: ${BEARER}`);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.filter((x) => x.name === 'addMcp')[1]?.args).toEqual([
        '/o',
        {
          id: 'acme',
          description: 'Acme search',
          server: {
            transport: 'http',
            url: 'https://mcp.acme.dev/mcp',
            env_keys: ['ACME_KEY'],
            headers: { Authorization: BEARER },
            bearer_command: ['acme', 'auth', 'print token'],
          },
          roles: ['assistant'],
          replace: true,
        },
      ]),
    );
  });

  it('Roles… puts the connector on the roles ticked (a PUT per role that changed)', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/customize&tab=connectors' });
    await screen.findByText('playwright');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for playwright' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Roles…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Roles for playwright' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Assistant/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Browser QA/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.filter((x) => x.name === 'setRoleLinks').map((x) => x.args)).toEqual([
        ['/o', 'assistant', { mcp: ['playwright'] }],
        ['/o', 'browser-qa', { mcp: [] }],
      ]),
    );
  });

  it('Remove asks first, then deletes', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/customize&tab=connectors' });
    await screen.findByText('playwright');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for playwright' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove playwright?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(call(calls, 'removeMcp')).toEqual(['/o', 'playwright']));
  });
});

describe('Customize: Plugins', () => {
  it('Yours shows what is set up, with its checks, its actions and what it brings', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/customize&tab=plugins' });
    await screen.findByText('Higgsfield');
    expect(screen.getByText('GitHub')).toBeTruthy();
    expect(screen.queryByText('Telegram')).toBeNull();
    expect(screen.getByText('CLI installed')).toBeTruthy();
    // GH_TOKEN or GITHUB_TOKEN: one need, met
    expect(screen.queryByRole('button', { name: 'GITHUB_TOKEN missing' })).toBeNull();
    expect(screen.getByText('GH_TOKEN or GITHUB_TOKEN')).toBeTruthy();
    expect(screen.getByText(/andre@example\.com/)).toBeTruthy();
    expect(screen.getByText(/3\.5 credits/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create an account' }).getAttribute('href')).toBe(
      'https://higgsfield.ai?fpr=andre-4fae29',
    );
    expect(screen.getByText(/affiliate link/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(calls.some((x) => x.name === 'higgsfieldLogin')).toBe(true));
    const reads = calls.filter((x) => x.name === 'plugins').length;
    fireEvent.click(screen.getAllByRole('button', { name: 'Check again' })[0] as HTMLElement);
    await waitFor(() =>
      expect(calls.filter((x) => x.name === 'plugins').length).toBeGreaterThan(reads),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add skill higgsfield' }));
    await waitFor(() =>
      expect(call(calls, 'addSkill')).toEqual([
        '/o',
        { source: 'repo', repo: 'higgsfield-ai/skills', ids: ['higgsfield'] },
      ]),
    );
    expect(await screen.findByRole('dialog', { name: 'Roles for higgsfield' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // github brings a connector from the registry: + opens its dialog
    fireEvent.click(screen.getByRole('button', { name: 'Add connector github' }));
    expect(await screen.findByRole('dialog', { name: 'Add GitHub' })).toBeTruthy();
  });

  it('actions: Log in POSTs through the store, Install copies its command, links open apart', async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t: string) => void writes.push(t) },
    });
    const { client: c, calls } = client({
      plugins: [
        {
          ...(PLUGINS[0] as PluginRow),
          actions: [
            ...(PLUGINS[0] as PluginRow).actions,
            { id: 'mystery', label: 'Mystery', href: '/somewhere/else' },
            { id: 'nothing', label: 'Nothing' },
          ],
        },
        PLUGINS[1] as PluginRow,
      ],
    });
    mount(c, { hash: '#/customize&tab=plugins' });
    await screen.findByText('Higgsfield');
    // a daemon path is never a link
    expect(screen.queryByRole('link', { name: 'Log in' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(calls.some((x) => x.name === 'higgsfieldLogin')).toBe(true));
    // the action's own command, not the one of the Higgsfield view
    fireEvent.click(screen.getByRole('button', { name: 'Install command' }));
    await waitFor(() =>
      expect(writes).toEqual(['curl -fsSL https://higgsfield.ai/cli/install.sh | sh']),
    );
    for (const name of ['Create an account', 'Open Higgsfield', 'Install gh', 'Create a token']) {
      const a = screen.getByRole('link', { name });
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      expect(a.getAttribute('href')).toMatch(/^https:\/\//);
    }
    // neither a usable link nor a known id: hidden
    expect(screen.queryByText('Mystery')).toBeNull();
    expect(screen.queryByText('Nothing')).toBeNull();
  });

  it('Add skill says why when the source does not have it', async () => {
    const { client: c } = client({ skip: { higgsfield: 'not_found' } });
    mount(c, { hash: '#/customize&tab=plugins' });
    fireEvent.click(await screen.findByRole('button', { name: 'Add skill higgsfield' }));
    expect(await screen.findByText(/higgsfield: not found in the source/)).toBeTruthy();
  });

  it('Discover shows the rest; there is no Add for plugins', async () => {
    const { client: c } = client();
    mount(c, { hash: '#/customize&tab=plugins&view=discover' });
    await screen.findByText('Telegram');
    expect(screen.queryByText('Higgsfield')).toBeNull();
    expect(screen.getByRole('link', { name: 'Channel docs' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('menuitem', { name: /Plugins are built in/ })).toBeTruthy();
  });
});

describe('Customize: Keys', () => {
  const block = (name: string) => screen.getByRole('region', { name });
  const firstCells = (name: string) =>
    within(block(name))
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.querySelector('td')?.textContent ?? '');

  it('Needed now: missing first, with who needs each key; Set saves into the vault', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/customize&tab=keys' });
    await waitFor(() => expect(firstCells('Needed now').length).toBe(3));
    expect(firstCells('Needed now')).toEqual([
      'OPENAI_API_KEY',
      'PW_TOKEN',
      'GH_TOKEN or GITHUB_TOKEN',
    ]);
    const needed = block('Needed now');
    expect(within(needed).getByText('tier cheap')).toBeTruthy();
    expect(within(needed).getByText('role browser-qa')).toBeTruthy();
    expect(within(needed).getByText('connector playwright')).toBeTruthy();
    // Telegram is not set up: its key waits in Other
    expect(within(needed).queryByText('plugin telegram')).toBeNull();
    expect(within(block('Other')).getByText('SHIBAOX_TELEGRAM_TOKEN')).toBeTruthy();
    expect(within(needed).getByText('plugin github')).toBeTruthy();
    fireEvent.change(within(needed).getByLabelText('OPENAI_API_KEY'), {
      target: { value: 'sk-new' },
    });
    fireEvent.click(within(needed).getAllByRole('button', { name: 'Save' })[0] as HTMLElement);
    await waitFor(() => expect(call(calls, 'setKey')).toEqual(['OPENAI_API_KEY', 'sk-new']));
    fireEvent.click(within(needed).getByRole('button', { name: 'Unset GH_TOKEN' }));
    await waitFor(() => expect(call(calls, 'unsetKey')).toEqual(['GH_TOKEN']));
  });

  it('the keys tables keep the field and Save inside (a fixed action column)', async () => {
    const { client: c } = client();
    mount(c, { hash: '#/customize&tab=keys' });
    await waitFor(() => expect(firstCells('Needed now').length).toBe(3));
    for (const name of ['Needed now', 'Providers', 'Other'])
      expect(block(name).querySelector('.keys-table')).toBeTruthy();
  });

  it('a key only in the environment says so, with no Unset', async () => {
    const { client: c } = client({
      mcp: [
        {
          id: 'playwright',
          description: 'A browser',
          transport: 'stdio',
          target: 'npx -y @playwright/mcp',
          roles: [],
          keys: [{ name: 'PW_TOKEN', present: true }],
        },
      ],
    });
    mount(c, { hash: '#/customize&tab=keys' });
    await waitFor(() => expect(firstCells('Needed now')).toContain('PW_TOKEN'));
    const row = within(block('Needed now'))
      .getAllByRole('row')
      .find((r) => r.querySelector('td')?.textContent === 'PW_TOKEN') as HTMLElement;
    expect(within(row).getByText('from the environment')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /Unset/ })).toBeNull();
  });

  it('Providers: the keys in use; Show all providers lists the rest', async () => {
    const { client: c } = client();
    mount(c, { hash: '#/customize&tab=keys' });
    await waitFor(() => expect(firstCells('Providers').length).toBeGreaterThan(0));
    expect(within(block('Providers')).queryByText('MISTRAL_API_KEY')).toBeNull();
    fireEvent.click(within(block('Providers')).getByRole('switch'));
    expect(within(block('Providers')).getByText('MISTRAL_API_KEY')).toBeTruthy();
  });

  it('?key= focuses that row; Other adds a custom key with a valid name', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/customize&tab=keys&key=PW_TOKEN' });
    await waitFor(() =>
      expect((document.activeElement as HTMLInputElement | null)?.getAttribute('aria-label')).toBe(
        'PW_TOKEN',
      ),
    );
    const other = block('Other');
    fireEvent.change(within(other).getByLabelText('New key name'), {
      target: { value: 'bad name' },
    });
    fireEvent.change(within(other).getByLabelText('New key value'), { target: { value: 'v' } });
    expect(
      (within(other).getByRole('button', { name: 'Add key' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(within(other).getByLabelText('New key name'), {
      target: { value: 'ACME_KEY' },
    });
    fireEvent.click(within(other).getByRole('button', { name: 'Add key' }));
    await waitFor(() => expect(call(calls, 'setKey')).toEqual(['ACME_KEY', 'v']));
  });
});

describe('Customize: Models', () => {
  it('tiers on top, the models with a filter, decisions at the bottom', async () => {
    const { client: c, calls } = client();
    mount(c, { hash: '#/customize&tab=models' });
    await screen.findByText('lmstudio/qwen');
    expect(screen.getByText('openai/gpt-5')).toBeTruthy();
    fireEvent.click(radio('Missing key'));
    expect(screen.queryByText('lmstudio/qwen')).toBeNull();
    expect(screen.getByText('openai/gpt-5')).toBeTruthy();
    fireEvent.click(radio('Local'));
    expect(screen.getByText('lmstudio/qwen')).toBeTruthy();
    expect(screen.queryByText('openai/gpt-5')).toBeNull();
    fireEvent.click(radio('All'));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search models' }), {
      target: { value: 'mistral' },
    });
    expect(screen.getByText('openrouter/mistralai/mistral-large')).toBeTruthy();
    expect(screen.queryByText('lmstudio/qwen')).toBeNull();
    // tiers
    fireEvent.change(screen.getByLabelText('Cheap'), { target: { value: 'openai/gpt-5-nano' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save tiers' }));
    await waitFor(() =>
      expect(call(calls, 'setOrgConfig')?.[1]).toMatchObject({
        tiers: { cheap: 'openai/gpt-5-nano' },
      }),
    );
    // decisions
    expect(screen.getByRole('heading', { name: 'Decisions' })).toBeTruthy();
    expect(screen.getByText(/missing OPENROUTER_API_KEY/)).toBeTruthy();
    const row = screen.getByRole('link', { name: /judge/ });
    expect(row.textContent).toMatch(/91%/);
    expect(row.getAttribute('href')).toBe('#/t/root');
  });

  it('Missing runtime: the models whose runtime is not there', async () => {
    const { client: c } = client();
    mount(c, { hash: '#/customize&tab=models' });
    await screen.findByText('lmstudio/qwen');
    fireEvent.click(radio('Missing runtime'));
    expect(screen.getByText('claude-code/opus')).toBeTruthy();
    expect(screen.getByText('no runtime (claude)')).toBeTruthy();
    expect(screen.queryByText('openai/gpt-5')).toBeNull();
    expect(screen.queryByText('lmstudio/qwen')).toBeNull();
  });

  it('the context and the price read like the model menu; a missing key badge keeps its name whole', async () => {
    const { client: c } = client();
    mount(c, { hash: '#/customize&tab=models' });
    await screen.findByText('lmstudio/qwen');
    const row = (ref: string) =>
      screen
        .getAllByRole('row')
        .find((r) => r.querySelector('td')?.textContent === ref) as HTMLElement;
    const cells = (ref: string) =>
      [...row(ref).querySelectorAll('td')].map((td) => td.textContent ?? '');
    expect(cells('openrouter/meta/llama-3.3-70b').slice(2)).toEqual(['131k', '$0.12/$0.30']);
    expect(cells('lmstudio/qwen').slice(2)).toEqual(['—', 'free']);
    expect(cells('anthropic/claude-opus').slice(2)).toEqual(['—', '—']);
    const missing = within(row('openai/gpt-5')).getByRole('button', {
      name: 'OPENAI_API_KEY missing',
    });
    expect(missing.getAttribute('title')).toBe('Missing OPENAI_API_KEY: set it in Keys');
  });

  it('shows 60 models at a time; a search or a filter starts over', async () => {
    const many = Array.from({ length: 130 }, (_, i) => ({
      ref: `openrouter/m-${String(i).padStart(3, '0')}`,
      provider: 'openrouter',
      model: `m-${i}`,
      configured: true,
    }));
    const { client: c } = client({ models: many });
    mount(c, { hash: '#/customize&tab=models' });
    await screen.findByText('openrouter/m-000');
    const shown = () =>
      within(screen.getByRole('region', { name: 'Models' })).getAllByRole('row').length - 1;
    expect(shown()).toBe(60);
    fireEvent.click(screen.getByRole('button', { name: 'Show 60 more' }));
    expect(shown()).toBe(120);
    fireEvent.click(screen.getByRole('button', { name: 'Show 10 more' }));
    expect(shown()).toBe(130);
    expect(screen.queryByRole('button', { name: /Show .* more/ })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search models' }), {
      target: { value: 'm-1' },
    });
    expect(shown()).toBe(30);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search models' }), {
      target: { value: '' },
    });
    expect(shown()).toBe(60);
  });

  it('decisions that cannot be read say so', async () => {
    const { client: c } = client({ fail: ['decisions'] });
    mount(c, { hash: '#/customize&tab=models' });
    expect(await screen.findByText(/The decisions could not be read/)).toBeTruthy();
    expect(screen.queryByText('Reading the daemon…')).toBeNull();
  });

  it('a missing key badge goes to Keys with the key focused', async () => {
    const { client: c } = client();
    mount(c, { hash: '#/customize&tab=models' });
    fireEvent.click(await screen.findByRole('button', { name: 'OPENAI_API_KEY missing' }));
    await waitFor(() =>
      expect(window.location.hash).toBe('#/customize&tab=keys&key=OPENAI_API_KEY'),
    );
  });
});
