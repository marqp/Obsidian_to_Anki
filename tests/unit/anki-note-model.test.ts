import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AnkiConnectRequest } from '../../src/anki'
import { createManager, requests2Payload } from './anki-test-helpers'

describe('Phase 5: updateNoteModel behind opt-in', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('queues updateNoteModel when the setting is on and the action is supported', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const { manager, invokeMock } = createManager({
			supportedActions: ['updateNote', 'updateNoteModel'],
			allowNoteTypeChanges: true,
			localModelName: 'Cloze',
			ankiModelName: 'Basic'
		})
		await manager.requests_1()

		const payload = requests2Payload(invokeMock)
		expect(payload).toContain('updateNoteModel')
		const requests2Multi = invokeMock.mock.calls[2] as [string, { actions: AnkiConnectRequest[] }]
		const modelBatch = requests2Multi[1].actions.find((action) =>
			JSON.stringify(action).includes('updateNoteModel')
		)
		const modelAction = (modelBatch?.params['actions'] as AnkiConnectRequest[])[0]
		expect(modelAction.params).toEqual({
			note: { id: 55, modelName: 'Cloze', fields: { Text: 'cloze content' }, tags: ['noteTag', 'fileTag'] }
		})
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it('only warns when the setting is off', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const { manager, invokeMock } = createManager({
			supportedActions: ['updateNote', 'updateNoteModel'],
			allowNoteTypeChanges: false,
			localModelName: 'Cloze',
			ankiModelName: 'Basic'
		})
		await manager.requests_1()

		expect(requests2Payload(invokeMock)).not.toContain('updateNoteModel')
		expect(warnSpy.mock.calls.flat().join(' ')).toContain('Allow Note Type Changes')
	})

	it('warns instead of queueing when the daemon lacks updateNoteModel', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const { manager, invokeMock } = createManager({
			supportedActions: ['updateNote'],
			allowNoteTypeChanges: true,
			localModelName: 'Cloze',
			ankiModelName: 'Basic'
		})
		await manager.requests_1()

		expect(requests2Payload(invokeMock)).not.toContain('updateNoteModel')
		expect(warnSpy.mock.calls.flat().join(' ')).toContain('does not support updateNoteModel')
	})

	it('does nothing when the models already match', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const { manager, invokeMock } = createManager({
			supportedActions: ['updateNote', 'updateNoteModel'],
			allowNoteTypeChanges: true,
			localModelName: 'Cloze',
			ankiModelName: 'Cloze'
		})
		await manager.requests_1()

		expect(requests2Payload(invokeMock)).not.toContain('updateNoteModel')
		expect(warnSpy).not.toHaveBeenCalled()
	})
})
