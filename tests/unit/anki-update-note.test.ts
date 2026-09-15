import { describe, it, expect, vi } from 'vitest'
import * as AnkiConnect from '../../src/anki'
import {
	createManager,
	createParsedSettings,
	createTestFile,
	mainMultiActions,
	requests2Payload
} from './anki-test-helpers'

describe('Phase 4: updateNote capability gate', () => {
	it('builds updateNote payloads with consolidated tags', () => {
		const file = createTestFile(createParsedSettings())
		const update = file.getNoteUpdates(true)
		const actions = update.params['actions'] as AnkiConnect.AnkiConnectRequest[]
		expect(actions[0]).toEqual({
			action: 'updateNote',
			version: 6,
			params: { note: { id: 55, fields: { Text: 'cloze content' }, tags: ['noteTag', 'fileTag'] } }
		})
	})

	it('falls back to updateNoteFields when updateNote is unsupported', () => {
		const file = createTestFile(createParsedSettings())
		const update = file.getNoteUpdates(false)
		const actions = update.params['actions'] as AnkiConnect.AnkiConnectRequest[]
		expect(actions[0].action).toBe('updateNoteFields')
		expect(actions[0].params).toEqual({ note: { id: 55, fields: { Text: 'cloze content' } } })
	})

	it('detectSupportedActions returns the reported subset', async () => {
		const transport = {
			invoke: vi.fn().mockResolvedValue({ scopes: ['actions'], actions: ['updateNote'] })
		}
		AnkiConnect.setTransport(transport)
		const supported = await AnkiConnect.detectSupportedActions(['updateNote', 'updateNoteModel'])
		expect(supported).toEqual(new Set(['updateNote']))
		expect(transport.invoke).toHaveBeenCalledWith('apiReflect', {
			scopes: ['actions'],
			actions: ['updateNote', 'updateNoteModel']
		})
	})

	it('detectSupportedActions degrades to empty set on failure', async () => {
		AnkiConnect.setTransport({ invoke: vi.fn().mockRejectedValue(new Error('unsupported action')) })
		expect(await AnkiConnect.detectSupportedActions(['updateNote'])).toEqual(new Set())
	})

	it('uses updateNote in round 1 and skips tag replacement in round 2', async () => {
		const { manager, invokeMock } = createManager({
			supportedActions: ['updateNote', 'updateNoteModel']
		})
		await manager.requests_1()

		const updateBatch = mainMultiActions(invokeMock)[4]
		const perFile = (updateBatch.params['actions'] as AnkiConnect.AnkiConnectRequest[])[0]
		const action = (perFile.params['actions'] as AnkiConnect.AnkiConnectRequest[])[0]
		expect(action.action).toBe('updateNote')
		expect(requests2Payload(invokeMock)).not.toContain('updateNoteTags')
	})

	it('keeps the legacy round-1/round-2 split when updateNote is unsupported', async () => {
		const { manager, invokeMock } = createManager({
			supportedActions: []
		})
		await manager.requests_1()

		const updateBatch = mainMultiActions(invokeMock)[4]
		const perFile = (updateBatch.params['actions'] as AnkiConnect.AnkiConnectRequest[])[0]
		const action = (perFile.params['actions'] as AnkiConnect.AnkiConnectRequest[])[0]
		expect(action.action).toBe('updateNoteFields')
		expect(requests2Payload(invokeMock)).toContain('updateNoteTags')
	})
})
