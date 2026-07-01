import { beforeEach, describe, expect, it, vi } from 'vitest'
import testMetadata from '../muhn-pace/fixtures/test-metadata.json' with {
	type: 'json',
}

describe('MetadataController Muhn Pace integration', () => {
	beforeEach(() => {
		vi.stubEnv('TESTING', 'true')
		vi.stubEnv('PREFER_MUHN_PACE', 'true')
		vi.resetModules()
	})

	it('findEpisodeByCRC32 resolves a Muhn Pace CRC32 to its episode', async () => {
		const { MetadataController } = await import('./metadata.controller.js')
		const metadata = new MetadataController()
		;(metadata as unknown as { metadata: typeof testMetadata }).metadata =
			testMetadata

		expect(metadata.findEpisodeByCRC32('CCBFE9BB')).toEqual(
			expect.objectContaining({ arc: 19, episode: 1 }),
		)
	})

	it('findEpisodeByCRC32 ignores Muhn Pace CRCs when the feature is disabled', async () => {
		vi.stubEnv('PREFER_MUHN_PACE', 'false')
		vi.resetModules()

		const { MetadataController } = await import('./metadata.controller.js')
		const metadata = new MetadataController()
		;(metadata as unknown as { metadata: typeof testMetadata }).metadata =
			testMetadata

		expect(() => metadata.findEpisodeByCRC32('CCBFE9BB')).toThrow()
	})

	it('findEpisodeByCRC32 still resolves standard One Pace CRCs', async () => {
		const { MetadataController } = await import('./metadata.controller.js')
		const metadata = new MetadataController()
		;(metadata as unknown as { metadata: typeof testMetadata }).metadata =
			testMetadata

		expect(metadata.findEpisodeByCRC32('AAAAAAAA')).toEqual(
			expect.objectContaining({ arc: 19, episode: 1 }),
		)
	})
})
