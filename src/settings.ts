import { PluginSettingTab, Setting, Notice, TFolder, type App } from 'obsidian'
import * as AnkiConnect from './anki'
import { probeAnkiStatus } from './anki-launch'
import type MyPlugin from '../main'

/**
 * True when the path resolves to a folder in the open vault.
 * Blank input is never a valid scan directory. Pure vault lookup, no side
 * effects — unit-testable via the App mock.
 */
export function isExistingFolder(app: App, dirPath: string): boolean {
	if (dirPath.trim() === '') {
		return false
	}
	return app.vault.getAbstractFileByPath(dirPath) instanceof TFolder
}

const defaultDescs: Record<string, string> = {
	'Scan Directories': 'The directories to scan. Leave empty to scan the entire vault. One path per line.',
	Tag: 'The tag that the plugin automatically adds to any generated cards.',
	Deck: 'The deck the plugin adds cards to if TARGET DECK is not specified in the file.',
	'Scheduling Interval':
		'The time, in minutes, between automatic scans of the vault. Set this to 0 to disable automatic scanning.',
	'Add File Link': 'Append a link to the file that generated the flashcard on the field specified in the table.',
	'Add Context':
		"Append 'context' for the card, in the form of path > heading > heading etc, to the field specified in the table.",
	CurlyCloze: "Convert {cloze deletions} -> {{c1::cloze deletions}} on note types that have a 'Cloze' in their name.",
	'CurlyCloze - Highlights to Clozes': 'Convert ==highlights== -> {highlights} to be processed by CurlyCloze.',
	'ID Comments': 'Wrap note IDs in a HTML comment.',
	'Add Obsidian Tags':
		'Interpret #tags in the fields of a note as Anki tags, removing them from the note text in Anki.',
	'Anki API Key':
		'API key for AnkiConnect (only needed if you set apiKey in the AnkiConnect config). Stored in plaintext; only protects localhost access.',
	'Sync to AnkiWeb': 'Trigger an AnkiWeb sync after each scan (requires AnkiWeb credentials in Anki desktop).',
	'Allow Note Type Changes':
		'Convert notes in Anki when their note type changed in Markdown. Uses updateNoteModel; fields not present in the new note type are discarded by Anki, so review the change first. Off by default.',
	'Delete Removed Notes':
		'Delete the Anki notes whose blocks were removed from Markdown. IDs are tracked per file; renames and moves between files are safe. The first scan of a file only records IDs, so nothing is deleted on that run.',
	'Auto-launch Anki':
		'Launch Anki Desktop automatically when a scan finds it closed (desktop only, fire-and-forget). Off by default.'
}

export const DEFAULT_IGNORED_FILE_GLOBS = ['**/*.excalidraw.md']

export type SettingsTabId = 'general' | 'notes' | 'folders' | 'actions'

const SETTINGS_TABS: Array<{ id: SettingsTabId; label: string }> = [
	{ id: 'general', label: 'General' },
	{ id: 'notes', label: 'Notes' },
	{ id: 'folders', label: 'Folders' },
	{ id: 'actions', label: 'Actions' }
]

export class SettingsTab extends PluginSettingTab {
	declare plugin: MyPlugin
	activeTab: SettingsTabId = 'general'

	setup_custom_regexp(note_type: string, row_cells: HTMLCollection) {
		const plugin = this.plugin
		const regexp_section = plugin.settings['CUSTOM_REGEXPS']
		const custom_regexp = new Setting(row_cells[1] as HTMLElement).addText((text) =>
			text
				.setValue(regexp_section.hasOwnProperty(note_type) ? regexp_section[note_type] : '')
				.onChange((value) => {
					plugin.settings['CUSTOM_REGEXPS'][note_type] = value
					plugin.saveAllData()
				})
		)
		custom_regexp.settingEl = row_cells[1] as HTMLElement
		custom_regexp.infoEl.remove()
		custom_regexp.controlEl.className += ' anki-center'
	}

	setup_link_field(note_type: string, row_cells: HTMLCollection) {
		const plugin = this.plugin
		const link_fields_section = plugin.settings.FILE_LINK_FIELDS
		const link_field = new Setting(row_cells[2] as HTMLElement).addDropdown(async (dropdown) => {
			if (!plugin.fields_dict[note_type]) {
				plugin.fields_dict = await plugin.loadFieldsDict()
				if (Object.keys(plugin.fields_dict).length != plugin.note_types.length) {
					new Notice('Need to connect to Anki to generate fields dictionary...')
					try {
						plugin.fields_dict = await plugin.generateFieldsDict()
						new Notice('Fields dictionary successfully generated!')
					} catch (_e) {
						new Notice("Couldn't connect to Anki! Check console for error message.")
						return
					}
				}
			}
			const field_names = plugin.fields_dict[note_type]
			for (const field of field_names) {
				dropdown.addOption(field, field)
			}
			dropdown.setValue(
				link_fields_section.hasOwnProperty(note_type) ? link_fields_section[note_type] : field_names[0]
			)
			dropdown.onChange((value) => {
				plugin.settings.FILE_LINK_FIELDS[note_type] = value
				plugin.saveAllData()
			})
		})
		link_field.settingEl = row_cells[2] as HTMLElement
		link_field.infoEl.remove()
		link_field.controlEl.className += ' anki-center'
	}

	setup_context_field(note_type: string, row_cells: HTMLCollection) {
		const plugin = this.plugin
		const context_fields_section: Record<string, string> = plugin.settings.CONTEXT_FIELDS
		const context_field = new Setting(row_cells[3] as HTMLElement).addDropdown(async (dropdown) => {
			const field_names = plugin.fields_dict[note_type]
			for (const field of field_names) {
				dropdown.addOption(field, field)
			}
			dropdown.setValue(
				context_fields_section.hasOwnProperty(note_type) ? context_fields_section[note_type] : field_names[0]
			)
			dropdown.onChange((value) => {
				plugin.settings.CONTEXT_FIELDS[note_type] = value
				plugin.saveAllData()
			})
		})
		context_field.settingEl = row_cells[3] as HTMLElement
		context_field.infoEl.remove()
		context_field.controlEl.className += ' anki-center'
	}

	setup_note_table(parent: HTMLElement) {
		const plugin = this.plugin
		parent.createEl('h3', { text: 'Note type settings' })
		const table_scroll = parent.createEl('div', { cls: 'o2a-table-scroll' })
		const note_type_table = table_scroll.createEl('table', { cls: 'anki-settings-table' })
		const head = note_type_table.createTHead()
		const header_row = head.insertRow()
		for (const header of ['Note Type', 'Custom Regexp', 'File Link Field', 'Context Field']) {
			const th = document.createElement('th')
			th.appendChild(document.createTextNode(header))
			header_row.appendChild(th)
		}
		const main_body = note_type_table.createTBody()
		if (!plugin.settings.hasOwnProperty('CONTEXT_FIELDS')) {
			plugin.settings.CONTEXT_FIELDS = {}
		}
		for (const note_type of plugin.note_types) {
			const row = main_body.insertRow()

			row.insertCell()
			row.insertCell()
			row.insertCell()
			row.insertCell()

			const row_cells = row.children

			row_cells[0].innerHTML = note_type
			this.setup_custom_regexp(note_type, row_cells)
			this.setup_link_field(note_type, row_cells)
			this.setup_context_field(note_type, row_cells)
		}
	}

	setup_syntax(parent: HTMLElement) {
		const plugin = this.plugin
		const syntax_settings = parent.createEl('h3', { text: 'Syntax Settings' })
		for (const key of Object.keys(plugin.settings['Syntax'])) {
			new Setting(syntax_settings).setName(key).addText((text) =>
				text.setValue(plugin.settings['Syntax'][key]).onChange((value) => {
					plugin.settings['Syntax'][key] = value
					plugin.saveAllData()
				})
			)
		}
	}

	setup_defaults(parent: HTMLElement) {
		const plugin = this.plugin
		const defaults_settings = parent.createEl('h3', { text: 'Defaults' })

		// Migration from old setting
		if (plugin.settings['Defaults'].hasOwnProperty('Scan Directory')) {
			const oldValue = plugin.settings['Defaults']['Scan Directory']
			if (typeof oldValue === 'string' && oldValue.trim() !== '') {
				plugin.settings['Defaults']['Scan Directories'] = [oldValue]
			} else {
				plugin.settings['Defaults']['Scan Directories'] = []
			}
			delete plugin.settings['Defaults']['Scan Directory']
			plugin.saveAllData()
		}

		if (!plugin.settings['Defaults'].hasOwnProperty('Scan Directories')) {
			plugin.settings['Defaults']['Scan Directories'] = []
		}

		// To account for new add context
		if (!plugin.settings['Defaults'].hasOwnProperty('Add Context')) {
			plugin.settings['Defaults']['Add Context'] = false
		}
		// To account for new scheduling interval
		if (!plugin.settings['Defaults'].hasOwnProperty('Scheduling Interval')) {
			plugin.settings['Defaults']['Scheduling Interval'] = 0
		}
		// To account for new highlights to clozes
		if (!plugin.settings['Defaults'].hasOwnProperty('CurlyCloze - Highlights to Clozes')) {
			plugin.settings['Defaults']['CurlyCloze - Highlights to Clozes'] = false
		}
		// To account for new add obsidian tags
		if (!plugin.settings['Defaults'].hasOwnProperty('Add Obsidian Tags')) {
			plugin.settings['Defaults']['Add Obsidian Tags'] = false
		}
		// To account for new Anki API key
		if (!plugin.settings['Defaults'].hasOwnProperty('Anki API Key')) {
			plugin.settings['Defaults']['Anki API Key'] = ''
		}
		// To account for new AnkiWeb sync toggle
		if (!plugin.settings['Defaults'].hasOwnProperty('Sync to AnkiWeb')) {
			plugin.settings['Defaults']['Sync to AnkiWeb'] = false
		}
		// To account for orphaned-note deletion
		if (!plugin.settings['Defaults'].hasOwnProperty('Delete Removed Notes')) {
			plugin.settings['Defaults']['Delete Removed Notes'] = true
		}
		// To account for new note-type change toggle
		if (!plugin.settings['Defaults'].hasOwnProperty('Allow Note Type Changes')) {
			plugin.settings['Defaults']['Allow Note Type Changes'] = false
		}
		// To account for Anki auto-launch toggle
		if (!plugin.settings['Defaults'].hasOwnProperty('Auto-launch Anki')) {
			plugin.settings['Defaults']['Auto-launch Anki'] = false
		}

		new Setting(defaults_settings)
			.setName('Scan Directories')
			.setDesc(
				defaultDescs['Scan Directories'] +
					' Invalid paths are highlighted and ignored at scan time (the scan continues with the valid ones).'
			)
			.addTextArea((text) => {
				text.setValue(plugin.settings.Defaults['Scan Directories'].join('\n'))
					.setPlaceholder('path/to/folder1\npath/to/folder2')
					.onChange((value) => {
						const scanDirs = value
							.split('\n')
							.map((dir) => dir.trim())
							.filter((dir) => dir !== '')
						plugin.settings.Defaults['Scan Directories'] = scanDirs
						plugin.saveAllData()
						// Inline validation: unknown paths get a red border via
						// the Obsidian theme variable, cleared when fixed or empty.
						const invalid = scanDirs.filter((dir) => !isExistingFolder(plugin.app, dir))
						if (invalid.length > 0) {
							text.inputEl.style.borderColor = 'var(--text-error)'
							text.inputEl.title = `Not a folder in this vault: ${invalid.join(', ')}`
						} else {
							text.inputEl.style.borderColor = ''
							text.inputEl.title = ''
						}
					})
				text.inputEl.rows = 5
				text.inputEl.cols = 30
			})

		for (const key of Object.keys(plugin.settings['Defaults'])) {
			// To account for removal of regex setting
			if (key === 'Regex' || key === 'Scan Directories') {
				continue
			}
			const defaultValue = plugin.settings['Defaults'][key]
			if (typeof defaultValue === 'string') {
				new Setting(defaults_settings)
					.setName(key)
					.setDesc(defaultDescs[key])
					.addText((text) =>
						text.setValue(defaultValue).onChange((value) => {
							plugin.settings['Defaults'][key] = value
							plugin.saveAllData()
						})
					)
			} else if (typeof defaultValue === 'boolean') {
				new Setting(defaults_settings)
					.setName(key)
					.setDesc(defaultDescs[key])
					.addToggle((toggle) =>
						toggle.setValue(defaultValue).onChange((value) => {
							plugin.settings['Defaults'][key] = value
							plugin.saveAllData()
						})
					)
			} else if (typeof defaultValue === 'number') {
				new Setting(defaults_settings)
					.setName(key)
					.setDesc(defaultDescs[key])
					.addSlider((slider) => {
						slider
							.setValue(defaultValue)
							.setLimits(0, 360, 5)
							.setDynamicTooltip()
							.onChange(async (value) => {
								plugin.settings['Defaults'][key] = value
								await plugin.saveAllData()
								if (plugin.hasOwnProperty('schedule_id')) {
									window.clearInterval(plugin.schedule_id)
								}
								if (value != 0) {
									plugin.schedule_id = window.setInterval(
										async () => await plugin.scanVault(),
										value * 1000 * 60
									)
									plugin.registerInterval(plugin.schedule_id)
								}
							})
					})
			}
		}
	}

	get_folders(): TFolder[] {
		const app = this.app
		const folder_list: TFolder[] = [app.vault.getRoot()]
		for (const folder of folder_list) {
			const filtered_list: TFolder[] =
				folder && folder.children
					? (folder.children.filter((element) => element.hasOwnProperty('children')) as TFolder[])
					: []
			folder_list.push(...filtered_list)
		}
		return folder_list.slice(1) //Removes initial vault folder
	}

	setup_folder_deck(folderPath: string, row_cells: HTMLCollection) {
		const plugin = this.plugin
		const folder_decks = plugin.settings.FOLDER_DECKS
		const folder_deck = new Setting(row_cells[1] as HTMLElement).addText((text) =>
			text.setValue(folder_decks[folderPath] || '').onChange((value) => {
				if (value.trim()) {
					plugin.settings.FOLDER_DECKS[folderPath] = value.trim()
				} else {
					delete plugin.settings.FOLDER_DECKS[folderPath]
				}
				plugin.saveAllData()
			})
		)
		folder_deck.settingEl = row_cells[1] as HTMLElement
		folder_deck.infoEl.remove()
		folder_deck.controlEl.className += ' anki-center'
	}

	setup_folder_tag(folderPath: string, row_cells: HTMLCollection) {
		const plugin = this.plugin
		const folder_tags = plugin.settings.FOLDER_TAGS
		const folder_tag = new Setting(row_cells[2] as HTMLElement).addText((text) =>
			text.setValue(folder_tags[folderPath] || '').onChange((value) => {
				if (value.trim()) {
					plugin.settings.FOLDER_TAGS[folderPath] = value.trim()
				} else {
					delete plugin.settings.FOLDER_TAGS[folderPath]
				}
				plugin.saveAllData()
			})
		)
		folder_tag.settingEl = row_cells[2] as HTMLElement
		folder_tag.infoEl.remove()
		folder_tag.controlEl.className += ' anki-center'
	}

	setup_folder_table(parent: HTMLElement) {
		const plugin = this.plugin
		parent.createEl('h3', { text: 'Folder settings' })

		if (!plugin.settings.hasOwnProperty('FOLDER_DECKS')) {
			plugin.settings.FOLDER_DECKS = {}
		}
		if (!plugin.settings.hasOwnProperty('FOLDER_TAGS')) {
			plugin.settings.FOLDER_TAGS = {}
		}

		// Prune empty string entries to avoid data.json bloat
		for (const key of Object.keys(plugin.settings.FOLDER_DECKS)) {
			if (!plugin.settings.FOLDER_DECKS[key] || plugin.settings.FOLDER_DECKS[key].trim() === '') {
				delete plugin.settings.FOLDER_DECKS[key]
			}
		}
		for (const key of Object.keys(plugin.settings.FOLDER_TAGS)) {
			if (!plugin.settings.FOLDER_TAGS[key] || plugin.settings.FOLDER_TAGS[key].trim() === '') {
				delete plugin.settings.FOLDER_TAGS[key]
			}
		}

		const configuredPaths = Array.from(
			new Set([...Object.keys(plugin.settings.FOLDER_DECKS), ...Object.keys(plugin.settings.FOLDER_TAGS)])
		).sort()

		const allFolders = this.get_folders()
		const availableFolders = allFolders
			.map((f) => f.path)
			.filter((p) => !configuredPaths.includes(p))
			.sort()

		if (availableFolders.length > 0) {
			let selectedFolderToAdd = availableFolders[0]
			const add_rule = new Setting(parent)
				.setName('Add folder rule')
				.setDesc('Map a vault folder to a specific target Anki deck or tags.')
			add_rule.settingEl.addClass('o2a-narrow-select')
			add_rule
				.addDropdown((dropdown) => {
					for (const path of availableFolders) {
						dropdown.addOption(path, path)
					}
					dropdown.setValue(selectedFolderToAdd)
					dropdown.onChange((val) => {
						selectedFolderToAdd = val
					})
				})
				.addButton((button) => {
					button
						.setButtonText('Add')
						.setClass('mod-cta')
						.onClick(async () => {
							if (selectedFolderToAdd) {
								plugin.settings.FOLDER_DECKS[selectedFolderToAdd] = ''
								await plugin.saveAllData()
								this.setup_display()
							}
						})
				})
		}

		const table_scroll = parent.createEl('div', { cls: 'o2a-table-scroll' })
		const folder_table = table_scroll.createEl('table', { cls: 'anki-settings-table' })
		const head = folder_table.createTHead()
		const header_row = head.insertRow()
		for (const header of ['Folder', 'Folder Deck', 'Folder Tags', 'Action']) {
			const th = document.createElement('th')
			th.appendChild(document.createTextNode(header))
			header_row.appendChild(th)
		}
		const main_body = folder_table.createTBody()

		if (configuredPaths.length === 0) {
			const emptyRow = main_body.insertRow()
			const cell = emptyRow.insertCell()
			cell.colSpan = 4
			cell.style.textAlign = 'center'
			cell.style.padding = '10px'
			cell.textContent = "No folder rules configured yet. Use 'Add folder rule' above to add one."
			return
		}

		for (const folderPath of configuredPaths) {
			const row = main_body.insertRow()

			row.insertCell()
			row.insertCell()
			row.insertCell()
			row.insertCell()

			const row_cells = row.children

			row_cells[0].innerHTML = folderPath
			this.setup_folder_deck(folderPath, row_cells)
			this.setup_folder_tag(folderPath, row_cells)

			const removeSetting = new Setting(row_cells[3] as HTMLElement).addButton((button) => {
				button.setButtonText('Remove').onClick(async () => {
					delete plugin.settings.FOLDER_DECKS[folderPath]
					delete plugin.settings.FOLDER_TAGS[folderPath]
					await plugin.saveAllData()
					this.setup_display()
				})
			})
			removeSetting.settingEl = row_cells[3] as HTMLElement
			removeSetting.infoEl.remove()
			removeSetting.controlEl.className += ' anki-center'
		}
	}

	setup_buttons(parent: HTMLElement) {
		const plugin = this.plugin
		const action_buttons = parent.createEl('h3', { text: 'Actions' })
		new Setting(action_buttons)
			.setName('Regenerate Note Type Table')
			.setDesc('Connect to Anki to regenerate the table with new note types, or get rid of deleted note types.')
			.addButton((button) => {
				button
					.setButtonText('Regenerate')
					.setClass('mod-cta')
					.onClick(async () => {
						new Notice('Need to connect to Anki to update note types...')
						try {
							plugin.note_types = await AnkiConnect.invoke('modelNames')
							plugin.regenerateSettingsRegexps()
							plugin.fields_dict = await plugin.loadFieldsDict()
							if (Object.keys(plugin.fields_dict).length != plugin.note_types.length) {
								new Notice('Need to connect to Anki to generate fields dictionary...')
								try {
									plugin.fields_dict = await plugin.generateFieldsDict()
									new Notice('Fields dictionary successfully generated!')
								} catch (_e) {
									new Notice("Couldn't connect to Anki! Check console for error message.")
									return
								}
							}
							await plugin.saveAllData()
							this.setup_display()
							new Notice('Note types updated!')
						} catch (_e) {
							new Notice("Couldn't connect to Anki! Check console for details.")
						}
					})
			})
		new Setting(action_buttons)
			.setName('Test AnkiConnect Connection')
			.setDesc('Check that Anki is reachable and report whether it requires an API key.')
			.addButton((button) => {
				button
					.setButtonText('Test')
					.setClass('mod-cta')
					.onClick(async () => {
						new Notice('Testing connection to Anki...')
						const probe = await probeAnkiStatus()
						new Notice(probe.message)
					})
			})
		new Setting(action_buttons)
			.setName('Clear Media Cache')
			.setDesc(
				`Clear the cached list of media filenames that have been added to Anki.

			The plugin will skip over adding a media file if it's added a file with the same name before, so clear this if e.g. you've updated the media file with the same name.`
			)
			.addButton((button) => {
				button
					.setButtonText('Clear')
					.setClass('mod-cta')
					.onClick(async () => {
						plugin.added_media = []
						await plugin.saveAllData()
						new Notice('Media Cache cleared successfully!')
					})
			})
		new Setting(action_buttons)
			.setName('Clear File Hash Cache')
			.setDesc(
				`Clear the cached dictionary of file hashes that the plugin has scanned before.

			The plugin will skip over a file if the file path and the hash is unaltered.`
			)
			.addButton((button) => {
				button
					.setButtonText('Clear')
					.setClass('mod-cta')
					.onClick(async () => {
						plugin.file_hashes = {}
						await plugin.saveAllData()
						new Notice('File Hash Cache cleared successfully!')
					})
			})
	}
	setup_ignore_files(parent: HTMLElement) {
		const plugin = this.plugin
		const ignored_files_settings = parent.createEl('h3', { text: 'Ignored File Settings' })
		plugin.settings['IGNORED_FILE_GLOBS'] = plugin.settings.hasOwnProperty('IGNORED_FILE_GLOBS')
			? plugin.settings['IGNORED_FILE_GLOBS']
			: DEFAULT_IGNORED_FILE_GLOBS
		const descriptionFragment = document.createDocumentFragment()
		descriptionFragment.createEl('span', {
			text: 'Glob patterns for files to ignore. You can add multiple patterns. One per line. Have a look at the '
		})
		descriptionFragment.createEl('a', {
			text: 'README.md',
			href: 'https://github.com/marqp/Obsidian_to_Anki?tab=readme-ov-file#features'
		})
		descriptionFragment.createEl('span', { text: ' for more information, examples and further resources.' })

		new Setting(ignored_files_settings)
			.setName('Patterns to ignore')
			.setDesc(descriptionFragment)
			.addTextArea((text) => {
				text.setValue(plugin.settings.IGNORED_FILE_GLOBS.join('\n'))
					.setPlaceholder("Examples: '**/*.excalidraw.md', 'Templates/**'")
					.onChange((value) => {
						let ignoreLines = value.split('\n')
						ignoreLines = ignoreLines.filter((e) => e.trim() != '') //filter out empty lines and blank lines
						plugin.settings.IGNORED_FILE_GLOBS = ignoreLines

						plugin.saveAllData()
					})
				text.inputEl.rows = 10
				text.inputEl.cols = 30
			})
	}

	setup_display() {
		const { containerEl } = this

		containerEl.empty()
		containerEl.createEl('h1', { text: 'Obsidian_to_Anki settings (marqp fork)', cls: 'o2a-title' })
		containerEl.createEl('a', {
			text: 'For more information check the wiki',
			href: 'https://github.com/marqp/Obsidian_to_Anki/tree/master/docs'
		})
		const tab_bar = containerEl.createEl('div', { cls: 'o2a-tabs' })
		const panels = new Map<SettingsTabId, HTMLElement>()
		for (const tab of SETTINGS_TABS) {
			panels.set(tab.id, containerEl.createEl('div', { cls: 'o2a-tab-panel' }))
		}
		for (const tab of SETTINGS_TABS) {
			const button = tab_bar.createEl('button', { cls: 'o2a-tab', text: tab.label })
			button.setAttr('aria-selected', String(tab.id === this.activeTab))
			if (tab.id === this.activeTab) {
				button.addClass('o2a-tab-active')
			}
			button.addEventListener('click', () => {
				this.activeTab = tab.id
				this.setup_display()
			})
		}
		const show = (id: SettingsTabId): HTMLElement => {
			const panel = panels.get(id)
			if (!panel) {
				throw new Error(`Unknown settings tab: ${id}`)
			}
			return panel
		}
		for (const [id, panel] of panels) {
			panel.style.display = id === this.activeTab ? '' : 'none'
		}
		this.setup_defaults(show('general'))
		this.setup_note_table(show('notes'))
		this.setup_syntax(show('notes'))
		this.setup_folder_table(show('folders'))
		this.setup_ignore_files(show('folders'))
		this.setup_buttons(show('actions'))
	}

	async display() {
		this.setup_display()
	}
}
