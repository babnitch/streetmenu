'use client'

import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { Restaurant } from '@/types'

interface MapProps {
  restaurants: Restaurant[]
  onSelectRestaurant: (restaurant: Restaurant) => void
  selectedId: string | null
  center?: [number, number] // [lng, lat] — Mapbox order
  zoom?: number
}

export default function Map({ restaurants, onSelectRestaurant, selectedId, center, zoom = 13 }: MapProps) {
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const markersRef = useRef<{ [key: string]: mapboxgl.Marker }>({})
  const initialCenter = center ?? [8.5417, 47.3769]

  useEffect(() => {
    if (center && mapRef.current) {
      const fly = () => mapRef.current?.flyTo({ center, zoom, duration: 800 })
      if (mapRef.current.isStyleLoaded()) fly()
      else mapRef.current.once('load', fly)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center?.[0], center?.[1]])

  useEffect(() => {
    if (!mapContainer.current) return

    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: initialCenter as [number, number],
      zoom,
    })

    map.addControl(new mapboxgl.NavigationControl(), 'top-right')
    map.addControl(new mapboxgl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), 'top-right')

    mapRef.current = map

    return () => {
      Object.values(markersRef.current).forEach(m => m.remove())
      map.remove()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!mapRef.current) return

    // Remove old markers
    Object.values(markersRef.current).forEach(m => m.remove())
    markersRef.current = {}

    restaurants.forEach(restaurant => {
      const el = document.createElement('div')
      el.className = 'marker-container'
      el.innerHTML = `
        <div class="marker ${restaurant.is_open ? 'marker-open' : 'marker-closed'} ${selectedId === restaurant.id ? 'marker-selected' : ''}">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
          </svg>
          <span class="marker-dot ${restaurant.is_open ? 'dot-open' : 'dot-closed'}"></span>
        </div>
      `

      el.addEventListener('click', () => onSelectRestaurant(restaurant))

      const marker = new mapboxgl.Marker(el)
        .setLngLat([restaurant.lng, restaurant.lat])
        .addTo(mapRef.current!)

      markersRef.current[restaurant.id] = marker
    })
  }, [restaurants, selectedId, onSelectRestaurant])

  return (
    <>
      <style>{`
        .marker-container { cursor: pointer; }
        .marker {
          width: 44px;
          height: 44px;
          border-radius: 50% 50% 50% 0;
          transform: rotate(-45deg);
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
          transition: transform 0.2s, box-shadow 0.2s;
        }
        .marker:hover { transform: rotate(-45deg) scale(1.15); box-shadow: 0 6px 20px rgba(0,0,0,0.4); }
        .marker-open { background: var(--brand, #F97316); }
        .marker-closed { background: #9ca3af; }
        .marker-selected { transform: rotate(-45deg) scale(1.2); box-shadow: 0 6px 20px rgba(249,115,22,0.6); }
        .marker svg { transform: rotate(45deg); }
        .marker-dot {
          position: absolute;
          bottom: -2px;
          right: -2px;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          border: 2px solid white;
          transform: rotate(45deg);
        }
        .dot-open { background: #22c55e; }
        .dot-closed { background: #ef4444; }
      `}</style>
      <div ref={mapContainer} className="w-full h-full" />
    </>
  )
}
