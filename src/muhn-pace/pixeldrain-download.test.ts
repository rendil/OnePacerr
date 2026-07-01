import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	downloadPixeldrainFile,
	shouldSwitchToPixeldrainBypass,
} from './pixeldrain-download.js'

const TEST_BYTES = Buffer.from('MUHN-TEST-EPISODE-CONTENT')

vi.mock('axios', () => ({
	default: {
		get: vi.fn(),
		isAxiosError: (error: unknown) =>
			typeof error === 'object' && error !== null && 'isAxiosError' in error,
	},
}))

function readableThatErrorsAfter(data: Buffer, error: Error): Readable {
	return Readable.from(
		(async function* () {
			yield data
			throw error
		})(),
	)
}

describe('pixeldrain-download', () => {
	let stagingDir: string
	let destPath: string
	let axiosGet: ReturnType<typeof vi.fn>

	beforeEach(async () => {
		stagingDir = mkdtempSync(path.join(tmpdir(), 'onepacerr-pixeldrain-'))
		destPath = path.join(stagingDir, 'test-file-id.mp4')
		vi.resetModules()
		const axios = (await import('axios')).default
		axiosGet = vi.mocked(axios.get)
	})

	afterEach(() => {
		rmSync(stagingDir, { recursive: true, force: true })
		vi.clearAllMocks()
	})

	it('shouldSwitchToPixeldrainBypass detects throttled pixeldrain.com throughput', () => {
		expect(
			shouldSwitchToPixeldrainBypass({
				host: 'pixeldrain.com',
				preferBypass: false,
				elapsedMs: 8000,
				bytesInWindow: 100 * 1024 * 8,
			}),
		).toBe(true)

		expect(
			shouldSwitchToPixeldrainBypass({
				host: 'pixeldrain.com',
				preferBypass: false,
				elapsedMs: 8000,
				bytesInWindow: 600 * 1024 * 8,
			}),
		).toBe(false)

		expect(
			shouldSwitchToPixeldrainBypass({
				host: 'cdn.pixeldrain.eu.cc',
				preferBypass: false,
				elapsedMs: 8000,
				bytesInWindow: 100 * 1024,
			}),
		).toBe(false)
	})

	it('falls back to bypass CDN when pixeldrain.com returns HTTP 429', async () => {
		axiosGet.mockImplementation(async (url: string) => {
			if (url.includes('pixeldrain.com/api/file/')) {
				throw Object.assign(new Error('rate limited'), {
					isAxiosError: true,
					response: { status: 429 },
				})
			}
			if (url.includes('cdn.pixeldrain.eu.cc/')) {
				return {
					data: Readable.from([TEST_BYTES]),
					headers: {},
					status: 200,
				}
			}
			throw new Error(`Unexpected axios.get URL: ${url}`)
		})

		const result = await downloadPixeldrainFile({
			fileId: 'test-file-id',
			destPath,
		})

		expect(result.usedBypass).toBe(true)
		expect(result.host).toBe('cdn.pixeldrain.eu.cc')
		expect(readFileSync(destPath)).toEqual(TEST_BYTES)
		expect(axiosGet).toHaveBeenCalledWith(
			'https://cdn.pixeldrain.eu.cc/test-file-id',
			expect.objectContaining({ responseType: 'stream' }),
		)
	})

	it('restarts on bypass CDN when pixeldrain.com is throttled', async () => {
		const slowPart = TEST_BYTES.subarray(0, 32)

		axiosGet.mockImplementation(async (url: string, config?: { headers?: { Range?: string } }) => {
			if (url.includes('pixeldrain.com/api/file/')) {
				return {
					data: Readable.from([slowPart]),
					headers: {},
					status: 200,
				}
			}
			if (url.includes('cdn.pixeldrain.eu.cc/')) {
				expect(config?.headers?.Range).toBeUndefined()
				return {
					data: Readable.from([TEST_BYTES]),
					headers: {},
					status: 200,
				}
			}
			throw new Error(`Unexpected axios.get URL: ${url}`)
		})

		const onPreferBypass = vi.fn()
		const result = await downloadPixeldrainFile({
			fileId: 'test-file-id',
			destPath,
			warmupMs: 0,
			minBytesPerSec: 1024 * 1024,
			onPreferBypass,
		})

		expect(onPreferBypass).toHaveBeenCalledTimes(1)
		expect(result.usedBypass).toBe(true)
		expect(result.host).toBe('cdn.pixeldrain.eu.cc')
		expect(readFileSync(destPath)).toEqual(TEST_BYTES)
	})

	it('restarts on bypass CDN when pixeldrain.com connection drops mid-stream', async () => {
		const partial = TEST_BYTES.subarray(0, 32)

		axiosGet.mockImplementation(async (url: string, config?: { headers?: { Range?: string } }) => {
			if (url.includes('pixeldrain.com/api/file/')) {
				return {
					data: readableThatErrorsAfter(
						partial,
						Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }),
					),
					headers: {},
					status: 200,
				}
			}
			if (url.includes('cdn.pixeldrain.eu.cc/')) {
				expect(config?.headers?.Range).toBeUndefined()
				return {
					data: Readable.from([TEST_BYTES]),
					headers: {},
					status: 200,
				}
			}
			throw new Error(`Unexpected axios.get URL: ${url}`)
		})

		const onPreferBypass = vi.fn()
		const result = await downloadPixeldrainFile({
			fileId: 'test-file-id',
			destPath,
			onPreferBypass,
		})

		expect(onPreferBypass).toHaveBeenCalledTimes(1)
		expect(result.usedBypass).toBe(true)
		expect(readFileSync(destPath)).toEqual(TEST_BYTES)
	})

	it('restarts from scratch when bypass CDN ignores range requests', async () => {
		const slowPart = TEST_BYTES.subarray(0, 32)

		axiosGet.mockImplementation(async (url: string, config?: { headers?: { Range?: string } }) => {
			if (url.includes('pixeldrain.com/api/file/')) {
				return {
					data: Readable.from([slowPart]),
					headers: {},
					status: 200,
				}
			}
			if (url.includes('cdn.pixeldrain.eu.cc/')) {
				expect(config?.headers?.Range).toBeUndefined()
				return {
					data: Readable.from([TEST_BYTES]),
					headers: { 'content-length': String(TEST_BYTES.length) },
					status: 200,
				}
			}
			throw new Error(`Unexpected axios.get URL: ${url}`)
		})

		const result = await downloadPixeldrainFile({
			fileId: 'test-file-id',
			destPath,
			warmupMs: 0,
			minBytesPerSec: 1024 * 1024,
			expectedTotalBytes: TEST_BYTES.length + slowPart.length,
		})

		expect(result.bytesWritten).toBe(TEST_BYTES.length)
		expect(readFileSync(destPath)).toEqual(TEST_BYTES)
	})

	it('measures throughput only after the warm-up window', async () => {
		const slowPart = TEST_BYTES.subarray(0, 32)

		axiosGet.mockImplementation(async (url: string, config?: { headers?: { Range?: string } }) => {
			if (url.includes('pixeldrain.com/api/file/')) {
				return {
					data: Readable.from([slowPart]),
					headers: {},
					status: 200,
				}
			}
			if (url.includes('cdn.pixeldrain.eu.cc/')) {
				expect(config?.headers?.Range).toBeUndefined()
				return {
					data: Readable.from([TEST_BYTES]),
					headers: {},
					status: 200,
				}
			}
			throw new Error(`Unexpected axios.get URL: ${url}`)
		})

		vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(9000)

		const result = await downloadPixeldrainFile({
			fileId: 'test-file-id',
			destPath,
			warmupMs: 8000,
			minBytesPerSec: 1024 * 1024,
		})

		expect(result.usedBypass).toBe(true)
		expect(readFileSync(destPath)).toEqual(TEST_BYTES)
	})

	it('skips pixeldrain.com when forceBypass is set', async () => {
		axiosGet.mockImplementation(async (url: string) => {
			if (url.includes('cdn.pixeldrain.eu.cc/')) {
				return {
					data: Readable.from([TEST_BYTES]),
					headers: {},
					status: 200,
				}
			}
			throw new Error(`Unexpected axios.get URL: ${url}`)
		})

		const result = await downloadPixeldrainFile({
			fileId: 'test-file-id',
			destPath,
			forceBypass: true,
		})

		expect(result.usedBypass).toBe(true)
		expect(axiosGet).toHaveBeenCalledTimes(1)
		expect(axiosGet.mock.calls[0]?.[0]).toContain('cdn.pixeldrain.eu.cc')
	})
})
