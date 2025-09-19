import React, { useState } from 'react';

// =====================
// Funciones de ayuda
// =====================

// Calcular distancia entre coordenadas (Haversine)
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Geocodificar dirección con OpenStreetMap
async function geocodeAddress(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&q=' + encodeURIComponent(q);
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('Error geocoding');
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error('Sin resultados');
  const hit = data[0];
  return { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon), displayName: hit.display_name };
}

// Crear link de Google Maps con paradas
function googleMapsDirLink(origin, stops) {
  const originParam = origin.lat + ',' + origin.lon;
  const dest = stops[stops.length - 1];
  const destinationParam = dest.lat + ',' + dest.lon;
  const waypoints = stops.slice(0, -1).map(p => p.lat + ',' + p.lon).join('|');
  const wpParam = waypoints ? '&waypoints=' + encodeURIComponent(waypoints) : '';
  return 'https://www.google.com/maps/dir/?api=1&origin=' +
    encodeURIComponent(originParam) +
    '&destination=' + encodeURIComponent(destinationParam) +
    wpParam;
}

// =====================
// Componentes principales
// =====================

function PackageForm({ onAdd }) {
  const [title, setTitle] = useState('');
  const [address, setAddress] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    if (!title || !address) return;
    try {
      const coords = await geocodeAddress(address);
      onAdd({ title, address, ...coords });
      setTitle('');
      setAddress('');
    } catch (err) {
      alert('Error geocodificando dirección');
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginBottom: '1em' }}>
      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="Nombre del paquete"
      />
      <input
        value={address}
        onChange={e => setAddress(e.target.value)}
        placeholder="Dirección"
      />
      <button type="submit">Añadir</button>
    </form>
  );
}

function App() {
  const [packages, setPackages] = useState([]);
  const [origin, setOrigin] = useState(null);

  function addPackage(pkg) {
    setPackages([...packages, pkg]);
  }

  async function setOriginFromAddress() {
    const addr = prompt("Introduce tu dirección de origen");
    if (!addr) return;
    try {
      const coords = await geocodeAddress(addr);
      setOrigin(coords);
    } catch (err) {
      alert('Error geocodificando origen');
    }
  }

  function openInMaps() {
    if (!origin || packages.length === 0) {
      alert("Falta origen o paquetes");
      return;
    }
    const url = googleMapsDirLink(origin, packages);
    window.open(url, '_blank');
  }

  return (
    <div style={{ padding: 20 }}>
      <h1>📦 Tony Rutas</h1>
      <button onClick={setOriginFromAddress}>📍 Definir Origen</button>
      <PackageForm onAdd={addPackage} />
      <ul>
        {packages.map((p, i) => (
          <li key={i}>{p.title} — {p.displayName}</li>
        ))}
      </ul>
      <button onClick={openInMaps}>🚀 Optimizar y abrir en Google Maps</button>
    </div>
  );
}

export default App;
