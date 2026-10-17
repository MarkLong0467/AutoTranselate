import { storage } from "@vendetta/plugin";

import { patchChat } from "./rows";
import Settings from "./settings";
import { resetTranslator } from "./translator";

let unpatch: (() => void) | undefined;

export default {
	onLoad() {
		storage.showLanguage ??= true;
		storage.ownMessages ??= false;
		// Settings from the first version.
		delete storage.smallText;
		delete storage.translateOwn;

		unpatch = patchChat();
	},
	onUnload() {
		resetTranslator();
		unpatch?.();
		unpatch = undefined;
	},
	settings: Settings,
};
