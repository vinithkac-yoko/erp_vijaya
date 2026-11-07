import type { MetadataRoute } from 'next';

/** Lets the owner put Vijaya Stores on his phone's home screen like an app. It is the same site: nothing is stored on the phone but the look. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Vijaya Stores', short_name: 'Vijaya', description: 'Stores and stock for Vijaya Electronics.',
    start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait',
    background_color: '#F4F0E6', theme_color: '#1B2A38',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
