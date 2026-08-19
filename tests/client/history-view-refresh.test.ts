import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('packages/client/src/views/hermes/HistoryView.vue', 'utf8')

describe('HistoryView refresh controls', () => {
  it('places the manual refresh control immediately before the outline control', () => {
    const refreshButton = source.indexOf('@click="refreshHistorySessions"')
    const outlineButton = source.indexOf('@click="showOutline = !showOutline"')

    expect(refreshButton).toBeGreaterThanOrEqual(0)
    expect(outlineButton).toBeGreaterThan(refreshButton)
    expect(source.slice(refreshButton, outlineButton)).toContain("t('common.refresh')")
  })

  it('refreshes only the history list every ten seconds without overlapping requests', () => {
    expect(source).toContain('if (historyRefreshing.value || hermesSessionsLoading.value) return')
    expect(source).toContain('historyRefreshTimer = window.setInterval(() => {')
    expect(source).toMatch(/void refreshHistorySessionListIfVisible\(\)\r?\n\s*}, 10_000\)/)
    expect(source).toContain("document.visibilityState !== 'visible'")

    const listRefreshStart = source.indexOf('async function refreshHistorySessionListIfVisible()')
    const visibilityHandlerStart = source.indexOf('function handleHistoryVisibilityChange()', listRefreshStart)
    expect(listRefreshStart).toBeGreaterThanOrEqual(0)
    expect(visibilityHandlerStart).toBeGreaterThan(listRefreshStart)
    expect(source.slice(listRefreshStart, visibilityHandlerStart)).toContain('await loadHermesSessions()')
    expect(source.slice(listRefreshStart, visibilityHandlerStart)).not.toContain('loadHistorySession(')
  })

  it('starts polling before awaiting history initialization', () => {
    const mountedStart = source.indexOf('onMounted(async () => {')
    const timerStart = source.indexOf('historyRefreshTimer = window.setInterval(() => {', mountedStart)
    const profileLoad = source.indexOf('await profilesStore.fetchProfiles()', mountedStart)
    const sessionLoad = source.indexOf('await loadHermesSessions()', mountedStart)

    expect(mountedStart).toBeGreaterThanOrEqual(0)
    expect(timerStart).toBeGreaterThan(mountedStart)
    expect(timerStart).toBeLessThan(profileLoad)
    expect(timerStart).toBeLessThan(sessionLoad)
  })

  it('refreshes after returning to the page and cleans up listeners and timers', () => {
    expect(source).toContain("document.addEventListener('visibilitychange', handleHistoryVisibilityChange)")
    expect(source).toContain("document.removeEventListener('visibilitychange', handleHistoryVisibilityChange)")
    expect(source).toContain('clearInterval(historyRefreshTimer)')
  })
})
