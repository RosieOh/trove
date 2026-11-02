/**
 * Loaded with `electron -r` by the e2e smoke test. Records every message box to the file
 * named by E2E_DIALOG_LOG and answers with the first button, so a startup that ends in a
 * dialog can run unattended. Has to be in place before the app's own code runs: those
 * dialogs come up before any window exists for Playwright to attach to.
 */
const fs = require('node:fs')
const { dialog } = require('electron')

dialog.showMessageBox = async (...args) => {
  const box = args.find((a) => a?.message)
  const { message, detail, buttons } = box
  fs.appendFileSync(process.env.E2E_DIALOG_LOG, `${JSON.stringify({ message, detail, buttons })}\n`)
  return { response: 0, checkboxChecked: false }
}
