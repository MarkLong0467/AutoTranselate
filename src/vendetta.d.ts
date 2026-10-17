// Minimal typings for the parts of Revenge's Vendetta plugin API this plugin
// uses. At build time every "@vendetta/..." import becomes "vendetta...."
// (see build.mjs).

declare module "@vendetta" {
	export const logger: {
		log(...messages: any[]): void;
		info(...messages: any[]): void;
		warn(...messages: any[]): void;
		error(...messages: any[]): void;
	};
}

declare module "@vendetta/plugin" {
	export const id: string;
	export const manifest: { name: string; [key: string]: any };
	export const storage: Record<string, any>;
}

declare module "@vendetta/patcher" {
	export function before(
		funcName: string,
		funcParent: any,
		callback: (args: any[]) => any,
		oneTime?: boolean,
	): () => boolean;
}

declare module "@vendetta/metro" {
	export function findByProps(...props: string[]): any;
	export function findByStoreName(name: string): any;
}

declare module "@vendetta/metro/common" {
	export const React: any;
	export const ReactNative: any;
	export const FluxDispatcher: any;
}

declare module "@vendetta/storage" {
	export function useProxy<T>(storage: T): T;
}

declare module "@vendetta/ui/components" {
	export const Forms: any;
}

declare module "@vendetta/ui/toasts" {
	export function showToast(content: string, asset?: number): void;
}

declare module "@vendetta/ui/assets" {
	export function getAssetIDByName(name: string): number | undefined;
}

declare var nativeModuleProxy: Record<string, any> | undefined;
declare var __turboModuleProxy: ((name: string) => any) | undefined;

declare namespace JSX {
	interface IntrinsicElements {
		[name: string]: any;
	}
}
