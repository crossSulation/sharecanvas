const { existsSync } = require('fs')
const { join } = require('path')

let nativeBinding = null
let localFileExisted = false
let loadError = null

function isMusl() {
  if (!process.report || typeof process.report.getReport !== 'function') {
    try {
      return readFileSync('/usr/bin/ldd', 'utf8').includes('musl')
    } catch {
      return true
    }
  } else {
    const report = process.report.getReport()
    const glibcVersion = report?.header?.glibcVersionRuntime
    return !glibcVersion
  }
}

const platform = process.platform
const arch = process.arch
const triples = {
  'darwin-arm64': 'sharecanvas-native.darwin-arm64.node',
  'darwin-x64': 'sharecanvas-native.darwin-x64.node',
  'linux-arm64-gnu': 'sharecanvas-native.linux-arm64-gnu.node',
  'linux-arm64-musl': 'sharecanvas-native.linux-arm64-musl.node',
  'linux-x64-gnu': 'sharecanvas-native.linux-x64-gnu.node',
  'linux-x64-musl': 'sharecanvas-native.linux-x64-musl.node',
  'win32-x64-msvc': 'sharecanvas-native.win32-x64-msvc.node',
}

function loadBinding() {
  const suffix = platform === 'linux' && arch === 'arm64' && isMusl() ? '-musl'
    : platform === 'linux' && arch === 'x64' && isMusl() ? '-musl'
    : platform === 'linux' ? '-gnu'
    : platform === 'win32' ? '-msvc'
    : ''
  const key = `${platform}-${arch}${suffix}`
  const filename = triples[key]
  if (!filename) throw new Error(`Unsupported platform: ${key}`)
  const filePath = join(__dirname, filename)
  if (!existsSync(filePath)) throw new Error(`Native binding not found: ${filename}`)
  try {
    nativeBinding = require(filePath)
  } catch (e) {
    loadError = e
    throw e
  }
}

loadBinding()

module.exports.beautifyStroke = nativeBinding.beautifyStroke
module.exports.beautify_stroke = nativeBinding.beautify_stroke
