import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { transcodeImageOutput, transcodeImageOutputAsync } from '../lib/image-output.js'

const require = createRequire(import.meta.url)
const PNG = require('../lib/vendor/pngjs/lib/png.js').PNG
const jpeg = require('../lib/vendor/jpeg-js')

function rgbaPng(width = 2, height = 2, rgba = [255, 0, 0, 128]) {
  const data = Buffer.alloc(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i)
  return PNG.sync.write({ width, height, data })
}

test('optional PNG to JPEG conversion emits real JPEG bytes and composites transparency onto selected background', async () => {
  const png = rgbaPng()
  const result = await transcodeImageOutputAsync(png, 'image/png', { jpegOutput: true, jpegQuality: 91, jpegBackground: '#ffffff' })
  assert.equal(result.converted, true)
  assert.equal(result.mediaType, 'image/jpeg')
  assert.equal(result.bytes.subarray(0, 2).toString('hex'), 'ffd8')
  const decoded = jpeg.decode(result.bytes, { useTArray: true })
  assert.equal(decoded.width, 2)
  assert.equal(decoded.height, 2)
  assert.ok(decoded.data[0] > 235, `red=${decoded.data[0]}`)
  assert.ok(decoded.data[1] > 95 && decoded.data[1] < 165, `green=${decoded.data[1]}`)
  assert.ok(decoded.data[2] > 95 && decoded.data[2] < 165, `blue=${decoded.data[2]}`)
})

test('JPEG passes through unchanged and unsupported formats are retained with a warning', () => {
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  const passthrough = transcodeImageOutput(jpegBytes, 'image/png', { jpegOutput: true })
  assert.equal(passthrough.bytes, jpegBytes)
  assert.equal(passthrough.mediaType, 'image/jpeg')
  const gifBytes = Buffer.from('GIF89a fixture')
  const unsupported = transcodeImageOutput(gifBytes, 'image/gif', { jpegOutput: true })
  assert.equal(unsupported.bytes, gifBytes)
  assert.match(unsupported.warning, /image\/gif.*已保留原格式/)
})

test('conversion refuses oversized dimensions before PNG decompression and keeps over-limit output original', () => {
  const oversized = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversized, 0)
  oversized.write('IHDR', 12, 'ascii')
  oversized.writeUInt32BE(10000, 16)
  oversized.writeUInt32BE(2000, 20)
  const tooManyPixels = transcodeImageOutput(oversized, 'image/png', { jpegOutput: true })
  assert.equal(tooManyPixels.bytes, oversized)
  assert.match(tooManyPixels.warning, /像素安全上限/)
  const png = rgbaPng()
  const tooLargeOutput = transcodeImageOutput(png, 'image/png', { jpegOutput: true }, { maxOutputBytes: 1 })
  assert.equal(tooLargeOutput.bytes, png)
  assert.equal(tooLargeOutput.mediaType, 'image/png')
  assert.match(tooLargeOutput.warning, /已保留原图/)
})

test('worker lifecycle falls back for constructor errors, clean exits without a message, and timeouts', async () => {
  const png = rgbaPng()
  const config = { jpegOutput: true }
  const createWorker = () => {
    const worker = new EventEmitter()
    worker.terminate = async () => {}
    return worker
  }
  const thrown = await transcodeImageOutputAsync(png, 'image/png', config, { workerFactory: () => { throw new Error('startup failed') } })
  assert.equal(thrown.bytes, png)
  assert.match(thrown.warning, /startup failed.*保留原图/)

  const exitingWorker = createWorker()
  const exited = transcodeImageOutputAsync(png, 'image/png', config, { workerFactory: () => exitingWorker })
  queueMicrotask(() => exitingWorker.emit('exit', 0))
  const noMessage = await exited
  assert.equal(noMessage.bytes, png)
  assert.match(noMessage.warning, /未返回结果/)

  const stuckWorker = createWorker()
  const timedOut = await transcodeImageOutputAsync(png, 'image/png', config, { workerFactory: () => stuckWorker, timeoutMs: 5 })
  assert.equal(timedOut.bytes, png)
  assert.match(timedOut.warning, /超时/)
})

test('aborting JPEG conversion terminates worker and returns the original image with a warning', async () => {
  const png = rgbaPng()
  const controller = new AbortController()
  const worker = new EventEmitter()
  worker.terminate = async () => {}
  const pending = transcodeImageOutputAsync(png, 'image/png', { jpegOutput: true }, { signal: controller.signal, workerFactory: () => worker })
  controller.abort()
  const result = await pending
  assert.equal(result.bytes, png)
  assert.match(result.warning, /已取消/)
})
