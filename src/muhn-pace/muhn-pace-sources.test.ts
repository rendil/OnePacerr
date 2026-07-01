import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureSources from './fixtures/muhn-pace-sources.json' with { type: 'json' }
import {
	findMuhnPaceSource,
	findMuhnPaceSourceByFileId,
	loadMuhnPaceSources,
	pixeldrainBypassFileUrl,
	pixeldrainFileUrl,
} from './muhn-pace-sources.js'

describe('muhn-pace-sources', () => {
	let tempDir: string
	let sourcesPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), 'onepacerr-muhn-sources-'))
		sourcesPath = path.join(tempDir, 'muhn-pace-sources.json')
		writeFileSync(sourcesPath, JSON.stringify(fixtureSources))
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it('loadMuhnPaceSources reads JSON from an explicit path', () => {
		const sources = loadMuhnPaceSources(sourcesPath)

		expect(sources.version).toBe('2026-07-01')
		expect(sources.entries).toHaveLength(2)
	})

	it('findMuhnPaceSource returns the entry for a known arc/episode', () => {
		const sources = loadMuhnPaceSources(sourcesPath)

		expect(findMuhnPaceSource(sources, 19, 1)).toEqual(fixtureSources.entries[0])
	})

	it('findMuhnPaceSource returns undefined when no entry exists', () => {
		const sources = loadMuhnPaceSources(sourcesPath)

		expect(findMuhnPaceSource(sources, 19, 3)).toBeUndefined()
	})

	it('findMuhnPaceSourceByFileId returns the entry for a Pixeldrain file id', () => {
		const sources = loadMuhnPaceSources(sourcesPath)

		expect(findMuhnPaceSourceByFileId(sources, 'test-file-id')).toEqual(
			fixtureSources.entries[0],
		)
	})

	it('pixeldrainFileUrl builds the Pixeldrain API URL', () => {
		expect(pixeldrainFileUrl('test-file-id')).toBe(
			'https://pixeldrain.com/api/file/test-file-id',
		)
	})

	it('pixeldrainBypassFileUrl builds the bypass CDN URL', () => {
		expect(pixeldrainBypassFileUrl('test-file-id')).toBe(
			'https://cdn.pixeldrain.eu.cc/test-file-id',
		)
	})

	it('loadMuhnPaceSources throws when the file is missing and PREFER_MUHN_PACE is true', () => {
		vi.stubEnv('PREFER_MUHN_PACE', 'true')

		expect(() =>
			loadMuhnPaceSources(path.join(tempDir, 'missing.json')),
		).toThrow(/Muhn Pace sources file not found/)
	})
})
