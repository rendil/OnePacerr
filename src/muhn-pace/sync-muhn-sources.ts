import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { MuhnPaceSourceEntry, MuhnPaceSources } from './muhn-pace.model.js'

export const DEFAULT_EPISODE_INDEX_URL =
	'https://raw.githubusercontent.com/Nicolaslahri/onepacedownloader/main/_source/episode_index.json'

export const DEFAULT_METADATA_URL =
	'https://raw.githubusercontent.com/ladyisatis/one-pace-metadata/refs/heads/v2/metadata/data.json'

/** Index arc title → metadata arc title when they differ. Keys are normalized. */
export const ARC_TITLE_ALIASES: Record<string, string> = {}

type EpisodeIndexSource = {
	kind: string
	album_id?: string
	file_id?: string
	filename?: string
	size_bytes?: number
}

type EpisodeIndex = {
	scraped_at?: string
	arcs: Array<{
		title: string
		episodes: Array<{
			num: number
			sources?: EpisodeIndexSource[]
		}>
	}>
}

type MetadataArc = {
	part: number
	title: string
}

type Metadata = {
	arcs: Record<string, MetadataArc[]>
}

export function normalizeArcTitle(title: string): string {
	return title.trim().toLowerCase()
}

export function buildArcPartMap(
	metadata: Metadata,
	language = 'en',
): Map<string, number> {
	const map = new Map<string, number>()
	for (const arc of metadata.arcs[language] ?? []) {
		map.set(normalizeArcTitle(arc.title), arc.part)
	}
	return map
}

export function resolveArcPart(
	arcTitle: string,
	arcPartMap: Map<string, number>,
): number | undefined {
	const normalized = normalizeArcTitle(arcTitle)
	const alias = ARC_TITLE_ALIASES[normalized]
	const lookupTitle = alias ? normalizeArcTitle(alias) : normalized
	return arcPartMap.get(lookupTitle)
}

export function extractMuhnEntriesFromEpisodeIndex(
	episodeIndex: EpisodeIndex,
	arcPartMap: Map<string, number>,
): { entries: MuhnPaceSourceEntry[]; unmappedArcs: string[] } {
	const entries: MuhnPaceSourceEntry[] = []
	const unmappedArcs = new Set<string>()

	for (const arc of episodeIndex.arcs) {
		const part = resolveArcPart(arc.title, arcPartMap)
		if (part === undefined) {
			const hasMuhn = arc.episodes.some(ep =>
				(ep.sources ?? []).some(source => source.kind === 'muhn'),
			)
			if (hasMuhn) {
				unmappedArcs.add(arc.title)
			}
			continue
		}

		for (const episode of arc.episodes) {
			for (const source of episode.sources ?? []) {
				if (source.kind !== 'muhn') continue
				if (!source.file_id || !source.album_id || !source.filename) continue

				entries.push({
					arc: part,
					episode: episode.num,
					album_id: source.album_id,
					file_id: source.file_id,
					filename: source.filename,
					...(source.size_bytes !== undefined
						? { size_bytes: source.size_bytes }
						: {}),
				})
			}
		}
	}

	entries.sort(
		(a, b) => a.arc - b.arc || a.episode - b.episode,
	)

	return { entries, unmappedArcs: [...unmappedArcs] }
}

export function buildMuhnPaceSources(
	episodeIndex: EpisodeIndex,
	metadata: Metadata,
	language = 'en',
): MuhnPaceSources {
	const arcPartMap = buildArcPartMap(metadata, language)
	const { entries } = extractMuhnEntriesFromEpisodeIndex(
		episodeIndex,
		arcPartMap,
	)
	const version =
		episodeIndex.scraped_at?.slice(0, 10) ??
		new Date().toISOString().slice(0, 10)

	return { version, entries }
}

export type SyncMuhnPaceSourcesOptions = {
	episodeIndexUrl?: string
	metadataUrl?: string
	outputPath?: string
	language?: string
	fetch?: typeof fetch
}

export async function syncMuhnPaceSources(
	options: SyncMuhnPaceSourcesOptions = {},
): Promise<MuhnPaceSources> {
	const fetchFn = options.fetch ?? fetch
	const episodeIndexUrl = options.episodeIndexUrl ?? DEFAULT_EPISODE_INDEX_URL
	const metadataUrl = options.metadataUrl ?? DEFAULT_METADATA_URL
	const outputPath =
		options.outputPath ?? path.resolve('muhn-pace-sources.json')
	const language = options.language ?? 'en'

	const [indexResponse, metadataResponse] = await Promise.all([
		fetchFn(episodeIndexUrl),
		fetchFn(metadataUrl),
	])

	if (!indexResponse.ok) {
		throw new Error(
			`Failed to fetch episode index (${indexResponse.status}): ${episodeIndexUrl}`,
		)
	}
	if (!metadataResponse.ok) {
		throw new Error(
			`Failed to fetch metadata (${metadataResponse.status}): ${metadataUrl}`,
		)
	}

	const episodeIndex = (await indexResponse.json()) as EpisodeIndex
	const metadata = (await metadataResponse.json()) as Metadata
	const arcPartMap = buildArcPartMap(metadata, language)
	const { entries, unmappedArcs } = extractMuhnEntriesFromEpisodeIndex(
		episodeIndex,
		arcPartMap,
	)

	if (unmappedArcs.length > 0) {
		console.warn(
			`Warning: skipped Muhn entries for unmapped arcs: ${unmappedArcs.join(', ')}`,
		)
	}

	const sources = buildMuhnPaceSources(episodeIndex, metadata, language)
	writeFileSync(outputPath, `${JSON.stringify(sources, null, '\t')}\n`)
	console.log(
		`Wrote ${sources.entries.length} Muhn Pace source entries to ${outputPath} (version ${sources.version})`,
	)

	return sources
}

const isMainModule =
	typeof process !== 'undefined' &&
	process.argv[1]?.endsWith('sync-muhn-sources.js')

if (isMainModule) {
	const outputFlag = process.argv.indexOf('--output')
	const outputPath =
		outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined

	syncMuhnPaceSources({ outputPath }).catch(error => {
		console.error(error)
		process.exit(1)
	})
}
