import React, { useEffect, useMemo, useRef, useState } from "react";

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
  let sum = 0;
  let prev = origin;
  for (const p of stops) {
    sum += haversine(prev, p);
    prev = p;
  }
  return sum; // sin vuelta al origen (one-way)
}

// Nearest Neighbor (origen fijo)
function nearestNeighbor(origin, stops) {
  const remaining = stops.slice();
  const ordered = [];
  let current = origin;
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversine(current, remaining[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    ordered.push(next);
    current = next;
  }
  return ordered;
}

// 2-Opt sobre la secuencia (origen fijo fuera)
function twoOpt(origin, stops) {
  if (stops.length < 3) return stops.slice();
  let best = stops.slice();
  let improved = true;
  const baseDist = () => routeDistance(origin, best);

  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 2; i++) {
      for (let k = i + 1; k < best.length - 1; k++) {
        const newRoute = best.slice(0, i + 1).concat(best.slice(i + 1, k + 1).reverse(), best.slice(k + 1));
        if (routeDistance(origin, newRoute) + 1e-9 < baseDist()) {
          best = newRoute;
          improved = true;
        }
      }
    }
  }
  return best;
}

function optimizeRoute(origin, stops) {
  if (!origin || stops.length < 2) return stops.slice();
  const nn = nearestNeighbor(origin, stops);
  const improved = twoOpt(origin, nn);
  return improved;
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

  // UI
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [search, setSearch] = useState("");

  // QR
  const [qrOpen, setQrOpen] = useState(false);
  const [useBack, setUseBack] = useState(true);
  const qrRegionRef = useRef(null);
  const html5QrRef = useRef(null);
  const camerasRef = useRef([]);

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

  /* --- Filtro búsqueda --- */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return packages;
    return packages.filter(
      p =>
        (p.name || "").toLowerCase().includes(q) ||
        (p.address || "").toLowerCase().includes(q) ||
        (p.displayName || "").toLowerCase().includes(q)
    );
  }, [search, packages]);

  const estKm = useMemo(() => {
    return Math.round(routeDistance(origin, packages) * 10) / 10;
  }, [origin, packages]);

  /* --- Acciones principales --- */
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
      };
      setPackages(prev => [...prev, item]);
      setPkgName(""); setPkgAddress("");
      setMsg("Paquete añadido ✅");
    } catch {
      setMsg("No pude localizar esa dirección. Prueba con ciudad/CP.");
    } finally { setLoading(false); }
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
    setPrevOrder(packages.slice()); // guardar para deshacer
    const optimized = optimizeRoute(origin, packages);
    setPackages(optimized);
    setMsg("Ruta optimizada ✅");
  }
  function undoOptimize() {
    if (prevOrder) {
      setPackages(prevOrder);
      setPrevOrder(null);
      setMsg("Orden restaurado.");
    }
  }

  /* --- QR: abrir, iniciar, cerrar --- */
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

    if (html5QrRef.current) {
      try { await html5QrRef.current.stop(); } catch {}
      try { await html5QrRef.current.clear(); } catch {}
      html5QrRef.current = null;
    }

    const cams = await Html5Qrcode.getCameras();
    camerasRef.current = cams;

    const wanted = useBack ? /back|rear|environment/i : /front|user/i;
    const match = cams.find(c => wanted.test(c.label));
    const cameraConfig = match
      ? { deviceId: { exact: match.id } }
      : (useBack ? { facingMode: "environment" } : { facingMode: "user" });

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
          Origen + paquetes, escáner QR, <b>optimización de ruta</b> y apertura en Google Maps.
        </p>
      </header>

      {/* Buscar */}
      <div className="card" style={{ marginBottom: 12 }}>
        <input
          placeholder="Buscar por nombre o dirección…"
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

      {/* Añadir paquete + QR */}
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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn" onClick={addPackage} disabled={loading}>Añadir</button>
            <button className="btn" onClick={openQR}>📷 Escanear QR</button>
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
            {packages.map((p, i) => (
              <div key={p.id} className="item" style={{ justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div className="muted" title={p.displayName}>{p.address}</div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="pill">#{i + 1}</span>
                  <button className="btn ghost" onClick={() => removePackage(p.id)}>Eliminar</button>
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
              <span>Escanear QR (cámara {useBack ? "trasera" : "delantera"})</span>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn ghost" onClick={async () => { setUseBack(v => !v); await startScanner(); }}>
                  Cambiar cámara
                </button>
                <button className="btn" onClick={closeQR}>Cerrar</button>
              </div>
            </div>

            <div id="qr-region" ref={qrRegionRef} style={{ width: "100%", height: "100%", background: "#000" }} />

            <div style={{ padding: 12, color: "#9aa5b1" }}>
              Consejo: apunta al QR y mantén el móvil estable.
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

