import React, { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";

// Carga condicional del plugin nativo (Android/iOS) para evitar romper el build web
let MLKitBarcodeScanner; // { BarcodeScanner }
if (Capacitor.getPlatform() !== "web") {
  // el await dinámico solo lo ejecuta el runtime (no el bundler)
  // eslint-disable-next-line no-undef
  (async () => {
    MLKitBarcodeScanner = await import("@capacitor-mlkit/barcode-scanning");
  })();
}

// Fallback web (se importa solo cuando se usa)
let Html5Qrcode = null;

const NOMINATIM =
  "https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&q=";

// ---------- Utilidades ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isLikelyJson(text) {
  const t = text?.trim();
  if (!t) return false;
  if (t.startsWith("{") && t.endsWith("}")) return true;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractAddressFromUrl(url) {
  try {
    const u = new URL(url);
    // intenta ?address=, ?addr=, ?q=
    const cand =
      u.searchParams.get("address") ||
      u.searchParams.get("addr") ||
      u.searchParams.get("q");
    return cand || "";
  } catch {
    return "";
  }
}

function looksLikeAddress(text) {
  // heurística suave: hay coma y alguna cifra (número/código postal)
  return /[,]/.test(text) && /\d/.test(text);
}

async function geocodeAddress(q) {
  const url = NOMINATIM + encodeURIComponent(q);
  const res = await fetch(url, {
    headers: { "Accept-Language": "es-ES,es" },
  });
  if (!res.ok) throw new Error("Error geocoding");
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const hit = data[0];
  return {
    lat: parseFloat(hit.lat),
    lon: parseFloat(hit.lon),
    displayName: hit.display_name,
  };
}

function buildGoogleMapsLink(origin, stops) {
  if (!origin || stops.length === 0) return "";
  const o = `${origin.lat},${origin.lon}`;
  const dest = `${stops[stops.length - 1].lat},${stops[stops.length - 1].lon}`;
  const waypoints = stops
    .slice(0, -1)
    .map((p) => `${p.lat},${p.lon}`)
    .join("|");
  const wpParam = waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : "";
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
    o
  )}&destination=${encodeURIComponent(dest)}${wpParam}`;
}

// ---------- App ----------
export default function App() {
  const [originText, setOriginText] = useState("");
  const [origin, setOrigin] = useState(null);

  const [nameText, setNameText] = useState("");
  const [addrText, setAddrText] = useState("");
  const [noteText, setNoteText] = useState("");
  const [packages, setPackages] = useState([]);

  const [scanning, setScanning] = useState(false);
  const html5QrRef = useRef(null);
  const scannerDivId = "qr-view";

  // Limpia el lector html5-qrcode si se desmonta
  useEffect(() => {
    return () => {
      if (html5QrRef.current) {
        html5QrRef.current.stop().catch(() => {});
        html5QrRef.current.clear().catch(() => {});
        html5QrRef.current = null;
      }
    };
  }, []);

  async function setOriginFromText() {
    if (!originText.trim()) return alert("Escribe una dirección de salida");
    const geo = await geocodeAddress(originText.trim());
    if (!geo) return alert("No pude localizar esa dirección. Prueba con ciudad/CP.");
    setOrigin({ ...geo, label: originText.trim() });
  }

  async function addPackageFromForm() {
    if (!addrText.trim()) return alert("Escribe o escanea una dirección");
    const geo = await geocodeAddress(addrText.trim());
    if (!geo)
      return alert("No pude localizar esa dirección. Prueba con ciudad/CP.");
    const item = {
      id: Date.now() + "_" + Math.random().toString(16).slice(2),
      name: nameText.trim() || "(sin nombre)",
      address: addrText.trim(),
      note: noteText.trim(),
      lat: geo.lat,
      lon: geo.lon,
      display: geo.displayName,
    };
    setPackages((p) => [...p, item]);
    setNameText("");
    setAddrText("");
    setNoteText("");
  }

  function removePackage(id) {
    setPackages((p) => p.filter((x) => x.id !== id));
  }

  // --- Escaneo (nativo / web) ---
  async function openScanner() {
    try {
      if (Capacitor.getPlatform() !== "web" && MLKitBarcodeScanner) {
        // Nativo (Android/iOS)
        const { BarcodeScanner } = MLKitBarcodeScanner;
        const perm = await BarcodeScanner.requestPermissions();
        if (perm?.camera !== "granted") {
          return alert("Permiso de cámara denegado");
        }
        const { barcodes } = await BarcodeScanner.scan({
          formats: ["ALL_FORMATS"], // QR + de barras
        });
        const txt = barcodes?.[0]?.rawValue || "";
        if (txt) await handleScannedText(txt);
        return;
      }

      // Web fallback
      if (!Html5Qrcode) {
        const mod = await import("html5-qrcode");
        Html5Qrcode = mod.Html5Qrcode;
      }
      setScanning(true);
      await sleep(50); // deja renderizar el overlay
      const instance = new Html5Qrcode(scannerDivId);
      html5QrRef.current = instance;

      await instance.start(
        { facingMode: { exact: "environment" } }, // cámara trasera si existe
        { fps: 10, qrbox: { width: 320, height: 320 } },
        async (decodedText) => {
          try {
            await instance.stop();
            await instance.clear();
          } catch {}
          html5QrRef.current = null;
          setScanning(false);
          await handleScannedText(decodedText);
        },
        () => {}
      );
    } catch (e) {
      console.error(e);
      setScanning(false);
      alert("No pude iniciar la cámara. Revisa permisos o vuelve a intentar.");
    }
  }

  async function closeScannerOverlay() {
    setScanning(false);
    if (html5QrRef.current) {
      try {
        await html5QrRef.current.stop();
        await html5QrRef.current.clear();
      } catch {}
      html5QrRef.current = null;
    }
  }

  // Procesa el texto leído (QR o código de barras)
  async function handleScannedText(raw) {
    let txt = (raw || "").trim();

    // 1) JSON con {name,address,city,zip,...}
    if (isLikelyJson(txt)) {
      const j = tryParseJson(txt);
      if (j && (j.address || j.street || j.dir)) {
        const name =
          j.name || j.cliente || j.recipient || j.destination || "(sin nombre)";
        const city = j.city || j.locality || "";
        const zip = j.zip || j.cp || j.postcode || "";
        const street =
          j.address || j.street || j.dir || j.addr || j.destinationAddress || "";
        const composed = [street, zip, city].filter(Boolean).join(", ");
        if (composed) {
          setNameText(name);
          setAddrText(composed);
          return;
        }
      }
    }

    // 2) URL con ?address= / ?addr= / ?q=
    const fromUrl = extractAddressFromUrl(txt);
    if (fromUrl) {
      setAddrText(fromUrl);
      return;
    }

    // 3) Código numérico (barras clásico). Pide asociar dirección.
    if (/^\d{6,}$/.test(txt)) {
      const assoc = prompt(
        `Escaneado ID "${txt}".\nIntroduce la dirección completa (calle, nº, CP, ciudad):`
      );
      if (assoc && assoc.trim()) {
        setNameText(`ID ${txt}`);
        setAddrText(assoc.trim());
      }
      return;
    }

    // 4) Texto “tipo dirección”
    if (looksLikeAddress(txt)) {
      setAddrText(txt);
      return;
    }

    alert("QR/Código inválido: no detecté una dirección.");
  }

  // Abrir Google Maps
  async function openInGoogleMaps() {
    if (!origin) return alert("Define primero el origen");
    if (packages.length === 0) return alert("No hay paradas");
    const link = buildGoogleMapsLink(origin, packages);
    if (!link) return;
    window.open(link, "_blank");
  }

  // “Optimización” simple: orden alfabético por ciudad/CP si aparece
  function optimizeOrder() {
    setPackages((p) => {
      const copy = [...p];
      copy.sort((a, b) => (a.address || "").localeCompare(b.address || ""));
      return copy;
    });
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 16 }}>
      <h1>Tony Rutas (Capacitor)</h1>
      <p>
        Origen + paquetes, <b>QR/código de barras</b> y optimización sencilla.
      </p>

      <div className="card" style={{ padding: 12, marginBottom: 16 }}>
        <input
          placeholder="Dirección del almacén / salida"
          value={originText}
          onChange={(e) => setOriginText(e.target.value)}
          style={{ width: "100%", padding: 10, marginBottom: 8 }}
        />
        <button onClick={setOriginFromText}>Definir Origen</button>
        {origin && (
          <div style={{ marginTop: 8, fontSize: 12 }}>
            Origen: {origin.label} <br />
            <span className="muted">{origin.display}</span>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 12, marginBottom: 16 }}>
        <h3>Añadir paquete</h3>
        <input
          placeholder="Nombre del cliente (opcional)"
          value={nameText}
          onChange={(e) => setNameText(e.target.value)}
          style={{ width: "100%", padding: 10, marginBottom: 8 }}
        />
        <input
          placeholder="Dirección completa (o escanéala)"
          value={addrText}
          onChange={(e) => setAddrText(e.target.value)}
          style={{ width: "100%", padding: 10, marginBottom: 8 }}
        />
        <textarea
          placeholder="Nota (opcional)"
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          style={{ width: "100%", padding: 10, marginBottom: 8 }}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={addPackageFromForm}>Añadir</button>
          <button onClick={openScanner}>📷 Escanear QR / Código</button>
          <button
            className="btn_ghost"
            onClick={() => {
              setNameText("");
              setAddrText("");
              setNoteText("");
            }}
          >
            Vaciar campos
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 12, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={openInGoogleMaps}>🚀 Abrir en Google Maps</button>
          <button onClick={optimizeOrder}>⚡ Optimizar orden</button>
        </div>
      </div>

      <h3>Paquetes ({packages.length})</h3>
      {packages.length === 0 && <div className="muted">Sin paquetes.</div>}
      <div className="list" style={{ display: "grid", gap: 10 }}>
        {packages.map((p) => (
          <div
            key={p.id}
            className="item"
            style={{
              background: "#fff",
              border: "1px solid #e5e5e5",
              padding: 12,
              borderRadius: 10,
            }}
          >
            <div style={{ fontWeight: 600 }}>{p.name}</div>
            <div>{p.address}</div>
            {p.note && <div className="muted">📝 {p.note}</div>}
            <div className="muted" style={{ fontSize: 12 }}>
              {p.display}
            </div>
            <div style={{ marginTop: 6 }}>
              <button className="btn_danger" onClick={() => removePackage(p.id)}>
                Eliminar
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Overlay de escaneo web */}
      {scanning && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.85)",
            zIndex: 9999,
            display: "grid",
            placeItems: "center",
            padding: 16,
          }}
          onClick={closeScannerOverlay}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(92vw, 520px)",
              maxWidth: "92vw",
              aspectRatio: "1/1",
              background: "#000",
              borderRadius: 12,
              overflow: "hidden",
              position: "relative",
            }}
          >
            <div
              id={scannerDivId}
              style={{ width: "100%", height: "100%", background: "#000" }}
            />
            <button
              onClick={closeScannerOverlay}
              style={{
                position: "absolute",
                right: 8,
                top: 8,
                padding: "6px 10px",
                borderRadius: 8,
              }}
            >
              Cerrar
            </button>
          </div>
          <div style={{ color: "#fff", marginTop: 12, textAlign: "center" }}>
            Consejo: apunta al QR/código y mantén el móvil estable.
          </div>
        </div>
      )}
    </div>
  );
}

