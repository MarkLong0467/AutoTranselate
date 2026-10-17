# AutoTranslate for Revenge

A [Revenge](https://github.com/revenge-mod/revenge-bundle) plugin for the Discord mobile app. It automatically translates every message it sees that isn't in English, and shows the English translation under the original message:

```
maria  Today at 4:20 PM
Hola amigo, ¿cómo estás?
🌐 Spanish: Hello friend, how are you?
```

English messages are left alone. Code blocks, links, mentions, emoji and spoilers are never sent for translation.

## Install

1. In Discord, open **Settings → Revenge → Plugins**.
2. Tap the **+** button ("Install a plugin") and paste this URL exactly:

   ```
   https://raw.githubusercontent.com/MarkLong0467/AutoTranselate/HEAD/dist/
   ```

   The repository page link (`https://github.com/MarkLong0467/AutoTranselate`) doesn't work: Revenge needs the link to the built plugin files, and fails with "Failed to fetch manifest" otherwise.

3. Revenge warns that the plugin isn't from its proxy. Tap **Continue**.
4. Make sure **AutoTranslate** is switched on. Messages in the open channel are translated within a few seconds.

## Settings

Tap the plugin in Revenge's plugin list to open its settings:

- **Small translation text**: shows translations as small grey text (Discord's `-#` subtext style). If translations don't appear on your Discord version, turn this off to use normal text.
- **Show original language**: starts each translation with the language it came from, like `Spanish:`.
- **Translate my own messages**: also translates messages you send. On by default.
- **Clear saved translations**: forgets cached translations and translates again.

## Good to know

- **Privacy:** the text of non-English messages is sent to Google Translate (the free `translate.googleapis.com` endpoint used by browser extensions) to be translated. English messages and code, links and mentions are not sent.
- Translations appear a moment after a message does, because they're fetched from Google.
- If Google rate-limits translations, the plugin pauses, shows a short notice, and retries automatically.
- Revenge plugins hook into Discord's internals, so a big Discord update can break the plugin until it's fixed.

## How it works

Discord renders chat natively. The JavaScript side sends rendered message rows to native code as JSON through `NativeChatModule.updateRows`. The plugin hooks that call, reads each message's parsed text, checks whether it's English (a quick local word check first, then Google's language detection), and appends the translation to the message's content as extra nodes.

Translations arrive after a row is first drawn. To redraw the row, the plugin briefly appends an invisible character to the message (a local `MESSAGE_UPDATE`, never sent to Discord's servers) and restores it about 400 ms later.

The code is in `src/`:

| File | What it does |
| --- | --- |
| `index.ts` | Plugin entry point (`onLoad`, `onUnload`, settings) |
| `rows.ts` | The `updateRows` hook, text extraction, and redrawing messages |
| `translator.ts` | Google Translate requests, queue, cache and rate-limit backoff |
| `english.ts` | The local "is this already English?" check |
| `languages.ts` | Language names for the detected source language |
| `settings.tsx` | Settings page |

## Development

Requires Node.js 22 or newer.

```sh
npm install
npm run build   # writes dist/index.js and dist/manifest.json
npm test        # builds, then runs the tests
npm run check   # TypeScript type check
```

Revenge loads the files in `dist/`, so commit them after building.

The tests load `dist/index.js` the same way Revenge does, against fake versions of Discord's message store, dispatcher, native chat module and Google Translate. To also run the main flow inside Hermes (the JavaScript engine Discord's app uses), point `HERMES` at a `hermes` binary, for example the one in the `hermes-engine-cli` npm package:

```sh
HERMES=/path/to/hermes node test/hermes/run.mjs
```
