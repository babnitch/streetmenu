'use client'

// Shrink a photo in the browser before upload: longest side 1600 px, JPEG
// ~0.82, the whole picture kept (never cropped). A 3–8 MB phone photo drops
// to ~300–600 KB — under Vercel's 4.5 MB request cap and kinder to mobile
// data. A format the site can't store (e.g. HEIC, which Safari can decode) is
// always re-encoded to JPEG. Anything the browser can't decode is returned
// unchanged; the caller / server then refuses it with a clear message.

import { isStorableImageType } from '@/lib/photoUpload'

export async function shrinkImage(file: File, maxSide = 1600, quality = 0.82): Promise<File> {
  if (file.type && !file.type.startsWith('image/')) return file
  const mustConvert = !isStorableImageType(file.type)
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
    if (!mustConvert && scale === 1 && file.size < 900 * 1024) { bmp.close(); return file }
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * scale)
    canvas.height = Math.round(bmp.height * scale)
    const ctx = canvas.getContext('2d')!
    // JPEG has no transparency: a transparent logo gets white, not black.
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    bmp.close()
    const blob: Blob | null = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality))
    if (!blob || (!mustConvert && blob.size >= file.size)) return file
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch {
    return file
  }
}
