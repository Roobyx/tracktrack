export function formatTaskNumber(prefix: string, number: number): string {
	return `${prefix}-${number}`
}

export function parseTaskNumber(text: string): { prefix: string; number: number } | null {
	const match = text.match(/^([A-Z]{2,5})-(\d+)$/i)
	if (!match) return null
	return { prefix: match[1].toUpperCase(), number: Number.parseInt(match[2], 10) }
}
