import type { PluginSettings } from '../interfaces/settings-interface'
import { DEFAULT_IGNORED_FILE_GLOBS } from '../settings'
import { DEFAULTS_META } from '../defaults-meta'

export interface MigrationResult {
	settings: PluginSettings
	dirty: boolean
}

function cloneDefault(value: string[] | string | number | boolean): string[] | string | number | boolean {
	return Array.isArray(value) ? [...value] : value
}

function isEmptyRecord(value: unknown): boolean {
	return typeof value !== 'object' || value === null || Array.isArray(value)
}

/**
 * Bring stored settings up to the current schema. Pure: no I/O, no plugin
 * access — the caller (loadSettings) persists once when dirty is true.
 * Must stay idempotent: a second run over migrated settings returns
 * dirty=false. Every branch here mirrors a former read-time mutation in
 * the settings display path (now render-only by AGENTS.md rule).
 */
export function migrateSettings(settings: PluginSettings): MigrationResult {
	let dirty = false
	const markDirty = (): void => {
		dirty = true
	}

	// Legacy single scan directory -> directory list (then drop the old key).
	if (Object.prototype.hasOwnProperty.call(settings.Defaults, 'Scan Directory')) {
		const oldValue = settings.Defaults['Scan Directory']
		if (typeof oldValue === 'string' && oldValue.trim() !== '') {
			settings.Defaults['Scan Directories'] = [oldValue]
		} else {
			settings.Defaults['Scan Directories'] = []
		}
		delete settings.Defaults['Scan Directory']
		markDirty()
	}

	// Fill defaults added after the stored data was written.
	for (const meta of DEFAULTS_META) {
		if (!Object.prototype.hasOwnProperty.call(settings.Defaults, meta.key)) {
			settings.Defaults[meta.key] = cloneDefault(meta.value)
			markDirty()
		}
	}

	// Shape guarantees the display path used to enforce on every open.
	if (isEmptyRecord(settings.CONTEXT_FIELDS)) {
		settings.CONTEXT_FIELDS = {}
		markDirty()
	}
	if (isEmptyRecord(settings.FOLDER_DECKS)) {
		settings.FOLDER_DECKS = {}
		markDirty()
	}
	if (isEmptyRecord(settings.FOLDER_TAGS)) {
		settings.FOLDER_TAGS = {}
		markDirty()
	}
	if (!Array.isArray(settings.IGNORED_FILE_GLOBS)) {
		settings.IGNORED_FILE_GLOBS = DEFAULT_IGNORED_FILE_GLOBS
		markDirty()
	}

	// Prune empty-string folder rules to avoid data.json bloat.
	for (const key of Object.keys(settings.FOLDER_DECKS)) {
		if (!settings.FOLDER_DECKS[key] || settings.FOLDER_DECKS[key].trim() === '') {
			delete settings.FOLDER_DECKS[key]
			markDirty()
		}
	}
	for (const key of Object.keys(settings.FOLDER_TAGS)) {
		if (!settings.FOLDER_TAGS[key] || settings.FOLDER_TAGS[key].trim() === '') {
			delete settings.FOLDER_TAGS[key]
			markDirty()
		}
	}

	return { settings, dirty }
}
