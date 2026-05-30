// electron-builder afterPack hook: ad-hoc sign the macOS .app so Apple Silicon
// will launch it. We have no Apple Developer certificate, so this is the minimum
// that makes an unsigned build runnable (after the user clears the download
// quarantine). No effect on Windows/Linux.
const { execFileSync } = require('child_process')
const path = require('path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
    console.log(`[afterPack] ad-hoc signed ${appPath}`)
  } catch (e) {
    console.warn(`[afterPack] ad-hoc sign failed: ${e.message}`)
  }
}
