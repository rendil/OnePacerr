import { Logger } from 'ez-ts-logger'

export class LibraryScanTimeoutError extends Error {
	constructor(public readonly server: string) {
		super(`${server} didn't notify folder update before timeout expired`)
		this.name = 'LibraryScanTimeoutError'
	}
}

export async function waitForLibraryScanIdle(args: {
	server: string
	timeoutMs: number
	getState: () => Promise<{ state: string; progress?: number }>
	pollIntervalMs?: number
}): Promise<void> {
	const pollIntervalMs = args.pollIntervalMs ?? 1000

	await new Promise<void>((resolve, reject) => {
		let settled = false

		const finish = (callback: () => void) => {
			if (settled) {
				return
			}
			settled = true
			clearTimeout(timeoutHandler)
			clearInterval(pollInterval)
			callback()
		}

		const timeoutHandler = setTimeout(() => {
			Logger.warn(
				`${args.server} didn't notify folder update before timeout expired...`,
			)
			finish(() => {
				reject(new LibraryScanTimeoutError(args.server))
			})
		}, args.timeoutMs)

		const pollInterval = setInterval(async () => {
			try {
				const currentTask = await args.getState()

				if (currentTask.state === 'Idle') {
					Logger.debug(`${args.server} notified folder update`)
					finish(resolve)
				} else {
					Logger.debug(
						`${args.server} Scanning... ${currentTask.progress ?? 0}%`,
					)
				}
			} catch (error) {
				finish(() => {
					reject(error)
				})
			}
		}, pollIntervalMs)
	})
}
