import { describe, expect, it } from 'vitest'
import testMetadata from '../muhn-pace/fixtures/test-metadata.json' with { type: 'json' }
import { Metadata } from './metadata.model.js'
import {
	getEpisodeFromMuhnCrc32,
	getMuhnPaceCrc32,
	hasMuhnPaceEntry,
} from './muhn-pace-metadata.js'

const metadata = testMetadata as Metadata

describe('muhn-pace-metadata', () => {
	it('hasMuhnPaceEntry returns true for a known arc/episode', () => {
		expect(hasMuhnPaceEntry(metadata, 19, 1)).toBe(true)
	})

	it('hasMuhnPaceEntry returns false when no entry exists', () => {
		expect(hasMuhnPaceEntry(metadata, 19, 99)).toBe(false)
	})

	it('getMuhnPaceCrc32 returns the CRC for a known entry', () => {
		expect(getMuhnPaceCrc32(metadata, 19, 1)).toBe('CCBFE9BB')
	})

	it('getMuhnPaceCrc32 returns undefined when no entry exists', () => {
		expect(getMuhnPaceCrc32(metadata, 1, 1)).toBeUndefined()
	})

	it('getEpisodeFromMuhnCrc32 resolves arc and episode from CRC', () => {
		expect(getEpisodeFromMuhnCrc32(metadata, 'CCBFE9BB')).toEqual({
			arc: 19,
			episode: 1,
		})
	})

	it('getEpisodeFromMuhnCrc32 is case-insensitive', () => {
		expect(getEpisodeFromMuhnCrc32(metadata, 'ccbfe9bb')).toEqual({
			arc: 19,
			episode: 1,
		})
	})

	it('getEpisodeFromMuhnCrc32 returns undefined for unknown CRC', () => {
		expect(getEpisodeFromMuhnCrc32(metadata, 'DEADBEEF')).toBeUndefined()
	})

	it('supports live one-pace-metadata v2 dict shape', () => {
		const liveMetadata = {
			...metadata,
			other_edits: {
				muhn_pace: {
					e76279289f760b1a: {
						arc: 31,
						episode: 3,
						hashes: { crc32: 'CCBFD631', blake2: 'e76279289f760b1a' },
					},
				},
			},
		} as Metadata

		expect(hasMuhnPaceEntry(liveMetadata, 31, 3)).toBe(true)
		expect(hasMuhnPaceEntry(liveMetadata, 31, 4)).toBe(false)
		expect(getMuhnPaceCrc32(liveMetadata, 31, 3)).toBe('CCBFD631')
		expect(getEpisodeFromMuhnCrc32(liveMetadata, 'ccbfd631')).toEqual({
			arc: 31,
			episode: 3,
		})
	})
})
