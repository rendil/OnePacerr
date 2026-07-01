import { Logger } from 'ez-ts-logger'

export function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`
	}
	if (bytes < 1024 ** 2) {
		return `${(bytes / 1024).toFixed(1)} KB`
	}
	if (bytes < 1024 ** 3) {
		return `${(bytes / 1024 ** 2).toFixed(1)} MB`
	}
	return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) {
		return 'unknown'
	}
	if (seconds < 60) {
		return `${Math.round(seconds)}s`
	}

	const minutes = Math.floor(seconds / 60)
	const remainingSeconds = Math.round(seconds % 60)
	if (minutes < 60) {
		return `${minutes}m ${remainingSeconds}s`
	}

	const hours = Math.floor(minutes / 60)
	const remainingMinutes = minutes % 60
	return `${hours}h ${remainingMinutes}m`
}

export type DownloadProgressOptions = {
	label: string
	expectedTotalBytes?: number
	attempt?: number
	maxAttempts?: number
}

export class DownloadProgressTracker {
	private totalBytes?: number
	private host?: string
	private lastLoggedMilestone = -1
	private lastHeartbeatAt = 0
	private readonly startedAt = Date.now()

	constructor(private readonly options: DownloadProgressOptions) {}

	setHost(host: string): void {
		this.host = host
	}

	setTotalBytes(totalBytes: number | undefined): void {
		if (totalBytes && totalBytes > 0) {
			this.totalBytes = totalBytes
		}
	}

	logStarted(): void {
		const attemptSuffix =
			this.options.attempt != null && this.options.maxAttempts != null
				? ` (attempt ${this.options.attempt}/${this.options.maxAttempts})`
				: ''
		const sizeHint =
			this.totalBytes ??
			this.options.expectedTotalBytes ??
			undefined
		const sizeSuffix = sizeHint ? `, size ${formatBytes(sizeHint)}` : ''

		Logger.info(
			`[Muhn Pace] Download started: ${this.options.label}${attemptSuffix}${sizeSuffix}${this.host ? ` via ${this.host}` : ''}`,
		)

		if (sizeHint) {
			this.logMilestone(0, 0, sizeHint)
		}
	}

	onBytesWritten(bytesWritten: number): void {
		const total = this.totalBytes ?? this.options.expectedTotalBytes
		if (total) {
			const percent = (bytesWritten / total) * 100
			const milestone = Math.min(90, Math.floor(percent / 10) * 10)
			if (milestone > this.lastLoggedMilestone) {
				this.logMilestone(milestone, bytesWritten, total)
			}
			return
		}

		const now = Date.now()
		if (now - this.lastHeartbeatAt < 30_000) {
			return
		}

		this.lastHeartbeatAt = now
		const elapsedSec = (now - this.startedAt) / 1000
		const speed = elapsedSec > 0 ? bytesWritten / elapsedSec : 0
		Logger.info(
			[
				`[Muhn Pace] ${this.options.label}`,
				formatBytes(bytesWritten),
				`${formatBytes(speed)}/s`,
				`elapsed ${formatDuration(elapsedSec)}`,
				this.host ? `via ${this.host}` : undefined,
			]
				.filter(Boolean)
				.join(' · '),
		)
	}

	logCompleted(bytesWritten: number): void {
		const total = this.totalBytes ?? this.options.expectedTotalBytes ?? bytesWritten
		this.logMilestone(100, bytesWritten, total)
	}

	private logMilestone(
		milestone: number,
		bytesWritten: number,
		total: number,
	): void {
		if (milestone <= this.lastLoggedMilestone && milestone < 100) {
			return
		}

		const elapsedSec = (Date.now() - this.startedAt) / 1000
		const speed = elapsedSec > 0 ? bytesWritten / elapsedSec : 0
		const remainingBytes = Math.max(0, total - bytesWritten)
		const etaSec = speed > 0 ? remainingBytes / speed : Number.POSITIVE_INFINITY

		const parts = [
			`[Muhn Pace] ${this.options.label}`,
			`${milestone}%`,
			`${formatBytes(bytesWritten)} / ${formatBytes(total)}`,
			`${formatBytes(speed)}/s`,
		]

		if (milestone < 100) {
			parts.push(`ETA ${formatDuration(etaSec)}`)
		} else {
			parts.push(`finished in ${formatDuration(elapsedSec)}`)
		}

		if (this.host) {
			parts.push(`via ${this.host}`)
		}

		Logger.info(parts.join(' · '))
		this.lastLoggedMilestone = milestone
	}
}
