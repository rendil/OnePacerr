import { describe, expect, it, vi } from 'vitest'
import {
	DownloadProgressTracker,
	formatBytes,
	formatDuration,
} from './download-progress.js'
import { Logger } from 'ez-ts-logger'

describe('download-progress', () => {
	it('formatBytes renders human-readable sizes', () => {
		expect(formatBytes(512)).toBe('512 B')
		expect(formatBytes(1536)).toBe('1.5 KB')
		expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MB')
	})

	it('formatDuration renders elapsed time', () => {
		expect(formatDuration(45)).toBe('45s')
		expect(formatDuration(125)).toBe('2m 5s')
		expect(formatDuration(3665)).toBe('1h 1m')
	})

	it('logs every 10% milestone', () => {
		const infoSpy = vi.spyOn(Logger, 'info').mockImplementation(() => {})
		const tracker = new DownloadProgressTracker({
			label: 'S19E01',
			expectedTotalBytes: 1000,
		})
		tracker.setHost('pixeldrain.com')
		tracker.logStarted()

		for (let bytes = 1; bytes <= 1000; bytes += 1) {
			tracker.onBytesWritten(bytes)
		}
		tracker.logCompleted(1000)

		const progressLines = infoSpy.mock.calls
			.map(call => String(call[0]))
			.filter(line => line.includes('S19E01 ·'))

		expect(progressLines).toEqual([
			'[Muhn Pace] S19E01 · 0% · 0 B / 1000 B · 0 B/s · ETA unknown · via pixeldrain.com',
			expect.stringContaining('[Muhn Pace] S19E01 · 10%'),
			expect.stringContaining('[Muhn Pace] S19E01 · 20%'),
			expect.stringContaining('[Muhn Pace] S19E01 · 30%'),
			expect.stringContaining('[Muhn Pace] S19E01 · 40%'),
			expect.stringContaining('[Muhn Pace] S19E01 · 50%'),
			expect.stringContaining('[Muhn Pace] S19E01 · 60%'),
			expect.stringContaining('[Muhn Pace] S19E01 · 70%'),
			expect.stringContaining('[Muhn Pace] S19E01 · 80%'),
			expect.stringContaining('[Muhn Pace] S19E01 · 90%'),
			expect.stringContaining('[Muhn Pace] S19E01 · 100%'),
		])

		infoSpy.mockRestore()
	})
})
