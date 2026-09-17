export const createdNotices: string[] = []

export function clearNotices(): void {
	createdNotices.length = 0
}

export class Notice {
	constructor(public message: string) {
		createdNotices.push(message)
	}
}

export class TAbstractFile {
	path: string = ''
	name: string = ''
	parent: TFolder | null = null
}

export class TFile extends TAbstractFile {
	basename: string = ''
	extension: string = ''
	stat = { ctime: 0, mtime: 0, size: 0 }
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = []
}

export class Vault {
	async read(file: TFile): Promise<string> {
		return ''
	}
	async modify(file: TFile, data: string): Promise<void> {}
	getName(): string {
		return 'test-vault'
	}
	getMarkdownFiles(): TFile[] {
		return []
	}
	getAbstractFileByPath(path: string): TAbstractFile | null {
		return null
	}
	getRoot(): TFolder {
		return new TFolder()
	}
	adapter = {
		getFullPath(path: string): string {
			return path
		}
	}
}

export class MetadataCache {
	getCache(path: string): any {
		return null
	}
	getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
		return null
	}
}

export class App {
	vault: Vault = new Vault()
	metadataCache: MetadataCache = new MetadataCache()
	workspace = {
		getActiveFile(): TFile | null {
			return null
		}
	}
}

export class Plugin {
	app: App = new App()
	manifest: any = {}
	async loadData(): Promise<any> {
		return null
	}
	async saveData(data: any): Promise<void> {}
	addSettingTab(tab: any): void {}
	addRibbonIcon(icon: string, title: string, callback: () => void): any {}
	addCommand(cmd: any): any {}
	registerInterval(id: any): void {}
}

function makeMockRow(cells = 4) {
	const row: Record<string, unknown> = { tag: 'tr', children: [] as unknown[] }
	const rowChildren = row['children'] as unknown[]
	for (let i = 0; i < cells; i++) {
		rowChildren.push(makeMockEl('td'))
	}
	return row
}

function makeMockTableSection() {
	const section: Record<string, unknown> = { tag: 'tbody', children: [] as unknown[] }
	section['insertRow'] = () => {
		const row = makeMockRow()
		;(section['children'] as unknown[]).push(row)
		return {
			...row,
			insertCell: () => {
				const cell = makeMockEl('td')
				;(row['children'] as unknown[]).push(cell)
				return cell
			},
			appendChild: (child: unknown) => {
				;(row['children'] as unknown[]).push(child)
			}
		}
	}
	return section
}

function makeMockTable() {
	const table = makeMockEl('table', { cls: 'anki-settings-table' })
	table['createTHead'] = () => makeMockTableSection()
	table['createTBody'] = () => makeMockTableSection()
	return table
}

function makeMockEl(tag = 'div', options: { cls?: string; text?: string } = {}) {
	const el: Record<string, unknown> = {
		tag,
		cls: options.cls ?? '',
		textContent: options.text ?? '',
		innerHTML: '',
		style: {} as Record<string, string>,
		children: [] as unknown[],
		listeners: {} as Record<string, Array<() => void>>
	}
	el['empty'] = () => {
		el['children'] = []
	}
	el['createEl'] = (childTag: string, childOptions?: { cls?: string; text?: string }) => {
		const child = childTag === 'table' ? makeMockTable() : makeMockEl(childTag, childOptions)
		;(el['children'] as unknown[]).push(child)
		return child
	}
	el['addClass'] = (cls: string) => {
		el['cls'] = `${el['cls']} ${cls}`.trim()
	}
	el['setAttr'] = (name: string, value: string) => {
		;(el as Record<string, unknown>)[`attr:${name}`] = value
	}
	el['addEventListener'] = (event: string, cb: () => void) => {
		const listeners = el['listeners'] as Record<string, Array<() => void>>
		listeners[event] = [...(listeners[event] ?? []), cb]
	}
	el['click'] = () => {
		for (const cb of (el['listeners'] as Record<string, Array<() => void>>)['click'] ?? []) {
			cb()
		}
	}
	return el
}

export class PluginSettingTab {
	containerEl = makeMockEl('div')
	constructor(
		public app: App,
		public plugin: any
	) {}
}

/**
 * Minimal AbstractInputSuggest stub: enough for settings.ts folder picker to
 * construct, filter, and select. Keeps the same public surface the plugin uses
 * (constructor, setValue/getValue, onSelect, getSuggestions, renderSuggestion).
 */
export abstract class AbstractInputSuggest<T> {
	private selectedCallback: ((value: T) => void) | null = null
	constructor(
		public app: App,
		public inputEl: any
	) {}
	abstract getSuggestions(query: string): T[] | Promise<T[]>
	abstract renderSuggestion(value: T, el: any): void
	selectSuggestion(value: T): void {
		this.setValue(String(value))
		if (this.selectedCallback) {
			this.selectedCallback(value)
		}
	}
	onSelect(callback: (value: T) => void): this {
		this.selectedCallback = callback
		return this
	}
	setValue(value: string): void {
		this.inputEl.value = value
	}
	getValue(): string {
		return this.inputEl.value ?? ''
	}
	open(): void {}
	close(): void {}
}

export class Setting {
	settingEl = {}
	infoEl = { remove() {} }
	controlEl = { className: '' }
	inputEl = { rows: 0, cols: 0, value: '', title: '', style: {} as Record<string, string> }
	constructor(containerEl: any) {}
	setName(name: string) {
		return this
	}
	setDesc(desc: any) {
		return this
	}
	addText(cb: (t: any) => void) {
		cb({
			setValue() {
				return this
			},
			setPlaceholder() {
				return this
			},
			onChange() {
				return this
			},
			inputEl: this.inputEl
		})
		return this
	}
	addTextArea(cb: (t: any) => void) {
		cb({
			setValue() {
				return this
			},
			setPlaceholder() {
				return this
			},
			onChange() {
				return this
			},
			inputEl: this.inputEl
		})
		return this
	}
	addToggle(cb: (t: any) => void) {
		cb({
			setValue() {
				return this
			},
			onChange() {
				return this
			}
		})
		return this
	}
	addSlider(cb: (t: any) => void) {
		cb({
			setValue() {
				return this
			},
			setLimits() {
				return this
			},
			setDynamicTooltip() {
				return this
			},
			onChange() {
				return this
			}
		})
		return this
	}
	addDropdown(cb: (d: any) => void) {
		cb({
			addOption() {
				return this
			},
			setValue() {
				return this
			},
			onChange() {
				return this
			}
		})
		return this
	}
	addButton(cb: (b: any) => void) {
		cb({
			setButtonText() {
				return this
			},
			setClass() {
				return this
			},
			onClick() {
				return this
			}
		})
		return this
	}
}

export function addIcon(name: string, svg: string): void {}

/** Minimal Modal: contentEl rendering + open/close lifecycle for modal tests. */
export class Modal {
	contentEl = makeMockEl('div')
	app: App
	constructor(app?: App) {
		this.app = app ?? new App()
	}
	open(): void {
		this.onOpen()
	}
	close(): void {
		this.onClose()
	}
	onOpen(): void {}
	onClose(): void {}
}

export const requestedUrls: unknown[] = []

export function clearRequestedUrls(): void {
	requestedUrls.length = 0
}

export async function requestUrl(params: any): Promise<any> {
	requestedUrls.push(params)
	return {
		status: 200,
		text: '',
		json: {}
	}
}

if (typeof globalThis.document === 'undefined') {
	;(globalThis as any).document = {
		createElement: (tag: string) => ({
			appendChild: () => {},
			setAttribute: () => {},
			style: {},
			textContent: ''
		}),
		createTextNode: (text: string) => text,
		createDocumentFragment: () => ({
			createEl: () => ({})
		})
	}
}

// Obsidian ships a legacy Array.prototype.contains polyfill; plugin code relies
// on it (files-manager). Mirror it so tests exercising non-empty file lists work.
declare global {
	interface Array<T> {
		contains(searchElement: T, fromIndex?: number): boolean
	}
}

if (typeof Array.prototype.contains !== 'function') {
	Object.defineProperty(Array.prototype, 'contains', {
		value: function <T>(this: T[], searchElement: T, fromIndex?: number): boolean {
			return this.indexOf(searchElement, fromIndex) >= 0
		},
		writable: true,
		configurable: true,
		enumerable: false
	})
}
