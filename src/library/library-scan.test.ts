import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	LibraryScanTimeoutError,
	waitForLibraryScanIdle,
} from './library-scan.js'

describe('library-scan', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('waitForLibraryScanIdle resolves when the scan task returns to Idle', async () => {
		let state = 'Running'
		const promise = waitForLibraryScanIdle({
			server: 'Emby',
			timeoutMs: 5000,
			pollIntervalMs: 1000,
			getState: async () => ({ state, progress: 50 }),
		})

		await vi.advanceTimersByTimeAsync(1000)
		state = 'Idle'
		await vi.advanceTimersByTimeAsync(1000)

		await expect(promise).resolves.toBeUndefined()
	})

	it('waitForLibraryScanIdle rejects with LibraryScanTimeoutError', async () => {
		const promise = waitForLibraryScanIdle({
			server: 'Emby',
			timeoutMs: 2000,
			pollIntervalMs: 500,
			getState: async () => ({ state: 'Running', progress: 10 }),
		})

		const expectation = expect(promise).rejects.toBeInstanceOf(
			LibraryScanTimeoutError,
		)
		await vi.advanceTimersByTimeAsync(2000)
		await expectation
	})
})
