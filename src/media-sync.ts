/*Decides what a scan does with media files that changed after they were sent to Anki.
Nothing here writes: FileManager applies the decisions and keeps the records.*/
import type { TFile } from 'obsidian'
import { basename } from 'path'
import * as AnkiConnect from './anki'
import type { ScanIssue, VaultPort } from './files-manager'
import { hashBytes, MEDIA_CHECKS_PER_SCAN, type MediaRecord, type MediaRecords } from './media-records'

/** The vault reads a media decision needs. */
type MediaVault = Pick<VaultPort, 'readBinary' | 'getFirstLinkpathDest'>

/** A media link a scan should compare with Anki. */
export interface MediaCandidate {
	link: string
	dataFile: TFile
	/** Absent when the link has no record, or its recorded file is gone. */
	record?: MediaRecord
}

export type MediaDecision =
	/** Anki already holds the vault's bytes, or nothing about them changed. */
	| { action: 'keep'; hash: string }
	/** The vault changed and Anki still holds what was sent. */
	| { action: 'send'; hash: string }
	/** Either side could be the right one: only a person can decide. */
	| { action: 'report'; inAnki: boolean }

/** What a real scan would do with the changed media, computed without writing. */
export interface MediaPlan {
	/** Names that would be sent. */
	resent: string[]
	/** Vault paths of those files, which a media comparison should not report. */
	paths: ReadonlySet<string>
	issues: ScanIssue[]
}

export const NO_MEDIA_PLAN: MediaPlan = { resent: [], paths: new Set(), issues: [] }

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function mediaDiffersMessage(name: string, inAnki: boolean): string {
	return inAnki
		? `${name} in the vault differs from the file of that name in Anki, and notes in Anki show Anki's file.`
		: `${name} is in the vault but not in Anki's media folder.`
}

/** A difference only a person can settle, filed under the image. */
export function mediaDiffersIssue(link: string, dataFile: TFile, inAnki: boolean): ScanIssue {
	return { file: dataFile.path, kind: 'media-differs', error: mediaDiffersMessage(basename(link), inAnki) }
}

/** A comparison that failed, filed under `path`: no note has to be retried for it. */
export function compareFailedIssue(path: string, link: string, error: unknown): ScanIssue {
	return { file: path, kind: 'media', error: `Could not compare ${link}: ${errorText(error)}` }
}

/**
 * The links worth comparing with Anki, sent files first, so files with no
 * record yet can't delay a changed one. A record whose stat still matches
 * needs no read: this runs on every scan and only looks at cached stats.
 */
export function staleMedia(vault: MediaVault, sent: Iterable<string>, records: MediaRecords): MediaCandidate[] {
	const changed: MediaCandidate[] = []
	const unrecorded: MediaCandidate[] = []
	for (const link of new Set([...sent, ...Object.keys(records)])) {
		const known = records[link]
		const atRecordedPath = known ? vault.getFirstLinkpathDest(known.path, '') : null
		if (atRecordedPath && known) {
			if (atRecordedPath.stat.mtime !== known.mtime || atRecordedPath.stat.size !== known.size) {
				changed.push({ link, dataFile: atRecordedPath, record: known })
			}
			continue
		}
		// Moved or never recorded: only a byte match can tie this file to what Anki holds.
		const dataFile = vault.getFirstLinkpathDest(link, '')
		if (dataFile) {
			unrecorded.push({ link, dataFile })
		}
	}
	return [...changed, ...unrecorded]
}

export async function decideMedia(
	vault: MediaVault,
	{ link, dataFile, record }: MediaCandidate
): Promise<MediaDecision> {
	const hash = hashBytes(await vault.readBinary(dataFile))
	const sentHash = record?.hash ?? null
	if (hash === sentHash) {
		return { action: 'keep', hash }
	}
	const encoded = await AnkiConnect.invoke<string | false>('retrieveMediaFile', { filename: basename(link) })
	if (encoded === false) {
		return { action: 'report', inAnki: false }
	}
	const ankiHash = hashBytes(Buffer.from(encoded, 'base64'))
	if (ankiHash === hash) {
		return { action: 'keep', hash }
	}
	return ankiHash === sentHash ? { action: 'send', hash } : { action: 'report', inAnki: true }
}

/** What a real scan would do with the sent files that changed. Writes nothing. */
export async function planChangedMedia(
	vault: MediaVault,
	sent: Iterable<string>,
	records: MediaRecords
): Promise<MediaPlan> {
	const resent: string[] = []
	const paths = new Set<string>()
	const issues: ScanIssue[] = []
	const recorded = staleMedia(vault, sent, records).filter((candidate) => typeof candidate.record?.hash === 'string')
	for (const candidate of recorded.slice(0, MEDIA_CHECKS_PER_SCAN)) {
		const { link, dataFile } = candidate
		try {
			const decision = await decideMedia(vault, candidate)
			if (decision.action === 'send') {
				resent.push(basename(link))
				paths.add(dataFile.path)
			} else if (decision.action === 'report') {
				issues.push(mediaDiffersIssue(link, dataFile, decision.inAnki))
			}
		} catch (error) {
			issues.push(compareFailedIssue(dataFile.path, link, error))
		}
	}
	return { resent, paths, issues }
}

/** Whether Anki's file of this name holds the vault's bytes; an issue when it does not. */
export async function compareMedia(
	vault: MediaVault,
	path: string,
	link: string,
	dataFile: TFile
): Promise<ScanIssue | null> {
	try {
		const name = basename(link)
		const encoded = await AnkiConnect.invoke<string | false>('retrieveMediaFile', { filename: name })
		if (encoded === false) {
			return { file: path, kind: 'media-differs', error: mediaDiffersMessage(name, false) }
		}
		const inVault = Buffer.from(await vault.readBinary(dataFile))
		if (Buffer.from(encoded, 'base64').equals(inVault)) {
			return null
		}
		return { file: path, kind: 'media-differs', error: mediaDiffersMessage(name, true) }
	} catch (error) {
		return compareFailedIssue(path, link, error)
	}
}
