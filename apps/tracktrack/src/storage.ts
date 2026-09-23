import { signal } from '@preact/signals'

export const viewMode = signal<'list' | 'kanban'>('list')
export const searchQuery = signal('')
export const stateFilter = signal<string[]>([])
export const priorityFilter = signal<string[]>([])
export const tagFilter = signal<string[]>([])
export const assigneeFilter = signal('')

export function clearFilters(): void {
	searchQuery.value = ''
	stateFilter.value = []
	priorityFilter.value = []
	tagFilter.value = []
	assigneeFilter.value = ''
}
