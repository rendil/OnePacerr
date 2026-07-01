import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import testMetadata from './fixtures/test-metadata.json' with { type: 'json' }
import muhnPaceSources from './fixtures/muhn-pace-sources.json' with { type: 'json' }

const TEST_EPISODE_BYTES = Buffer.from('MUHN-TEST-EPISODE-CONTENT')
const EXPECTED_MUHN_CRC32 = 'CCBFE9BB'

vi.mock('axios', () => ({
	default: {
		get: vi.fn(),
		isAxiosError: (e: unknown) =>
			typeof e === 'object' && e !== null && 'isAxiosError' in e,
	},
}))

describe('MuhnPaceController', () => {
	let libraryRoot: string
	let stagingDir: string
	let sourcesPath: string
	let axiosGet: ReturnType<typeof vi.fn>

	beforeEach(async () => {
		libraryRoot = mkdtempSync(path.join(tmpdir(), 'onepacerr-lib-'))
		stagingDir = mkdtempSync(path.join(tmpdir(), 'onepacerr-muhn-staging-'))
		sourcesPath = path.join(stagingDir, 'muhn-pace-sources.json')
		await import('node:fs/promises').then(fs =>
			fs.writeFile(sourcesPath, JSON.stringify(muhnPaceSources)),
		)

		vi.stubEnv('TESTING', 'true')
		vi.stubEnv('PREFER_MUHN_PACE', 'true')
		vi.stubEnv('LIBRARY_MEDIA_SERVER', 'none')
		vi.stubEnv('LIBRARY_NONE_ROOT_FOLDER', libraryRoot)
		vi.stubEnv('MUHN_PACE_DOWNLOAD_DIR', stagingDir)
		vi.stubEnv('MUHN_PACE_SOURCES_PATH', sourcesPath)
		vi.stubEnv('SKIP_DOWNLOADS', 'false')
		vi.stubEnv('SKIP_UPDATE_METADATA_PRESENT_FILES', 'true')
		vi.stubEnv(
			'LIBRARY_FILENAME_FORMAT',
			'{SERIES_NAME} - S{ARC}E{EPISODE} - {TITLE}.mp4',
		)

		vi.resetModules()
		const axios = (await import('axios')).default
		axiosGet = vi.mocked(axios.get)
		axiosGet.mockImplementation(async (url: string) => {
			if (url.includes('pixeldrain.com') || url.includes('cdn.pixeldrain.eu.cc')) {
				return {
					data: Readable.from([TEST_EPISODE_BYTES]),
					headers: {},
					status: 200,
				}
			}
			throw new Error(`Unexpected axios.get URL: ${url}`)
		})
	})

	afterEach(() => {
		rmSync(libraryRoot, { recursive: true, force: true })
		rmSync(stagingDir, { recursive: true, force: true })
		vi.unstubAllEnvs()
		vi.clearAllMocks()
	})

	it('downloads from Pixeldrain, verifies CRC32, and imports .mp4 to the library', async () => {
		const { Context } = await import('../util/context.js')
		const { MetadataController } = await import(
			'../metadata/metadata.controller.js'
		)
		const { LibraryController } = await import(
			'../library/library.controller.js'
		)
		const { MuhnPaceController } = await import('./muhn-pace.controller.js')
		const getFileCrc32Hash = (await import('../util/crc32.js')).default

		Context.metadata = new MetadataController()
		Context.library = new LibraryController()
		Context.muhnPace = new MuhnPaceController({ sourcesPath })
		await Context.library.init()

		;(Context.metadata as unknown as { metadata: typeof testMetadata }).metadata =
			testMetadata

		expect(await Context.muhnPace.queueDownload(19, 1)).toBe('added')
		await Context.muhnPace.processPendingDownloads()
		await Context.muhnPace.processStagingDirectory()

		const targetLibraryFile =
			await Context.library.getTargetLibraryEpisodeFile(
				Context.metadata.getEpisode(19, 1),
			)
		const importedPath = path.resolve(
			targetLibraryFile.path,
			targetLibraryFile.filename,
		)

		expect(existsSync(importedPath)).toBe(true)
		expect(importedPath).toMatch(/\.mp4$/)
		expect(readFileSync(importedPath)).toEqual(TEST_EPISODE_BYTES)

		const importedCrc = await getFileCrc32Hash(importedPath)
		expect(importedCrc).toBe(EXPECTED_MUHN_CRC32)

		expect(axiosGet).toHaveBeenCalledWith(
			'https://pixeldrain.com/api/file/test-file-id',
			expect.objectContaining({ responseType: 'stream' }),
		)
	})

	it('returns source_missing when no source entry exists', async () => {
		const { Context } = await import('../util/context.js')
		const { MetadataController } = await import(
			'../metadata/metadata.controller.js'
		)
		const { MuhnPaceController } = await import('./muhn-pace.controller.js')

		Context.metadata = new MetadataController()
		Context.muhnPace = new MuhnPaceController({ sourcesPath })
		;(Context.metadata as unknown as { metadata: typeof testMetadata }).metadata =
			testMetadata

		expect(await Context.muhnPace.queueDownload(19, 3)).toBe('source_missing')
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
					data: Readable.from([TEST_EPISODE_BYTES]),
					headers: {},
					status: 200,
				}
			}
			throw new Error(`Unexpected axios.get URL: ${url}`)
		})

		const { Context } = await import('../util/context.js')
		const { MetadataController } = await import(
			'../metadata/metadata.controller.js'
		)
		const { LibraryController } = await import(
			'../library/library.controller.js'
		)
		const { MuhnPaceController } = await import('./muhn-pace.controller.js')

		Context.metadata = new MetadataController()
		Context.library = new LibraryController()
		Context.muhnPace = new MuhnPaceController({ sourcesPath })
		await Context.library.init()
		;(Context.metadata as unknown as { metadata: typeof testMetadata }).metadata =
			testMetadata

		expect(await Context.muhnPace.queueDownload(19, 1)).toBe('added')
		await Context.muhnPace.processPendingDownloads()
		await Context.muhnPace.processStagingDirectory()

		expect(axiosGet).toHaveBeenCalledWith(
			'https://cdn.pixeldrain.eu.cc/test-file-id',
			expect.objectContaining({ responseType: 'stream' }),
		)

		const targetLibraryFile =
			await Context.library.getTargetLibraryEpisodeFile(
				Context.metadata.getEpisode(19, 1),
			)
		const importedPath = path.resolve(
			targetLibraryFile.path,
			targetLibraryFile.filename,
		)
		expect(existsSync(importedPath)).toBe(true)
	})

	it('skips pixeldrain.com for later files in the same album after bypass', async () => {
		axiosGet.mockImplementation(async (url: string) => {
			if (url.includes('pixeldrain.com/api/file/test-file-id')) {
				throw Object.assign(new Error('rate limited'), {
					isAxiosError: true,
					response: { status: 429 },
				})
			}
			if (url.includes('cdn.pixeldrain.eu.cc/')) {
				return {
					data: Readable.from([TEST_EPISODE_BYTES]),
					headers: {},
					status: 200,
				}
			}
			if (url.includes('pixeldrain.com')) {
				throw new Error(
					`pixeldrain.com should be skipped for album-locked downloads: ${url}`,
				)
			}
			throw new Error(`Unexpected axios.get URL: ${url}`)
		})

		const { Context } = await import('../util/context.js')
		const { MetadataController } = await import(
			'../metadata/metadata.controller.js'
		)
		const { LibraryController } = await import(
			'../library/library.controller.js'
		)
		const { MuhnPaceController } = await import('./muhn-pace.controller.js')

		Context.metadata = new MetadataController()
		Context.library = new LibraryController()
		Context.muhnPace = new MuhnPaceController({ sourcesPath })
		await Context.library.init()
		;(Context.metadata as unknown as { metadata: typeof testMetadata }).metadata =
			testMetadata

		expect(await Context.muhnPace.queueDownload(19, 1)).toBe('added')
		expect(await Context.muhnPace.queueDownload(19, 2)).toBe('added')
		await Context.muhnPace.processPendingDownloads()

		const pixeldrainCalls = axiosGet.mock.calls.filter(call =>
			String(call[0]).includes('pixeldrain.com'),
		)
		expect(pixeldrainCalls).toHaveLength(1)
		expect(pixeldrainCalls[0]?.[0]).toContain('test-file-id')

		const bypassCalls = axiosGet.mock.calls.filter(call =>
			String(call[0]).includes('cdn.pixeldrain.eu.cc'),
		)
		expect(bypassCalls).toHaveLength(2)
		expect(bypassCalls.map(call => call[0])).toEqual([
			'https://cdn.pixeldrain.eu.cc/test-file-id',
			'https://cdn.pixeldrain.eu.cc/test-file-id-2',
		])
	})

	it('re-queues failed downloads with exponential backoff', async () => {
		vi.stubEnv('MUHN_PACE_MAX_RETRIES', '2')
		vi.stubEnv('MUHN_PACE_RETRY_BASE_DELAY_MS', '0')
		vi.stubEnv('MUHN_PACE_RETRY_MAX_DELAY_MS', '0')
		vi.resetModules()
		vi.useFakeTimers()

		axiosGet.mockImplementation(async (url: string) => {
			if (url.includes('pixeldrain.com') || url.includes('cdn.pixeldrain.eu.cc')) {
				throw new Error('network down')
			}
			throw new Error(`Unexpected axios.get URL: ${url}`)
		})

		const { Context } = await import('../util/context.js')
		const { MetadataController } = await import(
			'../metadata/metadata.controller.js'
		)
		const { MuhnPaceController } = await import('./muhn-pace.controller.js')
		const { Logger } = await import('ez-ts-logger')
		const warnSpy = vi.spyOn(Logger, 'warn')

		Context.metadata = new MetadataController()
		Context.muhnPace = new MuhnPaceController({ sourcesPath })
		;(Context.metadata as unknown as { metadata: typeof testMetadata }).metadata =
			testMetadata

		expect(await Context.muhnPace.queueDownload(19, 1)).toBe('added')

		const firstPass = Context.muhnPace.processPendingDownloads()
		await vi.runAllTimersAsync()
		await firstPass

		const secondPass = Context.muhnPace.processPendingDownloads()
		await vi.runAllTimersAsync()
		await secondPass

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('[Muhn Pace] Re-queued S19E01'),
		)

		vi.useRealTimers()
		warnSpy.mockRestore()
	})

	it('deduplicates queue entries for the same arc and episode', async () => {
		const { Context } = await import('../util/context.js')
		const { MetadataController } = await import(
			'../metadata/metadata.controller.js'
		)
		const { MuhnPaceController } = await import('./muhn-pace.controller.js')

		Context.metadata = new MetadataController()
		Context.muhnPace = new MuhnPaceController({ sourcesPath })
		;(Context.metadata as unknown as { metadata: typeof testMetadata }).metadata =
			testMetadata

		expect(await Context.muhnPace.queueDownload(19, 1)).toBe('added')
		expect(await Context.muhnPace.queueDownload(19, 1)).toBe('added')

		await Context.muhnPace.processPendingDownloads()

		const pixeldrainCalls = axiosGet.mock.calls.filter(call =>
			String(call[0]).includes('pixeldrain'),
		)
		expect(pixeldrainCalls).toHaveLength(1)
	})

	it('pauses downloads when the staging backlog is at capacity', async () => {
		vi.stubEnv('MUHN_PACE_MAX_STAGING_FILES', '1')

		const { writeFileSync, rmSync } = await import('node:fs')
		// A completed, recognized staging file for another episode fills the
		// single backlog slot.
		const backlogPath = path.join(stagingDir, 'test-file-id-2.mp4')
		writeFileSync(backlogPath, TEST_EPISODE_BYTES)

		const { Context } = await import('../util/context.js')
		const { MetadataController } = await import(
			'../metadata/metadata.controller.js'
		)
		const { MuhnPaceController } = await import('./muhn-pace.controller.js')

		Context.metadata = new MetadataController()
		Context.muhnPace = new MuhnPaceController({ sourcesPath })
		;(Context.metadata as unknown as { metadata: typeof testMetadata }).metadata =
			testMetadata

		expect(await Context.muhnPace.queueDownload(19, 1)).toBe('added')
		await Context.muhnPace.processPendingDownloads()

		// Backlog is at capacity, so no new download starts.
		expect(axiosGet).not.toHaveBeenCalled()

		// Simulate the importer draining the backlog; the queued download resumes.
		rmSync(backlogPath)
		await Context.muhnPace.processPendingDownloads()

		expect(axiosGet).toHaveBeenCalledWith(
			'https://pixeldrain.com/api/file/test-file-id',
			expect.objectContaining({ responseType: 'stream' }),
		)
	})

	it('returns already_staged when a complete staging file is present', async () => {
		const { writeFileSync } = await import('node:fs')
		writeFileSync(
			path.join(stagingDir, 'test-file-id.mp4'),
			TEST_EPISODE_BYTES,
		)

		const { Context } = await import('../util/context.js')
		const { MetadataController } = await import(
			'../metadata/metadata.controller.js'
		)
		const { MuhnPaceController } = await import('./muhn-pace.controller.js')

		Context.metadata = new MetadataController()
		Context.muhnPace = new MuhnPaceController({ sourcesPath })
		;(Context.metadata as unknown as { metadata: typeof testMetadata }).metadata =
			testMetadata

		expect(await Context.muhnPace.queueDownload(19, 1)).toBe('already_staged')
		await Context.muhnPace.processPendingDownloads()
		expect(axiosGet).not.toHaveBeenCalled()
	})

	it('imports a completed staging file without re-downloading', async () => {
		const { writeFileSync } = await import('node:fs')
		const stagedPath = path.join(stagingDir, 'test-file-id.mp4')
		writeFileSync(stagedPath, TEST_EPISODE_BYTES)

		const { Context } = await import('../util/context.js')
		const { MetadataController } = await import(
			'../metadata/metadata.controller.js'
		)
		const { LibraryController } = await import(
			'../library/library.controller.js'
		)
		const { MuhnPaceController } = await import('./muhn-pace.controller.js')

		Context.metadata = new MetadataController()
		Context.library = new LibraryController()
		Context.muhnPace = new MuhnPaceController({ sourcesPath })
		await Context.library.init()
		;(Context.metadata as unknown as { metadata: typeof testMetadata }).metadata =
			testMetadata

		await Context.muhnPace.processStagingDirectory()

		expect(axiosGet).not.toHaveBeenCalled()

		const targetLibraryFile =
			await Context.library.getTargetLibraryEpisodeFile(
				Context.metadata.getEpisode(19, 1),
			)
		const importedPath = path.resolve(
			targetLibraryFile.path,
			targetLibraryFile.filename,
		)
		expect(existsSync(importedPath)).toBe(true)
		expect(existsSync(stagedPath)).toBe(false)
	})

	it('imports a complete staging file after already_staged is returned at queue time', async () => {
		const { writeFileSync } = await import('node:fs')
		const stagedPath = path.join(stagingDir, 'test-file-id.mp4')
		writeFileSync(stagedPath, TEST_EPISODE_BYTES)

		const { Context } = await import('../util/context.js')
		const { MetadataController } = await import(
			'../metadata/metadata.controller.js'
		)
		const { LibraryController } = await import(
			'../library/library.controller.js'
		)
		const { MuhnPaceController } = await import('./muhn-pace.controller.js')

		Context.metadata = new MetadataController()
		Context.library = new LibraryController()
		Context.muhnPace = new MuhnPaceController({ sourcesPath })
		await Context.library.init()
		;(Context.metadata as unknown as { metadata: typeof testMetadata }).metadata =
			testMetadata

		expect(await Context.muhnPace.queueDownload(19, 1)).toBe('already_staged')
		await Context.muhnPace.processPendingDownloads()
		expect(axiosGet).not.toHaveBeenCalled()
		expect(existsSync(stagedPath)).toBe(true)

		await Context.muhnPace.processStagingDirectory()

		const targetLibraryFile =
			await Context.library.getTargetLibraryEpisodeFile(
				Context.metadata.getEpisode(19, 1),
			)
		expect(
			existsSync(
				path.resolve(targetLibraryFile.path, targetLibraryFile.filename),
			),
		).toBe(true)
		expect(existsSync(stagedPath)).toBe(false)
	})

	it('skips partial staging files until the download size matches', async () => {
		const { writeFileSync } = await import('node:fs')
		const stagedPath = path.join(stagingDir, 'test-file-id.mp4')
		writeFileSync(stagedPath, TEST_EPISODE_BYTES.subarray(0, 10))

		const { Context } = await import('../util/context.js')
		const { MetadataController } = await import(
			'../metadata/metadata.controller.js'
		)
		const { LibraryController } = await import(
			'../library/library.controller.js'
		)
		const { MuhnPaceController } = await import('./muhn-pace.controller.js')

		Context.metadata = new MetadataController()
		Context.library = new LibraryController()
		Context.muhnPace = new MuhnPaceController({ sourcesPath })
		await Context.library.init()
		;(Context.metadata as unknown as { metadata: typeof testMetadata }).metadata =
			testMetadata

		await Context.muhnPace.processStagingDirectory()

		expect(existsSync(stagedPath)).toBe(true)
		const targetLibraryFile =
			await Context.library.getTargetLibraryEpisodeFile(
				Context.metadata.getEpisode(19, 1),
			)
		expect(
			existsSync(
				path.resolve(targetLibraryFile.path, targetLibraryFile.filename),
			),
		).toBe(false)
	})

	it('hasSource reports source-index coverage per episode', async () => {
		const { MuhnPaceController } = await import('./muhn-pace.controller.js')
		const controller = new MuhnPaceController({ sourcesPath })

		expect(controller.hasSource(19, 1)).toBe(true)
		expect(controller.hasSource(19, 3)).toBe(false)
	})
})
