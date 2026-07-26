export function getCurrentPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation is not supported by this browser.'))
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy }),
      (error) => reject(new Error(error.code === 1 ? 'Location permission was denied. Enable it in browser settings.' : 'Unable to determine your location.')),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000, ...options },
    )
  })
}
