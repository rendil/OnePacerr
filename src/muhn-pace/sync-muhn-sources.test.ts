import { describe, expect, it } from 'vitest'
import episodeIndexSnippet from './fixtures/episode-index-snippet.json' with {
	type: 'json',
}
import metadataArcsSnippet from './fixtures/metadata-arcs-snippet.json' with {
	type: 'json',
}
import {
	buildArcPartMap,
	buildMuhnPaceSources,
	extractMuhnEntriesFromEpisodeIndex,
	resolveArcPart,
} from './sync-muhn-sources.js'

describe('sync-muhn-sources', () => {
	it('maps episode index Muhn sources to One Pace arc/episode numbers', () => {
		const arcPartMap = buildArcPartMap(metadataArcsSnippet)
		const { entries, unmappedArcs } = extractMuhnEntriesFromEpisodeIndex(
			episodeIndexSnippet,
			arcPartMap,
		)

		expect(entries).toEqual([
			{
				arc: 19,
				episode: 11,
				album_id: '6VyLVkB2',
				file_id: '67SvndHA',
				filename: '[Muhn Pace] Enies Lobby - 11.mp4',
				size_bytes: 585778950,
			},
		])
		expect(unmappedArcs).toEqual(['Unknown Arc'])
	})

	it('buildMuhnPaceSources uses scraped_at date as version', () => {
		const sources = buildMuhnPaceSources(
			episodeIndexSnippet,
			metadataArcsSnippet,
		)

		expect(sources.version).toBe('2026-05-21')
		expect(sources.entries).toHaveLength(1)
	})

	it('resolveArcPart returns undefined for unknown arc titles', () => {
		const arcPartMap = buildArcPartMap(metadataArcsSnippet)

		expect(resolveArcPart('Enies Lobby', arcPartMap)).toBe(19)
		expect(resolveArcPart('Unknown Arc', arcPartMap)).toBeUndefined()
	})
})
