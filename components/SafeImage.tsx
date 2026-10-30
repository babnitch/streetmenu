'use client'

// next/image that never leaves an empty box: if the photo fails to load in
// the browser (dead URL, not an image…), `fallback` shows instead — the
// generated cover for places, restaurants and events. `overlay` (e.g. the
// photo credit) shows only while the photo itself is shown.

import Image, { type ImageProps } from 'next/image'
import { useEffect, useState, type ReactNode } from 'react'

export default function SafeImage({ fallback, overlay, ...props }: ImageProps & { fallback: ReactNode; overlay?: ReactNode }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [props.src])
  if (failed) return <>{fallback}</>
  // eslint-disable-next-line jsx-a11y/alt-text -- alt is passed through props
  return <><Image {...props} onError={() => setFailed(true)} />{overlay}</>
}
