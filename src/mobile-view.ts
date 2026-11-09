/**
 * MobileHtmlView — the mobile HTML/JSON reader.
 *
 * The rendering stack is the adapted Style HTML Viewer (taihoe/style-html-viewer v1.0.6, MIT) vendored in
 * ./vendor/style-html-viewer: its HtmlAssetResolver + PostCSS CSS engine, IpcBridge and PreviewPanel lifecycle.
 * This class only fixes the public identity (view id, handled extensions) that this plugin has always exposed.
 * No Node or Electron API is imported anywhere in this module graph.
 */
import { HtmlView } from "./vendor/style-html-viewer/src/view/HtmlView";

export const MOBILE_VIEW_TYPE = "open-in-webviewer-mobile";

export class MobileHtmlView extends HtmlView {
	getViewType(): string {
		return MOBILE_VIEW_TYPE;
	}

	canAcceptExtension(extension: string): boolean {
		return /^(html|htm|json)$/i.test(extension);
	}
}
