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
	},
}))

describe('Muhn Pace feature: missing dub episode import', () => {
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
		vi.stubEnv('FILTERS_INCLUDE', 'S19E01')
		vi.stubEnv('SKIP_VERIFY_PRESENT_FILES', 'false')
		vi.stubEnv('SKIP_ORGANIZE_PRESENT_FILES', 'true')
		vi.stubEnv('SKIP_UPDATE_METADATA_PRESENT_FILES', 'true')
		vi.stubEnv('SKIP_DOWNLOADS', 'false')
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

	it('downloads from Pixeldrain, verifies Muhn CRC32, and imports .mp4 to the library', async () => {
		const { Context } = await import('../util/context.js')
		const { MetadataController } = await import(
			'../metadata/metadata.controller.js'
		)
		const { LibraryController } = await import(
			'../library/library.controller.js'
		)
		const { MuhnPaceController } = await import(
			'./muhn-pace.controller.js'
		)
		const getFileCrc32Hash = (await import('../util/crc32.js')).default

		Context.metadata = new MetadataController()
		Context.library = new LibraryController()
		Context.muhnPace = new MuhnPaceController()
		await Context.library.init()

		;(Context.metadata as unknown as { metadata: typeof testMetadata }).metadata =
			testMetadata

		await Context.muhnPace.queueDownload(19, 1)
		await Context.muhnPace.processPendingDownloads()
		await Context.muhnPace.processStagingDirectory()

		const libraryFile = await Context.library.getExistingLibraryEpisodeFile(
			Context.metadata.getEpisode(19, 1),
		)

		expect(libraryFile).toBeTruthy()
		expect(libraryFile).toMatch(/\.mp4$/)
		expect(existsSync(libraryFile)).toBe(true)

		const importedCrc = await getFileCrc32Hash(libraryFile)
		expect(importedCrc).toBe(EXPECTED_MUHN_CRC32)
		expect(readFileSync(libraryFile)).toEqual(TEST_EPISODE_BYTES)

		const expectedName = LibraryController.resolveEpisodeTargetFileName(
			19,
			1,
			'The Law of the Sea',
		)
		expect(path.basename(libraryFile)).toBe(expectedName)

		expect(axiosGet).toHaveBeenCalledWith(
			'https://pixeldrain.com/api/file/test-file-id',
			expect.objectContaining({ responseType: 'stream' }),
		)
	})
})
