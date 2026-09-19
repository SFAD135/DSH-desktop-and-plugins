# Verification record

Everything below was executed against the live host at
`http://127.0.0.1:59961` with `DSH_HOME=D:\tools\DSH Desktop\data\dsh-home`, profile `web`.

## 1. Static checks — 53 assertions, all passing

| Suite | Result |
|---|---|
| `node verify.mjs` | **64/64 pass** |
| `node preflight.mjs <profileDir>` | **14/14 pass** |

Run from `<profile>\node_modules\dsh-session-prompt` so the shared
`@deepseek-ai/schemastery` dependency resolves.

The decisive host-half assertion drives two fake agents against one shared
namespace value and asserts each resolves **only its own** text:

```
ok   session A sees only its own text
ok   session B sees only its own text
ok   a session with no entry renders empty while its neighbour does not
ok   a session switched off renders empty
ok   switching one session off leaves its neighbour injecting
```

The per-session enable switch is covered by the same split: the host half must
render `''` for a session whose id is in the `disabled` map, the client half must
drop the blue styling the moment the switch is flipped, and flipping it must
emit exactly one op against `['disabled', sessionId]` while the session's stored
text is left byte-identical.

```
ok   switching off writes one op, to the disabled map only
ok   switching off keeps the session text intact
ok   no write ever targeted the text while toggling
ok   session B was never written to
```

## 2. The Loader mounted the row — observed on the running host

The HTML the running host serves lists its client modules in a
`/plugins/??…` preload bundle. Fetched live, it ends with:

```
dsh-session-prompt/client.js&rev=c41c1b132b0b
```

and contains **no** `dsh-global-prompt` entry. So the profile's `web` patch
layer hot-reloaded, retired the old row, and mounted this one — no restart.
(The revision hash changes on every rebuild, so it is a reliable signal that a
fresh bundle was picked up; an earlier revision of this same check is what
confirmed the first install.)

The served bytes were then downloaded and inspected directly: the bundle
contains the new entry label, the `conversation.input.left` target, the
`--dsw-alias-button-info-fill` token, and the restored `Switch` with its
`启用（关闭后保留文本但不注入）` label, all correctly UTF-8 encoded.

## 3. Per-session injection — proven end-to-end, in a real system prompt

The system prompt is not recorded in the session log (`request/header` carries
only `config` and `tools`), so the live test used the assistant itself as the
instrument. Three markers went into `settings.yaml`:

| Marker | Placed under | Expected |
|---|---|---|
| `SP-CHECK-MINE-9142` | this session's id | **present** |
| `SP-CHECK-DECOY-3311` | a different session id | absent |
| `BANANA-7788` | the retired `global-prompt:` section | absent |

After the next model request, the session's **system prompt** contained exactly:

```
You are a coding agent powered by the deepseek-v4-flash model.

自检标记 SP-CHECK-MINE-9142（插件端到端验证用，请忽略其内容）

Tokens prefixed with @ are workspace paths the user explicitly referenced, …
```

This single observation proves four things at once:

1. **Activation works** — the scoped section reaches real prompt assembly.
2. **Scoping is per-session, not global** — the decoy entry for another session
   did *not* appear. This is the property the redesign was for.
3. **The bootstrap path works** — this session's agent was created *before* the
   plugin loaded (hot-mounted mid-session), so the `ctx.agents.list()` sweep
   that picks up already-live agents is exercised.
4. **The legacy plugin is fully retired** — `BANANA-7788` is gone.

5. **Placement is correct** — the marker sits after the identity line and
   before the harness guidance, i.e. section order `10`, after the persona
   prefix and ahead of first-party sections.

All three markers were then removed; `settings.yaml` is back to the user's own
content.

### Not covered by machine checks

Rendering of the button and the blue active state inside the browser was
verified in the client half against a React stub, and the styling token was
verified against the shipped composer CSS. The visual result in a real browser
was not captured — a page refresh and one look at the composer confirms it.
