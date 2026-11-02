import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/nowhere' } }))

const { getUpdateStatus, initAutoUpdate, setAutoUpdateEnabled } = await import('../electron/updater')

/** The parts of BrowserWindow the updater touches; a destroyed one throws like the real thing. */
function fakeWindow() {
  const send = vi.fn()
  let destroyed = false
  return {
    send,
    destroy: () => {
      destroyed = true
    },
    window: {
      isDestroyed: () => destroyed,
      get webContents() {
        if (destroyed) throw new TypeError('Object has been destroyed')
        return { isDestroyed: () => false, send }
      },
    },
  }
}

describe('update status follows the current window', () => {
  it('survives a closed window and reaches the one opened after it', () => {
    const first = fakeWindow()
    let current: ReturnType<typeof fakeWindow>['window'] | null = first.window
    initAutoUpdate((() => current) as any, true)
    expect(first.send).toHaveBeenCalledWith(IPC.onUpdateStatus, { state: 'unsupported' })

    // Closed, and the window variable not cleared yet: the guard alone must hold.
    first.destroy()
    expect(() => setAutoUpdateEnabled(false)).not.toThrow()
    current = null
    expect(() => setAutoUpdateEnabled(true)).not.toThrow()
    expect(getUpdateStatus()).toEqual({ state: 'unsupported' })

    const second = fakeWindow()
    current = second.window
    setAutoUpdateEnabled(false)
    expect(second.send).toHaveBeenCalledWith(IPC.onUpdateStatus, { state: 'unsupported' })
    expect(first.send).toHaveBeenCalledTimes(1)
  })
})
