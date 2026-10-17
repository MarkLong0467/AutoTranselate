import { storage } from "@vendetta/plugin";

import { patchChat } from "./rows";
import Settings from "./settings";
import { resetTranslator } from "./translator";

let unpatch: (() => void) | undefined;

export default {
	onLoad() {
		storage.smallText ??= true;
		storage.showLanguage ??= true;
		storage.translateOwn ??= true;

		unpatch = patchChat();
	},
	onUnload() {
		resetTranslator();
		unpatch?.();
		unpatch = undefined;
	},
	settings: Settings,
};
