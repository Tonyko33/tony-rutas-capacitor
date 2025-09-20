import { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

/** ---------- Utils ---------- **/
const LS_KEY = "tony-rutas:stops:v1";
const LS_ORIGIN = "tony-rutas:origin:v1";

const hav = (deg) => (deg * Math.PI) / 180;
function haversine(a, b) {
  const R = 6371; // km
  const dLat = hav(b.lat - a.lat);
  const dLon = hav(b.lon - a.lon);
  const lat1 = hav(a.lat);
  const lat2 = hav(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function geocodeAddress(q) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&q=" +
    encodeURIComponent(q);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Error geocoding");
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0)
    throw new Error("Sin resultados");
  const hit = data[0];
  return {
    lat: parseFloat(hit.lat),
    lon: parseFloat(hit.lon),
    displayName: hit.display_name,
  };
}

/** ---------- Component ---------- **/
export default function App() {
  const [originText, setOriginText] = useState("");
  const [origin, setOrigin] = useState(null); // {lat,lon,displayName}
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [stops, setStops] = useState([]); // {id,name,address,lat,lon,displayName}
  const [busy, setBusy] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const qrRef = useRef(null);
  const qrObj = useRef(null);

  /** ---- Load/Save (persistencia) ---- **/
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) setStops(JSON.parse(raw));
      const o = localStorage.getItem(LS_ORIGIN);
      if (o) {
        const parsed = JSON.parse(o);
        setOrigin(parsed);
        setOriginText(parsed.displayName || "");
      }
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(stops));
    } catch {}
  }, [stops]);
  useEffect(() => {
    try {
      if (origin) localStorage.setItem(LS_ORIGIN, JSON.stringify(origin));
    } catch {}
  }, [origin]);

  /** ---- Add / Remove ---- **/
  async function setOriginFromText() {
    if (!originText.trim()) return;
    setBusy(true);
    try {
      const g = await geocodeAddress(originText.trim());
      setOrigin({ ...g, displayName: g.displayName });
      alert("Origen definido ✔");
    } catch (e) {
      alert("No se pudo geocodificar el origen: " + e.message);
    } finally {
      setBusy(false);
    }
  }

  async function addStop() {
    if (!address.trim()) return;
    setBusy(true);
    try {
      const g = await geocodeAddress(address.trim());
      const item = {
        id: crypto.randomUUID(),
        name: name.trim() || "Paquete",
        address: address.trim(),
        lat: g.lat,
        lon: g.lon,
        displayName: g.displayName,
      };
      setStops((x) => [...x, item]);
      setName("");
      setAddress("");
    } catch (e) {
      alert("Dirección no encontrada: " + e.message);
    } finally {
      setBusy(false);
    }
  }

  function removeStop(id) {
    setStops((x) => x.filter((s) => s.id !== id));
  }

  function clearAll() {
    if (confirm("¿Vaciar la lista?")) setStops([]);
  }

  /** ---- Optimización (heurística sencilla) ---- **/
  function optimizeOrder() {
    if (!origin || stops.length < 2) return;
    // nearest neighbor desde origin
    const remaining = [...stops];
    const ordered = [];
    let cur = { lat: origin.lat, lon: origin.lon };
    while (remaining.length) {
      let bestIdx = 0;
      let bestD = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = haversine(cur, remaining[i]);
        if (d < bestD) {
          bestD = d;
          bestIdx = i;
        }
      }
      const [pick] = remaining.splice(bestIdx, 1);
      ordered.push(pick);
      cur = pick;
    }
    setStops(ordered);
  }

  const totalKm = useMemo(() => {
    if (!origin || stops.length === 0) return 0;
    let sum = haversine(origin, stops[0]);
    for (let i = 0; i < stops.length - 1; i++) {
      sum += haversine(stops[i], stops[i + 1]);
    }
    return Math.round(sum * 10) / 10;
  }, [origin, stops]);

  /** ---- Abrir en Google Maps ---- **/
  function googleMapsDirLink(o, list) {
    if (!o || list.length === 0) return "#";
    const originParam = `${o.lat},${o.lon}`;
    const dest = list[list.length - 1];
    const destParam = `${dest.lat},${dest.lon}`;
    const via = list.slice(0, -1).map((p) => `${p.lat},${p.lon}`).join("|");
    const wpParam = via ? `&waypoints=${encodeURIComponent(via)}` : "";
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
      originParam
    )}&destination=${encodeURIComponent(destParam)}${wpParam}`;
  }
  function openMaps() {
    const url = googleMapsDirLink(origin, stops);
    if (url === "#") return;
    window.open(url, "_blank");
  }

  /** ---- Exportar / Importar ---- **/
  function exportCSV() {
    const rows = stops.map((s) => ({
      name: s.name,
      address: s.address,
      lat: s.lat,
      lon: s.lon,
    }));
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "rutas.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify(stops, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "rutas.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importCSV(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (res) => {
        // admite columnas: name,address  (si no hay lat/lon, geocodifica)
        const rows = res.data ?? [];
        const out = [];
        for (const r of rows) {
          try {
            let g =
              r.lat && r.lon
                ? { lat: parseFloat(r.lat), lon: parseFloat(r.lon), displayName: r.address || "" }
                : await geocodeAddress(r.address);
            out.push({
              id: crypto.randomUUID(),
              name: (r.name || "Paquete").trim(),
              address: (r.address || "").trim(),
              lat: g.lat,
              lon: g.lon,
              displayName: g.displayName,
            });
          } catch (e) {
            console.warn("Fila ignorada:", r, e);
          }
        }
        setStops((cur) => [...cur, ...out]);
        ev.target.value = "";
      },
    });
  }

  function importJSON(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const arr = JSON.parse(reader.result);
        if (!Array.isArray(arr)) throw new Error();
        const mapped = arr.map((s) => ({
          id: crypto.randomUUID(),
          name: s.name || "Paquete",
          address: s.address || "",
          lat: Number(s.lat),
          lon: Number(s.lon),
          displayName: s.displayName || s.address || "",
        }));
        setStops((cur) => [...cur, ...mapped]);
      } catch {
        alert("JSON inválido");
      }
    };
    reader.readAsText(file);
    ev.target.value = "";
  }

  /** ---- QR Scanner ---- **/
  async function openQR() {
    setQrOpen(true);
    if (!qrRef.current) return;
    if (qrObj.current) return; // ya abierto
    const { Html5Qrcode } = await import("html5-qrcode");
    const camId = (await Html5Qrcode.getCameras())[0]?.id;
    if (!camId) {
      alert("No se encontró cámara");
      return;
    }
    const html5Qr = new Html5Qrcode(qrRef.current.id);
    qrObj.current = html5Qr;
    html5Qr.start(
      camId,
      { fps: 10, qrbox: 250 },
      async (txt) => {
        try {
          // Formatos admitidos:
          // 1) JSON: {"name":"Caja 12","address":"Calle Mayor 10 Madrid"}
          // 2) Texto: "Caja 12 | Calle Mayor 10 Madrid"
          let parsed;
          try {
            parsed = JSON.parse(txt);
          } catch {
            const [n, ...rest] = txt.split("|");
            parsed = { name: (n || "Paquete").trim(), address: rest.join("|").trim() };
          }
          if (!parsed.address) throw new Error("QR sin dirección");
          setName(parsed.name || "");
          setAddress(parsed.address);
          await addStop(); // geocodifica y añade
          await closeQR();
        } catch (e) {
          alert("QR no válido: " + e.message);
        }
      }
    );
  }

  async function closeQR() {
    if (qrObj.current) {
      try {
        await qrObj.current.stop();
        await qrObj.current.clear();
      } catch {}
      qrObj.current = null;
    }
    setQrOpen(false);
  }

  /** ---- UI ---- **/
  return (
    <div style={{ maxWidth: 780, margin: "0 auto", padding: 16, fontFamily: "system-ui, Arial" }}>
      <h1>Tony Rutas (Capacitor)</h1>

      <section style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12, marginBottom: 12 }}>
        <h3>📍 Origen</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ flex: 1, padding: 8 }}
            placeholder="Almacén o punto de salida"
            value={originText}
            onChange={(e) => setOriginText(e.target.value)}
          />
          <button disabled={busy} onClick={setOriginFromText}>Definir origen</button>
        </div>
        {origin && <p style={{ marginTop: 6, color: "#555" }}>Origen: {origin.displayName}</p>}
      </section>

      <section style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12, marginBottom: 12 }}>
        <h3>➕ Añadir paquete</h3>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            style={{ flex: 0.4, padding: 8 }}
            placeholder="Nombre"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            style={{ flex: 1, padding: 8 }}
            placeholder="Dirección completa"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          <button disabled={busy} onClick={addStop}>Añadir</button>
          <button onClick={openQR}>📷 QR</button>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={optimizeOrder} disabled={!origin || stops.length < 2}>⚡ Optimizar orden</button>
          <button onClick={openMaps} disabled={!origin || stops.length === 0}>🚀 Abrir en Google Maps</button>
          <button onClick={exportCSV} disabled={stops.length === 0}>⬇️ Exportar CSV</button>
          <button onClick={exportJSON} disabled={stops.length === 0}>⬇️ Exportar JSON</button>
          <label style={{ border: "1px solid #ccc", padding: "6px 10px", borderRadius: 6, cursor: "pointer" }}>
            ⬆️ Importar CSV
            <input type="file" accept=".csv" style={{ display: "none" }} onChange={importCSV} />
          </label>
          <label style={{ border: "1px solid #ccc", padding: "6px 10px", borderRadius: 6, cursor: "pointer" }}>
            ⬆️ Importar JSON
            <input type="file" accept=".json" style={{ display: "none" }} onChange={importJSON} />
          </label>
          <button onClick={clearAll}>🧹 Limpiar</button>
        </div>
      </section>

      <section style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3>📦 Paquetes ({stops.length})</h3>
          <div style={{ color: "#555" }}>Distancia estimada: {totalKm} km</div>
        </div>
        {stops.length === 0 ? (
          <p>Sin paquetes.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {stops.map((s, i) => (
              <li key={s.id} style={{ padding: "8px 0", borderBottom: "1px solid #eee", display: "flex", gap: 8 }}>
                <div style={{ width: 28, opacity: 0.6 }}>{i + 1}.</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{s.name}</div>
                  <div style={{ fontSize: 13, color: "#555" }}>{s.displayName || s.address}</div>
                </div>
                <button onClick={() => removeStop(s.id)}>🗑️</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Modal QR */}
      {qrOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
          onClick={closeQR}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "#fff", padding: 12, borderRadius: 12, width: 340 }}
          >
            <h3>Escanear QR</h3>
            <div id="qr-region" ref={qrRef} style={{ width: 300, height: 300, margin: "0 auto" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button onClick={closeQR}>Cerrar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
