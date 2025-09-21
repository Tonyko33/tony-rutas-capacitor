import React, { useEffect, useMemo, useRef, useState } from "react";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";

/* ===================== Utils ===================== */
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

async function geocodeAddress(q) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=0&limit=1&q=" +
    encodeURIComponent(q);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Error geocoding");
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error("Sin resultados");
  const hit = data[0];
  return { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon), displayName: hit.display_name };
}

function googleMapsDirLink(origin, stops) {
  const MAX_WP = 9; // origen + destino + ~8 waypoints
  const list = stops.slice(0, MAX_WP);
  if (!origin || list.length === 0) return "#";
  const originParam = `${origin.lat},${origin.lon}`;
  const dest = list[list.length - 1];
  const destParam = `${dest.lat},${dest.lon}`;
  const waypoints = list.slice(0, -1).map(p => `${p.lat},${p.lon}`).join("|");
  const wpParam = waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : "";
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
    originParam
  )}&destination=${encodeURIComponent(destParam)}${wpParam}`;
}

async function ensureCameraPermission() {
  // Para html5-qrcode (escáner QR)
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Este dispositivo no soporta cámara");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false,
  });
  stream.getTracks().forEach(t => t.stop());
}

/* ---- Parser tolerante para QR ---- */
function parseQrPayload(raw) {
  const txt = (raw || "").trim();
  if (!txt) throw new Error("QR vacío");

  try {
    const obj = JSON.parse(txt);
    const name =
      (obj.name || obj.nombre || obj.pkg || obj.paquete || "").toString().trim();
    const address =
      (obj.address || obj.direccion || obj.dir || obj.addr || "").toString().trim();
    if (address) return { name: name || "(QR)", address };
  } catch (_) {}

  if (txt.includes("\n")) {
    const lines = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length >= 2) {
      const name = lines[0] || "(QR)";
      const address = lines.slice(1).join(", ");
      if (address) return { name, address };
    }
  }

  const m = txt.match(/^(.+?)\s*(?:\||,|;|-)\s+(.+)$/);
  if (m) {
    const name = m[1].trim() || "(QR)";
    const address = m[2].trim();
    if (address) return { name, address };
  }

  if (/\S+\s+\S+/.test(txt)) {
    return { name: "(QR)", address: txt };
  }

  throw new Error("El QR no contiene dirección");
}

/* ---- Distancias y optimización ---- */
const R = 6371; // km
function haversine(a, b) {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(la1) * Math.cos(la2) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function routeDistance(origin, stops) {
  if (!origin || stops.length === 0) return 0;
  let sum = 0, prev = origin;
  for (const p of stops) { sum += haversine(prev, p); prev = p; }
  return sum;
}
function nearestNeighbor(origin, stops) {
  const remaining = stops.slice(); const ordered = []; let current = origin;
  while (remaining.length) {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversine(current, remaining[i]);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const next = remaining.splice(bestIdx, 1)[0]; ordered.push(next); current = next;
  }
  return ordered;
}
function twoOpt(origin, stops) {
  if (stops.length < 3) return stops.slice();
  let best = stops.slice(), improved = true;
  const base = () => routeDistance(origin, best);
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 2; i++) {
      for (let k = i + 1; k < best.length - 1; k++) {
        const newR = best.slice(0, i + 1).concat(best.slice(i + 1, k + 1).reverse(), best.slice(k + 1));
        if (routeDistance(origin, newR) + 1e-9 < base()) { best = newR; improved = true; }
      }
    }
  }
  return best;
}
function optimizeRoute(origin, stops) {
  if (!origin || stops.length < 2) return stops.slice();
  return twoOpt(origin, nearestNeighbor(origin, stops));
}

/* ===================== App ===================== */
export default function App() {
  // Persistencia
  const [origin, setOrigin] = useState(null);
  const [packages, setPackages] = useState([]);
  const [prevOrder, setPrevOrder] = useState(null);

  // Formularios
  const [originAddress, setOriginAddress] = useState("");
  const [pkgName, setPkgName] = useState("");
  const [pkgAddress, setPkgAddress] = useState("");
  const [pkgNote, setPkgNote] = useState("");
  const [tempPhoto, setTempPhoto] = useState(null); // webPath temporal antes de crear paquete

  // UI
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [search, setSearch] = useState("");

  // QR
  const [qrOpen, setQrOpen] = useState(false);
  const [useBack, setUseBack] = useState(true);
  const qrRegionRef = useRef(null);
  const html5QrRef = useRef(null);

  // Visor foto
  const [viewer, setViewer] = useState({ open: false, src: null });

  /* --- Cargar / Guardar (localStorage) --- */
  useEffect(() => {
    try {
      const s = localStorage.getItem("tony.routes.data");
      if (s) {
        const parsed = JSON.parse(s);
        if (parsed.origin) {
          setOrigin(parsed.origin);
          if (parsed.origin.displayName) setOriginAddress(parsed.origin.displayName);
        }
        if (Array.isArray(parsed.packages)) setPackages(parsed.packages);
      }
    } catch {}
  }, []);
  useEffect(() => {
    localStorage.setItem("tony.routes.data", JSON.stringify({ origin, packages }));
  }, [origin, packages]);

  /* --- Filtro --- */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return packages;
    return packages.filter(
      p =>
        (p.name || "").toLowerCase().includes(q) ||
        (p.address || "").toLowerCase().includes(q) ||
        (p.displayName || "").toLowerCase().includes(q) ||
        (p.note || "").toLowerCase().includes(q)
    );
  }, [search, packages]);

  const estKm = useMemo(() => Math.round(routeDistance(origin, packages) * 10) / 10, [origin, packages]);

  /* --- Acciones --- */
  async function setOriginByAddress() {
    if (!originAddress.trim()) return setMsg("Escribe una dirección para el origen.");
    setLoading(true); setMsg("");
    try {
      const hit = await geocodeAddress(originAddress.trim());
      setOrigin({ ...hit, address: originAddress.trim() });
      setOriginAddress(hit.displayName);
      setMsg("Origen establecido ✅");
    } catch {
      setMsg("No pude localizar el origen. Añade ciudad/CP.");
    } finally { setLoading(false); }
  }

  async function addPackage() {
    if (!pkgAddress.trim()) return setMsg("Escribe la dirección.");
    setLoading(true); setMsg("");
    try {
      const hit = await geocodeAddress(pkgAddress.trim());
      const item = {
        id: uid(),
        name: pkgName.trim() || "(Sin nombre)",
        address: pkgAddress.trim(),
        lat: hit.lat, lon: hit.lon,
        displayName: hit.displayName,
        note: pkgNote.trim(),
        photo: tempPhoto || null, // webPath
      };
      setPackages(prev => [...prev, item]);
      setPkgName(""); setPkgAddress(""); setPkgNote(""); setTempPhoto(null);
      setMsg("Paquete añadido ✅");
    } catch {
      setMsg("No pude localizar esa dirección. Prueba con ciudad/CP.");
    } finally { setLoading(false); }
  }

  function updatePackage(id, patch) {
    setPackages(prev => prev.map(p => (p.id === id ? { ...p, ...patch } : p)));
  }
  function removePackage(id) {
    setPackages(prev => prev.filter(p => p.id !== id));
  }
  function clearAll() {
    if (confirm("¿Vaciar la lista completa?")) setPackages([]);
  }
  function openInGoogleMaps() {
    if (!origin) return alert("Primero define el origen.");
    if (packages.length === 0) return alert("Añade al menos una parada.");
    window.open(googleMapsDirLink(origin, packages), "_blank");
  }

  /* --- Optimización --- */
  function optimize() {
    if (!origin) return alert("Primero define el origen.");
    if (packages.length < 2) return alert("Añade al menos 2 paradas.");
    setPrevOrder(packages.slice());
    const optimized = optimizeRoute(origin, packages);
    setPackages(optimized);
    setMsg("Ruta optimizada ✅");
  }
  function undoOptimize() {
    if (prevOrder) { setPackages(prevOrder); setPrevOrder(null); setMsg("Orden restaurado."); }
  }

  /* --- Fotos con Capacitor Camera --- */
  async function takePhotoForNew() {
    try {
      const photo = await Camera.getPhoto({
        source: CameraSource.Camera,
        resultType: CameraResultType.Uri,
        quality: 70,
        saveToGallery: false,
        direction: "rear",
      });
      setTempPhoto(photo.webPath || photo.path || null);
    } catch (e) {
      if (e?.message?.includes("No Activity")) alert("No se pudo abrir la cámara.");
    }
  }
  async function takePhotoForPackage(id) {
    try {
      const photo = await Camera.getPhoto({
        source: CameraSource.Camera,
        resultType: CameraResultType.Uri,
        quality: 70,
        saveToGallery: false,
        direction: "rear",
      });
      updatePackage(id, { photo: photo.webPath || photo.path || null });
    } catch {}
  }

  /* --- QR escáner (html5-qrcode) --- */
  const [html5LibLoaded, setHtml5LibLoaded] = useState(false);
  async function openQR() {
    try { await ensureCameraPermission(); }
    catch (e) { return alert("Necesito permiso de cámara: " + e.message); }
    setQrOpen(true);
    requestAnimationFrame(startScanner);
  }
  async function startScanner() {
    const el = qrRegionRef.current;
    if (!el) return;
    el.style.width = "100%";
    el.style.height = "100%";

    const { Html5Qrcode } = await import("html5-qrcode");
    setHtml5LibLoaded(true);

    if (html5QrRef.current) {
      try { await html5QrRef.current.stop(); } catch {}
      try { await html5QrRef.current.clear(); } catch {}
      html5QrRef.current = null;
    }

    const cams = await Html5Qrcode.getCameras();
    const match = cams.find(c => /back|rear|environment/i.test(c.label));
    const cameraConfig = match ? { deviceId: { exact: match.id } } : { facingMode: "environment" };

    const scanner = new Html5Qrcode(el.id);
    html5QrRef.current = scanner;

    const boxSize = Math.floor(Math.min(el.clientWidth, el.clientHeight) * 0.8);

    await scanner.start(
      cameraConfig,
      { fps: 10, qrbox: { width: boxSize, height: boxSize } },
      onScanSuccess,
      () => {}
    );
  }
  async function closeQR() {
    if (html5QrRef.current) {
      try { await html5QrRef.current.stop(); } catch {}
      try { await html5QrRef.current.clear(); } catch {}
      html5QrRef.current = null;
    }
    setQrOpen(false);
  }
  function onScanSuccess(decodedText) {
    try {
      const { name, address } = parseQrPayload(decodedText);
      closeQR();
      setPkgName(name);
      setPkgAddress(address);
      setTimeout(() => { addPackage(); }, 100);
    } catch (e) {
      alert("QR inválido: " + e.message);
    }
  }

  /* ===================== UI ===================== */
  return (
    <main style={{ padding: 16, maxWidth: 960, margin: "0 auto" }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Tony Rutas (Capacitor)</h1>
        <p className="muted" style={{ marginTop: 4 }}>
          Origen + paquetes, <b>fotos</b>, <b>notas</b>, escáner QR y <b>optimización de ruta</b>.
        </p>
      </header>

      {/* Buscar */}
      <div className="card" style={{ marginBottom: 12 }}>
        <input
          placeholder="Buscar por nombre, dirección o nota…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: "100%", padding: 10 }}
        />
      </div>

      {/* Origen */}
      <section className="card" style={{ marginBottom: 12 }}>
        <h3 style={{ marginTop: 0 }}>📍 Origen</h3>
        <div className="grid" style={{ gap: 10 }}>
          <input
            placeholder="Dirección del almacén / salida"
            value={originAddress}
            onChange={e => setOriginAddress(e.target.value)}
            style={{ width: "100%", padding: 10 }}
          />
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
          <button className="btn" onClick={setOriginByAddress} disabled={loading}>
            Definir Origen
          </button>
          {origin && <span className="pill" title={origin.displayName}>{origin.displayName}</span>}
        </div>
      </section>

      {/* Añadir paquete + QR + Foto + Nota */}
      <section className="card" style={{ marginBottom: 12 }}>
        <h3 style={{ marginTop: 0 }}>➕ Añadir paquete</h3>
        <div className="grid" style={{ gap: 10 }}>
          <input
            placeholder="Nombre (opcional)"
            value={pkgName}
            onChange={e => setPkgName(e.target.value)}
            style={{ width: "100%", padding: 10 }}
          />
          <input
            placeholder="Dirección"
            value={pkgAddress}
            onChange={e => setPkgAddress(e.target.value)}
            style={{ width: "100%", padding: 10 }}
          />
          <textarea
            placeholder="Nota (opcional)"
            rows={3}
            value={pkgNote}
            onChange={e => setPkgNote(e.target.value)}
            style={{ width: "100%", padding: 10 }}
          />
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn" onClick={addPackage} disabled={loading}>Añadir</button>
            <button className="btn" onClick={openQR}>📷 Escanear QR</button>
            <button className="btn" onClick={takePhotoForNew}>📸 Foto del paquete</button>
            {tempPhoto && (
              <>
                <img
                  src={tempPhoto}
                  alt="preview"
                  style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: "1px solid #ddd" }}
                  onClick={() => setViewer({ open: true, src: tempPhoto })}
                />
                <button className="btn ghost" onClick={() => setTempPhoto(null)}>Quitar foto</button>
              </>
            )}
            <button className="btn danger" onClick={clearAll} disabled={packages.length === 0}>Vaciar lista</button>
          </div>
          {msg && <div className="muted">{msg}</div>}
        </div>
      </section>

      {/* Controles de ruta */}
      <section className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn" onClick={openInGoogleMaps} disabled={!origin || packages.length === 0}>
              🚀 Abrir en Google Maps
            </button>
            <button className="btn" onClick={optimize} disabled={!origin || packages.length < 2}>
              ⚡ Optimizar orden
            </button>
            <button className="btn ghost" onClick={undoOptimize} disabled={!prevOrder}>
              Deshacer
            </button>
          </div>
          <div className="muted">Distancia estimada: <b>{estKm} km</b></div>
        </div>
      </section>

      {/* Lista */}
      <section className="card" style={{ marginBottom: 12 }}>
        <h3 style={{ marginTop: 0 }}>📦 Paquetes ({packages.length})</h3>
        {packages.length === 0 ? (
          <div className="muted">Sin paquetes.</div>
        ) : (
          <div className="list">
            {filtered.map((p, i) => (
              <div key={p.id} className="item" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 56, height: 56, borderRadius: 8, border: "1px solid #ddd", background: "#f6f6f6", overflow: "hidden", display: "grid", placeItems: "center" }}>
                    {p.photo ? (
                      <img
                        src={p.photo}
                        alt="pkg"
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        onClick={() => setViewer({ open: true, src: p.photo })}
                      />
                    ) : (
                      <span className="muted" style={{ fontSize: 12 }}>sin foto</span>
                    )}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    <div className="muted" title={p.displayName}>{p.address}</div>
                    {p.note && <div className="muted" style={{ fontStyle: "italic" }}>📝 {p.note}</div>}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="pill">#{i + 1}</span>
                  <button className="btn" onClick={() => takePhotoForPackage(p.id)}>📷 Foto</button>
                  {p.photo && <button className="btn ghost" onClick={() => setViewer({ open: true, src: p.photo })}>Ver</button>}
                  {p.photo && <button className="btn ghost" onClick={() => updatePackage(p.id, { photo: null })}>Borrar foto</button>}
                  <button
                    className="btn ghost"
                    onClick={() => {
                      const n = prompt("Editar nota:", p.note || "");
                      if (n !== null) updatePackage(p.id, { note: n.trim() });
                    }}
                  >
                    📝 Nota
                  </button>
                  <button className="btn danger" onClick={() => removePackage(p.id)}>Eliminar</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Modal QR a pantalla completa */}
      {qrOpen && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", zIndex: 9999,
            display: "grid", placeItems: "center", padding: 0,
          }}
        >
          <div
            className="card"
            style={{
              width: "100vw", height: "100vh", maxWidth: "100vw", maxHeight: "100vh",
              borderRadius: 0, background: "#000",
              display: "grid", gridTemplateRows: "auto 1fr auto",
            }}
          >
            <div style={{ padding: 12, color: "#fff", fontWeight: 600, display: "flex", justifyContent: "space-between" }}>
              <span>Escanear QR (cámara trasera)</span>
              <button className="btn" onClick={closeQR}>Cerrar</button>
            </div>

            <div id="qr-region" ref={qrRegionRef} style={{ width: "100%", height: "100%", background: "#000" }} />

            <div style={{ padding: 12, color: "#9aa5b1" }}>
              Consejo: apunta al QR y mantén el móvil estable.
            </div>
          </div>
        </div>
      )}

      {/* Visor de imagen */}
      {viewer.open && viewer.src && (
        <div
          onClick={() => setViewer({ open: false, src: null })}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 10000,
            display: "grid", placeItems: "center"
          }}
        >
          <img
            src={viewer.src}
            alt="foto"
            style={{ maxWidth: "95vw", maxHeight: "90vh", objectFit: "contain", boxShadow: "0 10px 30px rgba(0,0,0,.6)" }}
          />
        </div>
      )}
    </main>
  );
}

