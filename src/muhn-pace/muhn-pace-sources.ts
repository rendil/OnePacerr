import { existsSync, readFileSync } from 'node:fs'
import environment from '../environment.js'
import type { MuhnPaceSourceEntry, MuhnPaceSources } from './muhn-pace.model.js'

export function loadMuhnPaceSources(path?: string): MuhnPaceSources {
	const sourcesPath = path ?? environment.MUHN_PACE_SOURCES_PATH

	if (!existsSync(sourcesPath)) {
		throw new Error(`Muhn Pace sources file not found at ${sourcesPath}`)
	}

	return JSON.parse(readFileSync(sourcesPath, 'utf8')) as MuhnPaceSources
}

export function findMuhnPaceSource(
	sources: MuhnPaceSources,
	arc: number,
	episode: number,
): MuhnPaceSourceEntry | undefined {
	return sources.entries.find(
		entry => entry.arc === arc && entry.episode === episode,
	)
}

export function findMuhnPaceSourceByFileId(
	sources: MuhnPaceSources,
	fileId: string,
): MuhnPaceSourceEntry | undefined {
	return sources.entries.find(entry => entry.file_id === fileId)
}

export function pixeldrainFileUrl(fileId: string): string {
	return `https://pixeldrain.com/api/file/${fileId}`
}

export function pixeldrainBypassFileUrl(fileId: string): string {
	return `https://cdn.pixeldrain.eu.cc/${fileId}`
}
