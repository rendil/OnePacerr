import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import testMetadata from '../../muhn-pace/fixtures/test-metadata.json' with {
	type: 'json',
}

describe('LocalFolderController.getExistingLibraryEpisodeFile', () => {
	let libraryRoot: string

	beforeEach(async () => {
		libraryRoot = mkdtempSync(path.join(tmpdir(), 'onepacerr-lib-'))
		vi.stubEnv('TESTING', 'true')
		vi.stubEnv('LIBRARY_MEDIA_SERVER', 'none')
		vi.stubEnv('LIBRARY_NONE_ROOT_FOLDER', libraryRoot)
		vi.stubEnv('PREFER_MUHN_PACE', 'true')
		vi.resetModules()
	})

	afterEach(() => {
		rmSync(libraryRoot, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it('finds .mp4 files by SxxExx pattern when Muhn Pace is enabled', async () => {
		const { Context } = await import('../../util/context.js')
		const { MetadataController } = await import(
			'../../metadata/metadata.controller.js'
		)
		const { LibraryController } = await import('../library.controller.js')

		Context.metadata = new MetadataController()
		Context.library = new LibraryController()
		await Context.library.init()
		;(Context.metadata as unknown as { metadata: typeof testMetadata }).metadata =
			testMetadata

		const seasonDir = path.join(
			libraryRoot,
			process.env.LIBRARY_SERIES_FOLDER_NAME ?? 'One Pace',
			'Season 19',
		)
		mkdirSync(seasonDir, { recursive: true })
		const mp4Name = 'One Pace - S19E01 - alternate-name.mp4'
		writeFileSync(path.join(seasonDir, mp4Name), 'test-content')

		const found = await Context.library.getExistingLibraryEpisodeFile(
			Context.metadata.getEpisode(19, 1),
		)

		expect(found).toBe(path.join(seasonDir, mp4Name))
	})
})
