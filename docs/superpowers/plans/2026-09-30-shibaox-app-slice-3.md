# App, fatia 3: Electron (macOS) — plano

> Executado inline (testes primeiro, revisão no fim, uma passagem de correcções, merge, release 0.2.3). Spec: `docs/superpowers/specs/2026-09-30-shibaox-app-design.md`.

**Objectivo:** `Shibaox.app` (dmg para macOS) abre a app do browser numa janela: liga-se ao daemon local pelo socket através da ponte, ou a um daemon remoto (`~/.shibaox/remote.json`). Sem funcionalidades próprias.

**Restrição que manda:** o processo principal do Electron não pode importar `@wizardingcode/shibaox-daemon` (better-sqlite3 compilado para a ABI do Node, não do Electron). Logo a ponte e o servidor estático saem para um pacote sem dependências.

## Tarefas

### T1 `packages/bridge` — `@wizardingcode/shibaox-bridge`
- `src/app-static.ts` (movido do daemon: `resolveAppDist`, `serveAppFile`, `APP_MISSING`) e `src/bridge.ts` (movido da CLI: `startBridge`, `Bridge`, `BridgeOptions`); zero dependências.
- O daemon depende de `bridge` e re-exporta (`export * from '@wizardingcode/shibaox-bridge'`) para a API não mudar; a CLI importa `startBridge` do pacote.
- Testes (fecham dois minors adiados da fatia 1): `app-static.test.ts` (content types, cache dos assets, `..` recusado, index para rotas sem extensão, 404 JSON sem dist), `bridge.test.ts` (serve `/app`, 401 sem token, reencaminha com token, 502 com socket morto, SSE passa em streaming, `close()` fecha ligações abertas).

### T2 `apps/desktop` — `@wizardingcode/shibaox-desktop` (privado)
- `src/paths.ts`: `homeRoot(env)` (`SHIBAOX_HOME` | `~/.shibaox`), `socketPath(root)`, `readRemote(root)` → `{baseUrl, token}` | undefined (JSON inválido ou sem baseUrl → undefined com `reason`).
- `src/launch.ts`: `planLaunch(deps)` com dependências injectadas (`remote`, `probe(socket)`, `startDaemon()`, `startBridge(port)`, `sleep`, `ports`): remoto com token → `{kind:'remote', url}`; senão sonda o socket, se morto tenta `startDaemon()` e espera até 15 s; ponte na primeira porta livre de 7434..7443 (origem estável → o localStorage da app sobrevive entre arranques) → `{kind:'bridge', url}`; daemon ainda morto → `{kind:'offline', url}` (a página offline).
- `src/main.ts`: `BrowserWindow` (1280×820, mín. 900×600, `contextIsolation`, `sandbox`, sem `nodeIntegration`), `setWindowOpenHandler`/`will-navigate` → `shell.openExternal` para http(s) fora da ponte; `shibaox-desktop://retry` (link da página offline) repete o arranque; `SHIBAOX_DESKTOP_SMOKE=1` imprime a URL/título carregado e sai (teste de fumo).
- `static/offline.html` com os tokens do design system: "The shibaox daemon is not running", como arrancar (`shibaox daemon start`, `npm i -g shibaox`), botão "Try again".
- `startDaemon()`: `$SHELL -lc 'shibaox daemon start'` (o PATH das apps GUI no macOS não tem o npm global), best effort.
- Build (`build.mjs`): esbuild `src/main.ts` → `dist/main.cjs` (só `electron` externo), copia `dist/` da app para `dist/app/` e `static/` para `dist/`; `build/icon.png` = ícone night 512 do design system. electron-builder (`dist` script): appId `io.wizardingcode.shibaox`, produto "Shibaox", dmg arm64 + x64, `files: dist/**`, sem `node_modules` (nada de runtime), saída `release/` (gitignored). Não assinado (documentar: abrir com control-click / `xattr -d com.apple.quarantine`).
- Testes: `paths.test.ts`, `launch.test.ts` (remoto; daemon vivo → ponte; daemon morto → startDaemon + espera → ponte; nunca sobe → offline; porta ocupada → a seguinte).

### T3 CI e docs
- `.github/workflows/desktop.yml`: em tag `v*` e a pedido, `macos-latest`, `pnpm build`, `pnpm --filter @wizardingcode/shibaox-desktop dist`, e anexa os dmg a uma **release rascunho** da tag (`gh release create --draft` ou `upload --clobber`); nada fica público sem o Andre publicar a release.
- Wiki `App.md` (secção "Desktop app (macOS)"), Installation (linha), README (bullet); release 0.2.3 (15 pacotes publicados: + `shibaox-bridge`; desktop não é publicado no npm).

## Review focus
1. Segurança da janela: `contextIsolation`/`sandbox`, navegação para fora da ponte, o token na URL do renderer (nunca em logs).
2. Arranque do daemon a partir de uma app GUI (PATH, shell de login, daemon já a correr pelo launchd, versão antiga).
3. Porta estável 7434..7443 e o que acontece com duas instâncias.
4. Ponte sem daemon: 502 limpos, SSE, fecho.
5. electron-builder com pnpm: ficheiros incluídos, ícone, dmg em ambas as arquitecturas.
