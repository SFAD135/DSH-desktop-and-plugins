# dsh-session-prompt

A DeepSeek Harness Desktop plugin: **one prompt block per session**, injected at
the head of that session's system prompt and nowhere else.

The composer tool row gets a button labelled **会话提示词**. What you type there
applies to the session you are in. Open a second session, type something else,
and the two never see each other's text.

While the current session has a non-empty prompt, the button turns the same
blue as the composer's send button, so the active state is visible at a glance
without opening the dialog.

The dialog carries a per-session **启用** switch. Switching it off keeps the
text but stops injecting it, and the composer button stops being blue right
away — so you can park a prompt for later without retyping it.

---

## Behaviour

| | |
|---|---|
| Scope | The session you opened the dialog from. Other sessions are unaffected. |
| Injection point | A system-prompt section named `user:session-prompt`, order `10`. |
| When it applies | The **next** model request. No restart, no page reload. |
| Cost when unset | Zero tokens — an empty section is dropped before rendering. |
| Storage | The `session-prompt` settings namespace: `prompts` (text) and `disabled` (switch), both keyed by session id. |
| Enable switch | Per session, applied immediately, and it keeps your text while stopping injection. |
| Empty text | The session's entry is removed, not stored as `""`. |

### Why a system-prompt section

The text is registered as a section of the system prompt rather than as an
extra user message, which means:

- **No history pollution.** Nothing is appended to the conversation, so the
  transcript stays exactly what you typed and compaction cannot drop it.
- **Stable prefix.** The rendered prefix is byte-identical between requests
  while the text is unchanged, so KV-cache reuse is preserved.
- **Immediate effect.** The section's text is a function evaluated on every
  prompt assembly — that is, on every model request — so an edit lands on the
  next request.

### How one session is kept apart from another

A section registered on the root context belongs to the global prompt layer and
would apply to every session. This plugin instead registers it through each
agent's **own scoped context**:

```js
const fiber = agent.ctx.inject(['systemPrompt'], (agentScope) => {
  agentScope.systemPrompt.section({
    name: 'user:session-prompt',
    order: 10,
    text: () => promptOf(scope.get(), agent.session.id),   // this session only
  })
})
```

Prompt assembly merges the global layer with the scope chain for the assembling
agent, so the section exists for exactly one session and unwinds when that agent
is disposed. Every live agent gets one on `agent/created`; agents already
running at load time are picked up from `ctx.agents.list()`.

The section's text reads the session id out of `agent.session.id` — the agent id
is the session id — so the *same* section definition serves every session and
each resolves its own entry.

---

## Install

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

Defaults to `$env:DSH_HOME` and the `web` profile; override with
`-DshHome <path> -ProfileName <name>`. The script:

1. removes the superseded `dsh-global-prompt` plugin if it is installed;
2. copies the package into `<profile>/node_modules/dsh-session-prompt`;
3. inserts one Loader row into `<profile>/cordis.patch.yml` (backing it up as
   `cordis.patch.yml.bak-session-prompt` first).

It is idempotent. Because the `web` profile reloads user patches live, the new
row normally hot-mounts; **refresh the browser** to pick up the client bundle.
If the button does not appear, restart the desktop app.

Re-run `install.ps1` after editing `lib/` to publish your changes — but note
that a rebuilt bundle is served under a new `rev` hash, so a hard refresh may be
needed.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1
```

Removes the package and reverts the Loader row (from the install-time backup
when present). The `session-prompt:` section in `settings.yaml` is deliberately
left alone, so a reinstall keeps every session's text; delete it by hand to drop
the values. Restart the app afterwards.

---

## Verify

```powershell
cd <profile>\node_modules\dsh-session-prompt
node verify.mjs                                   # 64 offline checks
node preflight.mjs <profileDir>                   # 14 Loader-resolution checks
```

`verify.mjs` drives both halves against stubs. The host half is checked for
per-agent registration, section name/order, and — the decisive property — that
two agents holding the same namespace value each resolve only their own text,
including that a session switched off injects nothing while its neighbour keeps
injecting. The client half is checked for its bundle shape, its slot
registration, that the control renders blue for an active session and unstyled
otherwise, and that flipping the switch writes one op to `disabled` and never
touches the stored text.

`preflight.mjs` proves the shipped Loader path resolves the row: Node resolution
from the profile anchor, the `dsh.client.platform` declaration, the `./client`
export existing on disk, the host half importing (including `schemastery`), and
the patch layer mounting this package while no longer mounting the superseded
one.

---

## Files

| Path | Role |
|---|---|
| `lib/index.js` | Host half: settings namespace, per-agent scoped prompt section. |
| `lib/client.js` | Browser half: the composer button and its dialog. |
| `install.ps1` / `uninstall.ps1` | Profile installation and removal. |
| `verify.mjs` / `preflight.mjs` | Offline checks. |

`lib/client.js` is a **hand-written** `window.__ModuleLoader__.load({...})`
bundle. There is no build step, so it must keep that shape: no `import` or
`export` syntax, and only platform-seeded modules may be required (`react` and
`@deepseek-ai/dsh-client-ui-primitives`).

### Editing the prompt by hand

`settings.yaml` holds the values directly:

```yaml
session-prompt:
  prompts:
    <session-id>: 始终使用中文回答，并解释原因。
  disabled:
    <session-id>: true      # 保留文本但不注入；删掉这一行即恢复注入
```

Editing the file directly is supported — DSH hot-reloads it. The UI writes
through path-addressed `settings.mutate` ops at `['prompts', sessionId]` and
`['disabled', sessionId]`, which is why editing one session never rewrites
another's entry, and why flipping the switch never rewrites your text.

---

## Notes

- The button's blue is `--dsw-alias-button-info-fill`, read from the theme — the
  same token the composer's send button uses (`uV2eYG_primary` in
  `dsh-client-ui-conversation`). It follows light and dark themes automatically
  and no CSS is injected.
- The dialog is bound to the session whose button was pressed. Opening a
  different session shows that session's text.
- This plugin supersedes `dsh-global-prompt`, which injected one global block
  into every session. Its `global-prompt:` section in `settings.yaml` is now
  inert and can be deleted.
