import { Md5 } from 'ts-md5'
import type { FileData, ParsedSettings } from './interfaces/settings-interface'

export const VAULT_SCAN_YIELD_INTERVAL = 100

export function getFileContentHash(content: string): string {
    return Md5.hashStr(content) as string
}

export function isFileUnchanged(
    path: string,
    content: string,
    fileHashes: Record<string, string>
): boolean {
    return Object.prototype.hasOwnProperty.call(fileHashes, path)
        && getFileContentHash(content) === fileHashes[path]
}

/**
 * Build the small amount of state that differs per file while sharing the
 * read-only dictionaries, regular expressions, and Anki note ID set.
 */
export function createFileData(
    data: ParsedSettings,
    deckName: string,
    tags: string[]
): FileData {
    return {
        fields_dict: data.fields_dict,
        custom_regexps: data.custom_regexps,
        file_link_fields: data.file_link_fields,
        context_fields: data.context_fields,
        template: {
            ...data.template,
            deckName,
            fields: { ...data.template.fields },
            options: { ...data.template.options },
            tags: [...tags]
        },
        EXISTING_IDS: data.EXISTING_IDS,
        vault_name: data.vault_name,
        FROZEN_REGEXP: data.FROZEN_REGEXP,
        DECK_REGEXP: data.DECK_REGEXP,
        TAG_REGEXP: data.TAG_REGEXP,
        NOTE_REGEXP: data.NOTE_REGEXP,
        INLINE_REGEXP: data.INLINE_REGEXP,
        EMPTY_REGEXP: data.EMPTY_REGEXP,
        curly_cloze: data.curly_cloze,
        highlights_to_cloze: data.highlights_to_cloze,
        comment: data.comment,
        add_context: data.add_context,
        add_obs_tags: data.add_obs_tags
    }
}

export async function yieldToEventLoop(): Promise<void> {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
}
