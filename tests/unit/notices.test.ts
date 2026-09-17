import { describe, it, expect, beforeEach } from 'vitest'
import { Notice, createdNotices, clearNotices } from '../mocks/obsidian'
import { obsidianNoticePort } from '../../src/notices'

describe('obsidianNoticePort', () => {
	beforeEach(() => {
		clearNotices()
	})

	it('surfaces scan messages through the Obsidian Notice', () => {
		expect(obsidianNoticePort.notify('Scanning vault (sync)...')).toBeInstanceOf(Notice)
		expect(createdNotices).toEqual(['Scanning vault (sync)...'])
	})
})
