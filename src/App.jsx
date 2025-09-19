import React, { useState, useEffect } from 'react';

function App() {
  const [origen, setOrigen] = useState('');
  const [paquetes, setPaquetes] = useState([]);
  const [nuevoNombre, setNuevoNombre] = useState('');
  const [nuevaDireccion, setNuevaDireccion] = useState('');

  // Cargar datos guardados
  useEffect(() => {
    const saved = localStorage.getItem('paquetes');
    const savedOrigen = localStorage.getItem('origen');
    if (saved) setPaquetes(JSON.parse(saved));
    if (savedOrigen) setOrigen(savedOrigen);
  }, []);

  // Guardar en localStorage
  useEffect(() => {
    localStorage.setItem('paquetes', JSON.stringify(paquetes));
    localStorage.setItem('origen', origen);
  }, [paquetes, origen]);

  // Añadir paquete
  const addPaquete = () => {
    if (!nuevoNombre || !nuevaDireccion) return;
    setPaquetes([...paquetes, { nombre: nuevoNombre, direccion: nuevaDireccion }]);
    setNuevoNombre('');
    setNuevaDireccion('');
  };

  // Eliminar paquete
  const removePaquete = (i) => {
    const updated = paquetes.filter((_, idx) => idx !== i);
    setPaquetes(updated);
  };

  // Abrir en Google Maps
  const abrirMaps = () => {
    if (!origen || paquetes.length === 0) return;
    const originParam = encodeURIComponent(origen);
    const dest = encodeURIComponent(paquetes[paquetes.length - 1].direccion);
    const waypoints = paquetes.slice(0, -1).map(p => encodeURIComponent(p.direccion)).join('|');
    const url = `https://www.google.com/maps/dir/?api=1&origin=${originParam}&destination=${dest}${waypoints ? `&waypoints=${waypoints}` : ''}`;
    window.open(url, '_blank');
  };

  return (
    <div>
      <div className="card">
        <h3>📍 Origen</h3>
        {origen && <span className="pill">{origen}</span>}
        <input type="text" placeholder="Dirección de origen" value={origen} onChange={e => setOrigen(e.target.value)} />
      </div>

      <div className="card">
        <h3>➕ Añadir Paquete</h3>
        <input type="text" placeholder="Nombre" value={nuevoNombre} onChange={e => setNuevoNombre(e.target.value)} />
        <input type="text" placeholder="Dirección" value={nuevaDireccion} onChange={e => setNuevaDireccion(e.target.value)} />
        <button onClick={addPaquete}>Añadir</button>
      </div>

      <div className="card">
        <h3>📦 Lista de Paquetes</h3>
        <ul>
          {paquetes.map((p, i) => (
            <li key={i}>
              <span>{p.nombre} - {p.direccion}</span>
              <button onClick={() => removePaquete(i)}>❌</button>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <button onClick={abrirMaps}>🚀 Abrir ruta en Google Maps</button>
        <button onClick={() => setPaquetes([])}>🗑 Vaciar lista</button>
      </div>
    </div>
  );
}

export default App;
