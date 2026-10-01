import { useEffect } from 'react';
import { ds } from '../../ds.js';
import { customizePath, navigate } from '../../router.js';
import { useAppState, useStore } from '../../store/hooks.js';
import { ConnectorsTab } from './ConnectorsTab.js';
import { KeysTab } from './KeysTab.js';
import { ModelsTab } from './ModelsTab.js';
import { PluginsTab } from './PluginsTab.js';
import { SkillsTab } from './SkillsTab.js';
import { CUSTOMIZE_TABS, type CustomizeTab, type CustomizeView } from './types.js';

/**
 * Customize: everything that extends Shibaox (skills, connectors, plugins), the keys they and
 * the models need, and the models themselves, in one screen with a tab per kind.
 */
export function CustomizeScreen(props: {
  tab: CustomizeTab;
  view: CustomizeView;
  focusKey?: string;
  /** The daemon runs on this machine (a file URL or a path may name a skill repository). */
  local?: boolean;
}): JSX.Element {
  const S = ds();
  const store = useStore();
  const state = useAppState();
  useEffect(() => {
    void store.loadCustomize();
  }, [store]);
  const org = state.customize?.org;
  return (
    <main className="main">
      <div className="top">
        <h2>Customize</h2>
        <S.Tabs
          items={CUSTOMIZE_TABS}
          value={props.tab}
          onChange={(id) => navigate(customizePath({ tab: id as CustomizeTab }))}
        />
        <span className="grow" />
        {org ? (
          <span className="muted mono ellipsis" title={org}>
            {org}
          </span>
        ) : null}
      </div>
      <div className="page sx-scroll">
        {!state.customize && state.customizeError ? (
          <div className="row">
            <p className="note">{`Could not read the org: ${state.customizeError}`}</p>
            <S.Button size="sm" variant="secondary" onClick={() => void store.loadCustomize()}>
              Retry
            </S.Button>
          </div>
        ) : props.tab === 'skills' ? (
          <SkillsTab view={props.view} local={props.local} />
        ) : props.tab === 'connectors' ? (
          <ConnectorsTab view={props.view} />
        ) : props.tab === 'plugins' ? (
          <PluginsTab view={props.view} />
        ) : props.tab === 'keys' ? (
          <KeysTab focus={props.focusKey} />
        ) : (
          <ModelsTab />
        )}
      </div>
    </main>
  );
}
