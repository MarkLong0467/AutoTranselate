import { findByProps } from "@vendetta/metro";
import { React, ReactNative as RN } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { Forms } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";

import { refreshShown } from "./rows";
import { clearTranslations } from "./translator";

const OPTIONS = [
	{
		key: "smallText",
		label: "Small translation text",
		subLabel: "Show translations as small grey text. Turn this off if translations don't show up.",
	},
	{
		key: "showLanguage",
		label: "Show original language",
		subLabel: "Start each translation with the language it was translated from.",
	},
	{
		key: "translateOwn",
		label: "Translate my own messages",
		subLabel: "Also translate messages you send.",
	},
];

let components: Record<string, any> | undefined;

function getComponents() {
	if (!components) {
		components = {};
		for (const name of ["TableRowGroup", "TableSwitchRow", "TableRow"]) {
			try {
				components[name] = findByProps(name)?.[name];
			} catch {}
		}
	}
	return components;
}

function setOption(key: string, value: boolean) {
	storage[key] = value;
	refreshShown();
}

function clearCache() {
	clearTranslations();
	refreshShown();
	showToast("AutoTranslate: cleared saved translations");
}

const CREDIT = "Translations by Google Translate.";

export default function Settings() {
	useProxy(storage);
	const { TableRowGroup, TableSwitchRow, TableRow } = getComponents();

	if (TableRowGroup && TableSwitchRow && TableRow) {
		return (
			<RN.ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 38 }}>
				<TableRowGroup title="Display">
					{OPTIONS.map(option => (
						<TableSwitchRow
							key={option.key}
							label={option.label}
							subLabel={option.subLabel}
							value={storage[option.key] !== false}
							onValueChange={(value: boolean) => setOption(option.key, value)}
						/>
					))}
				</TableRowGroup>
				<RN.View style={{ height: 16 }} />
				<TableRowGroup title="Translations">
					<TableRow
						label="Clear saved translations"
						subLabel="Translate messages again from scratch."
						onPress={clearCache}
					/>
					<TableRow label={CREDIT} />
				</TableRowGroup>
			</RN.ScrollView>
		);
	}

	const { FormSection, FormSwitchRow, FormRow } = Forms ?? {};
	if (FormSection && FormSwitchRow && FormRow) {
		return (
			<RN.ScrollView style={{ flex: 1 }}>
				<FormSection title="Display">
					{OPTIONS.map(option => (
						<FormSwitchRow
							key={option.key}
							label={option.label}
							subLabel={option.subLabel}
							value={storage[option.key] !== false}
							onValueChange={(value: boolean) => setOption(option.key, value)}
						/>
					))}
				</FormSection>
				<FormSection title="Translations">
					<FormRow
						label="Clear saved translations"
						subLabel="Translate messages again from scratch."
						onPress={clearCache}
					/>
					<FormRow label={CREDIT} />
				</FormSection>
			</RN.ScrollView>
		);
	}

	return (
		<RN.ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
			{OPTIONS.map(option => (
				<RN.View
					key={option.key}
					style={{ flexDirection: "row", alignItems: "center", paddingVertical: 12 }}
				>
					<RN.View style={{ flex: 1, paddingRight: 12 }}>
						<RN.Text style={{ color: "gray", fontSize: 16 }}>{option.label}</RN.Text>
						<RN.Text style={{ color: "gray", fontSize: 12 }}>{option.subLabel}</RN.Text>
					</RN.View>
					<RN.Switch
						value={storage[option.key] !== false}
						onValueChange={(value: boolean) => setOption(option.key, value)}
					/>
				</RN.View>
			))}
			<RN.Text style={{ color: "gray", fontSize: 12, paddingTop: 12 }}>{CREDIT}</RN.Text>
		</RN.ScrollView>
	);
}
