// src/App.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Camera, CameraDirection, CameraResultType, CameraSource } from "@capacitor/camera";

/* =========================
   Utilidades
   ========================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseQRText(txt) {
  if (!txt) return null;

  // 1) JSON válido
  try {
    const obj = JSON.parse(txt);
    if (obj && (obj.address || obj.dir || obj.direccion)) {
      return { name: obj.name || obj.nombre || "Sin nombre", address: obj.address || obj.dir || obj.direccion };
    }
  } catch {}

  // 2) JSON con comillas simples → convertir rápidamente a dobles
  const maybeJson = txt.trim();
  if (maybeJson.startsWith("{") && maybeJson.endsWith("}")) {
    try {
      const fixed = maybeJson
        .replace(/'/g, '"')
        .replace(/\bnombre\b/g, '"name"')
        .replace(/\bdireccion\b/g, '"address"')
        .replace(/\bdir\b/g, '"address"');
      const obj = JSON.parse(fixed);
      if (obj && (obj.address || obj.dir || obj.direccion)) {
        return { name: obj.name || obj.nombre || "Sin nombre", address: obj.address || obj.dir || obj.direccion };
      }
    } catch {}
  }

  // 3) Texto: "Nombre | Dirección"
  const pipes = txt.split("|");
  if (pipes.length === 2) {
    return { name: pipes[0].trim(), address: pipes[1].trim() };
  }

  // 4) Texto en dos líneas
  const lines = txt.split("\n").map((s) => s.trim()).filter(Boolean);
  if (lines.length >= 2) {
    return { name: lines[0], address: lines.slice(1).join(", ") };
  }

  // 5) address: ...
  const m = txt.match(/address\s*:\s*([^}\n\r]+)/i);
  if (m) return { name: "Sin nombre", address: m[1].trim() };

  return null;
}

const toRad = (d) => (d * Math.PI) / 180;
function haversine(a, b) {
  // a = [lat, lon], b = [lat, lon]
  const R = 6371; // km
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const la1 = toRad(a[0]);
  const la2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* =========================
   Geocodificación (OSM)
   ========================= */
async function geocodeAddress(q) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&q=" +
    encodeURIComponent(q);
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      // Nominatim recomienda identificar la aplicación
      "User-Agent": "TonyRutas/1.0 (capacitor)"
    }
  });
  if (!res.ok) throw new Error("Error geocoding");
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error("Sin resultados");
  const hit = data[0];
  return { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon), displayName: hit.display_name };
}

/* =========================
   Escáner QR (BarcodeDetector)
   - Grande, cámara trasera
   ========================= */
function QROverlay({ onCancel, onResult }) {
  const videoRef = useRef(null);
  const rafRef = useRef(0);
  const detector = useMemo(() => {
    // BarcodeDetector está en Chrome/Android modernos
    return "BarcodeDetector" in window
      ? new window.BarcodeDetector({ formats: ["qr_code"] })
      : null;
  }, []);

  useEffect(() => {
    let stream;
    let disposed = false;

    async function start() {
      try {
        // Cámara trasera + tamaño grande
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        });
        if (disposed) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();

        if (!detector) {
          alert("Este dispositivo no soporta el lector nativo (BarcodeDetector). Actualiza WebView/Chrome.");
          onCancel();
          return;
        }

        const tick = async () => {
          if (disposed) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes && codes.length > 0) {
              const raw = codes[0].rawValue || "";
              onResult(raw);
              return; // cerrará desde arriba
            }
          } catch (e) {
            // sigue intentando
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        alert("No se pudo abrir la cámara. Revisa permisos de cámara.");
        onCancel();
      }
    }

    start();
    return () => {
      disposed = true;
      cancelAnimationFrame(rafRef.current);
      try {
        stream && stream.getTracks().forEach((t) => t.stop());
      } catch {}
    };
  }, [detector, onCancel, onResult]);

  return (
    <div style={styles.overlay}>
      <div style={styles.scannerWrap}>
        <video ref={videoRef} playsInline style={styles.video} />
        <div style={styles.frame} />
        <button onClick={onCancel} style={styles.closeBtn}>Cerrar</button>
      </div>
    </div>
  );
}

/* =========================
   Componente principal
   ========================= */
export default function App() {
  const [originText, setOriginText] = useState("");
  const [originLL, setOriginLL] = useState(null);

  const [name, setName] = useState("");
  const [addressText, setAddressText] = useState("");
  const [note, setNote] = useState("");
  const [photoDataUrl, setPhotoDataUrl] = useState("");

  const [items, setItems] = useState([]);
  const [distanceKm, setDistanceKm] = useState(0);

  const [qrOpen, setQrOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  // calcular distancia estimada (suma tramos en orden actual)
  useEffect(() => {
    (async () => {
      try {
        if (!originLL || items.length === 0) {
          setDistanceKm(0);
          return;
        }
        let km = 0;
        let prev = originLL;
        for (const it of items) {
          if (!it.lat || !it.lon) { setDistanceKm(0); return; }
          km += haversine([prev.lat, prev.lon], [it.lat, it.lon]);
          prev = { lat: it.lat, lon: it.lon };
        }
        setDistanceKm(Math.round(km * 10) / 10);
      } catch {
        setDistanceKm(0);
      }
    })();
  }, [originLL, items]);

  async function setOrigin() {
    if (!originText.trim()) return;
    setBusy(true); setMsg("Geocodificando origen…");
    try {
      const g = await geocodeAddress(originText.trim());
      setOriginLL({ lat: g.lat, lon: g.lon, displayName: g.displayName });
      setMsg("Origen definido ✅");
    } catch {
      alert("No pude localizar ese origen. Prueba con ciudad/CP.");
    } finally {
      setBusy(false);
    }
  }

  async function addPackage() {
    if (!addressText.trim()) { alert("Escribe/escanea una dirección"); return; }
    setBusy(true); setMsg("Geocodificando paquete…");
    try {
      const g = await geocodeAddress(addressText.trim());
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      setItems((old) => [
        ...old,
        {
          id,
          name: name.trim() || "Sin nombre",
          address: addressText.trim(),
          displayName: g.displayName,
          lat: g.lat,
          lon: g.lon,
          note: note.trim(),
          photo: photoDataUrl || ""
        }
      ]);
      // reset campos
      setName("");
      setAddressText("");
      setNote("");
      setPhotoDataUrl("");
      setMsg("Paquete añadido ✅");
    } catch {
      alert("No pude localizar esa dirección. Prueba con ciudad/CP.");
    } finally {
      setBusy(false);
    }
  }

  async function takePhoto() {
    try {
      const p = await Camera.getPhoto({
        source: CameraSource.Camera,
        direction: CameraDirection.Rear,
        resultType: CameraResultType.DataUrl,
        quality: 70,
        allowEditing: false
      });
      if (p && p.dataUrl) {
        setPhotoDataUrl(p.dataUrl);
      }
    } catch {
      alert("No se pudo hacer la foto. Revisa permisos de cámara.");
    }
  }

  function removeItem(id) {
    setItems((old) => old.filter((x) => x.id !== id));
  }

  function optimizeOrder() {
    if (!originLL || items.length <= 2) return;
    // heurística nearest-neighbor desde el origen
    const rem = [...items];
    const out = [];
    let cur = originLL;
    while (rem.length) {
      let bestIdx = 0;
      let bestDist = Infinity;
      rem.forEach((it, i) => {
        const d = haversine([cur.lat, cur.lon], [it.lat, it.lon]);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      });
      const next = rem.splice(bestIdx, 1)[0];
      out.push(next);
      cur = { lat: next.lat, lon: next.lon };
    }
    setItems(out);
  }

  function googleMapsDirLink(origin, stops) {
    const originParam = `${origin.lat},${origin.lon}`;
    const dest = stops[stops.length - 1];
    const destParam = `${dest.lat},${dest.lon}`;
    const waypoints = stops.slice(0, -1).map((p) => `${p.lat},${p.lon}`).join("|");
    const wpParam = waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : "";
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(originParam)}&destination=${encodeURIComponent(destParam)}${wpParam}`;
  }

  function openInGoogleMaps() {
    if (!originLL || items.length === 0) return;
    const MAX = 9; // límite típico de waypoints por ruta
    const chunk = items.slice(0, Math.min(items.length, MAX));
    const url = googleMapsDirLink(originLL, chunk);
    window.open(url, "_blank");
  }

  function onQRDetected(raw) {
    const info = parseQRText(raw);
    if (!info) {
      alert("QR inválido: no se encontró dirección");
    } else {
      setName(info.name || "");
      setAddressText(info.address || "");
    }
    setQrOpen(false);
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <h1 style={{ margin: 0 }}>Tony Rutas (Capacitor)</h1>
        <div style={{ color: "#6b7280" }}>
          Origen + paquetes, <b>fotos</b>, <b>notas</b>, escáner QR y <b>optimización de ruta</b>.
        </div>
      </header>

      {/* Origen */}
      <section style={styles.card}>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={styles.input}
            placeholder="Dirección del almacén / salida"
            value={originText}
            onChange={(e) => setOriginText(e.target.value)}
          />
          <button style={styles.btnPrimary} onClick={setOrigin} disabled={busy}>Definir Origen</button>
        </div>
        {originLL && (
          <div style={{ marginTop: 8, color: "#16a34a" }}>
            ✅ {originLL.displayName}
          </div>
        )}
      </section>

      {/* Añadir paquete */}
      <section style={styles.card}>
        <h2 style={styles.h2}>Añadir paquete</h2>

        <input
          style={styles.input}
          placeholder="Nombre del paquete"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={styles.input}
            placeholder="Dirección completa"
            value={addressText}
            onChange={(e) => setAddressText(e.target.value)}
          />
        </div>
        <textarea
          style={styles.textarea}
          placeholder="Nota (opcional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
        />

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={styles.btnPrimary} onClick={addPackage} disabled={busy}>Añadir</button>
          <button style={styles.btn} onClick={() => setQrOpen(true)}>📷 Escanear QR</button>
          <button style={styles.btn} onClick={takePhoto}>📸 Foto del paquete</button>
          <button style={styles.btnGhost} onClick={() => { setName(""); setAddressText(""); setNote(""); setPhotoDataUrl(""); }}>Vaciar campos</button>
        </div>

        {!originLL && items.length === 0 && (
          <div style={{ marginTop: 8, color: "#9ca3af" }}>
            Consejo: define primero el origen para calcular distancias.
          </div>
        )}

        {msg && <div style={{ marginTop: 8, color: "#2563eb" }}>{msg}</div>}
      </section>

      {/* Foto previa */}
      {photoDataUrl && (
        <section style={styles.card}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Foto previa</div>
          <img alt="prev" src={photoDataUrl} style={{ width: 160, height: 160, objectFit: "cover", borderRadius: 12, border: "1px solid #e5e7eb" }} />
        </section>
      )}

      {/* Acciones de ruta */}
      <section style={styles.card}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={styles.btnPrimary} onClick={openInGoogleMaps} disabled={!originLL || items.length === 0}>🚀 Abrir en Google Maps</button>
          <button style={styles.btn} onClick={optimizeOrder} disabled={!originLL || items.length < 2}>⚡ Optimizar orden</button>
          <button style={styles.btnGhost} onClick={() => setItems([])} disabled={items.length === 0}>Deshacer</button>
        </div>
        <div style={{ marginTop: 8, color: "#111827" }}>
          Distancia estimada: <b>{distanceKm} km</b>
        </div>
      </section>

      {/* Lista */}
      <section style={styles.card}>
        <h2 style={styles.h2}>Paquetes ({items.length})</h2>
        {items.length === 0 ? (
          <div style={{ color: "#6b7280" }}>Sin paquetes.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {items.map((it, idx) => (
              <div key={it.id} style={styles.item}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700 }}>{idx + 1}. {it.name}</div>
                  <div style={{ color: "#374151" }}>{it.address}</div>
                  <div style={{ color: "#6b7280", fontSize: 12 }}>{it.displayName}</div>
                  {it.note && <div style={{ marginTop: 4, fontStyle: "italic", color: "#4b5563" }}>📝 {it.note}</div>}
                </div>
                {it.photo && (
                  <img alt="f" src={it.photo} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 10, border: "1px solid #e5e7eb" }} />
                )}
                <button onClick={() => removeItem(it.id)} style={styles.btnDanger}>Eliminar</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {qrOpen && <QROverlay onCancel={() => setQrOpen(false)} onResult={onQRDetected} />}
    </div>
  );
}

/* =========================
   Estilos inline sencillos
   ========================= */
const styles = {
  page: { maxWidth: 900, margin: "0 auto", padding: 16 },
  header: { padding: "12px 0 8px 0" },
  card: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 16, padding: 16, marginBottom: 12 },
  input: { flex: 1, border: "1px solid #d1d5db", borderRadius: 10, padding: "10px 12px", outline: "none" },
  textarea: { width: "100%", border: "1px solid #d1d5db", borderRadius: 10, padding: "10px 12px", outline: "none" },
  btnPrimary: { background: "#2563eb", color: "#fff", border: "none", borderRadius: 10, padding: "10px 14px", cursor: "pointer" },
  btn: { background: "#f3f4f6", color: "#111827", border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 14px", cursor: "pointer" },
  btnGhost: { background: "transparent", color: "#2563eb", border: "1px solid #bfdbfe", borderRadius: 10, padding: "10px 14px", cursor: "pointer" },
  btnDanger: { background: "#fee2e2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 10, padding: "8px 12px", cursor: "pointer", marginLeft: 8 },
  h2: { margin: 0, marginBottom: 12, fontSize: 20 },
  item: { display: "flex", alignItems: "center", gap: 12, border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 },
  /* QR overlay */
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 12 },
  scannerWrap: { position: "relative", width: "min(100%, 720px)", aspectRatio: "16/9", background: "#000", borderRadius: 16, overflow: "hidden", border: "1px solid #334155" },
  video: { width: "100%", height: "100%", objectFit: "cover" },
  frame: { position: "absolute", inset: "10%", border: "3px solid rgba(255,255,255,0.9)", borderRadius: 16, boxShadow: "0 0 0 100vmax rgba(0,0,0,0.25) inset" },
  closeBtn: { position: "absolute", right: 12, bottom: 12, background: "#111827", color: "#fff", border: "1px solid #374151", borderRadius: 10, padding: "10px 12px", cursor: "pointer" }
};

