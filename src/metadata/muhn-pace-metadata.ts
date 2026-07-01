import { Metadata } from './metadata.model.js'

type MuhnPaceEpisodeRef = {
	arc: number
	episode: number
}

/** Live metadata carries Muhn Pace CRCs under `other_edits.muhn_pace`. */
type MetadataWithMuhnPace = Metadata & {
	other_edits?: {
		muhn_pace?: unknown
	}
}

type MuhnPaceMetadataEntry = {
	arc: number
	episode: number
	crc32: string
}

type MuhnPaceIndex = {
	byArcEpisode: Map<string, MuhnPaceMetadataEntry>
	byCrc32: Map<string, MuhnPaceEpisodeRef>
}

/** Legacy test/fixture shape: [{ arc, episode, crc32 }] */
type MuhnPaceArrayEntry = {
	arc: number
	episode: number
	crc32: string
}

/** Live one-pace-metadata v2 shape: { [blake2]: { arc, episode, hashes: { crc32 } } } */
type MuhnPaceDictEntry = {
	arc: number
	episode: number
	hashes?: {
		crc32?: string
	}
}

function normalizeMuhnPaceEntries(muhnPace: unknown): MuhnPaceMetadataEntry[] {
	if (!muhnPace) {
		return []
	}

	if (Array.isArray(muhnPace)) {
		return (muhnPace as MuhnPaceArrayEntry[]).filter(
			entry => entry?.arc != null && entry?.episode != null && entry?.crc32,
		)
	}

	if (typeof muhnPace === 'object') {
		return Object.values(muhnPace as Record<string, MuhnPaceDictEntry>)
			.filter(entry => entry?.hashes?.crc32)
			.map(entry => ({
				arc: entry.arc,
				episode: entry.episode,
				crc32: entry.hashes!.crc32!,
			}))
	}

	return []
}

function buildMuhnPaceIndex(metadata: Metadata): MuhnPaceIndex {
	const byArcEpisode = new Map<string, MuhnPaceMetadataEntry>()
	const byCrc32 = new Map<string, MuhnPaceEpisodeRef>()

	for (const entry of normalizeMuhnPaceEntries(
		(metadata as MetadataWithMuhnPace).other_edits?.muhn_pace,
	)) {
		const key = `${entry.arc}-${entry.episode}`
		byArcEpisode.set(key, entry)
		byCrc32.set(entry.crc32.toUpperCase(), {
			arc: entry.arc,
			episode: entry.episode,
		})
	}

	return { byArcEpisode, byCrc32 }
}

export function hasMuhnPaceEntry(
	metadata: Metadata,
	arc: number,
	episode: number,
): boolean {
	const index = buildMuhnPaceIndex(metadata)
	return index.byArcEpisode.has(`${arc}-${episode}`)
}

export function getMuhnPaceCrc32(
	metadata: Metadata,
	arc: number,
	episode: number,
): string | undefined {
	const index = buildMuhnPaceIndex(metadata)
	return index.byArcEpisode.get(`${arc}-${episode}`)?.crc32
}

export function getEpisodeFromMuhnCrc32(
	metadata: Metadata,
	crc32: string,
): MuhnPaceEpisodeRef | undefined {
	const index = buildMuhnPaceIndex(metadata)
	return index.byCrc32.get(crc32.toUpperCase())
}
