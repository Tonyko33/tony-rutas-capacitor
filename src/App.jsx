import React, { useEffect, useMemo, useRef, useState } from "react";

// ---------------- Utils ----------------
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

async function geocodeAddress(q) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&" +
    "addressdetails=0&limit=1&q=" +
    encodeURIComponent(q);
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error("Error geocoding");
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Sin resultados");
  }
  const hit = data[0];
  return {
    lat: parseFloat(hit.lat),
    lon: parseFloat(hit.lon),
    displayName: hit.display_name,
  };
}

function googleMapsDirLink(origin, stops) {
  // Google Maps admite ~9 waypoints (origen + destino + 8 paradas)
  const MAX_WP = 9;
  const list = stops.slice(0, MAX_WP);
  if (list.length === 0) return "#";

  const originParam = origin ? `${origin.lat},${origin.lon}` : "";
  const dest = list[list.length - 1];
  const destParam = `${dest.lat},${dest.lon}`;
  const waypoints = list.slice(0, -1).map(p => `${p.lat},${p.lon}`).join("|");
  const wpParam = waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : "";

  // https://www.google.com/maps/dir/?api=1&origin=..&destination=..&waypoints=..
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(originParam)}&destination=${encodeURIComponent(destParam)}${wpParam}`;
}

async function ensureCameraPermission() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Este dispositivo no soporta cámara");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false,
  });
  // soltamos enseguida (solo queremos el permiso)
  stream.getTracks().forEach(t => t.stop());
}

// -------------- App --------------------
export default function App() {
  // origen y paquetes (persisten)
  const [origin, setOrigin] = useState(null);
  const [packages, setPackages] = useState([]);

  // formularios
  const [search, setSearch] = useState("");
  const [pkgName, setPkgName] = useState("");
  const [pkgAddress, setPkgAddress] = useState("");
  const [originAddress, setOriginAddress] = useState("");

  // estados UI
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  // QR
  const [qrOpen, setQrOpen] = useState(false);
  const qrRegionRef = useRef(null);
  const html5QrRef = useRef(null);

  // --- Persistencia ---
  useEffect(() => {
    try {
      const s = localStorage.getItem("tony.routes.data");
      if (s) {
        const parsed = JSON.parse(s);
        if (parsed.origin) setOrigin(parsed.origin);
        if (Array.isArray(parsed.packages)) setPackages(parsed.packages);
      }
    } catch {}
  }, []);

  useEffect(() => {
    const payload = JSON.stringify({ origin, packages });
    localStorage.setItem("tony.routes.data", payload);
  }, [origin, packages]);

  // --- Búsqueda en memoria ---
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return packages;
    return packages.filter(
      (p) =>
        (p.name || "").toLowerCase().includes(q) ||
        (p.address || "").toLowerCase().includes(q) ||
        (p.displayName || "").toLowerCase().includes(q)
    );
  }, [search, packages]);

  // ------------- Acciones ---------------
  async function setOriginByAddress() {
    if (!originAddress.trim()) {
      setMsg("Escribe una dirección para el origen.");
      return;
    }
    setLoading(true);
    setMsg("");
    try {
      const hit = await geocodeAddress(originAddress.trim());
      setOrigin({ ...hit, address: originAddress.trim() });
      setOriginAddress(hit.displayName);
      setMsg("Origen establecido ✅");
    } catch (e) {
      setMsg("No pude localizar el origen. Añade ciudad/CP.");
    } finally {
      setLoading(false);
    }
  }

  async function addPackage() {
    if (!pkgAddress.trim()) {
      setMsg("Escribe la dirección.");
      return;
    }
    setLoading(true);
    setMsg("");
    try {
      const hit = await geocodeAddress(pkgAddress.trim());
      const item = {
        id: uid(),
        name: pkgName.trim() || "(Sin nombre)",
        address: pkgAddress.trim(),
        lat: hit.lat,
        lon: hit.lon,
        displayName: hit.displayName,
      };
      setPackages((prev) => [...prev, item]);
      setPkgName("");
      setPkgAddress("");
      setMsg("Paquete añadido ✅");
    } catch (e) {
      setMsg("No pude localizar esa dirección. Prueba con ciudad/CP.");
    } finally {
      setLoading(false);
    }
  }

  function removePackage(id) {
    setPackages((prev) => prev.filter((p) => p.id !== id));
  }

  function clearAll() {
    if (!confirm("¿Vaciar todos los paquetes?")) return;
    setPackages([]);
  }

  function openInGoogleMaps() {
    if (!origin) {
      alert("Primero define el origen.");
      return;
    }
    if (packages.length === 0) {
      alert("Añade al menos una parada.");
      return;
    }
    const url = googleMapsDirLink(origin, packages);
    window.open(url, "_blank");
  }

  // ------------- QR ---------------------
  async function openQR() {
    try {
      await ensureCameraPermission();
    } catch (e) {
      alert("Necesito permiso de cámara: " + e.message);
      return;
    }
    setQrOpen(true);
    // espera a que el modal pinte y el div tenga tamaño
    requestAnimationFrame(startScanner);
  }

  async function startScanner() {
    const el = qrRegionRef.current;
    if (!el) return;
    // Aseguramos tamaño visible
    if (el.clientWidth < 50 || el.clientHeight < 50) {
      el.style.width = "100%";
      el.style.height = "320px";
    }
    const { Html5Qrcode } = await import("html5-qrcode");

    // limpia instancia previa si existiera
    if (html5QrRef.current) {
      try { await html5QrRef.current.stop(); } catch {}
      try { await html5QrRef.current.clear(); } catch {}
      html5QrRef.current = null;
    }

    const cameras = await Html5Qrcode.getCameras();
    if (!cameras.length) {
      alert("No se encontró ninguna cámara.");
      return;
    }
    const cameraId = cameras[0].id;

    const scanner = new Html5Qrcode(el.id);
    html5QrRef.current = scanner;

    await scanner.start(
      cameraId,
      { fps: 10, qrbox: 250 },
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

  function onScanSuccess(decodedText /*, decodedResult */) {
    // Formatos admitidos:
    // 1) JSON: {"name":"Caja 12","address":"Calle Mayor 10 Madrid"}
    // 2) Texto simple: "Caja 12 | Calle Mayor 10 Madrid"
    try {
      let name = "", address = "";
      const txt = (decodedText || "").trim();
      if (!txt) throw new Error("QR vacío");

      try {
        const obj = JSON.parse(txt);
        name = (obj.name || "").trim();
        address = (obj.address || "").trim();
      } catch {
        const [n, d] = txt.split("|");
        name = (n || "").trim();
        address = (d || "").trim();
      }

      if (!address) throw new Error("El QR no contiene dirección");

      // Cerrar el QR y usar la misma lógica del formulario
      closeQR();
      setPkgName(name);
      setPkgAddress(address);
      // auto añadir
      setTimeout(() => {
        addPackage();
      }, 100);
    } catch (e) {
      alert("QR inválido: " + e.message);
    }
  }

  // ------------- Render -----------------
  return (
    <main style={{ padding: 16, maxWidth: 960, margin: "0 auto" }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Tony Rutas (Capacitor)</h1>
        <p className="muted" style={{ marginTop: 4 }}>
          Organiza paquetes, escanea QR y abre la ruta en Google Maps.
        </p>
      </header>

      {/* Buscar */}
      <div className="card" style={{ marginBottom: 12 }}>
        <input
          placeholder="Buscar por nombre o dirección…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
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
            onChange={(e) => setOriginAddress(e.target.value)}
            style={{ width: "100%", padding: 10 }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={setOriginByAddress} disabled={loading}>
              Definir Origen
            </button>
            {origin && (
              <span className="pill" title={origin.displayName}>
                {origin.displayName}
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Añadir paquete + QR */}
      <section className="card" style={{ marginBottom: 12 }}>
        <h3 style={{ marginTop: 0 }}>➕ Añadir paquete</h3>
        <div className="grid" style={{ gap: 10 }}>
          <input
            placeholder="Nombre (opcional)"
            value={pkgName}
            onChange={(e) => setPkgName(e.target.value)}
            style={{ width: "100%", padding: 10 }}
          />
          <input
            placeholder="Dirección"
            value={pkgAddress}
            onChange={(e) => setPkgAddress(e.target.value)}
            style={{ width: "100%", padding: 10 }}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn" onClick={addPackage} disabled={loading}>
              Añadir
            </button>
            <button className="btn" onClick={openQR}>
              📷 Escanear QR
            </button>
            <button className="btn danger" onClick={clearAll} disabled={packages.length === 0}>
              Vaciar lista
            </button>
          </div>
          {msg && <div className="muted">{msg}</div>}
        </div>
      </section>

      {/* Lista de paquetes */}
      <section className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h3 style={{ marginTop: 0 }}>📦 Paquetes ({packages.length})</h3>
          <button className="btn" onClick={openInGoogleMaps} disabled={!origin || packages.length === 0}>
            🚀 Optimizar (orden actual) y abrir en Google Maps
          </button>
        </div>

        {filtered.length === 0 ? (
          <div className="muted">Sin paquetes.</div>
        ) : (
          <div className="list">
            {filtered.map((p, i) => (
              <div key={p.id} className="item" style={{ justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div className="muted" title={p.displayName}>
                    {p.address}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="pill">#{i + 1}</span>
                  <button className="btn ghost" onClick={() => removePackage(p.id)}>
                    Eliminar
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Modal QR */}
      {qrOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,.5)",
            display: "grid",
            placeItems: "center",
            zIndex: 9999,
          }}
        >
          <div
            className="card"
            style={{ width: "92%", maxWidth: 520, background: "#fff", padding: 16, borderRadius: 12 }}
          >
            <h3 style={{ marginTop: 0 }}>Escanear QR</h3>
            <div
              id="qr-region"
              ref={qrRegionRef}
              style={{
                width: "100%",
                height: 320,
                background: "#000",
                borderRadius: 8,
                overflow: "hidden",
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button className="btn" onClick={closeQR}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
