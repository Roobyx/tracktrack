/**
 * Minimal, escape-first markdown renderer.
 * All input is HTML-escaped before formatting rules are applied, so raw
 * markup can never reach the DOM. Supports the subset used in task
 * descriptions and planning notes: headings, emphasis, code, links,
 * lists, blockquotes, hr and paragraphs.
 */
function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

function inline(raw: string): string {
	let out = escapeHtml(raw)
	out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
	out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
	out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
	out = out.replace(
		/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
		'<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
	)
	return out
}

export function renderMarkdown(source: string): string {
	const text = (source ?? '').replace(/\r\n/g, '\n')
	if (!text.trim()) return ''
	const lines = text.split('\n')
	const out: string[] = []
	let listType: 'ul' | 'ol' | null = null
	let inCode = false
	let paragraph: string[] = []

	const flushParagraph = () => {
		if (paragraph.length > 0) {
			out.push(`<p>${inline(paragraph.join('<br>'))}</p>`)
			paragraph = []
		}
	}

	const closeList = () => {
		if (listType) {
			out.push(`</${listType}>`)
			listType = null
		}
	}

	for (const line of lines) {
		if (inCode) {
			if (/^```/.test(line.trim())) {
				inCode = false
				out.push('</code></pre>')
			} else {
				out.push(`${escapeHtml(line)}\n`)
			}
			continue
		}
		const trimmed = line.trim()
		if (/^```/.test(trimmed)) {
			flushParagraph()
			closeList()
			inCode = true
			out.push('<pre><code>')
			continue
		}
		if (!trimmed) {
			flushParagraph()
			closeList()
			continue
		}
		const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed)
		if (heading) {
			flushParagraph()
			closeList()
			const level = heading[1].length
			out.push(`<h${level + 1}>${inline(heading[2])}</h${level + 1}>`)
			continue
		}
		if (/^(---+|\*\*\*+)$/.test(trimmed)) {
			flushParagraph()
			closeList()
			out.push('<hr>')
			continue
		}
		const quote = /^>\s?/.test(trimmed)
		if (quote) {
			flushParagraph()
			closeList()
			out.push(`<blockquote>${inline(trimmed.replace(/^>\s?/, ''))}</blockquote>`)
			continue
		}
		const ul = /^[-*+]\s+(.*)$/.exec(trimmed)
		if (ul) {
			flushParagraph()
			if (listType !== 'ul') {
				closeList()
				out.push('<ul>')
				listType = 'ul'
			}
			out.push(`<li>${inline(ul[1])}</li>`)
			continue
		}
		const ol = /^\d+[.)]\s+(.*)$/.exec(trimmed)
		if (ol) {
			flushParagraph()
			if (listType !== 'ol') {
				closeList()
				out.push('<ol>')
				listType = 'ol'
			}
			out.push(`<li>${inline(ol[1])}</li>`)
			continue
		}
		if (listType) closeList()
		paragraph.push(trimmed)
	}
	if (inCode) out.push('</code></pre>')
	flushParagraph()
	closeList()
	return out.join('\n')
}
